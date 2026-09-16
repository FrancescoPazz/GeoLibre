import { getElevationMeanSeaLevelDefault } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import { CesiumDrawing, DEFAULT_DRAW_OPTIONS, type DrawOptions } from "./draw-engine";
import {
  computeMeasures,
  figuresFromFeatures,
  type DrawGeometry,
  type DrawMeasures,
  type DrawMode,
  type PathHit,
} from "./draw-geometry";
import type { LngLatAlt } from "./line-of-sight-geometry";
import {
  buildMultiPathFeatureCollection,
  measureFileStem,
  measureProfileCsv,
  measureSummaryText,
  type MeasurePath,
} from "./measure-export";
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
 * ground distance, export) build on — those read the same
 * {@link DrawGeometry}.
 *
 * A measurement can hold several paths (the geoportal's "percorsi
 * multipli"): one is active — drawn with its vertices and labels, edited by
 * the pointer, sampled, played by Play Path — and the others sit behind it
 * as thin lines. The module keeps the active path in its working variables
 * and mirrors them into `paths[activePath]` on every publish, so the panel
 * and the export functions see one list.
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
  /** Report heights above mean sea level (EGM96) rather than the ellipsoid. */
  heightsAboveSeaLevel: boolean;
  /** Whether the host has supplied a geoid, so the toggle can do anything. */
  geoidAvailable: boolean;
  /** Free text the user attaches to the active path; goes into the summary and the layer. */
  notes: string;
  /** How many paths the measurement holds (always ≥ 1). */
  pathCount: number;
  /** Which of them is being edited. */
  activePath: number;
  /** The name of the layer the active path was loaded from, if it was. */
  sourceName: string | null;
}

/** How long after the last edit (a drag settling) before the terrain is read. */
export const PROFILE_SAMPLING_DEBOUNCE_MS = 200;

/** One path of the measurement as the module stores it. */
interface StoredPath extends MeasurePath {
  sourceName: string | null;
}

let open = false;
let mode: DrawMode = "line";
let options: DrawOptions = { ...DEFAULT_DRAW_OPTIONS };
let geometry: DrawGeometry = { mode, points: [], closed: false };
let drawing: CesiumDrawing | null = null;
let cesium: CesiumSceneHandle["Cesium"] | null = null;
/** The host API the panel was opened with, for actions that create layers or files. */
let hostApp: GeoLibreAppAPI | null = null;
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
let heightsAboveSeaLevel = getElevationMeanSeaLevelDefault();
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

let notes = "";
let sourceName: string | null = null;
/** Every path; `paths[activePath]` mirrors the working variables above. */
let paths: StoredPath[] = [emptyPath()];
let activePath = 0;
/**
 * Set while the engine is being handed a stored path, so the change it
 * reports back keeps that path's profile instead of dropping it for a
 * resample.
 */
let restoringGeometry = false;

function emptyPath(): StoredPath {
  return {
    geometry: { mode, points: [], closed: false },
    measures: EMPTY_MEASURES,
    profile: null,
    notes: "",
    sourceName: null,
  };
}

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
    heightsAboveSeaLevel,
    geoidAvailable: geoid !== undefined,
    notes,
    pathCount: paths.length,
    activePath,
    sourceName,
  };
}

/** Write the working path back into the list, then tell the listeners. */
function publish(): void {
  paths[activePath] = { geometry, measures, profile, notes, sourceName };
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

/** Every path of the measurement, the active one included, in order. */
export function getMeasure3dPaths(): readonly MeasurePath[] {
  paths[activePath] = { geometry, measures, profile, notes, sourceName };
  return paths;
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
    geoid: heightsAboveSeaLevel ? geoid : undefined,
  });
  // Switching path bumps the counter too, so a read for a path that is no
  // longer the working one is dropped here as well.
  if (request !== samplingRequest) return;
  profile = result;
  sampling = false;
  if (hoverSample !== null && hoverSample >= result.samples.length) hoverSample = null;
  publish();
}

