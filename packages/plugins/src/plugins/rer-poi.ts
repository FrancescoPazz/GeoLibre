import {
  DEFAULT_LAYER_STYLE,
  useAppStore,
  type GeoLibreLayer,
  type MapViewState,
} from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreAppAPI } from "../types";

/**
 * Points of interest of the Emilia-Romagna 3D geoportal: a large ArcGIS
 * point layer (localities, peaks, waters, industrial sites …) that only
 * makes sense drawn *by level* — every point carries a `LEVEL_ID`, the
 * zoom at which it becomes worth showing, so a view at zoom 8 asks for the
 * capitals and a view at zoom 14 for every hamlet.
 *
 * The layer is an ordinary GeoJSON layer in the store, refilled from the
 * service whenever the view settles: the query is the view's extent padded
 * a little, with `LEVEL_ID` restricted to the levels at or below the current
 * zoom, paged on the service's page size; a request is skipped while the
 * camera is tilted past the configured limit, where the extent would cover
 * half the region. Each point takes its marker colour from the domain
 * styles (`ID_DOMINIO` → simplestyle) and is labelled with its name once
 * few enough are on screen. Every knob mirrors the old `rer-poi` catalog
 * item's traits, so a catalog entry drives this unchanged.
 */

export const RER_POI_SOURCE_KIND = "rer-poi";

export interface RerPoiOptions {
  /** The layer: `.../MapServer/<n>` or `.../FeatureServer/<n>`. */
  url: string;
  name: string;
  /** A fixed `where` clause AND-ed with the level filter. */
  where?: string;
  nameField: string;
  levelIdField: string;
  domainIdField: string;
  minLevelId?: number;
  maxLevelId?: number;
  clustering: boolean;
  /** Labels are shown while fewer points than this are loaded. */
  labelVisibilityThreshold: number;
  labelTextColor: string;
  labelFontSize: number;
  labelOutlineWidth: number;
  labelOutlineColor: string;
  /** The view extent is grown by this fraction on each side before querying. */
  queryBboxPaddingRatio: number;
  dynamicRequestDebounceMs: number;
  /** No request while the camera is tilted beyond this many degrees from the vertical. */
  cameraTiltLimitDegrees: number;
  defaultMarkerColor: string;
  markerSize: number;
  /** `ID_DOMINIO` value → simplestyle (`marker-color`, `marker-symbol`). */
  perPropertyStyles: Array<{ properties: Record<string, unknown>; style: Record<string, unknown> }>;
  featuresPerRequest: number;
}

