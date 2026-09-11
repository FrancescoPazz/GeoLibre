import type { Cartesian3, Cartographic, TerrainProvider } from "@cesium/engine";
import type { LngLatAlt } from "./line-of-sight-geometry";

type CesiumNs = typeof import("@cesium/engine");

/**
 * Terrain-sampled measurement of a drawn path: the ground is walked at a
 * regular step, its height read from the globe's terrain, and the three
 * distances the geoportal has always reported are derived — **geodesic**
 * (along the ellipsoid, heights ignored), **air** (the straight 3D line
 * between consecutive vertices) and **ground** (the sum of the small 3D steps
 * along the sampled surface). The samples are also the elevation profile.
 *
 * The sampling step adapts to the path: a 1-2-5 series between a thousand and
 * ten samples, nudged finer as the map is zoomed in. Both the series and the
 * blend are the ones users have tuned by hand for years, so a profile taken
 * here has the same resolution as one taken before the migration.
 *
 * Everything but the terrain read is synchronous and pure; the read goes
 * through `sampleTerrainMostDetailed` when the provider can answer it, and
 * keeps the vertices' own heights otherwise.
 */

/** The round steps, in metres, a user would pick by hand. */
export const SAMPLING_STEP_SERIES: readonly number[] = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000,
];

/** Zero switches resampling off. */
export const SAMPLING_STEP_DISABLED = 0;

const MAX_SAMPLE_POINTS = 1000;
const MIN_SAMPLE_POINTS = 10;
const MIN_RANGE_WIDTH = 2;
const PIXELS_PER_SAMPLE = 10;

export type SnapMode = "up" | "down" | "nearest";

/** The step from the series nearest `value` (or the next one up / down). */
export function snapSamplingStep(value: number, mode: SnapMode = "nearest"): number {
  const series = SAMPLING_STEP_SERIES;
  const last = series.length - 1;
  if (!(value > series[0])) return series[0];
  if (value >= series[last]) return series[last];
  let i = 0;
  while (i < last && series[i + 1] <= value) i += 1;
  if (mode === "down" || series[i] === value) return series[i];
  if (mode === "up") return series[i + 1];
  return value / series[i] <= series[i + 1] / value ? series[i] : series[i + 1];
}

/**
 * The steps worth offering for a path of `pathLength` metres: from the one
 * that yields a thousand samples to the one that yields ten, always at least
 * a couple of steps wide, never outside the series.
 */
export function samplingStepRange(pathLength: number | undefined): [number, number] {
  if (!pathLength || pathLength <= 0) return [0, 0];
  const series = SAMPLING_STEP_SERIES;
  const minIndex = series.indexOf(snapSamplingStep(pathLength / MAX_SAMPLE_POINTS, "up"));
  const maxIndex = Math.min(
    series.length - 1,
    Math.max(
      series.indexOf(snapSamplingStep(pathLength / MIN_SAMPLE_POINTS, "down")),
      minIndex + MIN_RANGE_WIDTH,
    ),
  );
  return [series[minIndex], series[Math.max(minIndex, maxIndex)]];
}

function blendSamplingStep(
  pathLength: number | undefined,
  groundResolution: number | undefined,
  viewWeight: number,
): number {
  const [min, max] = samplingStepRange(pathLength);
  if (!min || !max) return SAMPLING_STEP_DISABLED;
  const lengthStep = Math.sqrt(min * max);
  const weight = Math.min(1, Math.max(0, viewWeight));
  if (
    !groundResolution ||
    groundResolution <= 0 ||
    !Number.isFinite(groundResolution) ||
    weight === 0
  ) {
    return snapSamplingStep(lengthStep);
  }
  const viewStep = groundResolution * PIXELS_PER_SAMPLE;
  const blended = lengthStep ** (1 - weight) * viewStep ** weight;
  return snapSamplingStep(Math.min(max, Math.max(min, blended)));
}

/** The step for an elevation profile: half path length, half current zoom. */
export function profileSamplingStep(
  pathLength: number | undefined,
  groundResolution?: number,
): number {
  return blendSamplingStep(pathLength, groundResolution, 0.5);
}

/** The step for a fly-through: follows the zoom, clamped by the path length. */
export function flightSamplingStep(
  pathLength: number | undefined,
  groundResolution?: number,
): number {
  return blendSamplingStep(pathLength, groundResolution, 1);
}

/** One sample along the path. */
export interface ProfileSample extends LngLatAlt {
  /** Ground distance from the start of the path, in metres. */
  distanceM: number;
}

export interface TerrainProfile {
  samples: ProfileSample[];
  /** Index into `samples` of each original vertex. */
  stopIndex: number[];
  /** Per segment (vertex i-1 → i); index 0 is 0, as the geoportal reports it. */
  segmentGeodeticM: number[];
  segmentAirM: number[];
  segmentGroundM: number[];
  totalGeodeticM: number;
  totalAirM: number;
  totalGroundM: number;
  minAlt: number;
  maxAlt: number;
  /** The step the path was walked at (0 when only the vertices were used). */
  samplingStepM: number;
  /** Whether heights came from the terrain rather than the vertices. */
  detailed: boolean;
}

