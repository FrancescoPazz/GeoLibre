import type { Cartographic, TerrainProvider } from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { LngLatAlt } from "./line-of-sight-geometry";

type CesiumNs = CesiumSceneHandle["Cesium"];

/**
 * The visible area around an observer on the globe's terrain — the
 * geoportal's "viewshed area": a square grid of terrain heights in the
 * observer's east-north-up frame, a radial line-of-sight sweep over it on
 * the CPU, and the visible cells painted into an image that the tool drapes
 * on the terrain. Pure functions over plain arrays, so the sweep is
 * unit-tested on synthetic terrain and runs the same in a test as on the
 * globe; the terrain read is the one asynchronous step.
 *
 * The sweep is the classic one: along each ray from the centre outward, a
 * cell is visible when its elevation angle from the eye is at least the
 * highest angle met so far along that ray. Earth curvature and refraction
 * are not modelled — at the radii the tool offers (a few kilometres) the
 * curvature drop is under a metre or two, the terrain's own noise.
 */

/** Height of a cell outside the radius, or one the terrain could not answer. */
export const NO_DATA = Number.NaN;

export const VISIBILITY_NO_DATA = 255;
export const VISIBILITY_HIDDEN = 0;
export const VISIBILITY_VISIBLE = 1;

/** The most cells along one side of the grid: 300 keeps a 5 km radius at ~33 m cells. */
export const DEFAULT_MAX_CELLS_PER_SIDE = 300;

export interface TerrainVisibilityGrid {
  /** Cells per side; odd, so the observer sits on an exact centre cell. */
  gridWidth: number;
  /** Metres per cell. */
  cellSize: number;
  /** Row-major (north index × east index) heights, `NO_DATA` where unsampled. */
  heights: Float32Array;
  /** The terrain height at the centre cell, or `NO_DATA`. */
  groundHeightAtObserver: number;
}

/** Cell size and count for a radius, so the grid is square, odd-sided and centred. */
export function gridLayout(
  radiusMeters: number,
  maxCellsPerSide = DEFAULT_MAX_CELLS_PER_SIDE,
): { gridWidth: number; cellSize: number } {
  const cellSize = Math.max(1, (2 * radiusMeters) / maxCellsPerSide);
  let gridWidth = Math.ceil((2 * radiusMeters) / cellSize) + 1;
  if (gridWidth % 2 === 0) gridWidth += 1;
  return { gridWidth, cellSize };
}

/**
 * The positions of the cells within the radius, in the observer's ENU frame
 * turned into cartographics, with the grid index each stands for. Cells in
 * the square's corners, beyond the circle, are not sampled at all.
 */
export function gridCartographics(
  C: CesiumNs,
  observer: LngLatAlt,
  radiusMeters: number,
  layout: { gridWidth: number; cellSize: number },
): { cartographics: Cartographic[]; cellIndex: number[] } {
  const { gridWidth, cellSize } = layout;
  const half = (gridWidth - 1) / 2;
  const centre = C.Cartesian3.fromDegrees(observer.lng, observer.lat, 0);
  const enu = C.Transforms.eastNorthUpToFixedFrame(centre);
  const cartographics: Cartographic[] = [];
  const cellIndex: number[] = [];
  const r2 = radiusMeters * radiusMeters;
  for (let j = 0; j < gridWidth; j += 1) {
    const north = (j - half) * cellSize;
    for (let i = 0; i < gridWidth; i += 1) {
      const east = (i - half) * cellSize;
      if (east * east + north * north > r2) continue;
      const world = C.Matrix4.multiplyByPoint(
        enu,
        new C.Cartesian3(east, north, 0),
        new C.Cartesian3(),
      );
      cartographics.push(C.Cartographic.fromCartesian(world));
      cellIndex.push(j * gridWidth + i);
    }
  }
  return { cartographics, cellIndex };
}

/**
 * Read the terrain into a grid around the observer. Needs a provider with
 * availability data (`sampleTerrainMostDetailed`); without one there is no
 * terrain to see over, and the caller reports the tool as unavailable.
 */
export async function sampleTerrainVisibilityGrid(
  C: CesiumNs,
  terrainProvider: TerrainProvider,
  observer: LngLatAlt,
  radiusMeters: number,
  options: { maxCellsPerSide?: number } = {},
): Promise<TerrainVisibilityGrid> {
  if (!terrainProvider.availability) {
    throw new Error("The globe's terrain cannot be sampled for a viewshed.");
  }
  const layout = gridLayout(radiusMeters, options.maxCellsPerSide);
  const { cartographics, cellIndex } = gridCartographics(C, observer, radiusMeters, layout);
  const sampled = await C.sampleTerrainMostDetailed(terrainProvider, cartographics);
  const heights = new Float32Array(layout.gridWidth * layout.gridWidth).fill(NO_DATA);
  sampled.forEach((c, k) => {
    if (typeof c.height === "number" && Number.isFinite(c.height)) heights[cellIndex[k]] = c.height;
  });
  const half = (layout.gridWidth - 1) / 2;
  return {
    ...layout,
    heights,
    groundHeightAtObserver: heights[half * layout.gridWidth + half],
  };
}

