import type { Cartesian3 } from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import { geodesicMeters } from "./draw-geometry";
import { fromLngLatAlt, type LngLatAlt } from "./line-of-sight-geometry";
import { getMeasure3dSnapshot, subscribeMeasure3d } from "./measure-3d";
import {
  SAMPLING_STEP_DISABLED,
  flightSamplingStep,
  samplingStepRange,
  snapSamplingStep,
} from "./terrain-profile";

/**
 * Play Path: fly the camera along the path drawn with 3D Measure, as a
 * guided tour of the terrain it crosses.
 *
 * The path is resampled at a flight step (the geoportal's zoom-weighted
 * heuristic, or a step picked by hand) with heights interpolated between
 * the vertices, so the camera follows the ground. At each sample the camera
 * flies to a spot behind it — along the heading to the next sample, at the
 * distance and pitch the view had when play was pressed — then waits for
 * the terrain tiles to settle before moving on, so the flight never runs
 * ahead of what is drawn. Playback starts after a short countdown, from
 * whichever end of the path the camera is nearer; it can be paused and
 * resumed from the same sample, and stopping flies back to the start.
 *
 * Same shape as the other 3D tools: the module owns the camera work and
 * publishes a snapshot; the app's React panel renders it.
 */

export const PLAY_PATH_TOOL_ID = "play-path";

export const PLAY_SPEED_MIN = 0.25;
export const PLAY_SPEED_MAX = 4;
export const DEFAULT_PLAY_SPEED = 1;
/** Seconds one sample-to-sample flight takes at speed 1. */
export const PLAY_STEP_SECONDS = 2;
/** Seconds the stop flight back to the start takes at speed 1. */
export const PLAY_RETURN_SECONDS = 3;
/** Seconds from pressing play to the first move. */
export const PLAY_COUNTDOWN_SECONDS = 3;
/** The view must look down at least this much for the flight to read well. */
export const DEFAULT_PITCH_THRESHOLD_DEG = 30;
/** Never look at a sample from closer than this, whatever the view was. */
export const PLAY_MIN_RANGE_METERS = 50;
/** Never look at a sample from farther than this, whatever the view was. */
export const PLAY_MAX_RANGE_METERS = 50_000;
/** Profile samples must start/end near the drawn vertices or they are ignored. */
export const PLAY_PATH_PROFILE_VERTEX_TOLERANCE_M = 500;
/** If the camera is farther than this from the path, profile samples are not trusted. */
export const PLAY_PATH_CAMERA_SANITY_METERS = 500_000;

export interface PlayPathState {
  open: boolean;
  /** \`false\` while no primary globe is mounted. */
  bound: boolean;
  /** The 3D Measure figure is a path with at least two samples. */
  available: boolean;
  playing: boolean;
  /** Paused mid-way: play resumes from `currentIndex`. */
  paused: boolean;
  /** Seconds left before the first move, while counting down. */
  countdown: number | null;
  currentIndex: number;
  pointCount: number;
  reverse: boolean;
  speed: number;
  samplingStepAuto: boolean;
  samplingStepM: number;
  samplingStepRange: [number, number];
  /** The view looks too flat for a path flight; a hint, not a block. */
  pitchTooLow: boolean;
}

/** Timings, overridable so tests need not wait real seconds. */
export interface PlayPathTiming {
  countdownTickMs: number;
  tileSettleTimeoutMs: number;
}
let timing: PlayPathTiming = { countdownTickMs: 1000, tileSettleTimeoutMs: 8000 };
export function setPlayPathTiming(next: Partial<PlayPathTiming>): void {
  timing = { ...timing, ...next };
}

let open = false;
let handle: CesiumSceneHandle | null = null;
let speed = DEFAULT_PLAY_SPEED;
let samplingStepAuto = true;
let samplingStepManual = SAMPLING_STEP_DISABLED;
let samplingStepM = SAMPLING_STEP_DISABLED;
let stepRange: [number, number] = [0, 0];
let pitchThresholdDeg = DEFAULT_PITCH_THRESHOLD_DEG;

