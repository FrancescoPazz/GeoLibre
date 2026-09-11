import type { Cartographic } from "@cesium/engine";
import type { GeoidHeights } from "./terrain-profile";

/**
 * The Earth Gravity Model 1996 geoid, from the NGA `WW15MGH.DAC` grid: the
 * height of mean sea level above the WGS84 ellipsoid every 15 arc-minutes,
 * as big-endian 16-bit centimetres, 721 rows from the north pole down and
 * 1440 columns from Greenwich eastward.
 *
 * Terrain heights on the globe are ellipsoidal; subtracting the undulation
 * gives the orthometric heights a map reader expects — the geoportal's
 * "elevation above mean sea level". The grid is ~2 MB and is fetched once,
 * on first use, then kept.
 */

export const EGM96_ROWS = 721;
export const EGM96_COLUMNS = 1440;
/** Size of the grid file in bytes. */
export const EGM96_GRID_BYTES = EGM96_ROWS * EGM96_COLUMNS * 2;

/** Decode the `WW15MGH.DAC` bytes (big-endian int16, centimetres) into a grid. */
export function decodeEgm96Grid(buffer: ArrayBuffer): Int16Array {
  if (buffer.byteLength !== EGM96_GRID_BYTES) {
    throw new Error(`EGM96 grid: expected ${EGM96_GRID_BYTES} bytes, got ${buffer.byteLength}`);
  }
  const view = new DataView(buffer);
  const grid = new Int16Array(EGM96_ROWS * EGM96_COLUMNS);
  for (let i = 0; i < grid.length; i += 1) grid[i] = view.getInt16(i * 2, false);
  return grid;
}

function gridValue(grid: Int16Array, row: number, column: number): number {
  const r = Math.min(EGM96_ROWS - 1, Math.max(0, row));
  let c = column;
  if (c > EGM96_COLUMNS - 1) c -= EGM96_COLUMNS;
  else if (c < 0) c += EGM96_COLUMNS;
  return grid[r * EGM96_COLUMNS + c];
}

/**
 * The geoid undulation at a position, in metres, by bilinear interpolation
 * of the four surrounding grid nodes. Longitude wraps at the antimeridian;
 * latitude is clamped at the poles.
 */
export function egm96UndulationMeters(grid: Int16Array, lonRad: number, latRad: number): number {
  const rows = EGM96_ROWS - 1;
  const row = Math.min(rows, Math.max(0, (rows * (Math.PI / 2 - latRad)) / Math.PI));
  const twoPi = 2 * Math.PI;
  let lon = lonRad % twoPi;
  if (lon < 0) lon += twoPi;
  const column = Math.min(EGM96_COLUMNS, Math.max(0, (EGM96_COLUMNS * lon) / twoPi));

  const i = Math.floor(column);
  const j = Math.floor(row);
  const dx = column - i;
  const dy = row - j;
  const f11 = gridValue(grid, j, i);
  const f21 = gridValue(grid, j, i + 1);
  const f12 = gridValue(grid, j + 1, i);
  const f22 = gridValue(grid, j + 1, i + 1);
  return (
    (f11 * (1 - dx) * (1 - dy) + f21 * dx * (1 - dy) + f12 * (1 - dx) * dy + f22 * dx * dy) / 100
  );
}

export interface Egm96Geoid {
  /** Undulation at each position, in metres — the {@link GeoidHeights} contract. */
  heights: GeoidHeights;
  /** Undulation at one position given in degrees. */
  height(lngDeg: number, latDeg: number): Promise<number>;
  /** Whether the grid has been fetched and decoded. */
  loaded(): boolean;
}

type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

/**
 * A geoid backed by the grid at `gridUrl`, fetched once on first use. A
 * failed fetch is not cached, so the next call retries.
 */
export function createEgm96Geoid(gridUrl: string, fetchImpl?: FetchLike): Egm96Geoid {
  let grid: Int16Array | null = null;
  let pending: Promise<Int16Array> | null = null;
  const load = (): Promise<Int16Array> => {
    if (grid) return Promise.resolve(grid);
    if (pending) return pending;
    const doFetch = fetchImpl ?? ((url: string) => fetch(url));
    pending = doFetch(gridUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`EGM96 grid: HTTP ${response.status} for ${gridUrl}`);
        grid = decodeEgm96Grid(await response.arrayBuffer());
        return grid;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const toRad = Math.PI / 180;
  return {
    heights: async (positions: Cartographic[]) => {
      const data = await load();
      return positions.map((p) => egm96UndulationMeters(data, p.longitude, p.latitude));
    },
    height: async (lngDeg, latDeg) =>
      egm96UndulationMeters(await load(), lngDeg * toRad, latDeg * toRad),
    loaded: () => grid !== null,
  };
}
