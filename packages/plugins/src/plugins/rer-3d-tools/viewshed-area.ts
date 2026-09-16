import type { Cartesian2, Entity, ScreenSpaceEventHandler } from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import {
  fromLngLatAlt,
  pickGroundPosition,
  raiseByMeters,
  toLngLatAlt,
  type LngLatAlt,
} from "./line-of-sight-geometry";
import {
  computeViewshed,
  gridExtent,
  rasterizeVisibility,
  sampleTerrainVisibilityGrid,
  visibleFraction,
  type TerrainVisibilityGrid,
} from "./viewshed-area-geometry";

/**
 * Visible area on the 3D globe (Controls → Viewshed area): click an observer
 * and the terrain that can be seen from there, within a radius, is tinted
 * green on the globe — the geoportal's viewshed *area* tool, the companion
 * of the line-of-sight one.
 *
 * Same shape as the line-of-sight tool: this module owns the globe work
 * (the click, the observer marker, the terrain read, the draped result) and
 * publishes a snapshot the app's React panel renders. The result is drawn
 * as a rectangle entity with an image material clamped to the terrain, not
 * an imagery layer, so it sits above every store layer no matter how the
 * layer sync reorders the imagery stack, and goes away with the other
 * entities on a renderer swap.
 */

export const VIEWSHED_AREA_TOOL_ID = "viewshed-area";

export interface ViewshedAreaSettings {
  /** Eye height above the clicked ground, in metres. */
  observerHeight: number;
  /** How far out the visibility is tested, in metres. */
  radiusMeters: number;
  /** Opacity of the tint over the visible ground (0–1). */
  opacity: number;
}

export const VIEWSHED_AREA_HEIGHT_MIN = 0;
export const VIEWSHED_AREA_HEIGHT_MAX = 10_000;
export const VIEWSHED_AREA_RADIUS_MIN = 100;
/** 15 km: past this the grid cells grow past 100 m and the sweep says little. */
export const VIEWSHED_AREA_RADIUS_MAX = 15_000;

export const DEFAULT_VIEWSHED_AREA_SETTINGS: ViewshedAreaSettings = Object.freeze({
  observerHeight: 1.7,
  radiusMeters: 2_000,
  opacity: 0.45,
});

/** Where the tool is: no globe, waiting for the observer click, or showing a result. */
export type ViewshedAreaPhase = "unavailable" | "observer" | "done";

/** What the terrain read is up to. */
export type ViewshedAreaStatus = "idle" | "computing" | "ready" | "no-terrain" | "failed";

export interface ViewshedAreaState {
  open: boolean;
  phase: ViewshedAreaPhase;
  /** The clicked ground position. */
  observer: LngLatAlt | null;
  settings: ViewshedAreaSettings;
  status: ViewshedAreaStatus;
  /** Share of the sampled ground that is visible, once computed. */
  visibleFraction: number | null;
  /** Metres per grid cell of the last result. */
  cellSizeMeters: number | null;
}

type CesiumNs = CesiumSceneHandle["Cesium"];

const ENTITY_ID = {
  observer: `geolibre-${VIEWSHED_AREA_TOOL_ID}-observer`,
  radius: `geolibre-${VIEWSHED_AREA_TOOL_ID}-radius`,
  area: `geolibre-${VIEWSHED_AREA_TOOL_ID}-area`,
} as const;

const OBSERVER_COLOR = "#f97316";
const VISIBLE_RGB: [number, number, number] = [34, 197, 94];
const RADIUS_COLOR = "#22c55e";
/** How long after the last edit (a drag settling) before the terrain is read. */
export const VIEWSHED_AREA_DEBOUNCE_MS = 200;

let open = false;
let observer: LngLatAlt | null = null;
let settings: ViewshedAreaSettings = { ...DEFAULT_VIEWSHED_AREA_SETTINGS };
let status: ViewshedAreaStatus = "idle";
let fraction: number | null = null;
let cellSize: number | null = null;
/** The last result's image and extent, so a redraw does not recompute. */
let result: {
  /** The painted visibility; `null` where no canvas can be made (a headless host). */
  image: HTMLCanvasElement | null;
  extent: [number, number, number, number];
} | null = null;
let computeRequest = 0;
let computeTimer: ReturnType<typeof setTimeout> | null = null;

