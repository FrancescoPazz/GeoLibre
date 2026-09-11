import { getRuntimeEnvironment } from "./runtime-env";

/**
 * "Where am I": the name of the place under the pointer, read from a
 * deployment's own place-name service and shown in the status bar beside
 * the coordinates — a municipality, a district, a locality, whatever the
 * service's polygons carry.
 *
 * The service is an ArcGIS feature query (a `MapServer/<n>/query` URL with
 * its own `outFields`, `spatialRel` and `f=json` already in the query
 * string): the pointer's position goes in as a point `geometry`, the
 * answer's first feature carries the name. A deployment can name a second,
 * more accurate query for when the fast one — typically an index-only
 * spatial relation — returns more than one candidate: the candidates' ids
 * are passed to it as `objectIds`, and its first feature wins.
 */

/** A place-name lookup service, as configured by the deployment. */
export interface WhereAmIConfig {
  /** The query URL for every pointer move (fast; may over-match). */
  url: string;
  /** A query URL to disambiguate several fast matches by `objectIds`, if any. */
  accurateUrl?: string;
  /** The attribute carrying a feature's id, for `objectIds`. */
  idField: string;
  /** The attribute carrying the place name. */
  field: string;
  /** An attribute carrying a longer description, shown as a tooltip. */
  detailField?: string;
}

/** What the lookup found under a point. */
export interface WhereAmIPlace {
  name: string;
  detail: string | null;
}

/** The attribute that identifies a feature when the deployment does not say. */
export const WHERE_AM_I_DEFAULT_ID_FIELD = "OBJECTID";

/**
 * The deployment's place-name service, if it names one. `VITE_WHERE_AM_I_URL`
 * (or the bare `WHERE_AM_I_URL`) is the fast query URL and
 * `VITE_WHERE_AM_I_FIELD` the attribute to show; both are needed. Optional:
 * `VITE_WHERE_AM_I_ACCURATE_URL`, `VITE_WHERE_AM_I_ID_FIELD` (default
 * `OBJECTID`) and `VITE_WHERE_AM_I_DETAIL_FIELD`.
 */
