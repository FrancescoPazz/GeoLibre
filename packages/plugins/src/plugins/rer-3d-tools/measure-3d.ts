import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import { CesiumDrawing, DEFAULT_DRAW_OPTIONS, type DrawOptions } from "./draw-engine";
import {
  computeMeasures,
  type DrawGeometry,
  type DrawMeasures,
  type DrawMode,
} from "./draw-geometry";
import type { LngLatAlt } from "./line-of-sight-geometry";

/**
 * 3D measuring on the globe (Controls → 3D Measure): draw a line, polygon,
 * points, an angle or a circle on the terrain and read geodesic lengths,
 * areas, angles and radii off the map and the panel.
 *
 * Same shape as the line-of-sight tool: this module owns the drawing engine
 * and publishes a snapshot the app's React panel renders. It is the
 * interaction layer the terrain-sampled measurements (elevation profile,
 * ground distance, export) will build on — those read the same
 * {@link DrawGeometry}.
 */

export const MEASURE_3D_TOOL_ID = "measure-3d";

export const DRAW_MODES: readonly DrawMode[] = ["line", "polygon", "point", "angle", "circle"];

export interface Measure3dState {
  open: boolean;
  /** `false` while no primary globe is mounted (the 2D map is primary). */
  bound: boolean;
  mode: DrawMode;
  options: DrawOptions;
  geometry: DrawGeometry;
  measures: DrawMeasures;
}

let open = false;
let mode: DrawMode = "line";
let options: DrawOptions = { ...DEFAULT_DRAW_OPTIONS };
let geometry: DrawGeometry = { mode, points: [], closed: false };
let drawing: CesiumDrawing | null = null;
let cesium: CesiumSceneHandle["Cesium"] | null = null;

const EMPTY_MEASURES: DrawMeasures = Object.freeze({
  segmentMeters: [],
  totalMeters: 0,
  areaSqm: null,
  angleDeg: null,
  circleRadiusMeters: null,
  circlePerimeterMeters: null,
  circleAreaSqm: null,
});
let measures: DrawMeasures = EMPTY_MEASURES;

let snapshot: Measure3dState = buildSnapshot();
const listeners = new Set<() => void>();

function buildSnapshot(): Measure3dState {
  return { open, bound: liveDrawing() !== null, mode, options, geometry, measures };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribeMeasure3d(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getMeasure3dSnapshot(): Measure3dState {
  return snapshot;
}

export function isMeasure3dPanelVisible(): boolean {
  return open;
}

function primaryGlobe(app: GeoLibreAppAPI): CesiumSceneHandle | null {
  const globe = app.getCesiumScene?.() ?? null;
  return globe?.primary ? globe : null;
}

function liveDrawing(): CesiumDrawing | null {
  if (drawing && !drawing.isLive()) {
    // The widget went away under us (renderer swap); the entities went with it.
    drawing = null;
  }
  return drawing;
}

function onDrawingChange(next: DrawGeometry, nextMeasures: DrawMeasures): void {
  geometry = next;
  measures = nextMeasures;
  publish();
}

function attach(app: GeoLibreAppAPI): void {
  if (liveDrawing()) return;
  const handle = primaryGlobe(app);
  if (!handle) return;
  cesium = handle.Cesium;
  drawing = new CesiumDrawing(handle, options, onDrawingChange);
  // Restore whatever figure the store holds (a reopened panel, a loaded project).
  drawing.setGeometry({ ...geometry, mode });
}

function detach(): void {
  const current = drawing;
  drawing = null;
  current?.destroy();
}

export function openMeasure3dPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  publish();
}

/** Close the panel, keeping the figure so reopening shows it again. */
export function closeMeasure3dPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

export function setMeasure3dMode(next: DrawMode): void {
  if (next === mode && geometry.points.length === 0) return;
  mode = next;
  geometry = { mode, points: [], closed: false };
  measures = EMPTY_MEASURES;
  const d = liveDrawing();
  if (d) d.setMode(next);
  else publish();
}

export function setMeasure3dOptions(patch: Partial<DrawOptions>): void {
  options = { ...options, ...patch };
  liveDrawing()?.setOptions(patch);
  publish();
}

export function clearMeasure3d(): void {
  geometry = { mode, points: [], closed: false };
  measures = EMPTY_MEASURES;
  const d = liveDrawing();
  if (d) d.clear();
  else publish();
}

/** Re-bind after an engine mounts or is replaced, redrawing the kept figure. */
export function reattachMeasure3d(app: GeoLibreAppAPI): void {
  if (!open) return;
  const handle = primaryGlobe(app);
  const d = liveDrawing();
  if (d && handle && d.drives(handle.viewer)) return;
  detach();
  attach(app);
  publish();
}

function normalizeMode(raw: unknown): DrawMode {
  return typeof raw === "string" && (DRAW_MODES as readonly string[]).includes(raw)
    ? (raw as DrawMode)
    : "line";
}

function normalizePoints(raw: unknown): LngLatAlt[] {
  if (!Array.isArray(raw)) return [];
  const out: LngLatAlt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { lng, lat, alt } = item as Record<string, unknown>;
    if (typeof lng !== "number" || typeof lat !== "number") continue;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lat) > 90) continue;
    out.push({ lng, lat, alt: typeof alt === "number" && Number.isFinite(alt) ? alt : 0 });
  }
  return out;
}

export function normalizeDrawOptions(raw: unknown): DrawOptions {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    clampToGround:
      typeof source.clampToGround === "boolean"
        ? source.clampToGround
        : DEFAULT_DRAW_OPTIONS.clampToGround,
    showLabels:
      typeof source.showLabels === "boolean" ? source.showLabels : DEFAULT_DRAW_OPTIONS.showLabels,
  };
}

/** Restore from a project file's saved state; `undefined` resets the tool. */
export function restoreMeasure3d(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeMeasure3dPanel(app);
    mode = "line";
    options = { ...DEFAULT_DRAW_OPTIONS };
    geometry = { mode, points: [], closed: false };
    measures = EMPTY_MEASURES;
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  mode = normalizeMode(raw.mode);
  options = normalizeDrawOptions(raw);
  const points = normalizePoints(raw.points);
  geometry = {
    mode,
    points,
    closed: mode === "polygon" && raw.closed === true && points.length >= 3,
  };
  measures = cesium ? computeMeasures(cesium, geometry) : EMPTY_MEASURES;
  if (raw.open === true) {
    open = true;
    detach();
    attach(app);
    publish();
  } else {
    closeMeasure3dPanel(app);
  }
  return true;
}

/** The state worth persisting, or `undefined` when everything is at its default. */
export function getMeasure3dProjectState(): Record<string, unknown> | undefined {
  const defaultOptions =
    options.clampToGround === DEFAULT_DRAW_OPTIONS.clampToGround &&
    options.showLabels === DEFAULT_DRAW_OPTIONS.showLabels;
  if (!open && geometry.points.length === 0 && mode === "line" && defaultOptions) return undefined;
  return {
    open,
    mode,
    ...options,
    points: geometry.points,
    closed: geometry.closed,
  };
}