export const DEFAULT_RER_POI_OPTIONS: Omit<RerPoiOptions, "url" | "name"> = {
  nameField: "NOME",
  levelIdField: "LEVEL_ID",
  domainIdField: "ID_DOMINIO",
  clustering: false,
  labelVisibilityThreshold: 100,
  labelTextColor: "#ffffff",
  labelFontSize: 10,
  labelOutlineWidth: 4,
  labelOutlineColor: "rgba(0, 0, 0, 0.5)",
  queryBboxPaddingRatio: 0.2,
  dynamicRequestDebounceMs: 350,
  cameraTiltLimitDegrees: 60,
  defaultMarkerColor: "royalblue",
  markerSize: 48,
  perPropertyStyles: [],
  featuresPerRequest: 1000,
};

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Options from a TerriaJS `rer-poi` catalog entry (its raw keys), defaults filled in. */
export function rerPoiOptionsFromCatalogItem(item: {
  name: string;
  url?: string;
  extra?: Record<string, unknown>;
  perPropertyStyles?: RerPoiOptions["perPropertyStyles"];
  clustering?: boolean;
}): RerPoiOptions | null {
  if (!item.url) return null;
  const e = item.extra ?? {};
  return {
    ...DEFAULT_RER_POI_OPTIONS,
    url: item.url,
    name: item.name,
    where: str(e.where),
    nameField: str(e.nameField) ?? DEFAULT_RER_POI_OPTIONS.nameField,
    levelIdField: str(e.levelIdField) ?? DEFAULT_RER_POI_OPTIONS.levelIdField,
    domainIdField: str(e.domainIdField) ?? DEFAULT_RER_POI_OPTIONS.domainIdField,
    minLevelId: num(e.minLevelId),
    maxLevelId: num(e.maxLevelId),
    clustering: item.clustering ?? false,
    labelVisibilityThreshold:
      num(e.labelVisibilityThreshold) ?? DEFAULT_RER_POI_OPTIONS.labelVisibilityThreshold,
    labelTextColor: str(e.labelTextColor) ?? DEFAULT_RER_POI_OPTIONS.labelTextColor,
    labelFontSize: num(e.labelFontSize) ?? DEFAULT_RER_POI_OPTIONS.labelFontSize,
    labelOutlineWidth: num(e.labelOutlineWidth) ?? DEFAULT_RER_POI_OPTIONS.labelOutlineWidth,
    labelOutlineColor: str(e.labelOutlineColor) ?? DEFAULT_RER_POI_OPTIONS.labelOutlineColor,
    queryBboxPaddingRatio:
      num(e.queryBboxPaddingRatio) ?? DEFAULT_RER_POI_OPTIONS.queryBboxPaddingRatio,
    dynamicRequestDebounceMs:
      num(e.dynamicRequestDebounceMs) ?? DEFAULT_RER_POI_OPTIONS.dynamicRequestDebounceMs,
    cameraTiltLimitDegrees:
      num(e.cameraTiltLimitDegrees) ?? DEFAULT_RER_POI_OPTIONS.cameraTiltLimitDegrees,
    defaultMarkerColor: str(e.defaultMarkerColor) ?? DEFAULT_RER_POI_OPTIONS.defaultMarkerColor,
    markerSize: num(e.markerSize) ?? DEFAULT_RER_POI_OPTIONS.markerSize,
    perPropertyStyles: item.perPropertyStyles ?? [],
    featuresPerRequest: num(e.featuresPerRequest) ?? DEFAULT_RER_POI_OPTIONS.featuresPerRequest,
  };
}

/** `[west, south, east, north]` grown by `ratio` of its width/height on each side, clamped to the world. */
export function padExtent(
  extent: readonly [number, number, number, number],
  ratio: number,
): [number, number, number, number] {
  const [w, s, e, n] = extent;
  const dx = (e - w) * ratio;
  const dy = (n - s) * ratio;
  return [
    Math.max(-180, w - dx),
    Math.max(-90, s - dy),
    Math.min(180, e + dx),
    Math.min(90, n + dy),
  ];
}

/**
 * The levels to ask for at `zoom`: every known level at or below it, within
 * the configured bounds. Levels are the service's distinct `LEVEL_ID`
 * values (strings on the real service, so the clause is an `IN` list of
 * quoted values rather than a numeric comparison that would sort text).
 */
export function levelsForZoom(
  knownLevels: readonly number[],
  zoom: number,
  options: Pick<RerPoiOptions, "minLevelId" | "maxLevelId">,
): number[] {
  const ceiling = Math.min(Math.round(zoom), options.maxLevelId ?? Number.POSITIVE_INFINITY);
  const floor = options.minLevelId ?? Number.NEGATIVE_INFINITY;
  return knownLevels.filter((level) => level >= floor && level <= ceiling).sort((a, b) => a - b);
}

/** The `where` clause: the fixed one AND the level list; `1=1` when neither applies. */
export function rerPoiWhere(
  options: Pick<RerPoiOptions, "where" | "levelIdField">,
  levels: readonly number[],
): string {
  const clauses: string[] = [];
  if (options.where) clauses.push(`(${options.where})`);
  if (levels.length > 0) {
    clauses.push(`(${options.levelIdField} IN (${levels.map((l) => `'${l}'`).join(",")}))`);
  }
  return clauses.length ? clauses.join(" AND ") : "1=1";
}

