import type {
  ForwardRequestOptions,
  GeocodeMatch,
  GeocoderConfig,
  GeocodingProvider,
} from "./geocoding";

/**
 * Emilia-Romagna's address normaliser ("Normalizzatore", the eGeoCoding
 * service) as a geocoding provider.
 *
 * The service is SOAP-over-JSON rather than a REST query string: every call
 * is a POST with a JSON body, the operation is named in the `message` query
 * parameter, and an address search needs a session handle obtained first
 * from `GetHandle` with the service credentials. Searches are also confined
 * to a bounding box — the map's current view, or the region when the caller
 * has no view — and answer with a recordset whose field names carry the
 * lower-first-letter casing of the .NET serialiser (`sTRADARIO_ID`,
 * `cIVICO_X`, ...). This module owns that protocol so the rest of the
 * geocoding pipeline sees ordinary {@link GeocodeMatch} rows.
 *
 * Credentials come from the provider's API key as `username:password`; a
 * deployment that fronts the service with a same-origin proxy that injects
 * them can leave the key empty and point the endpoint at the proxy.
 */

export const RER_GEOCODER_PROVIDER_ID = "rer" as const;

/** The public eGeoCoding endpoint. */
export const RER_GEOCODER_ENDPOINT =
  "https://servizigis.regione.emilia-romagna.it/normalizzatore/eGeoCoding";

/**
 * Search area used when the caller supplies no view: the whole of
 * Emilia-Romagna, with a margin, so a batch run without a map still finds
 * every address in the region.
 */
export const RER_DEFAULT_SEARCH_EXTENT: readonly [number, number, number, number] = [
  9.1, 43.7, 12.85, 45.2,
];

/** Query-string operations of the Normalizzatore service. */
const SERVICE_QUERY = "serviceType=DBServices&serviceName=Normalizzatore";

/** The `GetHandle` URL for `endpoint`. */
export function rerHandleUrl(endpoint: string): string {
  return `${endpoint}?${SERVICE_QUERY}&message=GetHandle`;
}

/** The `Norm_Indirizzo_Unico_Area` (address search within an area) URL for `endpoint`. */
export function rerAddressUrl(endpoint: string): string {
  return `${endpoint}?${SERVICE_QUERY}&message=Norm_Indirizzo_Unico_Area`;
}

