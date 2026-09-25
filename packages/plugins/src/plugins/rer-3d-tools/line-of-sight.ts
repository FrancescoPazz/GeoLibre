import type { Cartesian2, Cartesian3, Entity, ScreenSpaceEventHandler } from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import {
  computeLineOfSight,
  computeLineOfSightSampled,
  fromLngLatAlt,
  lineOfSightResultEqual,
  pickGroundPosition,
  raiseByMeters,
  toLngLatAlt,
  type LineOfSightResult,
  type LngLatAlt,
} from "./line-of-sight-geometry";

/**
 * Line of sight on the 3D globe: click an observer, click a target, and see
 * whether terrain stands between them — the clear stretch drawn green, the
 * hidden remainder red, with the distances in the panel.
 *
 * Structured like the Flight Simulator and Sun plugins: this module owns the
 * globe work (picking, the entities, the intersection test) and publishes a
 * snapshot that the app's React panel renders with `useSyncExternalStore`, so
 * the tool needs no DOM of its own and survives a renderer swap — the host
 * calls {@link reattachLineOfSight} whenever an engine mounts, and the points
 * are kept as plain coordinates so the entities can be rebuilt on a fresh
 * globe. Cesium-native by design: it binds through `getCesiumScene()` and does
 * nothing on the 2D map, where the panel explains what to switch to.
 */

/** The first tool of the 3D tool set; used as the entity id prefix too. */
export const LINE_OF_SIGHT_TOOL_ID = "line-of-sight";

export interface LineOfSightSettings {
  /** Metres added above the clicked observer point (eye height, a tower). */
  observerHeight: number;
  /** Metres added above the clicked target point. */
  targetHeight: number;
}

export const LINE_OF_SIGHT_HEIGHT_MIN = 0;
export const LINE_OF_SIGHT_HEIGHT_MAX = 10_000;

/** Eye height for a standing observer; the target is the ground itself. */
export const DEFAULT_LINE_OF_SIGHT_SETTINGS: LineOfSightSettings = Object.freeze({
  observerHeight: 1.7,
  targetHeight: 0,
});

/**
 * Where the tool is in its click sequence. `unavailable` means no primary
 * globe is mounted (the 2D map is the primary renderer), so clicks have
 * nowhere to land.
 */
export type LineOfSightPhase = "unavailable" | "observer" | "target" | "done";

export interface LineOfSightState {
  open: boolean;
  phase: LineOfSightPhase;
  /** The clicked ground positions, before the heights are applied. */
  observer: LngLatAlt | null;
  target: LngLatAlt | null;
  settings: LineOfSightSettings;
  result: LineOfSightResult | null;
}

type CesiumNs = CesiumSceneHandle["Cesium"];

const ENTITY_ID = {
  observer: `geolibre-${LINE_OF_SIGHT_TOOL_ID}-observer`,
  target: `geolibre-${LINE_OF_SIGHT_TOOL_ID}-target`,
  visible: `geolibre-${LINE_OF_SIGHT_TOOL_ID}-visible`,
  hidden: `geolibre-${LINE_OF_SIGHT_TOOL_ID}-hidden`,
} as const;

const OBSERVER_COLOR = "#f97316";
const TARGET_COLOR = "#a855f7";
const VISIBLE_COLOR = "#22c55e";
const HIDDEN_COLOR = "#ef4444";
const LINE_WIDTH = 12;
const LINE_GLOW = 0.3;

let open = false;
let observer: LngLatAlt | null = null;
let target: LngLatAlt | null = null;
let settings: LineOfSightSettings = { ...DEFAULT_LINE_OF_SIGHT_SETTINGS };
let result: LineOfSightResult | null = null;

/** The globe the tool is bound to, with everything needed to unbind. */
interface Binding {
  handle: CesiumSceneHandle;
  handler: ScreenSpaceEventHandler;
  entities: Entity[];
  previousCursor: string;
  releaseTiles: () => void;
  /** A point being dragged, with the camera inputs suspended until it is let go. */
  dragging: { which: "observer" | "target"; restoreInputs: () => void } | null;
}
let binding: Binding | null = null;
let recomputeRequest = 0;

let snapshot: LineOfSightState = buildSnapshot();
const listeners = new Set<() => void>();