function layerUrl(url: string): string {
  const trimmed = url.replace(/\?.*$/, "").replace(/\/+$/, "");
  if (!/\/(FeatureServer|MapServer)\/\d+$/i.test(trimmed)) {
    throw new Error(`A RER POI url must point at a layer of a MapServer or FeatureServer: ${url}`);
  }
  return trimmed;
}

/** The GeoJSON query for one page of points within `extent`. */
export function rerPoiQueryUrl(
  options: Pick<RerPoiOptions, "url" | "where" | "levelIdField" | "featuresPerRequest">,
  levels: readonly number[],
  extent: readonly [number, number, number, number],
  offset: number,
): string {
  const url = new URL(`${layerUrl(options.url)}/query`);
  url.searchParams.set("f", "geojson");
  url.searchParams.set("where", rerPoiWhere(options, levels));
  url.searchParams.set("outFields", "*");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("geometry", extent.map((v) => v.toFixed(6)).join(","));
  url.searchParams.set("geometryType", "esriGeometryEnvelope");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  url.searchParams.set("returnGeometry", "true");
  url.searchParams.set("resultRecordCount", String(options.featuresPerRequest));
  url.searchParams.set("resultOffset", String(offset));
  return url.toString();
}

/** The query for the distinct values of `field` (the level range, the enums). */
export function rerPoiDistinctUrl(url: string, field: string): string {
  const u = new URL(`${layerUrl(url)}/query`);
  u.searchParams.set("f", "json");
  u.searchParams.set("where", "1=1");
  u.searchParams.set("outFields", field);
  u.searchParams.set("orderByFields", field);
  u.searchParams.set("returnDistinctValues", "true");
  u.searchParams.set("returnGeometry", "false");
  return u.toString();
}

/** The simplestyle a point takes from its domain, or the default colour. */
export function rerPoiFeatureStyle(
  properties: Record<string, unknown>,
  options: Pick<RerPoiOptions, "domainIdField" | "perPropertyStyles" | "defaultMarkerColor">,
): { "marker-color": string; "marker-symbol"?: string } {
  const value = properties[options.domainIdField];
  const match = options.perPropertyStyles.find((entry) =>
    Object.entries(entry.properties).every(([k, v]) => String(properties[k]) === String(v)),
  );
  const color = str(match?.style["marker-color"]) ?? options.defaultMarkerColor;
  const symbol = str(match?.style["marker-symbol"]);
  void value;
  return symbol ? { "marker-color": color, "marker-symbol": symbol } : { "marker-color": color };
}

/** Stamp each point with its simplestyle so the layer's per-feature styling draws it. */
export function styleRerPoiFeatures(
  features: readonly Feature[],
  options: Pick<RerPoiOptions, "domainIdField" | "perPropertyStyles" | "defaultMarkerColor">,
): Feature[] {
  return features.map((feature) => ({
    ...feature,
    properties: {
      ...(feature.properties ?? {}),
      ...rerPoiFeatureStyle(feature.properties ?? {}, options),
    },
  }));
}

/** The store layer for a POI source: an empty GeoJSON layer styled for pins and labels. */
export function createRerPoiLayer(options: RerPoiOptions, id?: string): GeoLibreLayer {
  const layerId =
    id ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `rer-poi-${Date.now()}`);
  return {
    id: layerId,
    name: options.name,
    type: "geojson",
    source: { url: options.url },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      simpleStyleEnabled: true,
      markerEnabled: true,
      markerShape: "pin",
      markerColor: options.defaultMarkerColor,
      markerSize: Math.max(8, Math.round(options.markerSize / 2)),
      pointRenderer: options.clustering ? "cluster" : "single",
      labels: {
        ...DEFAULT_LAYER_STYLE.labels,
        enabled: false,
        field: options.nameField,
        size: options.labelFontSize,
        color: options.labelTextColor,
        haloColor: options.labelOutlineColor,
        haloWidth: options.labelOutlineWidth,
      },
    },
    geojson: { type: "FeatureCollection", features: [] },
    capabilities: { create: false, update: false, delete: false },
    metadata: {
      sourceKind: RER_POI_SOURCE_KIND,
      rerPoi: options,
      identifiable: true,
    },
  };
}