/**
 * The radial sweep: one ray per `cellSize` of circumference (at least 360),
 * each walked outward a cell at a time, marking a cell visible when its
 * elevation angle from the eye is not below any angle met before it on
 * that ray. A cell several rays cross keeps `visible` once any ray saw it.
 */
export function computeViewshed(
  grid: Pick<TerrainVisibilityGrid, "gridWidth" | "cellSize" | "heights">,
  eyeHeight: number,
  options: { numRays?: number } = {},
): Uint8Array {
  const { gridWidth, cellSize, heights } = grid;
  const half = (gridWidth - 1) / 2;
  const maxRadius = half * cellSize;
  const numRays = options.numRays ?? Math.max(360, Math.ceil((2 * Math.PI * maxRadius) / cellSize));
  const result = new Uint8Array(gridWidth * gridWidth).fill(VISIBILITY_NO_DATA);
  const centreIndex = half * gridWidth + half;
  if (!Number.isNaN(heights[centreIndex])) result[centreIndex] = VISIBILITY_VISIBLE;

  for (let ray = 0; ray < numRays; ray += 1) {
    const theta = (ray / numRays) * 2 * Math.PI;
    const dirE = Math.sin(theta);
    const dirN = Math.cos(theta);
    let maxAngleSoFar = Number.NEGATIVE_INFINITY;
    for (let r = cellSize; r <= maxRadius; r += cellSize) {
      const i = Math.round((dirE * r) / cellSize + half);
      const j = Math.round((dirN * r) / cellSize + half);
      if (i < 0 || i >= gridWidth || j < 0 || j >= gridWidth) break;
      const index = j * gridWidth + i;
      const h = heights[index];
      if (Number.isNaN(h)) continue;
      const angle = Math.atan2(h - eyeHeight, r);
      if (angle >= maxAngleSoFar) {
        result[index] = VISIBILITY_VISIBLE;
        maxAngleSoFar = angle;
      } else if (result[index] !== VISIBILITY_VISIBLE) {
        result[index] = VISIBILITY_HIDDEN;
      }
    }
  }
  return result;
}

/** How much of the sampled ground is visible (0–1), the panel's one number. */
export function visibleFraction(visibility: Uint8Array): number {
  let visible = 0;
  let ground = 0;
  for (const v of visibility) {
    if (v === VISIBILITY_NO_DATA) continue;
    ground += 1;
    if (v === VISIBILITY_VISIBLE) visible += 1;
  }
  return ground === 0 ? 0 : visible / ground;
}

/**
 * The visible cells as RGBA pixels, north row first (image rows run top to
 * bottom, the grid's north index bottom to top). Hidden and unsampled cells
 * are left transparent.
 */
export function rasterizeVisibility(
  grid: Pick<TerrainVisibilityGrid, "gridWidth">,
  visibility: Uint8Array,
  rgba: [number, number, number, number],
): { width: number; height: number; data: Uint8ClampedArray } {
  const { gridWidth } = grid;
  const data = new Uint8ClampedArray(gridWidth * gridWidth * 4);
  for (let j = 0; j < gridWidth; j += 1) {
    for (let i = 0; i < gridWidth; i += 1) {
      if (visibility[j * gridWidth + i] !== VISIBILITY_VISIBLE) continue;
      const row = gridWidth - 1 - j;
      const at = (row * gridWidth + i) * 4;
      data[at] = rgba[0];
      data[at + 1] = rgba[1];
      data[at + 2] = rgba[2];
      data[at + 3] = rgba[3];
    }
  }
  return { width: gridWidth, height: gridWidth, data };
}

/** The geographic rectangle `[west, south, east, north]` the grid's square covers. */
export function gridExtent(
  C: CesiumNs,
  observer: LngLatAlt,
  layout: { gridWidth: number; cellSize: number },
): [number, number, number, number] {
  const half = (layout.gridWidth - 1) / 2;
  const radius = half * layout.cellSize;
  const centre = C.Cartesian3.fromDegrees(observer.lng, observer.lat, 0);
  const enu = C.Transforms.eastNorthUpToFixedFrame(centre);
  const corners = [
    [-radius, -radius],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
  ].map(([east, north]) =>
    C.Cartographic.fromCartesian(
      C.Matrix4.multiplyByPoint(enu, new C.Cartesian3(east, north, 0), new C.Cartesian3()),
    ),
  );
  const rect = C.Rectangle.fromCartographicArray(corners);
  return [
    C.Math.toDegrees(rect.west),
    C.Math.toDegrees(rect.south),
    C.Math.toDegrees(rect.east),
    C.Math.toDegrees(rect.north),
  ];
}
