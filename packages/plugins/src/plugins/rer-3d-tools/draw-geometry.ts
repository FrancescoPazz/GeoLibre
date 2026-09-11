import type { Cartesian3, Cartographic } from "@cesium/engine";
import type { LngLatAlt } from "./line-of-sight-geometry";

type CesiumNs = typeof import("@cesium/engine");

/**
 * Geometry for the 3D drawing and measuring tools: geodesic lengths, areas,
 * angles and circles on the WGS84 ellipsoid, plus the hit-testing that turns a
 * click into "add a vertex" or "insert one into this segment". Pure functions
 * over Cesium's maths, so every number a label shows is unit-tested.
 *
 * The formulas match the ones the geoportal's users have been reading for
 * years, so a measurement taken here agrees with one taken before the
 * migration: segment lengths are ellipsoidal geodesics (`EllipsoidGeodesic`),
 * a polygon's area is a fan of triangles from its first vertex with each
 * triangle's area from Heron's formula on its geodesic sides, an angle is the
 * 3D angle at the middle vertex, and a circle is traced with the great-circle
 * destination formula on the ellipsoid's equatorial radius.
 */

export type DrawMode = "line" | "polygon" | "point" | "angle" | "circle";

/** What the user has drawn, as ground positions in degrees. */
export interface DrawGeometry {
  mode: DrawMode;
  points: LngLatAlt[];
  /** A polygon whose ring has been closed by clicking its first vertex. */
  closed: boolean;
}

/** The numbers the tool shows, derived from a {@link DrawGeometry}. */
export interface DrawMeasures {
  /** Geodesic length of each consecutive segment (the closing one included for a closed polygon). */
  segmentMeters: number[];
  /** Sum of the segments. */
  totalMeters: number;
  /** Geodetic area of a closed polygon with at least three vertices. */
  areaSqm: number | null;
  /** The angle at the middle vertex of a three-point angle. */
  angleDeg: number | null;
  /** Circle radius (centre to edge, geodesic), with its perimeter and area. */
  circleRadiusMeters: number | null;
  circlePerimeterMeters: number | null;
  circleAreaSqm: number | null;
}

/** Ellipsoidal geodesic length between two ground positions, heights ignored. */
export function geodesicMeters(C: CesiumNs, a: LngLatAlt, b: LngLatAlt): number {
  const geodesic = new C.EllipsoidGeodesic(
    C.Cartographic.fromDegrees(a.lng, a.lat),
    C.Cartographic.fromDegrees(b.lng, b.lat),
    C.Ellipsoid.WGS84,
  );
  return geodesic.surfaceDistance;
}

/** The ground position at `fraction` of the geodesic from `a` to `b`. */
export function geodesicInterpolate(
  C: CesiumNs,
  a: LngLatAlt,
  b: LngLatAlt,
  fraction: number,
): LngLatAlt {
  const geodesic = new C.EllipsoidGeodesic(
    C.Cartographic.fromDegrees(a.lng, a.lat),
    C.Cartographic.fromDegrees(b.lng, b.lat),
    C.Ellipsoid.WGS84,
  );
  const carto: Cartographic = geodesic.interpolateUsingFraction(fraction, new C.Cartographic());
  return {
    lng: C.Math.toDegrees(carto.longitude),
    lat: C.Math.toDegrees(carto.latitude),
    alt: (a.alt + b.alt) / 2,
  };
}

/**
 * Geodetic area of a ring: a fan of triangles from the first vertex, each
 * measured with Heron's formula on its three geodesic side lengths. A
 * degenerate triangle (collinear vertices, rounding past zero) contributes
 * nothing rather than NaN.
 */
export function polygonGeodeticAreaSqm(C: CesiumNs, ring: LngLatAlt[]): number {
  if (ring.length < 3) return 0;
  let total = 0;
  for (let i = 1; i < ring.length - 1; i += 1) {
    const a = geodesicMeters(C, ring[0], ring[i]);
    const b = geodesicMeters(C, ring[i], ring[i + 1]);
    const c = geodesicMeters(C, ring[i + 1], ring[0]);
    const s = (a + b + c) / 2;
    const area = Math.sqrt(s * (s - a) * (s - b) * (s - c));
    if (Number.isFinite(area)) total += area;
  }
  return total;
}

