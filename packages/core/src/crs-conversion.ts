import { getRuntimeEnvironment } from "./runtime-env";

/**
 * Coordinate conversion through an ArcGIS GeometryServer `project`
 * operation, for the reference systems an Italian regional geoportal
 * deals in: Monte Mario (Gauss-Boaga), ED50, ETRS89, RDN2008 and WGS84
 * UTM, to and from WGS84 degrees.
 *
 * The conversion runs on the server rather than in the browser because
 * the datum shifts that matter — Monte Mario and ED50 to ETRS89 — are
 * NTv2 grid transformations whose grids are installed on the region's
 * ArcGIS server and named in the request as a GEOGTRAN WKT. A client-side
 * proj4 without those grids would be metres off. The service URL is the
 * deployment's (`COORDS_CONVERTER_URL`); nothing here is region-specific
 * beyond the list of pairs and the names of the two grids.
 */

/** One direction of a conversion between an EPSG code and WGS84. */
export interface CrsConversion {
  /** `EPSG:4326 WGS84 → EPSG:3003 Monte Mario / Italy zone 1` and the like. */
  label: string;
  from: number;
  to: number;
  /**
   * Which way the datum transformation named by `wkt` is applied: the
   * GEOGTRANs below go from the local datum to ETRS89, so a conversion
   * *into* the local system applies them backward.
   */
  transformForward: boolean;
  /** The GEOGTRAN naming the NTv2 grid on the server, when a datum shift is needed. */
  wkt?: string;
}

/** Monte Mario → ETRS89 through the region's AD400 NTv2 grid. */
export const MONTE_MARIO_ETRS89_WKT =
  'GEOGTRAN["CGT_AD400_MM_ETRS89_V1A",GEOGCS["GCS_Monte_Mario",DATUM["D_Monte_Mario",SPHEROID["International_1924",6378388.0,297.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],METHOD["NTv2"],PARAMETER["Dataset_it_emirom_ad400_v1/RER_AD400_MM_ETRS89_V1A",0.0]]';

/** ED50 → ETRS89 through the region's GPS7 NTv2 grid. */
export const ED50_ETRS89_WKT =
  'GEOGTRAN["CGT_ED50_ETRS89_GPS7_K2",GEOGCS["GCS_European_1950",DATUM["D_European_1950",SPHEROID["International_1924",6378388.0,297.0]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],METHOD["NTv2"],PARAMETER["Dataset_it_emirom_gps7_k2/RER_ED50_ETRS89_GPS7_K2",0.0]]';

export const WGS84_EPSG = 4326;

/** The systems offered, each paired with WGS84 in both directions. */
const LOCAL_SYSTEMS: ReadonlyArray<{ epsg: number; name: string; wkt?: string }> = [
  { epsg: 3003, name: "Monte Mario / Italy zone 1", wkt: MONTE_MARIO_ETRS89_WKT },
  { epsg: 3004, name: "Monte Mario / Italy zone 2", wkt: MONTE_MARIO_ETRS89_WKT },
  { epsg: 4265, name: "Monte Mario", wkt: MONTE_MARIO_ETRS89_WKT },
  { epsg: 5659, name: "UTMRER", wkt: MONTE_MARIO_ETRS89_WKT },
  { epsg: 4258, name: "ETRS89" },
  { epsg: 25832, name: "ETRS89 / UTM zone 32N" },
  { epsg: 25833, name: "ETRS89 / UTM zone 33N" },
  { epsg: 6706, name: "RDN2008" },
  { epsg: 7791, name: "RDN2008 / UTM zone 32N" },
  { epsg: 7792, name: "RDN2008 / UTM zone 33N" },
  { epsg: 4230, name: "ED50", wkt: ED50_ETRS89_WKT },
  { epsg: 23032, name: "ED50 / UTM zone 32N", wkt: ED50_ETRS89_WKT },
  { epsg: 23033, name: "ED50 / UTM zone 33N", wkt: ED50_ETRS89_WKT },
  { epsg: 32632, name: "WGS 84 / UTM zone 32N" },
  { epsg: 32633, name: "WGS 84 / UTM zone 33N" },
];

const WGS84_LABEL = `EPSG:${WGS84_EPSG} WGS84`;

/** Every conversion offered: WGS84 → each local system, then each local system → WGS84. */
export const CRS_CONVERSIONS: readonly CrsConversion[] = [
  ...LOCAL_SYSTEMS.map((s) => ({
    label: `${WGS84_LABEL} → EPSG:${s.epsg} ${s.name}`,
    from: WGS84_EPSG,
    to: s.epsg,
    transformForward: false,
    ...(s.wkt ? { wkt: s.wkt } : {}),
  })),
  ...LOCAL_SYSTEMS.map((s) => ({
    label: `EPSG:${s.epsg} ${s.name} → ${WGS84_LABEL}`,
    from: s.epsg,
    to: WGS84_EPSG,
    transformForward: true,
    ...(s.wkt ? { wkt: s.wkt } : {}),
  })),
];

/** The conversions that make sense for the input: projected input cannot start from WGS84. */
export function conversionsForInput(cartographic: boolean): readonly CrsConversion[] {
  return cartographic ? CRS_CONVERSIONS : CRS_CONVERSIONS.filter((c) => c.from !== WGS84_EPSG);
}

/** A pair of numbers typed in the panel, as typed: `first, second`. */
export interface CoordinateInput {
  first: number;
  second: number;
  /**
   * Whether the pair can be read as `latitude, longitude`. It cannot when
   * the second number is no latitude AND the first is no longitude — the
   * eastings and northings of a projected system fail both.
   */
  cartographic: boolean;
}