function buildSnapshot(): LineOfSightState {
  return {
    open,
    phase: !binding ? "unavailable" : !observer ? "observer" : !target ? "target" : "done",
    observer,
    target,
    settings,
    result,
  };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribeLineOfSight(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getLineOfSightSnapshot(): LineOfSightState {
  return snapshot;
}

export function isLineOfSightPanelVisible(): boolean {
  return open;
}

export function normalizeLineOfSightSettings(raw: unknown): LineOfSightSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const height = (value: unknown, fallback: number): number => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(LINE_OF_SIGHT_HEIGHT_MAX, Math.max(LINE_OF_SIGHT_HEIGHT_MIN, n));
  };
  return {
    observerHeight: height(source.observerHeight, DEFAULT_LINE_OF_SIGHT_SETTINGS.observerHeight),
    targetHeight: height(source.targetHeight, DEFAULT_LINE_OF_SIGHT_SETTINGS.targetHeight),
  };
}

function normalizePoint(raw: unknown): LngLatAlt | null {
  if (!raw || typeof raw !== "object") return null;
  const { lng, lat, alt } = raw as Record<string, unknown>;
  if (typeof lng !== "number" || typeof lat !== "number" || typeof alt !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !Number.isFinite(alt)) return null;
  if (Math.abs(lat) > 90) return null;
  return { lng, lat, alt };
}

function settingsEqual(a: LineOfSightSettings, b: LineOfSightSettings): boolean {
  return a.observerHeight === b.observerHeight && a.targetHeight === b.targetHeight;
}

/**
 * The globe the tool binds to: the primary one when the primary map is a
 * globe, else the first globe in a grid pane — the arrangement a geoportal
 * runs in, the 2D map primary and the globe beside it for the 3D tools.
 * Hosts that predate `getCesiumScenes` offer the primary globe only.
 */
function primaryGlobe(app: GeoLibreAppAPI): CesiumSceneHandle | null {
  const scenes = app.getCesiumScenes?.();
  if (scenes) return scenes[0] ?? null;
  return app.getCesiumScene?.() ?? null;
}

function live(): Binding | null {
  if (!binding) return null;
  if (binding.handle.viewer.isDestroyed()) {
    // The widget went away under us (renderer swap); nothing to unbind from.
    binding = null;
    return null;
  }
  return binding;
}

function raisedEnds(C: CesiumNs): { observer: Cartesian3; target: Cartesian3 } | null {
  if (!observer || !target) return null;
  return {
    observer: raiseByMeters(C, fromLngLatAlt(C, observer), settings.observerHeight),
    target: raiseByMeters(C, fromLngLatAlt(C, target), settings.targetHeight),
  };
}

function removeEntities(b: Binding): void {
  const { viewer } = b.handle;
  if (!viewer.isDestroyed()) {
    for (const entity of b.entities) viewer.entities.remove(entity);
  }
  b.entities = [];
}

/**
 * Rebuild the four entities from the current state. They are few and cheap,
 * and rebuilding keeps every state change (a moved point, a new height, a
 * refined terrain hit) on one path instead of patching entities in place.
 */