let flight: {
  id: number;
  points: LngLatAlt[];
  index: number;
  reverse: boolean;
  range: number;
  pitch: number;
} | null = null;
let playing = false;
let paused = false;
let countdown: number | null = null;
let countdownTimer: ReturnType<typeof setTimeout> | null = null;
let flightId = 0;
let abortCurrent: (() => void) | null = null;
let unsubscribeMeasure: (() => void) | null = null;

let snapshot: PlayPathState = buildSnapshot();
const listeners = new Set<() => void>();

function profileMatchesVertices(samples: LngLatAlt[], vertices: LngLatAlt[]): boolean {
  if (vertices.length < 2 || samples.length < 2) return false;
  const Cesium = C();
  const start = geodesicMeters(Cesium, samples[0], vertices[0]);
  const end = geodesicMeters(Cesium, samples[samples.length - 1], vertices[vertices.length - 1]);
  return (
    start <= PLAY_PATH_PROFILE_VERTEX_TOLERANCE_M && end <= PLAY_PATH_PROFILE_VERTEX_TOLERANCE_M
  );
}

/** The path Play Path flies: profile samples when they match the figure, else vertices. */
export function pathForFlight(measure = getMeasure3dSnapshot()): LngLatAlt[] {
  if (measure.mode !== "line" && measure.mode !== "polygon") return [];
  const vertices = measure.geometry.points;
  if (vertices.length < 2) return [];
  let source = vertices.map((p) => ({ ...p }));
  if (handle && measure.profile && measure.profile.samples.length >= 2) {
    const samples = measure.profile.samples.map((s) => ({
      lng: s.lng,
      lat: s.lat,
      alt: s.alt,
    }));
    if (profileMatchesVertices(samples, vertices)) source = samples;
  }
  return source;
}

function livePath(): LngLatAlt[] {
  return pathForFlight();
}

