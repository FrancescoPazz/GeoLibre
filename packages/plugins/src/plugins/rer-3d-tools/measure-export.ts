import type { Feature, FeatureCollection, Geometry } from "geojson";
import { circleRing, geodesicMeters, type DrawGeometry, type DrawMeasures } from "./draw-geometry";
import type { LngLatAlt } from "./line-of-sight-geometry";
import type { TerrainProfile } from "./terrain-profile";

type CesiumNs = typeof import("@cesium/engine");

/**
 * Turning a 3D measurement into data: a GeoJSON feature collection that
 * becomes an ordinary project layer — so it is styled, exported to every
 * format the app knows, and saved with the project — and the plain-text
 * summary the geoportal has always offered alongside its downloads.
 *
 * The collection carries the figure itself, one point per vertex with the
 * per-segment distances, and — when the terrain was sampled — the profile
 * as a line with heights in its coordinates. Property names are the
 * summary's own (`geodetic_distance_m`, `alt_min_m`, …) so the two agree.
 */

export type MeasureSummaryKind = "points" | "line" | "polygon" | "angle" | "circle";

export function measureSummaryKind(geometry: DrawGeometry): MeasureSummaryKind {
  if (geometry.mode === "point") return "points";
  if (geometry.mode === "angle") return "angle";
  if (geometry.mode === "circle") return "circle";
  if (geometry.mode === "polygon" && geometry.closed && geometry.points.length >= 3)
    return "polygon";
  return "line";
}

/** Initial bearing from the first vertex to the last, in degrees clockwise from north. */
export function pathBearingDegrees(C: CesiumNs, points: LngLatAlt[]): number | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  if (start.lng === end.lng && start.lat === end.lat) return null;
  const geodesic = new C.EllipsoidGeodesic(
    C.Cartographic.fromDegrees(start.lng, start.lat),
    C.Cartographic.fromDegrees(end.lng, end.lat),
    C.Ellipsoid.WGS84,
  );
  return (C.Math.toDegrees(geodesic.startHeading) + 360) % 360;
}