/** The angle at `vertex` between the arms to `a` and `c`, in degrees to 2 dp. */
export function angleDegrees(
  C: CesiumNs,
  a: Cartesian3,
  vertex: Cartesian3,
  c: Cartesian3,
): number {
  const v1 = C.Cartesian3.normalize(
    C.Cartesian3.subtract(a, vertex, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const v2 = C.Cartesian3.normalize(
    C.Cartesian3.subtract(c, vertex, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const dot = Math.min(1, Math.max(-1, C.Cartesian3.dot(v1, v2)));
  return Math.round(C.Math.toDegrees(Math.acos(dot)) * 100) / 100;
}

/**
 * Points along the arc that marks an angle, swept from arm `a` to arm `c`
 * around `vertex` at a fraction of the shorter arm — the visual cue only, the
 * number comes from {@link angleDegrees}.
 */
export function angleArc(
  C: CesiumNs,
  a: Cartesian3,
  vertex: Cartesian3,
  c: Cartesian3,
  segments = 30,
  radiusFraction = 0.6,
): Cartesian3[] {
  const va = C.Cartesian3.subtract(a, vertex, new C.Cartesian3());
  const vc = C.Cartesian3.subtract(c, vertex, new C.Cartesian3());
  const radius = Math.min(C.Cartesian3.magnitude(va), C.Cartesian3.magnitude(vc)) * radiusFraction;
  if (!(radius > 0)) return [];
  const u = C.Cartesian3.normalize(va, new C.Cartesian3());
  const v = C.Cartesian3.normalize(vc, new C.Cartesian3());
  const angle = Math.acos(Math.min(1, Math.max(-1, C.Cartesian3.dot(u, v))));
  if (!(angle > 0)) return [];
  const axis = C.Cartesian3.normalize(
    C.Cartesian3.cross(u, v, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const w = C.Cartesian3.cross(axis, u, new C.Cartesian3());
  const out: Cartesian3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = (angle * i) / segments;
    const dir = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(u, Math.cos(t), new C.Cartesian3()),
      C.Cartesian3.multiplyByScalar(w, Math.sin(t), new C.Cartesian3()),
      new C.Cartesian3(),
    );
    out.push(
      C.Cartesian3.add(vertex, C.Cartesian3.multiplyByScalar(dir, radius, dir), new C.Cartesian3()),
    );
  }
  return out;
}

/** How many segments to trace a circle with: one per ~20 m of perimeter, 64–512. */
export function circleSegmentCount(radiusMeters: number): number {
  return Math.max(64, Math.min(512, Math.ceil((2 * Math.PI * radiusMeters) / 20)));
}

/**
 * The ring of a circle of `radiusMeters` around `center`, traced with the
 * great-circle destination formula on the ellipsoid's equatorial radius —
 * the same trace the geoportal has always drawn. The first point is repeated
 * at the end so the ring closes.
 */
export function circleRing(
  C: CesiumNs,
  center: LngLatAlt,
  radiusMeters: number,
  segments = circleSegmentCount(radiusMeters),
): LngLatAlt[] {
  const earthRadius = C.Ellipsoid.WGS84.maximumRadius;
  const angular = radiusMeters / earthRadius;
  const lat1 = C.Math.toRadians(center.lat);
  const lon1 = C.Math.toRadians(center.lng);
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angular);
  const cosAd = Math.cos(angular);
  const ring: LngLatAlt[] = [];
  for (let i = 0; i < segments; i += 1) {
    const bearing = (2 * Math.PI * i) / segments;
    const lat2 = Math.asin(sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearing));
    const lon2 =
      lon1 + Math.atan2(Math.sin(bearing) * sinAd * cosLat1, cosAd - sinLat1 * Math.sin(lat2));
    ring.push({ lng: C.Math.toDegrees(lon2), lat: C.Math.toDegrees(lat2), alt: center.alt });
  }
  ring.push(ring[0]);
  return ring;
}

/** Everything the panel and the on-map labels show for a drawing. */
export function computeMeasures(C: CesiumNs, geometry: DrawGeometry): DrawMeasures {
  const { mode, points, closed } = geometry;
  const empty: DrawMeasures = {
    segmentMeters: [],
    totalMeters: 0,
    areaSqm: null,
    angleDeg: null,
    circleRadiusMeters: null,
    circlePerimeterMeters: null,
    circleAreaSqm: null,
  };
  if (mode === "point") return empty;
  if (mode === "circle") {
    if (points.length < 2) return empty;
    const radius = geodesicMeters(C, points[0], points[1]);
    return {
      ...empty,
      circleRadiusMeters: radius,
      circlePerimeterMeters: 2 * Math.PI * radius,
      circleAreaSqm: Math.PI * radius * radius,
    };
  }
  const segmentMeters: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    segmentMeters.push(geodesicMeters(C, points[i - 1], points[i]));
  }
  if (mode === "polygon" && closed && points.length >= 3) {
    segmentMeters.push(geodesicMeters(C, points[points.length - 1], points[0]));
  }
  const totalMeters = segmentMeters.reduce((sum, m) => sum + m, 0);
  if (mode === "angle") {
    if (points.length < 3) return { ...empty, segmentMeters, totalMeters };
    const cart = points.map((p) => C.Cartesian3.fromDegrees(p.lng, p.lat, p.alt));
    return {
      ...empty,
      segmentMeters,
      totalMeters,
      angleDeg: angleDegrees(C, cart[0], cart[1], cart[2]),
    };
  }
  return {
    ...empty,
    segmentMeters,
    totalMeters,
    areaSqm:
      mode === "polygon" && closed && points.length >= 3 ? polygonGeodeticAreaSqm(C, points) : null,
  };
}

/** The mean of the vertices — where a polygon's area label sits. */
export function verticesCentroid(points: LngLatAlt[]): LngLatAlt | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, p) => ({ lng: acc.lng + p.lng, lat: acc.lat + p.lat, alt: acc.alt + p.alt }),
    { lng: 0, lat: 0, alt: 0 },
  );
  const n = points.length;
  return { lng: sum.lng / n, lat: sum.lat / n, alt: sum.alt / n };
}