function pathLength(points: LngLatAlt[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += geodesicMeters(C(), points[i - 1], points[i]);
  return total;
}

function C(): CesiumSceneHandle["Cesium"] {
  if (!handle) throw new Error("play-path: no globe");
  return handle.Cesium;
}

/** Keep terrain correction from re-applying the store view during a flight. */
async function withOwnedCamera(work: () => Promise<void>): Promise<void> {
  if (handle?.runWithOwnedCamera) await handle.runWithOwnedCamera(work);
  else await work();
}

function isLive(): boolean {
  return handle !== null && !handle.viewer.isDestroyed();
}

function pitchTooLow(): boolean {
  if (!isLive()) return false;
  const pitch = handle!.camera.pitch;
  return Math.abs(C().Math.toDegrees(pitch)) < pitchThresholdDeg;
}

function buildSnapshot(): PlayPathState {
  const points = flight?.points ?? (handle ? livePath() : []);
  return {
    open,
    bound: isLive(),
    available: isLive() && livePath().length >= 2,
    playing,
    paused,
    countdown,
    currentIndex: flight?.index ?? 0,
    pointCount: points.length,
    reverse: flight?.reverse ?? false,
    speed,
    samplingStepAuto,
    samplingStepM,
    samplingStepRange: stepRange,
    pitchTooLow: pitchTooLow(),
  };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribePlayPath(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getPlayPathSnapshot(): PlayPathState {
  return snapshot;
}

export function isPlayPathPanelVisible(): boolean {
  return open;
}

/** The pitch, in degrees, below which the flight is flagged as too flat. */
export function setPlayPathPitchThreshold(deg: number): void {
  if (Number.isFinite(deg) && deg >= 0 && deg <= 90) pitchThresholdDeg = deg;
  publish();
}

/**
 * Resample the path at `stepMeters`: every segment longer than the step is
 * split into equal parts along the geodesic, with the height interpolated
 * linearly between its ends. Zero keeps the points as they are.
 */
export function resamplePathForFlight(
  Cesium: CesiumSceneHandle["Cesium"],
  points: LngLatAlt[],
  stepMeters: number,
): LngLatAlt[] {
  if (points.length === 0 || !(stepMeters > 0)) return points.map((p) => ({ ...p }));
  const out: LngLatAlt[] = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const geodesic = new Cesium.EllipsoidGeodesic(
      Cesium.Cartographic.fromDegrees(start.lng, start.lat),
      Cesium.Cartographic.fromDegrees(end.lng, end.lat),
      Cesium.Ellipsoid.WGS84,
    );
    const segment = geodesic.surfaceDistance;
    if (segment > stepMeters) {
      const parts = Math.ceil(segment / stepMeters);
      for (let s = 1; s < parts; s += 1) {
        const fraction = s / parts;
        const carto = geodesic.interpolateUsingFraction(fraction, new Cesium.Cartographic());
        out.push({
          lng: Cesium.Math.toDegrees(carto.longitude),
          lat: Cesium.Math.toDegrees(carto.latitude),
          alt: start.alt + (end.alt - start.alt) * fraction,
        });
      }
    }
    out.push({ ...end });
  }
  return out;
}

/**
 * Where the camera sits to look at `target` from `range` metres behind it
 * along `headingRad`, tilted down by `pitchRad` (negative): in the target's
 * east-north-up frame, opposite the heading horizontally and above it
 * vertically, so that a camera there with that heading and pitch looks
 * straight at the target.
 */
export function lookAtCameraPosition(
  Cesium: CesiumSceneHandle["Cesium"],
  target: Cartesian3,
  headingRad: number,
  pitchRad: number,
  range: number,
): Cartesian3 {
  const down = Math.min(Math.PI / 2, Math.max(0, -pitchRad));
  const horizontal = range * Math.cos(down);
  const enu = new Cesium.Cartesian3(
    -Math.sin(headingRad) * horizontal,
    -Math.cos(headingRad) * horizontal,
    range * Math.sin(down),
  );
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(target);
  return Cesium.Matrix4.multiplyByPoint(frame, enu, new Cesium.Cartesian3());
}

function headingBetween(a: LngLatAlt, b: LngLatAlt): number {
  const Cesium = C();
  const geodesic = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(a.lng, a.lat),
    Cesium.Cartographic.fromDegrees(b.lng, b.lat),
    Cesium.Ellipsoid.WGS84,
  );
  return (geodesic.startHeading + 2 * Math.PI) % (2 * Math.PI);
}

/** Fly the camera to look at `target` with the given heading/pitch/range; resolves when the flight ends. */
function flyTo(
  target: LngLatAlt,
  headingRad: number,
  pitchRad: number,
  range: number,
  seconds: number,
): Promise<"complete" | "cancel"> {
  const Cesium = C();
  const h = handle!;
  const destination = lookAtCameraPosition(
    Cesium,
    fromLngLatAlt(Cesium, target),
    headingRad,
    pitchRad,
    range,
  );
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: "complete" | "cancel") => {
      if (settled) return;
      settled = true;
      abortCurrent = null;
      resolve(outcome);
    };
    abortCurrent = () => {
      h.camera.cancelFlight();
      done("cancel");
    };
    h.camera.flyTo({
      destination,
      orientation: { heading: headingRad, pitch: pitchRad, roll: 0 },
      duration: seconds,
      complete: () => done("complete"),
      cancel: () => done("cancel"),
    });
  });
}

/** Resolve once the globe's tile loading reaches zero, or after a timeout. */
function waitForTiles(): Promise<void> {
  const h = handle;
  const event = h?.scene.globe?.tileLoadProgressEvent;
  if (!h || !event) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      event.removeEventListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (remaining: number) => {
      if (remaining === 0) finish();
    };
    const timer = setTimeout(finish, timing.tileSettleTimeoutMs);
    event.addEventListener(listener);
    if (h.scene.globe.tilesLoaded) finish();
  });
}

function resolveSamplingStep(points: LngLatAlt[]): number {
  const length = pathLength(points);
  stepRange = samplingStepRange(length);
  if (!samplingStepAuto) {
    if (samplingStepManual === SAMPLING_STEP_DISABLED) return SAMPLING_STEP_DISABLED;
    const [min, max] = stepRange;
    return min
      ? Math.min(max, Math.max(min, snapSamplingStep(samplingStepManual)))
      : samplingStepManual;
  }
  return flightSamplingStep(length, metersPerPixel());
}