/** The densified path: vertices plus interpolated positions every `stepMeters`. */
export function densifyPath(
  C: CesiumNs,
  points: LngLatAlt[],
  stepMeters: number,
  closed = false,
): { cartographics: Cartographic[]; stopIndex: number[]; segmentGeodeticM: number[] } {
  const ring = closed && points.length >= 3 ? [...points, points[0]] : points;
  const cartos = ring.map((p) => C.Cartographic.fromDegrees(p.lng, p.lat, p.alt));
  if (cartos.length === 0) return { cartographics: [], stopIndex: [], segmentGeodeticM: [] };
  const cartographics: Cartographic[] = [cartos[0]];
  const stopIndex = [0];
  const segmentGeodeticM = [0];
  for (let i = 0; i < cartos.length - 1; i += 1) {
    const geodesic = new C.EllipsoidGeodesic(cartos[i], cartos[i + 1], C.Ellipsoid.WGS84);
    const segment = geodesic.surfaceDistance;
    segmentGeodeticM.push(segment);
    if (stepMeters > 0) {
      let y = 0;
      while ((y += stepMeters) < segment) {
        cartographics.push(geodesic.interpolateUsingSurfaceDistance(y, new C.Cartographic()));
      }
    }
    stopIndex.push(cartographics.length);
    cartographics.push(cartos[i + 1]);
  }
  return { cartographics, stopIndex, segmentGeodeticM };
}

/** A source of geoid undulations, for reporting heights above mean sea level. */
export type GeoidHeights = (positions: Cartographic[]) => Promise<number[]>;

/**
 * Read the terrain height under each position. When the provider carries
 * availability data `sampleTerrainMostDetailed` is asked; a failed read (a
 * tile that will not load) keeps the positions' own heights rather than
 * failing the whole profile. Heights are ellipsoidal unless a `geoid` is
 * given, whose undulation is then subtracted to give heights above mean sea
 * level — the geoportal's `useElevationMeanSeaLevel`.
 */
export async function sampleTerrain(
  C: CesiumNs,
  terrainProvider: TerrainProvider | undefined,
  cartographics: Cartographic[],
  geoid?: GeoidHeights,
): Promise<{ sampled: Cartographic[]; detailed: boolean }> {
  const detailed = Boolean(terrainProvider?.availability);
  const positions = cartographics.map((c) => C.Cartographic.clone(c));
  if (detailed && terrainProvider) {
    try {
      await C.sampleTerrainMostDetailed(terrainProvider, positions);
    } catch {
      // Keep the vertices' own heights; the profile is flat where tiles failed.
    }
  }
  if (geoid && terrainProvider) {
    const undulation = await geoid(positions);
    positions.forEach((p, i) => {
      p.height -= undulation[i] ?? 0;
    });
  }
  return { sampled: positions, detailed };
}

/** Derive the distances and the profile from the sampled positions. */
export function measureSampledPath(
  C: CesiumNs,
  sampled: Cartographic[],
  stopIndex: number[],
  segmentGeodeticM: number[],
  detailed: boolean,
  samplingStepM: number,
): TerrainProfile {
  const cartesians: Cartesian3[] = sampled.map((c) =>
    C.Cartesian3.fromRadians(c.longitude, c.latitude, c.height),
  );
  const stepM: number[] = [0];
  for (let i = 1; i < cartesians.length; i += 1) {
    stepM.push(
      detailed
        ? C.Cartesian3.distance(cartesians[i - 1], cartesians[i])
        : new C.EllipsoidGeodesic(sampled[i - 1], sampled[i], C.Ellipsoid.WGS84).surfaceDistance,
    );
  }
  const segmentAirM = [0];
  const segmentGroundM = [0];
  for (let i = 0; i < stopIndex.length - 1; i += 1) {
    const from = stopIndex[i];
    const to = stopIndex[i + 1];
    segmentAirM.push(C.Cartesian3.distance(cartesians[from], cartesians[to]));
    let ground = 0;
    if (detailed) for (let k = from + 1; k <= to; k += 1) ground += stepM[k];
    else ground = segmentGeodeticM[i + 1];
    segmentGroundM.push(ground);
  }
  let distance = 0;
  let minAlt = Number.POSITIVE_INFINITY;
  let maxAlt = Number.NEGATIVE_INFINITY;
  const samples: ProfileSample[] = sampled.map((c, i) => {
    distance += stepM[i];
    minAlt = Math.min(minAlt, c.height);
    maxAlt = Math.max(maxAlt, c.height);
    return {
      lng: C.Math.toDegrees(c.longitude),
      lat: C.Math.toDegrees(c.latitude),
      alt: c.height,
      distanceM: distance,
    };
  });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    samples,
    stopIndex,
    segmentGeodeticM,
    segmentAirM,
    segmentGroundM,
    totalGeodeticM: sum(segmentGeodeticM),
    totalAirM: sum(segmentAirM),
    totalGroundM: sum(segmentGroundM),
    minAlt: samples.length ? minAlt : 0,
    maxAlt: samples.length ? maxAlt : 0,
    samplingStepM,
    detailed,
  };
}

export interface BuildProfileOptions {
  /** Metres between samples; `SAMPLING_STEP_DISABLED` walks the vertices only. */
  stepMeters: number;
  closed?: boolean;
  geoid?: GeoidHeights;
}

/** Densify, sample the terrain and measure, in one call. */
export async function buildTerrainProfile(
  C: CesiumNs,
  terrainProvider: TerrainProvider | undefined,
  points: LngLatAlt[],
  options: BuildProfileOptions,
): Promise<TerrainProfile> {
  const { cartographics, stopIndex, segmentGeodeticM } = densifyPath(
    C,
    points,
    options.stepMeters,
    options.closed,
  );
  const { sampled, detailed } = await sampleTerrain(
    C,
    terrainProvider,
    cartographics,
    options.geoid,
  );
  return measureSampledPath(C, sampled, stopIndex, segmentGeodeticM, detailed, options.stepMeters);
}