function drawEntities(b: Binding): void {
  removeEntities(b);
  const { Cesium: C, viewer } = b.handle;
  if (viewer.isDestroyed()) return;
  const point = (id: string, position: Cartesian3, color: string): Entity =>
    viewer.entities.add({
      id,
      position,
      point: {
        pixelSize: 14,
        color: C.Color.fromCssColorString(color),
        outlineColor: C.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  const line = (id: string, positions: Cartesian3[], color: string): Entity =>
    viewer.entities.add({
      id,
      polyline: {
        positions,
        width: LINE_WIDTH,
        material: new C.PolylineGlowMaterialProperty({
          glowPower: LINE_GLOW,
          color: C.Color.fromCssColorString(color),
        }),
      },
    });

  if (observer) {
    b.entities.push(
      point(
        ENTITY_ID.observer,
        raiseByMeters(C, fromLngLatAlt(C, observer), settings.observerHeight),
        OBSERVER_COLOR,
      ),
    );
  }
  const ends = raisedEnds(C);
  if (ends && target) {
    b.entities.push(point(ENTITY_ID.target, ends.target, TARGET_COLOR));
    const hit = result?.hit ? fromLngLatAlt(C, result.hit) : null;
    const clearEnd = result?.occluded && hit ? hit : ends.target;
    b.entities.push(line(ENTITY_ID.visible, [ends.observer, clearEnd], VISIBLE_COLOR));
    if (result?.occluded && hit) {
      b.entities.push(line(ENTITY_ID.hidden, [hit, ends.target], HIDDEN_COLOR));
    }
  }
  b.handle.requestRender();
}

/** Re-run the intersection test; returns whether the published result changed. */
function recompute(b: Binding): boolean {
  const { Cesium: C, scene } = b.handle;
  const ends = raisedEnds(C);
  const next = ends ? computeLineOfSight(C, scene, ends.observer, ends.target) : null;
  if (lineOfSightResultEqual(next, result)) return false;
  result = next;
  return true;
}

async function recomputeSampled(b: Binding): Promise<void> {
  const request = ++recomputeRequest;
  const { Cesium: C, viewer } = b.handle;
  const ends = raisedEnds(C);
  if (!ends) {
    if (result !== null) result = null;
    return;
  }
  const provider = viewer.terrainProvider;
  if (!provider?.availability) {
    recompute(b);
    return;
  }
  const next = await computeLineOfSightSampled(C, provider, ends.observer, ends.target);
  if (request !== recomputeRequest) return;
  result = next;
}

function refresh(b: Binding): void {
  const provider = b.handle.viewer.terrainProvider;
  if (provider?.availability) {
    void recomputeSampled(b).then(() => {
      if (live() !== b) return;
      drawEntities(b);
      publish();
    });
    return;
  }
  recompute(b);
  drawEntities(b);
  publish();
}

function applyCursor(b: Binding): void {
  const canvas = b.handle.canvas;
  const placing = open && (!observer || !target);
  canvas.style.cursor = placing ? "crosshair" : b.previousCursor;
}

/** Which of the two points is under the pointer, if either. */
function pointAt(b: Binding, position: Cartesian2): "observer" | "target" | null {
  const picked = b.handle.scene.pick(position) as { id?: { id?: unknown } } | undefined;
  const id = picked?.id?.id;
  if (id === ENTITY_ID.observer) return "observer";
  if (id === ENTITY_ID.target) return "target";
  return null;
}

function onLeftDown(b: Binding, position: Cartesian2): void {
  if (b.dragging) return;
  const which = pointAt(b, position);
  if (!which) return;
  // Take the drag away from the camera: without this the globe pans under
  // the point. Restored when the button comes up, even mid-detach.
  const controller = b.handle.scene.screenSpaceCameraController;
  const previous = controller.enableInputs;
  controller.enableInputs = false;
  b.dragging = {
    which,
    restoreInputs: () => {
      if (!b.handle.viewer.isDestroyed()) controller.enableInputs = previous;
    },
  };
}

function onMouseMove(b: Binding, position: Cartesian2): void {
  if (!b.dragging) return;
  const { Cesium: C, viewer } = b.handle;
  const picked = pickGroundPosition(C, viewer, position);
  if (!picked) return;
  const ground = toLngLatAlt(C, picked);
  if (b.dragging.which === "observer") observer = ground;
  else target = ground;
  refresh(b);
}

function endDrag(b: Binding): void {
  const drag = b.dragging;
  b.dragging = null;
  drag?.restoreInputs();
}

function onClick(b: Binding, position: Cartesian2): void {
  const { Cesium: C, viewer } = b.handle;
  // A click on a placed point is the end of a drag or a missed grab, not a
  // new measurement.
  if (pointAt(b, position)) return;
  const picked = pickGroundPosition(C, viewer, position);
  if (!picked) return;
  const ground = toLngLatAlt(C, picked);
  if (!observer) {
    observer = ground;
  } else if (!target) {
    target = ground;
  } else {
    // A third click starts over from a new observer.
    observer = ground;
    target = null;
    result = null;
  }
  applyCursor(b);
  refresh(b);
}

function watchTiles(handle: CesiumSceneHandle, onSettled: () => void): () => void {
  const globe = handle.scene.globe;
  const event = globe?.tileLoadProgressEvent;
  if (!event) return () => {};
  const listener = (remaining: number) => {
    if (remaining === 0) onSettled();
  };
  event.addEventListener(listener);
  return () => event.removeEventListener(listener);
}

function attach(app: GeoLibreAppAPI): void {
  if (live()) return;
  const handle = primaryGlobe(app);
  if (!handle) return;
  const { Cesium: C, viewer } = handle;
  const handler = new C.ScreenSpaceEventHandler(viewer.canvas);
  const b: Binding = {
    handle,
    handler,
    entities: [],
    previousCursor: viewer.canvas.style.cursor,
    releaseTiles: () => {},
    dragging: null,
  };
  binding = b;
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    if (!open || live() !== b) return;
    onClick(b, movement.position);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  // Placed points can be dragged to a new spot, the way the old geoportal
  // let its measurement handles be moved.
  handler.setInputAction((movement: { position: Cartesian2 }) => {
    if (!open || live() !== b) return;
    onLeftDown(b, movement.position);
  }, C.ScreenSpaceEventType.LEFT_DOWN);
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
    if (live() !== b) return;
    onMouseMove(b, movement.endPosition);
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
  handler.setInputAction(() => {
    if (live() !== b) return;
    endDrag(b);
  }, C.ScreenSpaceEventType.LEFT_UP);
  // Terrain refines as tiles load, and `globe.pick` only sees loaded tiles,
  // so the answer is re-asked once loading settles rather than every frame.
  b.releaseTiles = watchTiles(handle, () => {
    if (live() !== b || !observer || !target) return;
    refresh(b);
  });
  applyCursor(b);
  refresh(b);
}

function detach(): void {
  const b = binding;
  binding = null;
  if (!b) return;
  b.releaseTiles();
  endDrag(b);
  if (!b.handle.viewer.isDestroyed()) {
    b.handle.canvas.style.cursor = b.previousCursor;
    removeEntities(b);
    b.handle.requestRender();
  }
  if (!b.handler.isDestroyed()) b.handler.destroy();
}

/** Open the panel and, when a globe is mounted, start listening for clicks. */
export function openLineOfSightPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  const b = live();
  if (b) applyCursor(b);
  publish();
}

/**
 * Close the panel. The points are kept so reopening — or a project reload —
 * shows the last sight line again; {@link clearLineOfSight} forgets them.
 */
export function closeLineOfSightPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

/** Forget both points and the result, ready for a new observer click. */
export function clearLineOfSight(): void {
  observer = null;
  target = null;
  result = null;
  const b = live();
  if (b) {
    applyCursor(b);
    drawEntities(b);
  }
  publish();
}

/** Merge a heights patch and re-run the test against the raised points. */
export function setLineOfSightSettings(patch: Partial<LineOfSightSettings>): void {
  const next = normalizeLineOfSightSettings({ ...settings, ...patch });
  if (settingsEqual(next, settings)) return;
  settings = next;
  const b = live();
  if (b) refresh(b);
  else publish();
}

/**
 * Re-bind after an engine mounts or is replaced. Switching the primary
 * renderer destroys the globe (and every entity on it) or brings one into
 * existence, so this is also how the tool comes alive when the user moves
 * from the 2D map to the globe with the panel already open.
 */
export function reattachLineOfSight(app: GeoLibreAppAPI): void {
  if (!open) return;
  const handle = primaryGlobe(app);
  const b = live();
  if (b && handle && b.handle.viewer === handle.viewer) return;
  detach();
  attach(app);
  publish();
}

/** Restore from a project file's saved state; `undefined` resets the tool. */
export function restoreLineOfSight(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeLineOfSightPanel(app);
    observer = null;
    target = null;
    result = null;
    settings = { ...DEFAULT_LINE_OF_SIGHT_SETTINGS };
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  settings = normalizeLineOfSightSettings(raw);
  observer = normalizePoint(raw.observer);
  target = observer ? normalizePoint(raw.target) : null;
  result = null;
  if (raw.open === true) {
    // Bind first so the restored points are drawn and tested on the globe.
    open = true;
    detach();
    attach(app);
    publish();
  } else {
    closeLineOfSightPanel(app);
  }
  return true;
}

/** The state worth persisting, or `undefined` when everything is at its default. */
export function getLineOfSightProjectState(): Record<string, unknown> | undefined {
  if (!open && !observer && settingsEqual(settings, DEFAULT_LINE_OF_SIGHT_SETTINGS)) {
    return undefined;
  }
  return {
    open,
    ...settings,
    ...(observer ? { observer } : {}),
    ...(target ? { target } : {}),
  };
}