/** Ground metres per screen pixel at the camera's height (0 for an orthographic view). */
function metersPerPixel(): number {
  if (!isLive()) return 0;
  const { camera, canvas } = handle!;
  const fovy = (camera.frustum as { fovy?: number }).fovy;
  const height = camera.positionCartographic?.height;
  const pixels = canvas.clientHeight || canvas.height;
  if (!fovy || !height || !pixels) return 0;
  return (2 * height * Math.tan(fovy / 2)) / pixels;
}

async function run(id: number): Promise<void> {
  const f = flight;
  if (!f || f.id !== id) return;
  await withOwnedCamera(async () => {
    playing = true;
    paused = false;
    publish();
    const stepSeconds = PLAY_STEP_SECONDS / speed;
    while (flight && flight.id === id && isLive()) {
      const i = flight.index;
      const pts = flight.points;
      const last = flight.reverse ? 0 : pts.length - 1;
      const next = flight.reverse ? i - 1 : i + 1;
      const heading =
        i === last
          ? headingBetween(pts[flight.reverse ? i + 1 : i - 1], pts[i])
          : headingBetween(pts[i], pts[next]);
      const outcome = await flyTo(pts[i], heading, flight.pitch, flight.range, stepSeconds);
      if (!flight || flight.id !== id) return;
      if (outcome === "cancel") {
        // A pause or stop interrupted the flight; they have already published.
        return;
      }
      await waitForTiles();
      if (!flight || flight.id !== id) return;
      if (i === last) {
        playing = false;
        paused = false;
        publish();
        return;
      }
      flight.index = next;
      publish();
    }
  });
}

function clearCountdown(): void {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  countdown = null;
}

function startCountdown(id: number): void {
  countdown = PLAY_COUNTDOWN_SECONDS;
  publish();
  const tick = () => {
    if (!flight || flight.id !== id) return;
    if (countdown !== null && countdown > 1) {
      countdown -= 1;
      publish();
      countdownTimer = setTimeout(tick, timing.countdownTickMs);
      return;
    }
    clearCountdown();
    void run(id);
  };
  countdownTimer = setTimeout(tick, timing.countdownTickMs);
}

/** Start (or resume) the flight along the current 3D Measure path. */
export function playPath(): boolean {
  if (!isLive()) return false;
  if (playing) return true;
  if (paused && flight) {
    // Resume from where the pause left off, with the same points and view.
    const id = ++flightId;
    flight = { ...flight, id };
    void run(id);
    return true;
  }
  let source = livePath();
  if (source.length < 2) return false;
  const Cesium = C();
  const h = handle!;
  const cameraPos = Cesium.Cartesian3.clone(h.camera.positionWC);
  const vertices = getMeasure3dSnapshot().geometry.points;
  if (
    vertices.length >= 2 &&
    Cesium.Cartesian3.distance(cameraPos, fromLngLatAlt(Cesium, source[0])) >
      PLAY_PATH_CAMERA_SANITY_METERS
  ) {
    source = vertices.map((p) => ({ ...p }));
  }
  samplingStepM = resolveSamplingStep(source);
  const points = resamplePathForFlight(Cesium, source, samplingStepM);
  const first = fromLngLatAlt(Cesium, points[0]);
  const lastPt = fromLngLatAlt(Cesium, points[points.length - 1]);
  const distFirst = Cesium.Cartesian3.distance(cameraPos, first);
  const distLast = Cesium.Cartesian3.distance(cameraPos, lastPt);
  const reverse = distFirst > distLast;
  const range = Math.min(
    PLAY_MAX_RANGE_METERS,
    Math.max(PLAY_MIN_RANGE_METERS, reverse ? distLast : distFirst),
  );
  const pitch = Math.min(0, h.camera.pitch);
  const id = ++flightId;
  flight = { id, points, index: reverse ? points.length - 1 : 0, reverse, range, pitch };
  paused = false;
  startCountdown(id);
  return true;
}

/** Hold the flight at the current sample; `playPath()` resumes it. */
export function pausePath(): void {
  if (!flight) return;
  if (countdown !== null) {
    clearCountdown();
    flight = null;
    playing = false;
    paused = false;
    publish();
    return;
  }
  if (!playing) return;
  flightId += 1;
  flight = { ...flight, id: flightId };
  abortCurrent?.();
  playing = false;
  paused = true;
  publish();
}

