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
import {
  SAMPLING_STEP_DISABLED,
  buildTerrainProfile,
  profileSamplingStep,
  samplingStepRange,
  snapSamplingStep,
  type GeoidHeights,
  type TerrainProfile,
} from "./terrain-profile";

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
  /** The terrain-sampled path (lines and polygons with two or more vertices). */
  profile: TerrainProfile | null;
  /** A terrain read is in flight. */
  sampling: boolean;
  /** Whether the sampling step follows the path length and zoom. */
  samplingStepAuto: boolean;
  /** The step in use, in metres; 0 walks the vertices only. */
  samplingStepM: number;
  /** The steps worth offering for the current path. */
  samplingStepRange: [number, number];
  /** Index into `profile.samples` under the pointer on the chart. */
  hoverSample: number | null;
}

/** How long after the last edit (a drag settling) before the terrain is read. */
export const PROFILE_SAMPLING_DEBOUNCE_MS = 200;

let open = false;
let mode: DrawMode = "line";
let options: DrawOptions = { ...DEFAULT_DRAW_OPTIONS };
let geometry: DrawGeometry = { mode, points: [], closed: false };
let drawing: CesiumDrawing | null = null;
let cesium: CesiumSceneHandle["Cesium"] | null = null;
let profile: TerrainProfile | null = null;
let sampling = false;
let samplingStepAuto = true;
let samplingStepManual = 0;
let samplingStepM = SAMPLING_STEP_DISABLED;
let stepRange: [number, number] = [0, 0];
let hoverSample: number | null = null;
let samplingRequest = 0;
let samplingTimer: ReturnType<typeof setTimeout> | null = null;
/** Geoid undulations to subtract, for heights above mean sea level; set by the host. */
let geoid: GeoidHeights | undefined;

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
  return {
    open,
    bound: liveDrawing() !== null,
    mode,
    options,
    geometry,
    measures,
    profile,
    sampling,
    samplingStepAuto,
    samplingStepM,
    samplingStepRange: stepRange,
    hoverSample,
  };
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

function profilable(g: DrawGeometry): boolean {
  return (g.mode === "line" || g.mode === "polygon") && g.points.length >= 2;
}

/** The step to walk the current path at: manual, or blended from length and zoom. */
function resolveSamplingStep(): number {
  const pathLength = measures.totalMeters;
  stepRange = samplingStepRange(pathLength);
  if (!samplingStepAuto) {
    const [min, max] = stepRange;
    if (samplingStepManual === SAMPLING_STEP_DISABLED) return SAMPLING_STEP_DISABLED;
    return min
      ? Math.min(max, Math.max(min, snapSamplingStep(samplingStepManual)))
      : samplingStepManual;
  }
  return profileSamplingStep(pathLength, liveDrawing()?.metersPerPixel());
}

/**
 * Read the terrain along the path after the edits settle. A request counter
 * discards a read that finishes after a newer one started, so a drag never
 * publishes a stale profile over a fresh one.
 */
function scheduleSampling(): void {
  if (samplingTimer) clearTimeout(samplingTimer);
  samplingTimer = setTimeout(() => {
    samplingTimer = null;
    void sampleNow();
  }, PROFILE_SAMPLING_DEBOUNCE_MS);
}

async function sampleNow(): Promise<void> {
  const d = liveDrawing();
  const C = cesium;
  const request = ++samplingRequest;
  if (!d || !C || !profilable(geometry)) {
    profile = null;
    sampling = false;
    hoverSample = null;
    d?.setMarker(null);
    publish();
    return;
  }
  samplingStepM = resolveSamplingStep();
  sampling = true;
  publish();
  const snapshotGeometry = geometry;
  const result = await buildTerrainProfile(C, d.getTerrainProvider(), snapshotGeometry.points, {
    stepMeters: samplingStepM,
    closed: snapshotGeometry.closed,
    geoid,
  });
  if (request !== samplingRequest) return;
  profile = result;
  sampling = false;
  if (hoverSample !== null && hoverSample >= result.samples.length) hoverSample = null;
  publish();
}

function onDrawingChange(next: DrawGeometry, nextMeasures: DrawMeasures): void {
  geometry = next;
  measures = nextMeasures;
  if (profilable(next)) {
    scheduleSampling();
  } else {
    profile = null;
    hoverSample = null;
    samplingRequest += 1;
    if (samplingTimer) clearTimeout(samplingTimer);
    samplingTimer = null;
  }
  publish();
}

/** Supply (or clear) the geoid the host wants heights referred to. */
export function setMeasure3dGeoid(next: GeoidHeights | undefined): void {
  geoid = next;
  if (profilable(geometry)) scheduleSampling();
}

/** Choose the sampling step by hand (snapped to the series), or hand it back to auto. */
export function setMeasure3dSamplingStep(step: number | "auto"): void {
  if (step === "auto") {
    samplingStepAuto = true;
  } else {
    samplingStepAuto = false;
    samplingStepManual =
      Number.isFinite(step) && step > 0 ? snapSamplingStep(step) : SAMPLING_STEP_DISABLED;
  }
  if (profilable(geometry)) scheduleSampling();
  else publish();
}

/** Highlight a profile sample on the globe (the chart's hover), or clear it. */
export function setMeasure3dHover(index: number | null): void {
  const next =
    index !== null && profile && index >= 0 && index < profile.samples.length ? index : null;
  if (next === hoverSample) return;
  hoverSample = next;
  const sample = next !== null && profile ? profile.samples[next] : null;
  liveDrawing()?.setMarker(sample ? { lng: sample.lng, lat: sample.lat, alt: sample.alt } : null);
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
  samplingRequest += 1;
  if (samplingTimer) clearTimeout(samplingTimer);
  samplingTimer = null;
  sampling = false;
  hoverSample = null;
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
  profile = null;
  hoverSample = null;
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
  profile = null;
  hoverSample = null;
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
    profile = null;
    samplingStepAuto = true;
    samplingStepManual = 0;
    samplingStepM = SAMPLING_STEP_DISABLED;
    stepRange = [0, 0];
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
  profile = null;
  samplingStepAuto = raw.samplingStepAuto !== false;
  samplingStepManual =
    typeof raw.samplingStep === "number" &&
    Number.isFinite(raw.samplingStep) &&
    raw.samplingStep > 0
      ? snapSamplingStep(raw.samplingStep)
      : SAMPLING_STEP_DISABLED;
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
  if (
    !open &&
    geometry.points.length === 0 &&
    mode === "line" &&
    defaultOptions &&
    samplingStepAuto
  ) {
    return undefined;
  }
  return {
    open,
    mode,
    ...options,
    points: geometry.points,
    closed: geometry.closed,
    samplingStepAuto,
    ...(samplingStepAuto ? {} : { samplingStep: samplingStepManual }),
  };
}