// --- Loader ------------------------------------------------------------------

interface Loader {
  layerId: string;
  options: RerPoiOptions;
  levels: number[] | null;
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  sequence: number;
  /** Last extent + levels served; a view inside it with the same levels needs no request. */
  served: { extent: [number, number, number, number]; key: string } | null;
  dispose: () => void;
}

const loaders = new Map<string, Loader>();
let fetchImpl: typeof globalThis.fetch | null = null;

/** Replace the fetch the loaders use (tests). */
export function setRerPoiFetch(next: typeof globalThis.fetch | null): void {
  fetchImpl = next;
}

const doFetch = (url: string, signal?: AbortSignal) => (fetchImpl ?? fetch)(url, { signal });

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await doFetch(url, signal);
  if (!response.ok) throw new Error(`RER POI: HTTP ${response.status}`);
  const text = await response.text();
  if (/^\s*</.test(text)) throw new Error("RER POI: the service answered HTML, not JSON");
  return JSON.parse(text) as unknown;
}

async function loadLevels(options: RerPoiOptions, signal?: AbortSignal): Promise<number[]> {
  const data = (await fetchJson(rerPoiDistinctUrl(options.url, options.levelIdField), signal)) as {
    features?: Array<{ attributes?: Record<string, unknown> }>;
  };
  const values = (data.features ?? [])
    .map((f) => Number(f.attributes?.[options.levelIdField]))
    .filter((n) => Number.isFinite(n));
  return [...new Set(values)].sort((a, b) => a - b);
}

function containsExtent(
  outer: readonly [number, number, number, number],
  inner: readonly [number, number, number, number],
): boolean {
  return (
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3]
  );
}

function viewOf(
  app: GeoLibreAppAPI,
): { extent: [number, number, number, number]; view: MapViewState } | null {
  const bounds = app.getViewBounds?.();
  const view = useAppStore.getState().mapView;
  if (!bounds) return null;
  return { extent: [bounds[0], bounds[1], bounds[2], bounds[3]], view };
}

async function reload(app: GeoLibreAppAPI, loader: Loader): Promise<void> {
  const state = useAppStore.getState();
  const layer = state.layers.find((l) => l.id === loader.layerId);
  if (!layer || !layer.visible) return;
  const current = viewOf(app);
  if (!current) return;
  if (current.view.pitch > loader.options.cameraTiltLimitDegrees) return;
  loader.abort?.abort();
  const controller = new AbortController();
  loader.abort = controller;
  const sequence = ++loader.sequence;
  try {
    if (!loader.levels) loader.levels = await loadLevels(loader.options, controller.signal);
    if (sequence !== loader.sequence) return;
    const levels = levelsForZoom(loader.levels, current.view.zoom, loader.options);
    const key = levels.join(",");
    const extent = padExtent(current.extent, loader.options.queryBboxPaddingRatio);
    if (
      loader.served &&
      loader.served.key === key &&
      containsExtent(loader.served.extent, current.extent)
    ) {
      return;
    }
    const features: Feature[] = [];
    for (let offset = 0; ; offset += loader.options.featuresPerRequest) {
      const page = (await fetchJson(
        rerPoiQueryUrl(loader.options, levels, extent, offset),
        controller.signal,
      )) as FeatureCollection & {
        exceededTransferLimit?: boolean;
        properties?: { exceededTransferLimit?: boolean };
      };
      if (sequence !== loader.sequence) return;
      features.push(...(page.features ?? []));
      const more =
        (page.exceededTransferLimit ?? page.properties?.exceededTransferLimit ?? false) &&
        (page.features?.length ?? 0) >= loader.options.featuresPerRequest;
      if (!more || features.length >= 20 * loader.options.featuresPerRequest) break;
    }
    const styled = styleRerPoiFeatures(features, loader.options);
    const live = useAppStore.getState().layers.find((l) => l.id === loader.layerId);
    if (!live || sequence !== loader.sequence) return;
    const showLabels = styled.length < loader.options.labelVisibilityThreshold;
    useAppStore.getState().updateLayer(loader.layerId, {
      geojson: { type: "FeatureCollection", features: styled },
      style:
        live.style.labels.enabled === showLabels
          ? live.style
          : { ...live.style, labels: { ...live.style.labels, enabled: showLabels } },
    });
    loader.served = { extent, key };
  } catch (error) {
    if (controller.signal.aborted) return;
    console.warn("[GeoLibre] RER POI reload failed", error);
  }
}