function onDrawingChange(next: DrawGeometry, nextMeasures: DrawMeasures): void {
  geometry = next;
  measures = nextMeasures;
  if (restoringGeometry) {
    // A stored path handed back to the engine: its profile still describes
    // it, and the caller publishes once the hand-over is complete.
    return;
  }
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

/**
 * The pointer moved along the drawn path on the globe: light up the profile
 * sample it is over, so the chart follows the map as the map follows the
 * chart.
 */
function onDrawingHover(hit: PathHit | null): void {
  if (!profile || hit === null) {
    if (hoverSample !== null) setMeasure3dHover(null);
    return;
  }
  const from = profile.stopIndex[hit.segment];
  const to = profile.stopIndex[hit.segment + 1];
  if (from === undefined || to === undefined) return;
  setMeasure3dHover(from + Math.round(hit.t * (to - from)));
}

/** Supply (or clear) the geoid the host wants heights referred to. */
export function setMeasure3dGeoid(next: GeoidHeights | undefined): void {
  geoid = next;
  if (profilable(geometry) && heightsAboveSeaLevel) scheduleSampling();
  else publish();
}

/** Refer heights to mean sea level (needs a geoid) or to the ellipsoid. */
export function setMeasure3dHeightsAboveSeaLevel(enabled: boolean): void {
  if (enabled === heightsAboveSeaLevel) return;
  heightsAboveSeaLevel = enabled;
  if (profilable(geometry)) scheduleSampling();
  else publish();
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

/** Attach a note to the active path (the summary and the saved layer carry it). */
export function setMeasure3dNotes(text: string): void {
  if (text === notes) return;
  notes = text;
  publish();
}

/**
 * Set a circle's radius by number: the edge vertex moves along the geodesic
 * from the centre through the current edge (due east when there is none)
 * to `meters` away, so the readout agrees with what was typed.
 */
export function setMeasure3dCircleRadius(meters: number): void {
  const C = cesium;
  const centre = geometry.points[0];
  if (mode !== "circle" || !C || !centre || !Number.isFinite(meters) || meters <= 0) return;
  const edge = geometry.points[1] ?? { lng: centre.lng + 1e-3, lat: centre.lat, alt: centre.alt };
  const geodesic = new C.EllipsoidGeodesic(
    C.Cartographic.fromDegrees(centre.lng, centre.lat),
    C.Cartographic.fromDegrees(edge.lng, edge.lat),
    C.Ellipsoid.WGS84,
  );
  const carto = geodesic.interpolateUsingSurfaceDistance(meters, new C.Cartographic());
  const next: DrawGeometry = {
    mode,
    points: [
      centre,
      {
        lng: C.Math.toDegrees(carto.longitude),
        lat: C.Math.toDegrees(carto.latitude),
        alt: centre.alt,
      },
    ],
    closed: false,
  };
  const d = liveDrawing();
  if (d) {
    d.setGeometry(next);
    return;
  }
  geometry = next;
  measures = cesium ? computeMeasures(cesium, next) : EMPTY_MEASURES;
  publish();
}

/** Hand `next` to the engine as the working figure, keeping the profile; the caller publishes. */
function handToEngine(next: DrawGeometry): void {
  const d = liveDrawing();
  if (d) {
    restoringGeometry = true;
    try {
      d.setGeometry(next);
    } finally {
      restoringGeometry = false;
    }
    return;
  }
  geometry = next;
  measures = cesium ? computeMeasures(cesium, next) : EMPTY_MEASURES;
}

/** Show every path but the active one behind it. */
function syncBackground(): void {
  liveDrawing()?.setBackgroundFigures(
    paths.filter((_, i) => i !== activePath).map((p) => p.geometry),
  );
}

/** Take `paths[index]` as the working path and show it; `index` must be valid. */
function activatePath(index: number): void {
  activePath = index;
  const target = paths[index];
  geometry = target.geometry;
  measures = target.measures;
  profile = target.profile;
  notes = target.notes;
  sourceName = target.sourceName;
  hoverSample = null;
  liveDrawing()?.setMarker(null);
  samplingRequest += 1;
  if (samplingTimer) clearTimeout(samplingTimer);
  samplingTimer = null;
  sampling = false;
  syncBackground();
  handToEngine(geometry);
  if (!profile && profilable(geometry)) scheduleSampling();
  publish();
}

/** Make `index` the path being edited. */
export function setMeasure3dActivePath(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= paths.length || index === activePath)
    return;
  paths[activePath] = { geometry, measures, profile, notes, sourceName };
  activatePath(index);
}

/** Start another, empty path in the current mode and make it the active one. */
export function addMeasure3dPath(): void {
  paths[activePath] = { geometry, measures, profile, notes, sourceName };
  paths.push(emptyPath());
  activatePath(paths.length - 1);
}

/** Drop the active path; the one after it (or the last) takes its place. A lone path is cleared instead. */
export function removeMeasure3dPath(): void {
  if (paths.length <= 1) {
    clearMeasure3d();
    return;
  }
  paths.splice(activePath, 1);
  activatePath(Math.min(activePath, paths.length - 1));
}

function attach(app: GeoLibreAppAPI): void {
  if (liveDrawing()) return;
  const handle = primaryGlobe(app);
  if (!handle) return;
  cesium = handle.Cesium;
  drawing = new CesiumDrawing(handle, options, onDrawingChange);
  drawing.setHoverListener(onDrawingHover);
  syncBackground();
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
  hostApp = app;
  attach(app);
  publish();
}

/** Close the panel, keeping the figure so reopening shows it again. */
export function closeMeasure3dPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

/** Switch mode; every path is discarded, since a path belongs to the mode it was drawn in. */
export function setMeasure3dMode(next: DrawMode): void {
  if (next === mode && geometry.points.length === 0 && paths.length === 1) return;
  mode = next;
  geometry = { mode, points: [], closed: false };
  measures = EMPTY_MEASURES;
  profile = null;
  hoverSample = null;
  notes = "";
  sourceName = null;
  paths = [emptyPath()];
  activePath = 0;
  const d = liveDrawing();
  if (d) {
    d.setBackgroundFigures([]);
    d.setMode(next);
  } else publish();
}

export function setMeasure3dOptions(patch: Partial<DrawOptions>): void {
  options = { ...options, ...patch };
  liveDrawing()?.setOptions(patch);
  publish();
}

/** Empty the active path (the other paths stay). */
export function clearMeasure3d(): void {
  geometry = { mode, points: [], closed: false };
  measures = EMPTY_MEASURES;
  profile = null;
  hoverSample = null;
  notes = "";
  sourceName = null;
  const d = liveDrawing();
  if (d) d.clear();
  else publish();
}

/**
 * Load the paths a layer's features make (see {@link figuresFromFeatures})
 * as the measurement — every line as a path of its own, the first active —
 * and open the panel. Returns how many paths were loaded; 0 leaves the
 * tool as it was.
 */
export function loadMeasure3dPathFromFeatures(
  app: GeoLibreAppAPI,
  features: ReadonlyArray<{ geometry?: unknown } | null | undefined>,
  options_: { sourceName?: string } = {},
): number {
  const figures = figuresFromFeatures(features);
  if (figures.length === 0) return 0;
  hostApp = app;
  const nextMode = figures[0].mode;
  mode = nextMode;
  paths = figures.map((figure) => ({
    geometry: figure,
    measures: cesium ? computeMeasures(cesium, figure) : EMPTY_MEASURES,
    profile: null,
    notes: "",
    sourceName: options_.sourceName ?? null,
  }));
  activePath = 0;
  const first = paths[0];
  geometry = first.geometry;
  measures = first.measures;
  profile = null;
  notes = "";
  sourceName = first.sourceName;
  hoverSample = null;
  open = true;
  const d = liveDrawing();
  if (d) {
    // Mode first (it clears the engine's figure), then the loaded one; the
    // engine's reports are swallowed on the way so the working path stays.
    restoringGeometry = true;
    try {
      d.setMode(nextMode);
    } finally {
      restoringGeometry = false;
    }
    syncBackground();
    handToEngine(first.geometry);
    if (profilable(geometry)) scheduleSampling();
    publish();
  } else {
    attach(app);
    publish();
  }
  return figures.length;
}

/** Re-bind after an engine mounts or is replaced, redrawing the kept figure. */
export function reattachMeasure3d(app: GeoLibreAppAPI): void {
  if (!open) return;
  hostApp = app;
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

/**
 * Add the measurement to the project as a GeoJSON layer — every path's
 * figure, its vertices with per-segment distances, and the sampled profile —
 * so it can be styled, exported in any format and saved with the project.
 * Returns the new layer's id, or null when there is nothing to save.
 */
export function saveMeasure3dAsLayer(name: string): string | null {
  const C = cesium;
  if (!hostApp || !C) return null;
  const collection = buildMultiPathFeatureCollection(C, getMeasure3dPaths());
  if (collection.features.length === 0) return null;
  return hostApp.addGeoJsonLayer(name, collection);
}

/** The plain-text summary of the active path, or null when there is none. */
export function measure3dSummary(name: string): string | null {
  const C = cesium;
  if (!C || geometry.points.length === 0) return null;
  const text = measureSummaryText(C, name, geometry, measures, profile, notes);
  return paths.length > 1 ? `${text}\npath: ${activePath + 1} of ${paths.length}` : text;
}

/** Download the summary as `<name>_summary.txt` through the host. */
export function exportMeasure3dSummary(name: string): boolean {
  const text = measure3dSummary(name);
  if (!text || !hostApp?.exportTextFile) return false;
  hostApp.exportTextFile(`${measureFileStem(name)}_summary.txt`, text, { mimeType: "text/plain" });
  return true;
}

/** The active path's terrain samples as CSV, or null while there is no profile. */
export function measure3dProfileCsv(): string | null {
  return profile && profile.samples.length > 0 ? measureProfileCsv(profile) : null;
}

/** Download the profile samples as `<name>_profile.csv` through the host. */
export function exportMeasure3dProfileCsv(name: string): boolean {
  const csv = measure3dProfileCsv();
  if (!csv || !hostApp?.exportTextFile) return false;
  hostApp.exportTextFile(`${measureFileStem(name)}_profile.csv`, csv, { mimeType: "text/csv" });
  return true;
}

function resetToDefaults(): void {
  mode = "line";
  options = { ...DEFAULT_DRAW_OPTIONS };
  geometry = { mode, points: [], closed: false };
  measures = EMPTY_MEASURES;
  profile = null;
  notes = "";
  sourceName = null;
  paths = [emptyPath()];
  activePath = 0;
  samplingStepAuto = true;
  samplingStepManual = 0;
  samplingStepM = SAMPLING_STEP_DISABLED;
  stepRange = [0, 0];
  heightsAboveSeaLevel = getElevationMeanSeaLevelDefault();
}

function normalizeStoredPath(raw: unknown, pathMode: DrawMode): StoredPath | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const points = normalizePoints(source.points);
  const g: DrawGeometry = {
    mode: pathMode,
    points,
    closed: pathMode === "polygon" && source.closed === true && points.length >= 3,
  };
  return {
    geometry: g,
    measures: cesium ? computeMeasures(cesium, g) : EMPTY_MEASURES,
    profile: null,
    notes: typeof source.notes === "string" ? source.notes : "",
    sourceName: typeof source.sourceName === "string" ? source.sourceName : null,
  };
}

/** Restore from a project file's saved state; `undefined` resets the tool. */
export function restoreMeasure3d(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeMeasure3dPanel(app);
    resetToDefaults();
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  hostApp = app;
  mode = normalizeMode(raw.mode);
  options = normalizeDrawOptions(raw);
  // The current shape is a `paths` list; an earlier file holds one path as
  // top-level `points`/`closed`.
  const stored = Array.isArray(raw.paths)
    ? raw.paths.map((p) => normalizeStoredPath(p, mode)).filter((p): p is StoredPath => p !== null)
    : [];
  paths = stored.length > 0 ? stored : [normalizeStoredPath(raw, mode) ?? emptyPath()];
  activePath =
    typeof raw.activePath === "number" && Number.isInteger(raw.activePath)
      ? Math.min(Math.max(0, raw.activePath), paths.length - 1)
      : 0;
  const active = paths[activePath];
  geometry = active.geometry;
  measures = active.measures;
  profile = null;
  notes = active.notes;
  sourceName = active.sourceName;
  samplingStepAuto = raw.samplingStepAuto !== false;
  heightsAboveSeaLevel =
    typeof raw.meanSeaLevel === "boolean" ? raw.meanSeaLevel : getElevationMeanSeaLevelDefault();
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
  const all = getMeasure3dPaths() as readonly StoredPath[];
  if (
    !open &&
    all.length === 1 &&
    geometry.points.length === 0 &&
    !notes &&
    mode === "line" &&
    defaultOptions &&
    samplingStepAuto &&
    heightsAboveSeaLevel === getElevationMeanSeaLevelDefault()
  ) {
    return undefined;
  }
  return {
    open,
    mode,
    ...options,
    // The active path at the top level too, so a build that predates
    // multi-path measurements still finds its figure.
    points: geometry.points,
    closed: geometry.closed,
    ...(notes ? { notes } : {}),
    paths: all.map((p) => ({
      points: p.geometry.points,
      closed: p.geometry.closed,
      ...(p.notes ? { notes: p.notes } : {}),
      ...(p.sourceName ? { sourceName: p.sourceName } : {}),
    })),
    activePath,
    samplingStepAuto,
    ...(samplingStepAuto ? {} : { samplingStep: samplingStepManual }),
    meanSeaLevel: heightsAboveSeaLevel,
  };
}