interface Binding {
  handle: CesiumSceneHandle;
  handler: ScreenSpaceEventHandler;
  entities: Entity[];
  previousCursor: string;
  releaseTiles: () => void;
  dragging: { restoreInputs: () => void } | null;
}
let binding: Binding | null = null;

let snapshot: ViewshedAreaState = buildSnapshot();
const listeners = new Set<() => void>();

function buildSnapshot(): ViewshedAreaState {
  return {
    open,
    phase: !binding ? "unavailable" : !observer ? "observer" : "done",
    observer,
    settings,
    status,
    visibleFraction: fraction,
    cellSizeMeters: cellSize,
  };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribeViewshedArea(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getViewshedAreaSnapshot(): ViewshedAreaState {
  return snapshot;
}

export function isViewshedAreaPanelVisible(): boolean {
  return open;
}

export function normalizeViewshedAreaSettings(raw: unknown): ViewshedAreaSettings {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    observerHeight: clamp(
      source.observerHeight,
      DEFAULT_VIEWSHED_AREA_SETTINGS.observerHeight,
      VIEWSHED_AREA_HEIGHT_MIN,
      VIEWSHED_AREA_HEIGHT_MAX,
    ),
    radiusMeters: clamp(
      source.radiusMeters,
      DEFAULT_VIEWSHED_AREA_SETTINGS.radiusMeters,
      VIEWSHED_AREA_RADIUS_MIN,
      VIEWSHED_AREA_RADIUS_MAX,
    ),
    opacity: clamp(source.opacity, DEFAULT_VIEWSHED_AREA_SETTINGS.opacity, 0.05, 1),
  };
}

function normalizePoint(raw: unknown): LngLatAlt | null {
  if (!raw || typeof raw !== "object") return null;
  const { lng, lat, alt } = raw as Record<string, unknown>;
  if (typeof lng !== "number" || typeof lat !== "number") return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  return { lng, lat, alt: typeof alt === "number" && Number.isFinite(alt) ? alt : 0 };
}

function settingsEqual(a: ViewshedAreaSettings, b: ViewshedAreaSettings): boolean {
  return (
    a.observerHeight === b.observerHeight &&
    a.radiusMeters === b.radiusMeters &&
    a.opacity === b.opacity
  );
}

function primaryGlobe(app: GeoLibreAppAPI): CesiumSceneHandle | null {
  const scenes = app.getCesiumScenes?.();
  if (scenes) return scenes[0] ?? null;
  return app.getCesiumScene?.() ?? null;
}

function live(): Binding | null {
  if (!binding) return null;
  if (binding.handle.viewer.isDestroyed()) {
    binding = null;
    return null;
  }
  return binding;
}

function removeEntities(b: Binding): void {
  const { viewer } = b.handle;
  if (!viewer.isDestroyed()) for (const entity of b.entities) viewer.entities.remove(entity);
  b.entities = [];
}

/**
 * The observer marker, the radius ring, and — once computed — the visible
 * area draped on the terrain. Rebuilt whole on every change, like the other
 * tools' entities.
 */
function drawEntities(b: Binding): void {
  removeEntities(b);
  const { Cesium: C, viewer } = b.handle;
  if (viewer.isDestroyed()) return;
  if (observer) {
    b.entities.push(
      viewer.entities.add({
        id: ENTITY_ID.observer,
        position: raiseByMeters(C, fromLngLatAlt(C, observer), settings.observerHeight),
        point: {
          pixelSize: 14,
          color: C.Color.fromCssColorString(OBSERVER_COLOR),
          outlineColor: C.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    );
    b.entities.push(
      viewer.entities.add({
        id: ENTITY_ID.radius,
        position: C.Cartesian3.fromDegrees(observer.lng, observer.lat, 0),
        ellipse: {
          semiMajorAxis: settings.radiusMeters,
          semiMinorAxis: settings.radiusMeters,
          fill: false,
          outline: true,
          outlineColor: C.Color.fromCssColorString(RADIUS_COLOR).withAlpha(0.8),
          outlineWidth: 2,
          classificationType: C.ClassificationType.TERRAIN,
        },
      }),
    );
  }
  if (observer && result?.image) {
    const [west, south, east, north] = result.extent;
    b.entities.push(
      viewer.entities.add({
        id: ENTITY_ID.area,
        rectangle: {
          coordinates: C.Rectangle.fromDegrees(west, south, east, north),
          material: new C.ImageMaterialProperty({ image: result.image, transparent: true }),
          classificationType: C.ClassificationType.TERRAIN,
        },
      }),
    );
  }
  b.handle.requestRender();
}

/**
 * Read the terrain around the observer once the edits settle, sweep it,
 * paint the visible cells. A request counter drops a read that finishes
 * after a newer one started, so a drag never shows a stale area.
 */
function scheduleCompute(): void {
  if (computeTimer) clearTimeout(computeTimer);
  computeTimer = setTimeout(() => {
    computeTimer = null;
    void computeNow();
  }, VIEWSHED_AREA_DEBOUNCE_MS);
}

async function computeNow(): Promise<void> {
  const b = live();
  const request = ++computeRequest;
  if (!b || !observer) {
    result = null;
    fraction = null;
    cellSize = null;
    status = "idle";
    publish();
    return;
  }
  const { Cesium: C, viewer } = b.handle;
  const provider = viewer.isDestroyed() ? undefined : viewer.terrainProvider;
  if (!provider?.availability) {
    result = null;
    fraction = null;
    cellSize = null;
    status = "no-terrain";
    drawEntities(b);
    publish();
    return;
  }
  status = "computing";
  publish();
  const at = observer;
  const wanted = settings;
  let grid: TerrainVisibilityGrid;
  try {
    grid = await sampleTerrainVisibilityGrid(C, provider, at, wanted.radiusMeters);
  } catch {
    if (request !== computeRequest) return;
    status = "failed";
    publish();
    return;
  }
  if (request !== computeRequest) return;
  const ground = Number.isNaN(grid.groundHeightAtObserver) ? at.alt : grid.groundHeightAtObserver;
  const visibility = computeViewshed(grid, ground + wanted.observerHeight);
  const pixels = rasterizeVisibility(grid, visibility, [
    ...VISIBLE_RGB,
    Math.round(wanted.opacity * 255),
  ]);
  result = { image: paintVisibility(pixels), extent: gridExtent(C, at, grid) };
  fraction = visibleFraction(visibility);
  cellSize = grid.cellSize;
  status = "ready";
  const current = live();
  if (current) drawEntities(current);
  publish();
}

/** The visible cells as a canvas the rectangle material can show; `null` without a DOM. */
function paintVisibility(pixels: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof ImageData === "undefined") return null;
  const image = document.createElement("canvas");
  image.width = pixels.width;
  image.height = pixels.height;
  const context = image.getContext("2d");
  if (!context) return null;
  const data = new Uint8ClampedArray(pixels.data.length);
  data.set(pixels.data);
  context.putImageData(new ImageData(data, pixels.width, pixels.height), 0, 0);
  return image;
}

function applyCursor(b: Binding): void {
  b.handle.canvas.style.cursor = open && !observer ? "crosshair" : b.previousCursor;
}

function observerAt(b: Binding, position: Cartesian2): boolean {
  const picked = b.handle.scene.pick(position) as { id?: { id?: unknown } } | undefined;
  return picked?.id?.id === ENTITY_ID.observer;
}

function moveObserver(b: Binding, ground: LngLatAlt): void {
  observer = ground;
  result = null;
  fraction = null;
  cellSize = null;
  applyCursor(b);
  drawEntities(b);
  scheduleCompute();
  publish();
}

function onLeftDown(b: Binding, position: Cartesian2): void {
  if (b.dragging || !observerAt(b, position)) return;
  const controller = b.handle.scene.screenSpaceCameraController;
  const previous = controller.enableInputs;
  controller.enableInputs = false;
  b.dragging = {
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
  moveObserver(b, toLngLatAlt(C, picked));
}

function endDrag(b: Binding): void {
  const drag = b.dragging;
  b.dragging = null;
  drag?.restoreInputs();
}

function onClick(b: Binding, position: Cartesian2): void {
  const { Cesium: C, viewer } = b.handle;
  if (observerAt(b, position)) return;
  const picked = pickGroundPosition(C, viewer, position);
  if (!picked) return;
  // Every click places (or moves) the one observer.
  moveObserver(b, toLngLatAlt(C, picked));
}

function watchTiles(handle: CesiumSceneHandle, onSettled: () => void): () => void {
  const event = handle.scene.globe?.tileLoadProgressEvent;
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
  // The most detailed terrain the provider has is what the grid reads, so
  // unlike line of sight the result does not depend on the tiles in view —
  // but a globe that had no terrain at all when the click landed gets one
  // once terrain is switched on and its tiles arrive.
  b.releaseTiles = watchTiles(handle, () => {
    if (live() !== b || !observer || status !== "no-terrain") return;
    scheduleCompute();
  });
  applyCursor(b);
  drawEntities(b);
  if (observer && !result) scheduleCompute();
}

function detach(): void {
  const b = binding;
  binding = null;
  computeRequest += 1;
  if (computeTimer) clearTimeout(computeTimer);
  computeTimer = null;
  if (status === "computing") status = result ? "ready" : "idle";
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

/** Open the panel and, when a globe is mounted, start listening for the observer click. */
export function openViewshedAreaPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  const b = live();
  if (b) applyCursor(b);
  publish();
}

/** Close the panel; the observer and result are kept for a reopen. */
export function closeViewshedAreaPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

/** Forget the observer and its result. */
export function clearViewshedArea(): void {
  observer = null;
  result = null;
  fraction = null;
  cellSize = null;
  status = "idle";
  computeRequest += 1;
  if (computeTimer) clearTimeout(computeTimer);
  computeTimer = null;
  const b = live();
  if (b) {
    applyCursor(b);
    drawEntities(b);
  }
  publish();
}

/** Merge a settings patch; a new height or radius recomputes, a new opacity repaints. */
export function setViewshedAreaSettings(patch: Partial<ViewshedAreaSettings>): void {
  const next = normalizeViewshedAreaSettings({ ...settings, ...patch });
  if (settingsEqual(next, settings)) return;
  const recompute =
    next.observerHeight !== settings.observerHeight || next.radiusMeters !== settings.radiusMeters;
  settings = next;
  const b = live();
  if (recompute) {
    result = null;
    fraction = null;
    cellSize = null;
    if (b) drawEntities(b);
    if (b && observer) scheduleCompute();
  } else if (b && observer) {
    scheduleCompute();
  }
  publish();
}

/** Re-bind after an engine mounts or is replaced, redrawing and recomputing the kept observer. */
export function reattachViewshedArea(app: GeoLibreAppAPI): void {
  if (!open) return;
  const handle = primaryGlobe(app);
  const b = live();
  if (b && handle && b.handle.viewer === handle.viewer) return;
  detach();
  result = null;
  attach(app);
  publish();
}

/** Restore from a project file's saved state; `undefined` resets the tool. */
export function restoreViewshedArea(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeViewshedAreaPanel(app);
    observer = null;
    result = null;
    fraction = null;
    cellSize = null;
    status = "idle";
    settings = { ...DEFAULT_VIEWSHED_AREA_SETTINGS };
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  settings = normalizeViewshedAreaSettings(raw);
  observer = normalizePoint(raw.observer);
  result = null;
  fraction = null;
  cellSize = null;
  status = "idle";
  if (raw.open === true) {
    open = true;
    detach();
    attach(app);
    publish();
  } else {
    closeViewshedAreaPanel(app);
  }
  return true;
}

/** The state worth persisting, or `undefined` when everything is at its default. */
export function getViewshedAreaProjectState(): Record<string, unknown> | undefined {
  if (!open && !observer && settingsEqual(settings, DEFAULT_VIEWSHED_AREA_SETTINGS)) {
    return undefined;
  }
  return {
    open,
    ...settings,
    ...(observer ? { observer } : {}),
  };
}