function schedule(app: GeoLibreAppAPI, loader: Loader, immediate = false): void {
  if (loader.timer) clearTimeout(loader.timer);
  loader.timer = setTimeout(
    () => {
      loader.timer = null;
      void reload(app, loader);
    },
    immediate ? 0 : loader.options.dynamicRequestDebounceMs,
  );
}

/** Start refilling `layerId` from the service as the view settles. */
export function startRerPoiLoader(
  app: GeoLibreAppAPI,
  layerId: string,
  options: RerPoiOptions,
): () => void {
  stopRerPoiLoader(layerId);
  const loader: Loader = {
    layerId,
    options,
    levels: null,
    timer: null,
    abort: null,
    sequence: 0,
    served: null,
    dispose: () => {},
  };
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (!state.layers.some((l) => l.id === layerId)) {
      stopRerPoiLoader(layerId);
      return;
    }
    const layer = state.layers.find((l) => l.id === layerId);
    const was = previous.layers.find((l) => l.id === layerId);
    if (state.mapView !== previous.mapView || (layer?.visible && !was?.visible)) {
      schedule(app, loader);
    }
  });
  loader.dispose = () => {
    unsubscribe();
    if (loader.timer) clearTimeout(loader.timer);
    loader.abort?.abort();
  };
  loaders.set(layerId, loader);
  schedule(app, loader, true);
  return () => stopRerPoiLoader(layerId);
}

export function stopRerPoiLoader(layerId: string): void {
  const loader = loaders.get(layerId);
  if (!loader) return;
  loaders.delete(layerId);
  loader.dispose();
}

/** Whether a loader is running for `layerId`. */
export function isRerPoiLoaderActive(layerId: string): boolean {
  return loaders.has(layerId);
}

/** Add a POI layer to the map and start its loader; the layer id. */
export function addRerPoiLayer(app: GeoLibreAppAPI, options: RerPoiOptions): string {
  const layer = createRerPoiLayer(options);
  useAppStore.getState().addLayer(layer);
  startRerPoiLoader(app, layer.id, options);
  return layer.id;
}

/**
 * Re-attach loaders for POI layers in a reopened project: their options
 * round-trip in `metadata.rerPoi`, the features do not (they are the view's).
 */
export function restoreRerPoiLayers(app: GeoLibreAppAPI): void {
  for (const layer of useAppStore.getState().layers) {
    if (layer.metadata.sourceKind !== RER_POI_SOURCE_KIND || loaders.has(layer.id)) continue;
    const options = layer.metadata.rerPoi as RerPoiOptions | undefined;
    if (!options || typeof options.url !== "string") continue;
    startRerPoiLoader(app, layer.id, { ...DEFAULT_RER_POI_OPTIONS, ...options });
  }
}

/** The distinct values of `field` on the service, for the query tools' enums. */
export async function fetchRerPoiDistinctValues(
  url: string,
  field: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const data = (await fetchJson(rerPoiDistinctUrl(url, field), signal)) as {
    features?: Array<{ attributes?: Record<string, unknown> }>;
  };
  return (data.features ?? [])
    .map((f) => f.attributes?.[field])
    .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
    .map(String);
}
