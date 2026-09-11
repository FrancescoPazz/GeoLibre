import type { Cartesian3, CesiumWidget, Scene } from "@cesium/engine";

type CesiumNs = typeof import("@cesium/engine");

/**
 * Line-of-sight geometry: the engine-independent half of the tool, so the
 * intersection test and its tolerances can be unit-tested against Cesium's
 * real vector maths with a faked globe.
 *
 * The test itself is deliberately simple — one ray from the observer to the
 * target, asked of the globe's loaded terrain — because that is what the
 * question "can I see that point from here?" needs. It is not an area
 * viewshed; GeoLibre's context-menu viewshed and the Whitebox Viewshed tool
 * cover that. Earth curvature is inherent (the ray is a chord through the
 * ellipsoid-anchored terrain mesh); atmospheric refraction is not modelled.
 */

/** A position in degrees, with its height above the ellipsoid in metres. */
export interface LngLatAlt {
  lng: number;
  lat: number;
  alt: number;
}

/** What the sight line found between the two raised end points. */
export interface LineOfSightResult {
  /** Straight-line (3D) distance from observer to target, in metres. */
  totalMeters: number;
  /**
   * How far along that line the view stays clear: to the first terrain hit
   * when there is one, else the full distance.
   */
  visibleMeters: number;
  /** Whether terrain stands between the two points. */
  occluded: boolean;
  /** Where the sight line meets the terrain, when it does. */
  hit: LngLatAlt | null;
}

/**
 * A hit this close to the target counts as reaching it. Both end points sit
 * *on* the terrain mesh, so a ray aimed at a target with no height added
 * grazes the surface it is standing on and can report an intersection a few
 * centimetres short. Relative to the distance so a 30 km sight line is judged
 * by the same standard as a 300 m one; floored so short lines are not held to
 * a millimetre.
 */
export const LINE_OF_SIGHT_TARGET_TOLERANCE_RATIO = 0.005;
export const LINE_OF_SIGHT_TARGET_TOLERANCE_MIN_METERS = 1;

/**
 * The first stretch of the ray that is not tested. The observer point comes
 * from the same terrain mesh the ray is tested against, so with no height
 * added the ray starts inside a triangle and the first "hit" is the observer's
 * own footprint. Skipping half a metre steps off that triangle without
 * skipping anything a person could stand behind.
 */
export const LINE_OF_SIGHT_ORIGIN_SKIP_METERS = 0.5;

/** The tolerance in metres at which a hit is treated as the target itself. */
export function targetTolerance(totalMeters: number): number {
  return Math.max(
    LINE_OF_SIGHT_TARGET_TOLERANCE_MIN_METERS,
    totalMeters * LINE_OF_SIGHT_TARGET_TOLERANCE_RATIO,
  );
}

/** Cartesian → degrees + ellipsoidal height. */
export function toLngLatAlt(C: CesiumNs, position: Cartesian3): LngLatAlt {
  const carto = C.Cartographic.fromCartesian(position);
  return {
    lng: C.Math.toDegrees(carto.longitude),
    lat: C.Math.toDegrees(carto.latitude),
    alt: carto.height,
  };
}

/** Degrees + ellipsoidal height → Cartesian. */
export function fromLngLatAlt(C: CesiumNs, point: LngLatAlt): Cartesian3 {
  return C.Cartesian3.fromDegrees(point.lng, point.lat, point.alt);
}

/**
 * Move a point straight up (along the ellipsoid normal) by `meters`. This is
 * how the observer and target heights are applied: an eye 1.7 m above the
 * ground the user clicked, a mast 30 m above its base.
 */
export function raiseByMeters(C: CesiumNs, position: Cartesian3, meters: number): Cartesian3 {
  if (!meters) return C.Cartesian3.clone(position);
  const carto = C.Cartographic.fromCartesian(position);
  return C.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height + meters);
}

/**
 * Cast the sight line from `observer` to `target` against the globe's loaded
 * terrain. Both positions are taken as already raised.
 *
 * `scene.globe.pick` answers with the nearest intersection of the ray and the
 * currently loaded terrain tiles, so the answer refines as the camera brings
 * in finer tiles — callers recompute when tile loading settles.
 */
export function computeLineOfSight(
  C: CesiumNs,
  scene: Scene,
  observer: Cartesian3,
  target: Cartesian3,
): LineOfSightResult {
  const totalMeters = C.Cartesian3.distance(observer, target);
  if (!(totalMeters > LINE_OF_SIGHT_ORIGIN_SKIP_METERS)) {
    return { totalMeters, visibleMeters: totalMeters, occluded: false, hit: null };
  }
  const direction = C.Cartesian3.normalize(
    C.Cartesian3.subtract(target, observer, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const origin = C.Cartesian3.add(
    observer,
    C.Cartesian3.multiplyByScalar(direction, LINE_OF_SIGHT_ORIGIN_SKIP_METERS, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const hit = scene.globe ? scene.globe.pick(new C.Ray(origin, direction), scene) : undefined;
  if (!hit) {
    return { totalMeters, visibleMeters: totalMeters, occluded: false, hit: null };
  }
  const hitMeters = LINE_OF_SIGHT_ORIGIN_SKIP_METERS + C.Cartesian3.distance(origin, hit);
  if (hitMeters >= totalMeters - targetTolerance(totalMeters)) {
    // The terrain the ray met is the ground the target stands on.
    return { totalMeters, visibleMeters: totalMeters, occluded: false, hit: null };
  }
  return { totalMeters, visibleMeters: hitMeters, occluded: true, hit: toLngLatAlt(C, hit) };
}

/**
 * The ground position under a screen point: the loaded terrain where there is
 * some, else the bare ellipsoid so the tool still works before terrain
 * arrives. Mirrors `@geolibre/map`'s own drawing pick; kept local because a
 * plugin only imports *types* from the map package — its runtime entry pulls
 * in MapLibre and its stylesheet, which the globe-only code path and the unit
 * tests have no use for.
 */
export function pickGroundPosition(
  C: CesiumNs,
  viewer: CesiumWidget,
  position: { x: number; y: number },
): Cartesian3 | undefined {
  const { scene, camera } = viewer;
  const ray = camera.getPickRay(position as Parameters<typeof camera.getPickRay>[0]);
  const onTerrain = ray && scene.globe ? scene.globe.pick(ray, scene) : undefined;
  if (onTerrain) return onTerrain;
  return camera.pickEllipsoid(
    position as Parameters<typeof camera.pickEllipsoid>[0],
    scene.globe?.ellipsoid ?? C.Ellipsoid.WGS84,
  );
}

/** Whether two results would render and read the same, to skip a no-op publish. */
export function lineOfSightResultEqual(
  a: LineOfSightResult | null,
  b: LineOfSightResult | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.occluded === b.occluded &&
    Math.abs(a.totalMeters - b.totalMeters) < 0.01 &&
    Math.abs(a.visibleMeters - b.visibleMeters) < 0.01
  );
}