export function getWhereAmIConfig(
  env?: Record<string, string | undefined>,
): WhereAmIConfig | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const read = (name: string) =>
    (runtimeEnv[`VITE_${name}`] ?? runtimeEnv[name])?.trim() || undefined;
  const url = read("WHERE_AM_I_URL");
  const field = read("WHERE_AM_I_FIELD");
  if (!url || !field) return undefined;
  try {
    const { protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return {
    url,
    accurateUrl: read("WHERE_AM_I_ACCURATE_URL"),
    idField: read("WHERE_AM_I_ID_FIELD") ?? WHERE_AM_I_DEFAULT_ID_FIELD,
    field,
    detailField: read("WHERE_AM_I_DETAIL_FIELD"),
  };
}

/**
 * The query URL for `point`, keeping whatever parameters the configured URL
 * already carries and adding the point geometry (`lng, lat`, the form the
 * ArcGIS query endpoint reads for a point) and, when given, the ids to
 * restrict the answer to.
 */
export function whereAmIQueryUrl(
  base: string,
  point: readonly [number, number],
  objectIds?: readonly (string | number)[],
): string {
  const url = new URL(base);
  url.searchParams.set("geometry", `${point[0]}, ${point[1]}`);
  if (objectIds && objectIds.length > 0) url.searchParams.set("objectIds", objectIds.join(","));
  return url.toString();
}

interface QueryFeature {
  attributes?: Record<string, unknown>;
}

function features(data: unknown): QueryFeature[] {
  const list = (data as { features?: unknown } | null)?.features;
  return Array.isArray(list)
    ? list.filter((f): f is QueryFeature => Boolean(f) && typeof f === "object")
    : [];
}

function attribute(feature: QueryFeature | undefined, field: string | undefined): string | null {
  if (!feature || !field) return null;
  const value = feature.attributes?.[field];
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function placeOf(feature: QueryFeature | undefined, config: WhereAmIConfig): WhereAmIPlace | null {
  const name = attribute(feature, config.field);
  return name ? { name, detail: attribute(feature, config.detailField) } : null;
}

async function fetchJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Place service returned HTTP ${response.status}`);
  const text = await response.text();
  return text.trim() ? (JSON.parse(text) as unknown) : undefined;
}

/**
 * Look up the place under `point`: the fast query first; when it returns
 * several candidates and an accurate query is configured, that query
 * decides among them. Null when nothing is there.
 */
export async function lookupWhereAmI(
  config: WhereAmIConfig,
  point: readonly [number, number],
  fetchImpl: typeof globalThis.fetch = fetch,
  signal?: AbortSignal,
): Promise<WhereAmIPlace | null> {
  const fast = features(await fetchJson(fetchImpl, whereAmIQueryUrl(config.url, point), signal));
  if (fast.length > 1 && config.accurateUrl) {
    const ids = fast
      .map((f) => attribute(f, config.idField))
      .filter((id): id is string => id !== null);
    const accurate = features(
      await fetchJson(fetchImpl, whereAmIQueryUrl(config.accurateUrl, point, ids), signal),
    );
    return placeOf(accurate[0], config);
  }
  return placeOf(fast[0], config);
}

/** How long the pointer must sit still before the service is asked. */
export const WHERE_AM_I_DEBOUNCE_MS = 400;
/** Places remembered per resolver; bounded so a long session cannot grow it without limit. */
export const WHERE_AM_I_CACHE_LIMIT = 500;

/** Round a coordinate to ~11 m so nearby hovers share one cache entry. */
function cacheKey(point: readonly [number, number]): string {
  return `${point[0].toFixed(4)},${point[1].toFixed(4)}`;
}

export interface WhereAmIResolverOptions {
  config: WhereAmIConfig;
  /** Receives the place under the pointer, or null while unknown / off the map. */
  emit: (place: WhereAmIPlace | null) => void;
  /** Whether the readout is on; read per call. Defaults to always on. */
  isEnabled?: () => boolean;
  debounceMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export interface WhereAmIResolver {
  /** The pointer moved to `point`, or left the map (`null`). */
  update: (point: readonly [number, number] | null) => void;
  /** Drop any pending or in-flight lookup without emitting. */
  invalidate: () => void;
  dispose: () => void;
}

/**
 * Debounced, cached place lookup for a moving pointer: the service is asked
 * once the pointer settles, a slow answer for a spot the pointer has left is
 * dropped, and places already seen (to ~11 m) come back without a request.
 * Failures are not cached, so a network blip gets another chance.
 */
export function createWhereAmIResolver(options: WhereAmIResolverOptions): WhereAmIResolver {
  const { config, emit } = options;
  const isEnabled = options.isEnabled ?? (() => true);
  const debounceMs = options.debounceMs ?? WHERE_AM_I_DEBOUNCE_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, WhereAmIPlace | null>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;

  const cancelPending = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    controller?.abort();
    controller = null;
  };

  const update = (point: readonly [number, number] | null) => {
    generation += 1;
    cancelPending();
    if (!point || !isEnabled()) {
      emit(null);
      return;
    }
    const key = cacheKey(point);
    if (cache.has(key)) {
      const cached = cache.get(key) ?? null;
      cache.delete(key);
      cache.set(key, cached);
      emit(cached);
      return;
    }
    const requested = generation;
    timer = setTimeout(() => {
      timer = null;
      const mine = new AbortController();
      controller = mine;
      void (async () => {
        let place: WhereAmIPlace | null;
        try {
          place = await lookupWhereAmI(config, point, fetchImpl, mine.signal);
        } catch {
          return;
        }
        if (cache.size >= WHERE_AM_I_CACHE_LIMIT) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, place);
        if (requested !== generation || !isEnabled()) return;
        emit(place);
      })();
    }, debounceMs);
  };

  const invalidate = () => {
    generation += 1;
    cancelPending();
  };

  return { update, invalidate, dispose: invalidate };
}