function round(value: number | null | undefined, digits: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function position(p: LngLatAlt): [number, number, number] {
  return [p.lng, p.lat, round(p.alt, 2) ?? 0];
}

/** The properties describing the whole figure, shared by the layer and the summary. */
export function measureSummaryProperties(
  C: CesiumNs,
  geometry: DrawGeometry,
  measures: DrawMeasures,
  profile: TerrainProfile | null,
): Record<string, unknown> {
  const kind = measureSummaryKind(geometry);
  const vertexAlts = geometry.points.map((p) => p.alt).filter((a) => Number.isFinite(a));
  const altMin = profile ? profile.minAlt : vertexAlts.length ? Math.min(...vertexAlts) : null;
  const altMax = profile ? profile.maxAlt : vertexAlts.length ? Math.max(...vertexAlts) : null;
  const first = geometry.points[0];
  const last = geometry.points[geometry.points.length - 1];
  const props: Record<string, unknown> = {
    kind,
    vertices: geometry.points.length,
  };
  if (kind === "polygon") {
    props.geodetic_area_m2 = round(measures.areaSqm, 2);
    props.geodetic_perimeter_m = round(measures.totalMeters, 2);
    if (profile) {
      props.air_perimeter_m = round(profile.totalAirM, 2);
      props.ground_perimeter_m = round(profile.totalGroundM, 2);
    }
  } else if (kind === "circle") {
    props.circle_radius_m = round(measures.circleRadiusMeters, 2);
    props.circle_perimeter_m = round(measures.circlePerimeterMeters, 2);
    props.circle_area_m2 = round(measures.circleAreaSqm, 2);
  } else if (kind === "angle") {
    props.angle_deg = measures.angleDeg;
    props.geodetic_distance_m = round(measures.totalMeters, 2);
  } else if (kind === "line") {
    props.geodetic_distance_m = round(measures.totalMeters, 2);
    if (profile) {
      props.air_distance_m = round(profile.totalAirM, 2);
      props.ground_distance_m = round(profile.totalGroundM, 2);
    }
    props.bearing_deg = round(pathBearingDegrees(C, geometry.points), 1);
  }
  if (kind !== "circle") {
    props.alt_min_m = round(altMin, 2);
    props.alt_max_m = round(altMax, 2);
    if (first && last && kind !== "polygon") props.alt_diff_m = round(last.alt - first.alt, 2);
  }
  if (profile) {
    props.sampling_step_m = profile.samplingStepM;
    props.terrain_sampled = profile.detailed;
  }
  return props;
}

/**
 * The measurement as a feature collection: the figure, its vertices, and
 * the sampled profile when there is one.
 */
export function buildMeasureFeatureCollection(
  C: CesiumNs,
  geometry: DrawGeometry,
  measures: DrawMeasures,
  profile: TerrainProfile | null,
): FeatureCollection {
  const kind = measureSummaryKind(geometry);
  const points = geometry.points;
  const summary = measureSummaryProperties(C, geometry, measures, profile);
  const features: Feature[] = [];

  let figure: Geometry | null = null;
  if (kind === "polygon") {
    figure = { type: "Polygon", coordinates: [[...points.map(position), position(points[0])]] };
  } else if (kind === "circle" && measures.circleRadiusMeters) {
    const ring = circleRing(C, points[0], measures.circleRadiusMeters).map(position);
    figure = { type: "Polygon", coordinates: [ring] };
  } else if ((kind === "line" || kind === "angle") && points.length >= 2) {
    figure = { type: "LineString", coordinates: points.map(position) };
  }
  if (figure)
    features.push({
      type: "Feature",
      geometry: figure,
      properties: { ...summary, feature: "figure" },
    });

  if (kind === "circle") {
    if (points[0]) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: position(points[0]) },
        properties: { feature: "centre", circle_radius_m: summary.circle_radius_m ?? null },
      });
    }
  } else {
    let cumulative = 0;
    points.forEach((p, i) => {
      const segment =
        i === 0 ? 0 : (measures.segmentMeters[i - 1] ?? geodesicMeters(C, points[i - 1], p));
      cumulative += segment;
      const props: Record<string, unknown> = {
        feature: "vertex",
        vertex: i + 1,
        alt_m: round(p.alt, 2),
        geodetic_from_start_m: round(cumulative, 2),
        segment_geodetic_m: round(segment, 2),
      };
      if (profile && profile.segmentAirM[i] !== undefined) {
        props.segment_air_m = round(profile.segmentAirM[i], 2);
        props.segment_ground_m = round(profile.segmentGroundM[i], 2);
      }
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: position(p) },
        properties: props,
      });
    });
  }

  if (profile && profile.samples.length >= 2) {
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: profile.samples.map(position) },
      properties: {
        feature: "profile",
        sample_count: profile.samples.length,
        sampling_step_m: profile.samplingStepM,
        ground_distance_m: round(profile.totalGroundM, 2),
        alt_min_m: round(profile.minAlt, 2),
        alt_max_m: round(profile.maxAlt, 2),
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** The `name: value` summary text the geoportal downloads as `<name>_summary.txt`. */
export function measureSummaryText(
  C: CesiumNs,
  name: string,
  geometry: DrawGeometry,
  measures: DrawMeasures,
  profile: TerrainProfile | null,
): string {
  const kind = measureSummaryKind(geometry);
  const lines: string[] = [`name: ${name}`, `kind: ${kind}`];
  const num = (label: string, value: number | null | undefined, digits: number, unit: string) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    lines.push(`${label}: ${value.toFixed(digits)} ${unit}`);
  };
  if (kind === "polygon") {
    const area = measures.areaSqm ?? 0;
    num("geodetic_area", area / 1_000_000, 6, "km2");
    num("geodetic_area", area * 0.0001, 4, "ha");
    num("geodetic_perimeter", measures.totalMeters, 2, "m");
    if (profile) {
      num("air_perimeter", profile.totalAirM, 2, "m");
      num("ground_perimeter", profile.totalGroundM, 2, "m");
    }
    return lines.join("\n");
  }
  if (kind === "circle") {
    num("circle_radius", measures.circleRadiusMeters, 2, "m");
    num("circle_perimeter", measures.circlePerimeterMeters, 2, "m");
    num("circle_area", (measures.circleAreaSqm ?? 0) / 1_000_000, 6, "km2");
    num("circle_area", (measures.circleAreaSqm ?? 0) * 0.0001, 4, "ha");
    return lines.join("\n");
  }
  const props = measureSummaryProperties(C, geometry, measures, profile);
  num("alt_min", props.alt_min_m as number | null, 2, "m");
  num("alt_max", props.alt_max_m as number | null, 2, "m");
  const bearing = pathBearingDegrees(C, geometry.points);
  if (bearing !== null) lines.push(`bearing: ${bearing.toFixed(1)}°`);
  if (typeof props.alt_diff_m === "number")
    lines.push(`alt_diff: ${props.alt_diff_m.toFixed(2)} m`);
  if (kind === "angle") num("angle", measures.angleDeg, 2, "°");
  if (kind === "line" || kind === "angle") {
    num("geodetic_distance", measures.totalMeters, 2, "m");
    if (profile) {
      num("air_distance", profile.totalAirM, 2, "m");
      num("ground_distance", profile.totalGroundM, 2, "m");
    }
  }
  return lines.join("\n");
}

/** A file-safe stem for downloads: letters, digits, dash and underscore. */
export function measureFileStem(name: string): string {
  const stem = name
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return stem || "measure";
}