/** One row of the service's address recordset (only the fields read here). */
export interface RerAddressRecord {
  sTRADARIO_ID?: string;
  cIVICO_X?: string;
  cIVICO_Y?: string;
  cENTR_X?: string;
  cENTR_Y?: string;
  dUG?: string;
  dENOMINAZIONE?: string;
  dESCRIZIONE_CIVICO?: string;
  cOMUNE?: string;
  pROVINCIA?: string;
  gR_AFFIDABILITA?: string;
  [key: string]: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function coordinate(value: unknown): number | null {
  const s = text(value).trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The reliability rank of a record (`gR_AFFIDABILITA`, lower is better), or +∞ when missing. */
function reliability(record: RerAddressRecord): number {
  // A blank rank is missing, not zero (`Number("")` is 0, the best rank).
  return coordinate(record.gR_AFFIDABILITA) ?? Number.POSITIVE_INFINITY;
}

/** Split the provider API key into the service credentials, or null when there is none. */
export function rerCredentials(
  apiKey: string | undefined,
): { username: string; password: string } | null {
  const key = apiKey?.trim();
  if (!key) return null;
  const colon = key.indexOf(":");
  if (colon < 0) return { username: key, password: "" };
  return { username: key.slice(0, colon), password: key.slice(colon + 1) };
}

/**
 * Normalise the service's recordset into matches: rows ordered by ascending
 * reliability rank, one per street id (the best one), named
 * `DUG DENOMINAZIONE[ CIVICO], COMUNE, PROVINCIA`, positioned at the house
 * number when the row has one and at the street centroid otherwise. Rows
 * without a usable position are dropped rather than sent to 0°,0°. The
 * match score is the reliability rank itself (0 is the best the service
 * gives).
 */
export function parseRerRecords(records: unknown): GeocodeMatch[] {
  if (!Array.isArray(records)) return [];
  const rows = records.filter((r): r is RerAddressRecord => Boolean(r) && typeof r === "object");
  const sorted = [...rows].sort((a, b) => reliability(a) - reliability(b));
  const seen = new Set<string>();
  const matches: GeocodeMatch[] = [];
  for (const row of sorted) {
    const id = text(row.sTRADARIO_ID);
    if (seen.has(id)) continue;
    seen.add(id);
    const isHouseNumber = text(row.cIVICO_X) !== "";
    const lon = coordinate(isHouseNumber ? row.cIVICO_X : row.cENTR_X);
    const lat = coordinate(isHouseNumber ? row.cIVICO_Y : row.cENTR_Y);
    if (lon === null || lat === null) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    const street = [text(row.dUG), text(row.dENOMINAZIONE)].filter(Boolean).join(" ");
    const withNumber =
      isHouseNumber && text(row.dESCRIZIONE_CIVICO)
        ? `${street} ${text(row.dESCRIZIONE_CIVICO)}`
        : street;
    const displayName = [withNumber, text(row.cOMUNE), text(row.pROVINCIA)]
      .filter(Boolean)
      .join(", ");
    if (!displayName) continue;
    const rank = reliability(row);
    matches.push({ lat, lon, displayName, score: Number.isFinite(rank) ? rank : null });
  }
  return matches;
}

/** The recordset inside a `Norm_Indirizzo_Unico_Area` response, or null when the shape is wrong. */
export function rerRecordset(data: unknown): unknown[] | null {
  const output = (data as { norm_Indirizzo_Unico_AreaOutput?: unknown } | null)
    ?.norm_Indirizzo_Unico_AreaOutput;
  const records = (output as { norm_Indirizzo_Unico_AreaOutputRecordsetArray?: unknown } | null)
    ?.norm_Indirizzo_Unico_AreaOutputRecordsetArray;
  return Array.isArray(records) ? records : null;
}

/** The session handle inside a `GetHandle` response, or null. */
export function rerHandle(data: unknown): string | null {
  const output = (data as { getHandleOutput?: unknown } | null)?.getHandleOutput;
  const params = (output as { getHandleOutputParams?: unknown } | null)?.getHandleOutputParams;
  const handle = (params as { p_Handle?: unknown } | null)?.p_Handle;
  return typeof handle === "string" && handle ? handle : null;
}

/** The address-search request body for `query` inside `extent`. */
export function rerSearchBody(
  query: string,
  handle: string,
  extent: readonly [number, number, number, number],
): Record<string, unknown> {
  const [west, south, east, north] = extent;
  return {
    Norm_Indirizzo_Unico_AreaInputParams: {
      p_Indirizzo: query,
      p_Tipo_Coord: "WGS84",
      p_Rif_Geo_Civ: "ECIV",
      p_Handle: handle,
      p_minx: `${west}`,
      p_miny: `${south}`,
      p_maxx: `${east}`,
      p_maxy: `${north}`,
    },
  };
}

/** The `GetHandle` request body for the given credentials (empty when a proxy supplies them). */
export function rerHandleBody(
  credentials: { username: string; password: string } | null,
): Record<string, unknown> {
  return {
    GetHandleInputParams: credentials
      ? { p_Username: credentials.username, p_Userpassword: credentials.password }
      : {},
  };
}

// One session handle per endpoint, shared by every search and fetched only
// once — the service hands them out per login, not per query. A handle the
// service stops accepting is dropped and fetched again on the next search.
const handles = new Map<string, Promise<string>>();

/** Forget cached session handles (tests, or after a credential change). */
export function resetRerGeocoderSessions(): void {
  handles.clear();
}

async function postJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      // The service routes on this header as well as on `message`.
      soapAction: url,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Geocoder returned HTTP ${response.status}`);
  }
  const textBody = await response.text();
  return textBody.trim() ? (JSON.parse(textBody) as unknown) : undefined;
}

function sessionHandle(
  fetchImpl: typeof globalThis.fetch,
  config: GeocoderConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  const endpoint = config.forwardEndpoint;
  let pending = handles.get(endpoint);
  if (!pending) {
    pending = postJson(
      fetchImpl,
      rerHandleUrl(endpoint),
      rerHandleBody(rerCredentials(config.apiKey)),
      signal,
    ).then((data) => {
      const handle = rerHandle(data);
      if (!handle) throw new Error("Geocoder returned no session handle");
      return handle;
    });
    handles.set(endpoint, pending);
    // A failed login must not poison later searches with a rejected promise.
    pending.catch(() => {
      if (handles.get(endpoint) === pending) handles.delete(endpoint);
    });
  }
  return pending;
}

/**
 * Run an address search: get (or reuse) the session handle, post the query
 * within the view's extent, and normalise the recordset. A response without
 * a recordset is read as an expired handle: it is dropped and the search
 * repeated once with a fresh one.
 */
export async function rerFetchForward(
  config: GeocoderConfig,
  query: string,
  options: ForwardRequestOptions,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<GeocodeMatch[]> {
  if (!query.trim()) return [];
  const extent = options.bbox ?? RER_DEFAULT_SEARCH_EXTENT;
  const endpoint = config.forwardEndpoint;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await sessionHandle(fetchImpl, config, signal);
    const data = await postJson(
      fetchImpl,
      rerAddressUrl(endpoint),
      rerSearchBody(query, handle, extent),
      signal,
    );
    const records = rerRecordset(data);
    if (records) {
      const matches = parseRerRecords(records);
      return options.limit ? matches.slice(0, options.limit) : matches;
    }
    handles.delete(endpoint);
  }
  throw new Error("Geocoder returned no address recordset");
}

export const rerGeocodingProvider: GeocodingProvider = {
  id: RER_GEOCODER_PROVIDER_ID,
  label: "Emilia-Romagna eGeoCoding (Normalizzatore)",
  forward: true,
  reverse: false,
  requiresApiKey: false,
  acceptsApiKey: true,
  defaultForwardEndpoint: RER_GEOCODER_ENDPOINT,
  defaultReverseEndpoint: RER_GEOCODER_ENDPOINT,
  buildForwardUrl: (config) => rerAddressUrl(config.forwardEndpoint),
  parseForward: (data) => parseRerRecords(rerRecordset(data) ?? []),
  fetchForward: rerFetchForward,
  buildReverseUrl: (config) => config.reverseEndpoint,
  parseReverse: () => null,
};