/**
 * Parse "44.49, 11.34" / "683000; 4928000" / "683000 4928000": two numbers
 * separated by commas, semicolons or spaces. Null when there are not two
 * finite numbers.
 */
export function parseCoordinateInput(text: string): CoordinateInput | null {
  const parts = text.trim().split(/[\s,;]+/);
  if (parts.length < 2) return null;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  const notLatitude = second < -90 || second > 90;
  const notLongitude = first < -360 || first > 360;
  return { first, second, cartographic: !(notLatitude && notLongitude) };
}

/**
 * The `x,y` the `project` operation wants: for cartographic input the panel
 * reads `latitude, longitude`, so x is the second number.
 */
export function inputXY(input: CoordinateInput): { x: number; y: number } {
  return input.cartographic
    ? { x: input.second, y: input.first }
    : { x: input.first, y: input.second };
}

/** The `project` request URL for one attempt. */
export function projectRequestUrl(
  serviceUrl: string,
  conversion: CrsConversion,
  xy: { x: number; y: number },
  withTransformation: boolean,
): string {
  const url = new URL(serviceUrl);
  url.searchParams.set("inSR", String(conversion.from));
  url.searchParams.set("outSR", String(conversion.to));
  url.searchParams.set("geometries", `${xy.x},${xy.y}`);
  url.searchParams.set(
    "transformation",
    withTransformation && conversion.wkt ? JSON.stringify({ wkt: conversion.wkt }) : "{}",
  );
  url.searchParams.set("transformForward", String(conversion.transformForward));
  url.searchParams.set("f", "json");
  return url.toString();
}

/** A converted position, formatted the way the panel shows it. */
export interface ConvertedCoordinates {
  x: number;
  y: number;
  /** Whether the result reads as degrees (`latitude, longitude`, 6 decimals) rather than metres (`x, y`, 4). */
  cartographic: boolean;
  text: string;
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.trim().replace(",", "."));
  return Number.NaN;
}

/** The first geometry of a `project` answer, tolerant of the shapes servers use. */
function firstGeometry(results: unknown): unknown {
  const r = results as Record<string, unknown> | null;
  const geometries = r?.geometries;
  if (Array.isArray(geometries) && geometries.length > 0) return geometries[0];
  if (r?.geometry) return r.geometry;
  const features = r?.features;
  if (Array.isArray(features) && features.length > 0) {
    return (features[0] as { geometry?: unknown } | null)?.geometry ?? null;
  }
  return null;
}

/** Read a projected point out of `results`, or null when there is none. */
export function parseProjectedPoint(results: unknown): ConvertedCoordinates | null {
  const g = firstGeometry(results);
  if (!g || typeof g !== "object") return null;
  const geometry = g as Record<string, unknown> & unknown[];
  const rawX = geometry.x ?? geometry.lon ?? geometry.lng ?? geometry.longitude ?? geometry[0];
  const rawY = geometry.y ?? geometry.lat ?? geometry.latitude ?? geometry[1];
  const x = numeric(rawX);
  const y = numeric(rawY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return formatConverted(x, y);
}

/** Format a converted position: degrees to 6 decimals as `lat, lon`, metres to 4 as `x, y`. */
export function formatConverted(x: number, y: number): ConvertedCoordinates {
  const cartographic = x >= -360 && x <= 360 && y >= -90 && y <= 90;
  const decimals = cartographic ? 6 : 4;
  const xs = x.toFixed(decimals);
  const ys = y.toFixed(decimals);
  return {
    x: Number(xs),
    y: Number(ys),
    cartographic,
    text: cartographic ? `${ys}, ${xs}` : `${xs}, ${ys}`,
  };
}

/** The server's error message, if the answer carries one. */
function serviceError(results: unknown): string | null {
  const error = (results as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : null;
}

/**
 * Convert `input` with `conversion` on the service at `serviceUrl`. The
 * request names the NTv2 grid when the pair needs one; if the server
 * rejects that (a server without the grid), the conversion is retried with
 * no datum transformation, which is what the server would then do on its
 * own. Throws with the server's message when both fail.
 */
export async function convertCoordinates(
  serviceUrl: string,
  conversion: CrsConversion,
  input: CoordinateInput,
  fetchImpl: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<ConvertedCoordinates> {
  const xy = inputXY(input);
  const attempts = conversion.wkt ? [true, false] : [false];
  let lastError = "Conversion failed.";
  for (const withTransformation of attempts) {
    const url = projectRequestUrl(serviceUrl, conversion, xy, withTransformation);
    let results: unknown;
    try {
      const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
      if (!response.ok) {
        lastError = `Conversion service returned HTTP ${response.status}`;
        continue;
      }
      const text = await response.text();
      results = text.trim() ? (JSON.parse(text) as unknown) : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    const point = parseProjectedPoint(results);
    if (point) return point;
    lastError = serviceError(results) ?? `Invalid converter response: ${JSON.stringify(results)}`;
  }
  throw new Error(lastError);
}

/**
 * The deployment's GeometryServer `project` URL (`VITE_COORDS_CONVERTER_URL`
 * or the bare `COORDS_CONVERTER_URL`), or undefined when none is set or it
 * is not an http(s) URL.
 */
export function getCoordsConverterUrl(
  env?: Record<string, string | undefined>,
): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = (runtimeEnv.VITE_COORDS_CONVERTER_URL ?? runtimeEnv.COORDS_CONVERTER_URL)?.trim();
  if (!raw) return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:" ? raw : undefined;
  } catch {
    return undefined;
  }
}