/** Distance from `p` to the segment `ab`, and where along it the foot falls (0–1). */
export function pointToSegment(
  C: CesiumNs,
  p: Cartesian3,
  a: Cartesian3,
  b: Cartesian3,
): { meters: number; t: number } {
  const ab = C.Cartesian3.subtract(b, a, new C.Cartesian3());
  const ap = C.Cartesian3.subtract(p, a, new C.Cartesian3());
  const length2 = C.Cartesian3.magnitudeSquared(ab);
  const t = length2 > 0 ? Math.min(1, Math.max(0, C.Cartesian3.dot(ap, ab) / length2)) : 0;
  const foot = C.Cartesian3.add(a, C.Cartesian3.multiplyByScalar(ab, t, ab), new C.Cartesian3());
  return { meters: C.Cartesian3.distance(p, foot), t };
}

/**
 * The segment of `points` a click at `p` lands on, if any: the nearest one
 * whose distance is within `tolerance(segmentLength)`. Returns the index the
 * new vertex should be inserted at (after segment `i` means index `i + 1`).
 */
export function nearestSegment(
  C: CesiumNs,
  points: LngLatAlt[],
  p: Cartesian3,
  tolerance: (segmentMeters: number) => number,
  closed = false,
): { insertAt: number; meters: number } | null {
  if (points.length < 2) return null;
  const cart = points.map((q) => C.Cartesian3.fromDegrees(q.lng, q.lat, q.alt));
  let best: { insertAt: number; meters: number } | null = null;
  const segments = closed ? cart.length : cart.length - 1;
  for (let i = 0; i < segments; i += 1) {
    const a = cart[i];
    const b = cart[(i + 1) % cart.length];
    const { meters, t } = pointToSegment(C, p, a, b);
    // A click at either end is the vertex itself, not the segment.
    if (t <= 0 || t >= 1) continue;
    if (meters > tolerance(C.Cartesian3.distance(a, b))) continue;
    if (!best || meters < best.meters) best = { insertAt: i + 1, meters };
  }
  return best;
}

/**
 * How close a click has to land to a segment to insert a vertex into it: the
 * historical one-per-mille of the segment's length, widened to a few screen
 * pixels so it stays clickable on a long segment seen from afar.
 */
export const INSERT_TOLERANCE_RATIO = 0.001;
export const INSERT_TOLERANCE_PIXELS = 8;
export function insertTolerance(metersPerPixel: number): (segmentMeters: number) => number {
  return (segmentMeters) =>
    Math.max(segmentMeters * INSERT_TOLERANCE_RATIO, metersPerPixel * INSERT_TOLERANCE_PIXELS);
}

/** "12.34 m" below a kilometre, "1.23 km" from there — the labels users know. */
export function formatMeters(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters.toFixed(2)} m`;
}

/** "123.4 m²", "1.23 ha" from a hectare, "1.23 km²" from a square kilometre. */
export function formatSquareMeters(sqm: number): string {
  if (sqm >= 1_000_000) return `${(sqm / 1_000_000).toFixed(2)} km²`;
  if (sqm >= 10_000) return `${(sqm / 10_000).toFixed(2)} ha`;
  return `${sqm.toFixed(1)} m²`;
}

/** "45.67°". */
export function formatDegrees(deg: number): string {
  return `${deg.toFixed(2)}°`;
}