/** End the flight and return the camera to the start of the path. */
export function stopPath(): void {
  const f = flight;
  clearCountdown();
  flightId += 1;
  abortCurrent?.();
  flight = null;
  playing = false;
  paused = false;
  publish();
  if (f && isLive() && f.points.length >= 2) {
    const start = f.reverse ? f.points.length - 1 : 0;
    const neighbour = f.reverse ? start - 1 : start + 1;
    void withOwnedCamera(() =>
      flyTo(
        f.points[start],
        headingBetween(f.points[start], f.points[neighbour]),
        f.pitch,
        f.range,
        PLAY_RETURN_SECONDS / speed,
      ).then(() => {}),
    );
  }
}

export function setPlayPathSpeed(next: number): void {
  if (!Number.isFinite(next)) return;
  speed = Math.min(PLAY_SPEED_MAX, Math.max(PLAY_SPEED_MIN, next));
  publish();
}

export function setPlayPathSamplingStep(step: number | "auto"): void {
  if (step === "auto") samplingStepAuto = true;
  else {
    samplingStepAuto = false;
    samplingStepManual =
      Number.isFinite(step) && step > 0 ? snapSamplingStep(step) : SAMPLING_STEP_DISABLED;
  }
  if (!flight) {
    const source = handle ? livePath() : [];
    samplingStepM = source.length >= 2 ? resolveSamplingStep(source) : SAMPLING_STEP_DISABLED;
  }
  publish();
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

function attach(app: GeoLibreAppAPI): void {
  if (isLive()) return;
  handle = primaryGlobe(app);
  if (!handle) return;
  unsubscribeMeasure ??= subscribeMeasure3d(() => {
    if (!flight) {
      const source = livePath();
      samplingStepM = source.length >= 2 ? resolveSamplingStep(source) : SAMPLING_STEP_DISABLED;
    }
    publish();
  });
  const source = livePath();
  samplingStepM = source.length >= 2 ? resolveSamplingStep(source) : SAMPLING_STEP_DISABLED;
}

function detach(): void {
  clearCountdown();
  flightId += 1;
  if (isLive()) abortCurrent?.();
  abortCurrent = null;
  flight = null;
  playing = false;
  paused = false;
  handle = null;
  unsubscribeMeasure?.();
  unsubscribeMeasure = null;
}

export function openPlayPathPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  publish();
}

export function closePlayPathPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

/** Re-bind after an engine mounts or is replaced; a flight in progress ends. */
export function reattachPlayPath(app: GeoLibreAppAPI): void {
  if (!open) return;
  const globe = primaryGlobe(app);
  if (isLive() && globe && handle!.viewer === globe.viewer) return;
  detach();
  attach(app);
  publish();
}

export function restorePlayPath(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closePlayPathPanel(app);
    speed = DEFAULT_PLAY_SPEED;
    samplingStepAuto = true;
    samplingStepManual = SAMPLING_STEP_DISABLED;
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  speed =
    typeof raw.speed === "number" && Number.isFinite(raw.speed)
      ? Math.min(PLAY_SPEED_MAX, Math.max(PLAY_SPEED_MIN, raw.speed))
      : DEFAULT_PLAY_SPEED;
  samplingStepAuto = raw.samplingStepAuto !== false;
  samplingStepManual =
    typeof raw.samplingStep === "number" &&
    Number.isFinite(raw.samplingStep) &&
    raw.samplingStep > 0
      ? snapSamplingStep(raw.samplingStep)
      : SAMPLING_STEP_DISABLED;
  if (raw.open === true) openPlayPathPanel(app);
  else closePlayPathPanel(app);
  return true;
}

/** The state worth persisting — never a flight in progress. */
export function getPlayPathProjectState(): Record<string, unknown> | undefined {
  if (!open && speed === DEFAULT_PLAY_SPEED && samplingStepAuto) return undefined;
  return {
    open,
    speed,
    samplingStepAuto,
    ...(samplingStepAuto ? {} : { samplingStep: samplingStepManual }),
  };
}
