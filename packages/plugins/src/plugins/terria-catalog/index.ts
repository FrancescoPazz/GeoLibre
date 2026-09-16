import {
  USE_AUTHENTICATION_METADATA_KEY,
  canAccessGroups,
  createCesiumIonLayer,
  getGeoportalSession,
  getRuntimeEnvironment,
  isGeoportalAuthenticated,
  subscribeGeoportalSession,
  useAppStore,
  type GeoLibreLayer,
  type LayerPopupConfig,
  type LayerStyle,
  type PopupFieldConfig,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import { addArcGISLayer, fetchArcGISMapServiceSublayers } from "../arcgis-layer";
import { addRerPoiLayer, rerPoiOptionsFromCatalogItem } from "../rer-poi";
import {
  catalogNodeMatchesQuery,
  filterCatalog,
  findCatalogNode,
  parseTerriaCatalogText,
  type CatalogFeatureInfo,
  type CatalogGroup,
  type CatalogItem,
  type CatalogNode,
  type TerriaCatalog,
} from "./catalog-model";
import { parseWmtsCapabilities, wmtsCapabilitiesUrl, wmtsTileTemplate } from "./wmts-capabilities";

/**
 * Catalog: a browsable tree of a geoportal's data services, read from one
 * or more TerriaJS init files (`{ "catalog": [...] }`).
 *
 * The tree is the declaration a TerriaJS geoportal ships — groups, WMS,
 * WMTS and ArcGIS map services, nested as its curators arranged them — and
 * GeoLibre has no built-in notion of "available but not loaded" data. This
 * plugin gives it one without touching the project format: the panel lists
 * the tree, opening an item adds an ordinary layer through the host API,
 * and the layer is tagged with its catalog id so the panel marks it and can
 * remove it again. The catalog URLs come from the deployment
 * (`CATALOG_URLS`), from the panel, or from the project file.
 */

export const TERRIA_CATALOG_PLUGIN_ID = "terria-catalog";
const PANEL_ID = TERRIA_CATALOG_PLUGIN_ID;
/** Layer metadata key holding `{ source, item }` for a layer this plugin added. */
export const CATALOG_LAYER_METADATA_KEY = "terriaCatalog";
/** Layer metadata key holding the item's `queryableProperties`, for the query tools. */
export const QUERYABLE_PROPERTIES_METADATA_KEY = "queryableProperties";
/** Layer metadata key holding the item's per-profile popup fields. */
export const PER_PROFILE_FIELDS_METADATA_KEY = "perProfileInfoFields";
/** Layer metadata: the item's full popup field list, before any profile narrowing. */
export const POPUP_FIELDS_METADATA_KEY = "popupFields";
/** Layer metadata key holding the property the search box looks in. */
export const SEARCH_FIELD_METADATA_KEY = "searchField";

export interface TerriaCatalogLabels {
  title: string;
  hint: string;
  urlPlaceholder: string;
  load: string;
  loading: string;
  loadError: (url: string) => string;
  noCatalog: string;
  searchPlaceholder: string;
  noMatches: string;
  unsupported: (type: string) => string;
  /** The entry is restricted and the user is not signed in. */
  signInRequired: string;
  /** The entry is restricted to groups the signed-in user is not in. */
  accessDenied: string;
  /** Badge on a restricted entry the user may not open. */
  locked: string;
  /** The style picker on a WMS entry that lists the styles to choose from. */
  style: string;
  /** The panel checkbox: fly to an entry's extent when it is added. */
  zoomOnAdd: string;
  add: string;
  remove: string;
  adding: (name: string) => string;
  added: (name: string) => string;
  removed: (name: string) => string;
  addError: (name: string) => string;
  expand: string;
  collapse: string;
  removeSource: string;
  home: string;
}

export const DEFAULT_TERRIA_CATALOG_LABELS: TerriaCatalogLabels = {
  title: "Catalog",
  hint: "Browse the catalog and click an entry to add it to the map; click it again to remove it.",
  urlPlaceholder: "Catalog URL (TerriaJS init JSON)",
  load: "Load",
  loading: "Loading catalog…",
  loadError: (url) => `Could not load the catalog at ${url}.`,
  noCatalog: "No catalog loaded. Enter the URL of a catalog file above.",
  searchPlaceholder: "Filter the catalog",
  noMatches: "Nothing matches.",
  unsupported: (type) => `Not supported here (${type})`,
  signInRequired: "Sign in to open this entry.",
  accessDenied: "Your account may not open this entry.",
  locked: "Restricted entry",
  style: "Style",
  zoomOnAdd: "Zoom to an entry when it is added",
  add: "Add to map",
  remove: "Remove from map",
  adding: (name) => `Adding ${name}…`,
  added: (name) => `Added ${name}.`,
  removed: (name) => `Removed ${name}.`,
  addError: (name) => `Could not add ${name}.`,
  expand: "Expand",
  collapse: "Collapse",
  removeSource: "Remove this catalog",
  home: "Go to the catalog's home view",
};

/** Network and layer-adding seams, replaceable for tests. */
export interface TerriaCatalogAdapters {
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>;
  /** POST a JSON body and read a JSON reply (the Google tile session). */
  postJson: (url: string, body: unknown) => Promise<unknown>;
  addArcGis: typeof addArcGISLayer;
  fetchArcGisSublayers: typeof fetchArcGISMapServiceSublayers;
}

const defaultAdapters: TerriaCatalogAdapters = {
  fetchText: async (url, signal) => {
    const response = await fetch(url, {
      signal,
      headers: { Accept: "application/json, text/plain, */*" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  },
  postJson: async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  addArcGis: addArcGISLayer,
  fetchArcGisSublayers: fetchArcGISMapServiceSublayers,
};

interface CatalogSource {
  url: string;
  catalog: TerriaCatalog | null;
  loading: boolean;
  error: string | null;
  /** Children resolved for `esri-mapServer-group` nodes, by node id. */
  resolvedGroups: Map<string, CatalogItem[]>;
}

export interface TerriaCatalogState {
  sources: Array<{ url: string; loaded: boolean; loading: boolean; error: string | null }>;
  /** The panel checkbox: fly to an entry when it is added. */
  zoomOnAdd: boolean;
  /** Catalog item ids currently on the map, with their layer ids. */
  added: Record<string, string>;
  busy: string[];
  status: string | null;
}

let appRef: GeoLibreAppAPI | null = null;
let adapters: TerriaCatalogAdapters = defaultAdapters;
let labels: TerriaCatalogLabels = { ...DEFAULT_TERRIA_CATALOG_LABELS };
let sources: CatalogSource[] = [];
const expanded = new Set<string>();
const busy = new Set<string>();
let query = "";
let status: string | null = null;
/**
 * Whether adding an entry also flies the map to its `rectangle` — the
 * geoportal previewed an entry by zooming to it; here the map is the
 * preview, so it is a choice in the panel, off by default.
 */
let zoomOnAdd = false;
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let rerender: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let unsubscribeSession: (() => void) | null = null;
let loadGeneration = 0;
/** Bumps when the search box changes so stale map-server prefetches don't redraw. */
let searchPrefetchGeneration = 0;
const listeners = new Set<() => void>();

export function setTerriaCatalogLabels(next: Partial<TerriaCatalogLabels>): void {
  labels = { ...DEFAULT_TERRIA_CATALOG_LABELS, ...next };
  rerender?.();
}

/** Replace the network/layer seams (tests). Pass nothing to restore the defaults. */
export function setTerriaCatalogAdapters(next?: Partial<TerriaCatalogAdapters>): void {
  adapters = { ...defaultAdapters, ...next };
}

export function subscribeTerriaCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
  rerender?.();
}

/** Layers on the map that this plugin added, keyed by `source|item`. */
function addedLayers(): Map<string, GeoLibreLayer> {
  const out = new Map<string, GeoLibreLayer>();
  for (const layer of useAppStore.getState().layers) {
    const tag = layer.metadata?.[CATALOG_LAYER_METADATA_KEY] as
      | { source?: unknown; item?: unknown }
      | undefined;
    if (tag && typeof tag.source === "string" && typeof tag.item === "string") {
      out.set(`${tag.source}|${tag.item}`, layer);
    }
  }
  return out;
}

export function getTerriaCatalogState(): TerriaCatalogState {
  const added: Record<string, string> = {};
  for (const [key, layer] of addedLayers()) added[key] = layer.id;
  return {
    sources: sources.map((s) => ({
      url: s.url,
      loaded: s.catalog !== null,
      loading: s.loading,
      error: s.error,
    })),
    added,
    busy: [...busy],
    status,
    zoomOnAdd,
  };
}

/** Fly to an entry's `rectangle` when it is added (the panel's checkbox). */
export function setCatalogZoomOnAdd(enabled: boolean): void {
  if (enabled === zoomOnAdd) return;
  zoomOnAdd = enabled;
  notify();
}

/** Catalog URLs the deployment names (`VITE_CATALOG_URLS` / `CATALOG_URLS`, comma or whitespace separated). */
export function deploymentCatalogUrls(env?: Record<string, string | undefined>): string[] {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = runtimeEnv.VITE_CATALOG_URLS ?? runtimeEnv.CATALOG_URLS ?? "";
  return raw
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//i.test(u) || u.startsWith("/") || u.startsWith("./"));
}

function resolveUrl(url: string): string {
  try {
    return new URL(url, typeof document !== "undefined" ? document.baseURI : undefined).href;
  } catch {
    return url;
  }
}

/** Load (or reload) the catalog at `url`, adding it to the sources when new. */
export async function loadCatalog(url: string): Promise<boolean> {
  const resolved = resolveUrl(url.trim());
  if (!resolved) return false;
  let source = sources.find((s) => s.url === resolved);
  if (!source) {
    source = {
      url: resolved,
      catalog: null,
      loading: false,
      error: null,
      resolvedGroups: new Map(),
    };
    sources = [...sources, source];
  }
  source.loading = true;
  source.error = null;
  const generation = ++loadGeneration;
  notify();
  try {
    const text = await adapters.fetchText(resolved);
    const catalog = parseTerriaCatalogText(text);
    if (!sources.includes(source)) return false;
    source.catalog = catalog;
    source.loading = false;
    for (const node of catalog.roots)
      if (node.kind === "group" && node.isOpen) expanded.add(node.id);
    notify();
    if (generation === loadGeneration) await applyWorkbench(source);
    return true;
  } catch (error) {
    if (!sources.includes(source)) return false;
    source.loading = false;
    source.error = error instanceof Error ? error.message : String(error);
    status = labels.loadError(resolved);
    notify();
    return false;
  }
}

export function removeCatalog(url: string): void {
  sources = sources.filter((s) => s.url !== url);
  notify();
}

/**
 * The file's initial workbench, honoured for an empty project only: a
 * project that already has layers keeps them, and a reopened project gets
 * its own layers back through the project file rather than the file's
 * defaults on top.
 */
async function applyWorkbench(source: CatalogSource): Promise<void> {
  const app = appRef;
  const catalog = source.catalog;
  if (!app || !catalog || catalog.workbench.length === 0) return;
  if (useAppStore.getState().layers.length > 0) return;
  for (const id of catalog.workbench) {
    const node = findCatalogNode(catalog.roots, id);
    if (node?.kind === "item" && node.supported) await addCatalogItem(source.url, node.id);
  }
  if (catalog.homeExtent) app.fitBounds?.(catalog.homeExtent);
}

function sourceOf(url: string): CatalogSource | undefined {
  return sources.find((s) => s.url === url);
}

/** Resolve the children of an ArcGIS map-service group: one item per sublayer. */
export async function expandMapServerGroup(
  sourceUrl: string,
  groupId: string,
): Promise<CatalogItem[]> {
  const source = sourceOf(sourceUrl);
  if (!source?.catalog) return [];
  const cached = source.resolvedGroups.get(groupId);
  if (cached) return cached;
  const node = findCatalogNode(source.catalog.roots, groupId);
  if (!node || node.kind !== "item" || node.type !== "esri-mapServer-group" || !node.url) return [];
  busy.add(groupId);
  notify();
  try {
    const sublayers = await adapters.fetchArcGisSublayers({ url: node.url });
    const children: CatalogItem[] = sublayers.map((sub) => ({
      kind: "item",
      id: `${groupId}/${sub.id}`,
      name: sub.name,
      styleNamesBeforeTitles: false,
      type: "esri-mapServer",
      supported: true,
      url: node.url,
      layers: String(sub.id),
      attribution: node.attribution,
      opacity: node.opacity,
      inWorkbench: false,
      allowedGroups: node.allowedGroups,
      hideWhenUnauthorized: node.hideWhenUnauthorized,
      useAuthentication: node.useAuthentication,
      disableExport: node.disableExport,
      clustering: false,
      extra: {},
    }));
    source.resolvedGroups.set(groupId, children);
    return children;
  } catch (error) {
    status = error instanceof Error ? error.message : String(error);
    return [];
  } finally {
    busy.delete(groupId);
    notify();
  }
}

function findItem(source: CatalogSource, itemId: string): CatalogItem | null {
  if (!source.catalog) return null;
  const node = findCatalogNode(source.catalog.roots, itemId);
  if (node?.kind === "item") return node;
  for (const children of source.resolvedGroups.values()) {
    const child = children.find((c) => c.id === itemId);
    if (child) return child;
  }
  return null;
}

/** Sublayer ids for an ArcGIS item's `layers`, mapping names to ids through the service. */
async function arcgisSublayerIds(item: CatalogItem): Promise<string | undefined> {
  if (!item.layers || !item.url) return undefined;
  const wanted = item.layers
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.every((w) => /^\d+$/.test(w))) return wanted.join(",");
  const sublayers = await adapters.fetchArcGisSublayers({ url: item.url });
  const ids = wanted.map((w) => {
    if (/^\d+$/.test(w)) return w;
    const match =
      sublayers.find((s) => s.name === w) ??
      sublayers.find((s) => s.name.toLowerCase() === w.toLowerCase());
    return match ? String(match.id) : null;
  });
  const resolved = ids.filter((id): id is string => id !== null);
  return resolved.length ? resolved.join(",") : undefined;
}

/** The WMS style an item is drawn with: the chosen one, else `styles`, else the first of `stylesToUse`. */
export function catalogItemWmsStyle(item: CatalogItem, chosen?: string): string | undefined {
  if (chosen && (!item.stylesToUse || item.stylesToUse.includes(chosen))) return chosen;
  return item.styles ?? item.stylesToUse?.[0];
}

/** How the style picker labels a style: its title when known and wanted, else its name. */
export function catalogItemStyleLabel(item: CatalogItem, style: string): string {
  if (item.styleNamesBeforeTitles) return style;
  return item.styleTitles?.[style] ?? style;
}

async function addLayerFor(
  app: GeoLibreAppAPI,
  item: CatalogItem,
  options: { style?: string } = {},
): Promise<string> {
  const common = {
    attribution: item.attribution,
    opacity: item.opacity,
    tileSize: item.tileSize,
  };
  switch (item.type) {
    case "wms": {
      if (!item.url || !item.layers) throw new Error("WMS item without url or layers");
      const id = app.addWmsLayer?.(item.name, {
        url: item.url,
        layers: item.layers,
        styles: catalogItemWmsStyle(item, options.style),
        format: item.parameters?.format ?? item.parameters?.FORMAT,
        version: item.parameters?.version ?? item.parameters?.VERSION,
        transparent: true,
        ...common,
      });
      if (!id) throw new Error("addWmsLayer unavailable");
      return id;
    }
    case "wmts": {
      if (!item.url || !item.layers) throw new Error("WMTS item without url or layer");
      const xml = await adapters.fetchText(wmtsCapabilitiesUrl(item.url));
      const tile = wmtsTileTemplate(parseWmtsCapabilities(xml), item.layers, item.url);
      if (!tile) throw new Error(`WMTS layer ${item.layers} not found or not in Web Mercator`);
      const id = app.addWmtsLayer?.(item.name, tile.template, { ...common, maxzoom: tile.maxZoom });
      if (!id) throw new Error("addWmtsLayer unavailable");
      return id;
    }
    case "esri-mapServer": {
      if (!item.url) throw new Error("ArcGIS item without url");
      const sublayers = await arcgisSublayerIds(item);
      return adapters.addArcGis(app, {
        layerType: "map-service",
        sourceType: "url",
        url: item.url,
        sublayers,
        name: item.name,
        zoomTo: false,
      });
    }
    case "geojson": {
      if (!item.url) throw new Error("GeoJSON item without url");
      const text = await adapters.fetchText(item.url);
      const data = JSON.parse(text) as FeatureCollection;
      if (data?.type !== "FeatureCollection") throw new Error("Not a FeatureCollection");
      return app.addGeoJsonLayer(item.name, data, item.url);
    }
    case "3d-tiles": {
      if (item.ionAssetId === undefined) throw new Error("3D Tiles item without an Ion asset id");
      const layer = createCesiumIonLayer({
        name: item.name,
        assetId: item.ionAssetId,
        kind: "3d-tiles",
      });
      useAppStore.getState().addLayer(layer);
      return layer.id;
    }
    case "rer-poi": {
      const options = rerPoiOptionsFromCatalogItem(item);
      if (!options) throw new Error("POI item without url");
      return addRerPoiLayer(app, options);
    }
    case "google-tile-maps": {
      // Google's 2D Map Tiles API: a session token per map type, language
      // and region, then plain XYZ tiles carrying the session and the key.
      const google = item.googleTiles;
      if (!google) throw new Error("Google tile item without key");
      const session = (await adapters.postJson(
        `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(google.key)}`,
        {
          mapType: google.mapType,
          language: google.language ?? "",
          region: google.region ?? "",
        },
      )) as { session?: unknown } | null;
      if (!session || typeof session.session !== "string" || !session.session)
        throw new Error("Google tile session not granted");
      const template =
        `https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}` +
        `?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(google.key)}`;
      const id = app.addTileLayer?.(item.name, template, {
        ...common,
        attribution: item.attribution ?? "Google",
        maxzoom: 22,
      });
      if (!id) throw new Error("addTileLayer unavailable");
      return id;
    }
    case "open-street-map": {
      if (!item.url) throw new Error("Tile item without url");
      const template = /\{z\}/.test(item.url)
        ? item.url
        : `${item.url.replace(/\/$/, "")}/{z}/{x}/{y}.png`;
      const id = app.addTileLayer?.(item.name, template, common);
      if (!id) throw new Error("addTileLayer unavailable");
      return id;
    }
    default:
      throw new Error(labels.unsupported(item.type));
  }
}

/** The popup configuration a TerriaJS `featureInfoTemplate` amounts to. */
export function popupConfigFromFeatureInfo(info: CatalogFeatureInfo): LayerPopupConfig {
  const popup: LayerPopupConfig = {};
  const title = info.name?.trim();
  if (title) {
    const single = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(title);
    if (single) popup.titleField = single[1];
    else if (!title.includes("{{")) popup.titleExpression = JSON.stringify(title);
  }
  if (info.partials) {
    popup.fields = Object.entries(info.partials).map(([field, label]): PopupFieldConfig => {
      const format = info.formats?.[field];
      const config: PopupFieldConfig = { field, label };
      if (format?.type === "number") {
        config.kind = "number";
        config.format = { thousands: format.useGrouping === true };
      } else if (format?.type === "dateTime" || format?.type === "date") {
        config.kind = "date";
        config.format = { dateFormat: format.type === "date" ? "date" : "datetime" };
      }
      return config;
    });
  }
  return popup;
}

/**
 * The popup fields a profile may see: the item's field list narrowed to the
 * profile's allowance (`"undefined"` names the anonymous user), or all of
 * them when the profile is not listed there.
 */
export function popupFieldsForProfile(
  fields: readonly PopupFieldConfig[] | undefined,
  perProfile: Record<string, string[]> | undefined,
  profile: string | null,
): PopupFieldConfig[] | undefined {
  if (!perProfile) return fields ? [...fields] : undefined;
  const allowed = perProfile[profile ?? "undefined"];
  if (!allowed) return fields ? [...fields] : undefined;
  const allowedSet = new Set(allowed);
  const base = fields ?? allowed.map((field): PopupFieldConfig => ({ field }));
  return base.filter((f) => allowedSet.has(f.field));
}

/** What a catalog item asks of the layer beyond its data: style, popup, capabilities, metadata. */
function configureLayerFromItem(
  layerId: string,
  item: CatalogItem,
  sourceUrl: string,
  style?: string,
): void {
  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const patch: Partial<GeoLibreLayer> = {};
  const metadata: Record<string, unknown> = {
    ...layer.metadata,
    [CATALOG_LAYER_METADATA_KEY]: {
      source: sourceUrl,
      item: item.id,
      ...(style ? { style } : {}),
    },
  };
  if (item.useAuthentication) metadata[USE_AUTHENTICATION_METADATA_KEY] = true;
  if (item.queryableProperties)
    metadata[QUERYABLE_PROPERTIES_METADATA_KEY] = item.queryableProperties;
  if (item.featureInfo?.perProfileInfoFields) {
    metadata[PER_PROFILE_FIELDS_METADATA_KEY] = item.featureInfo.perProfileInfoFields;
  }
  if (item.searchField) metadata[SEARCH_FIELD_METADATA_KEY] = item.searchField;
  patch.metadata = metadata;
  if (item.disableExport) patch.capabilities = { ...(layer.capabilities ?? {}), export: false };
  if (item.featureInfo) {
    const popup = popupConfigFromFeatureInfo(item.featureInfo);
    if (!popup.titleField && !popup.titleExpression && item.searchField)
      popup.titleField = item.searchField;
    if (item.featureInfo.perProfileInfoFields) {
      // Keep the whole list: the profile can change after the layer is added.
      metadata[POPUP_FIELDS_METADATA_KEY] = popup.fields ?? [];
      popup.fields = popupFieldsForProfile(
        popup.fields,
        item.featureInfo.perProfileInfoFields,
        getGeoportalSession().profile,
      );
    }
    patch.popup = popup;
  } else if (item.searchField) {
    patch.popup = { ...(layer.popup ?? {}), titleField: item.searchField };
  }
  if (item.type === "geojson") {
    const style: LayerStyle = { ...layer.style };
    let changed = false;
    if (item.clustering && style.pointRenderer === "single") {
      style.pointRenderer = "cluster";
      changed = true;
    }
    // TerriaJS perPropertyStyles: one colour per matched property value, as a
    // categorized style on the first property the entries agree on.
    const entries = item.perPropertyStyles ?? [];
    const property = entries.length ? Object.keys(entries[0].properties)[0] : undefined;
    if (
      property &&
      entries.every((e) => Object.keys(e.properties).length === 1 && property in e.properties)
    ) {
      const stops = entries
        .map((e) => {
          const color = e.style["marker-color"] ?? e.style.fill ?? e.style.stroke;
          const value = e.properties[property];
          return typeof color === "string" &&
            (typeof value === "string" || typeof value === "number")
            ? { value, color }
            : null;
        })
        .filter((stop): stop is { value: string | number; color: string } => stop !== null);
      if (stops.length) {
        style.vectorStyleMode = "categorized";
        style.vectorStyleProperty = property;
        style.vectorStyleStops = stops;
        changed = true;
      }
    }
    const fill = item.style?.fill ?? item.style?.["marker-color"];
    if (typeof fill === "string") {
      style.fillColor = fill;
      style.markerColor = fill;
      changed = true;
    }
    const stroke = item.style?.stroke;
    if (typeof stroke === "string") {
      style.strokeColor = stroke;
      changed = true;
    }
    if (changed) patch.style = style;
  }
  if (item.useAuthentication) {
    const authorization = getGeoportalSession().authorization;
    if (authorization) {
      patch.source = {
        ...layer.source,
        requestHeaders: {
          ...((layer.source.requestHeaders as object) ?? {}),
          Authorization: authorization,
        },
      };
    }
  }
  store.updateLayer(layerId, patch);
}

/**
 * Bring every layer the catalog tagged in line with the session: the
 * Authorization header on layers whose service is asked with it (added on
 * sign-in, removed on sign-out — also for layers a project file restored),
 * and the popup fields the current profile may see. Layers already in line
 * are left untouched, so calling this after any change converges.
 */
export function applyGeoportalSessionToLayers(): void {
  const store = useAppStore.getState();
  const { authorization, profile } = getGeoportalSession();
  for (const layer of store.layers) {
    const patch: Partial<GeoLibreLayer> = {};
    if (layer.metadata[USE_AUTHENTICATION_METADATA_KEY] === true) {
      const headers = (layer.source.requestHeaders ?? {}) as Record<string, string>;
      if (authorization && headers.Authorization !== authorization) {
        patch.source = {
          ...layer.source,
          requestHeaders: { ...headers, Authorization: authorization },
        };
      } else if (!authorization && headers.Authorization !== undefined) {
        const { Authorization: _dropped, ...rest } = headers;
        patch.source = {
          ...layer.source,
          requestHeaders: Object.keys(rest).length ? rest : undefined,
        };
      }
    }
    const perProfile = layer.metadata[PER_PROFILE_FIELDS_METADATA_KEY] as
      | Record<string, string[]>
      | undefined;
    const fields = layer.metadata[POPUP_FIELDS_METADATA_KEY] as PopupFieldConfig[] | undefined;
    if (perProfile && fields) {
      const next = popupFieldsForProfile(fields, perProfile, profile) ?? [];
      const current = layer.popup?.fields ?? [];
      const same =
        next.length === current.length && next.every((f, i) => f.field === current[i]?.field);
      if (!same) patch.popup = { ...(layer.popup ?? {}), fields: next };
    }
    if (Object.keys(patch).length) store.updateLayer(layer.id, patch);
  }
}

/** Whether the user may open the item now; sets the status line when not. */
function checkAccess(item: CatalogItem): boolean {
  if (canAccessGroups(item.allowedGroups)) return true;
  status = isGeoportalAuthenticated() ? labels.accessDenied : labels.signInRequired;
  notify();
  return false;
}

/**
 * Add the catalog item to the map as a layer tagged with its catalog id.
 * `style` picks one of a WMS item's `stylesToUse` for this add.
 */
export async function addCatalogItem(
  sourceUrl: string,
  itemId: string,
  options: { style?: string } = {},
): Promise<string | null> {
  const app = appRef;
  const source = sourceOf(sourceUrl);
  const item = source ? findItem(source, itemId) : null;
  if (!app || !item || !item.supported) return null;
  const key = `${sourceUrl}|${itemId}`;
  if (addedLayers().has(key) || busy.has(itemId)) return null;
  if (!checkAccess(item)) return null;
  busy.add(itemId);
  status = labels.adding(item.name);
  notify();
  try {
    const layerId = await addLayerFor(app, item, options);
    if (!appRef) return null;
    const style = item.type === "wms" ? catalogItemWmsStyle(item, options.style) : undefined;
    configureLayerFromItem(layerId, item, sourceUrl, style);
    if (zoomOnAdd && item.extent) app.fitBounds?.(item.extent);
    status = labels.added(item.name);
    return layerId;
  } catch (error) {
    status = `${labels.addError(item.name)} ${error instanceof Error ? error.message : String(error)}`;
    return null;
  } finally {
    busy.delete(itemId);
    notify();
  }
}

/** Remove the layer added for the catalog item, if it is on the map. */
export function removeCatalogItem(sourceUrl: string, itemId: string): boolean {
  const layer = addedLayers().get(`${sourceUrl}|${itemId}`);
  if (!layer) return false;
  useAppStore.getState().removeLayer(layer.id);
  status = labels.removed(layer.name);
  notify();
  return true;
}

export async function toggleCatalogItem(sourceUrl: string, itemId: string): Promise<void> {
  if (removeCatalogItem(sourceUrl, itemId)) return;
  await addCatalogItem(sourceUrl, itemId);
}

/** The WMS style the added layer for this item was drawn with, or the item's default. */
export function getCatalogItemStyle(sourceUrl: string, itemId: string): string | undefined {
  const source = sourceOf(sourceUrl);
  const item = source ? findItem(source, itemId) : null;
  if (!item) return undefined;
  const layer = addedLayers().get(`${sourceUrl}|${itemId}`);
  const tag = layer?.metadata?.[CATALOG_LAYER_METADATA_KEY] as { style?: unknown } | undefined;
  return catalogItemWmsStyle(item, typeof tag?.style === "string" ? tag.style : undefined);
}

/**
 * Draw a WMS item with another of its `stylesToUse`: the layer is re-added
 * with the style (its position in the list is kept) or, if the item is not
 * on the map yet, added with it.
 */
export async function setCatalogItemStyle(
  sourceUrl: string,
  itemId: string,
  style: string,
): Promise<string | null> {
  const source = sourceOf(sourceUrl);
  const item = source ? findItem(source, itemId) : null;
  if (!item || item.type !== "wms" || !item.stylesToUse?.includes(style)) return null;
  const current = addedLayers().get(`${sourceUrl}|${itemId}`);
  if (current) {
    if (getCatalogItemStyle(sourceUrl, itemId) === style) return current.id;
    const store = useAppStore.getState();
    const index = store.layers.findIndex((l) => l.id === current.id);
    const next = store.layers[index + 1];
    store.removeLayer(current.id);
    const id = await addCatalogItem(sourceUrl, itemId, { style });
    if (id && next) {
      // Back where the layer was: `addLayer` appended it at the end.
      const layers = useAppStore.getState().layers;
      const from = layers.findIndex((l) => l.id === id);
      const to = layers.findIndex((l) => l.id === next.id);
      if (from >= 0 && to >= 0 && from !== to) useAppStore.getState().moveLayer(id, to);
    }
    return id;
  }
  return addCatalogItem(sourceUrl, itemId, { style });
}

/** A catalog entry matched by the search box, with where it sits in the tree. */
export interface CatalogSearchMatch {
  sourceUrl: string;
  item: CatalogItem;
  /** Group names from the root down to the item's parent. */
  path: string[];
}

/**
 * Entries of every loaded catalog whose name (or url / layers) matches `query`,
 * for the place-search box: supported items only (an entry nobody can open is
 * noise there), the sublayers of an already-expanded map-service group included,
 * up to `limit`.
 */
export function searchCatalogItems(query: string, limit = 6): CatalogSearchMatch[] {
  const probe = query.trim();
  if (!probe) return [];
  const out: CatalogSearchMatch[] = [];
  const walk = (sourceUrl: string, nodes: readonly CatalogNode[], path: string[]) => {
    for (const node of nodes) {
      if (out.length >= limit) return;
      if (node.kind === "group") {
        walk(sourceUrl, node.members, [...path, node.name]);
        continue;
      }
      if (
        node.supported &&
        node.type !== "esri-mapServer-group" &&
        !hiddenFromUser(node) &&
        catalogNodeMatchesQuery(node, probe)
      ) {
        out.push({ sourceUrl, item: node, path });
      }
    }
  };
  for (const source of sources) {
    if (!source.catalog) continue;
    walk(source.url, source.catalog.roots, []);
    for (const [groupId, children] of source.resolvedGroups) {
      const group = findCatalogNode(source.catalog.roots, groupId);
      const path = group ? [group.name] : [];
      walk(source.url, children, path);
    }
  }
  return out.slice(0, limit);
}

/**
 * Fetch sublayers for every `esri-mapServer-group` still unresolved. Those
 * entries look like nested catalog folders; search must open them and list
 * their children (e.g. "3 - Uso del Suolo" → "Uso del Suolo" → layers).
 */
async function prefetchMapServerGroupsForSearch(): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  const walk = (sourceUrl: string, nodes: readonly CatalogNode[]) => {
    for (const node of nodes) {
      if (node.kind === "group") {
        walk(sourceUrl, node.members);
        continue;
      }
      if (node.type === "esri-mapServer-group" && node.url) {
        const source = sourceOf(sourceUrl);
        if (source && !source.resolvedGroups.has(node.id)) {
          jobs.push(expandMapServerGroup(sourceUrl, node.id));
        }
      }
    }
  };
  for (const source of sources) {
    if (!source.catalog) continue;
    walk(source.url, source.catalog.roots);
  }
  if (jobs.length > 0) await Promise.all(jobs);
}

export function setCatalogQuery(next: string): void {
  query = next;
  notify();
  if (!next.trim()) return;
  const generation = ++searchPrefetchGeneration;
  void prefetchMapServerGroupsForSearch().then(() => {
    if (generation === searchPrefetchGeneration && query.trim()) notify();
  });
}

export function toggleCatalogGroup(id: string): void {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  notify();
}

// --- Panel -----------------------------------------------------------------

const styles = {
  panel:
    "display:flex;flex-direction:column;gap:8px;padding:8px;height:100%;box-sizing:border-box;" +
    "font-size:12px;color:hsl(var(--foreground));",
  row: "display:flex;gap:6px;",
  input:
    "min-width:0;flex:1;padding:6px 8px;border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  searchInput:
    "min-width:0;width:100%;box-sizing:border-box;padding:4px 8px;font-size:12px;line-height:1.3;" +
    "border:1px solid hsl(var(--border));border-radius:6px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  button:
    "padding:5px 9px;border:1px solid hsl(var(--border));border-radius:5px;cursor:pointer;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
  status: "font-size:11px;color:hsl(var(--muted-foreground));line-height:1.4;",
  tree: "display:flex;flex-direction:column;overflow:auto;min-height:0;flex:1;",
  source:
    "display:flex;align-items:center;gap:6px;padding:4px 0;font-weight:600;" +
    "border-bottom:1px solid hsl(var(--border));margin-bottom:4px;",
  group: "display:flex;align-items:center;gap:4px;padding:3px 0;cursor:pointer;user-select:none;",
  groupName: "font-weight:600;",
  item: "display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;border-radius:4px;",
  itemAdded: "color:hsl(var(--primary));font-weight:600;",
  itemUnsupported: "color:hsl(var(--muted-foreground));cursor:default;",
  badge:
    "font-size:10px;color:hsl(var(--muted-foreground));border:1px solid hsl(var(--border));" +
    "border-radius:3px;padding:0 4px;",
  caret: "width:14px;display:inline-block;text-align:center;color:hsl(var(--muted-foreground));",
  check: "width:14px;display:inline-block;text-align:center;",
  checkRow:
    "display:flex;align-items:center;gap:6px;font-size:11px;color:hsl(var(--muted-foreground));" +
    "cursor:pointer;user-select:none;",
  stylePicker:
    "margin-inline-start:auto;max-width:45%;font-size:11px;padding:1px 2px;" +
    "border:1px solid hsl(var(--border));border-radius:4px;" +
    "background:hsl(var(--background));color:hsl(var(--foreground));",
} as const;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  style?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (style) node.setAttribute("style", style);
  return node;
}

function renderItem(
  list: HTMLElement,
  source: CatalogSource,
  item: CatalogItem,
  depth: number,
  added: Map<string, GeoLibreLayer>,
): void {
  const isAdded = added.has(`${source.url}|${item.id}`);
  const accessible = canAccessGroups(item.allowedGroups);
  const row = element(
    "div",
    undefined,
    styles.item +
      (isAdded ? styles.itemAdded : "") +
      (item.supported ? "" : styles.itemUnsupported),
  );
  if (item.allowedGroups && !accessible) row.dataset.catalogLocked = "true";
  row.style.paddingInlineStart = `${8 + depth * 14}px`;
  row.setAttribute("role", "button");
  row.setAttribute("aria-pressed", String(isAdded));
  row.dataset.catalogItem = item.id;
  row.title = [item.description, item.url].filter(Boolean).join("\n") || item.name;
  const check = element("span", isAdded ? "✓" : busy.has(item.id) ? "…" : "", styles.check);
  row.appendChild(check);
  row.appendChild(element("span", item.name));
  if (!item.supported)
    row.appendChild(element("span", labels.unsupported(item.type), styles.badge));
  if (item.allowedGroups && !accessible) {
    const badge = element("span", "🔒", styles.badge);
    badge.title = labels.locked;
    badge.setAttribute("aria-label", labels.locked);
    row.appendChild(badge);
  }
  if (item.supported) {
    row.addEventListener("click", () => {
      void toggleCatalogItem(source.url, item.id);
    });
    row.setAttribute("aria-label", `${isAdded ? labels.remove : labels.add}: ${item.name}`);
  }
  // A WMS item that lists the styles a user may pick from gets a picker on
  // its row; changing it redraws the layer (or adds it) with that style.
  if (item.supported && item.type === "wms" && (item.stylesToUse?.length ?? 0) > 1 && accessible) {
    const picker = element("select", undefined, styles.stylePicker);
    picker.title = labels.style;
    picker.setAttribute("aria-label", `${labels.style}: ${item.name}`);
    picker.dataset.catalogStylePicker = item.id;
    const current = getCatalogItemStyle(source.url, item.id);
    for (const name of item.stylesToUse ?? []) {
      const option = element("option", catalogItemStyleLabel(item, name));
      option.value = name;
      option.selected = name === current;
      picker.appendChild(option);
    }
    picker.addEventListener("click", (event) => event.stopPropagation());
    picker.addEventListener("change", (event) => {
      event.stopPropagation();
      void setCatalogItemStyle(source.url, item.id, picker.value);
    });
    row.appendChild(picker);
  }
  list.appendChild(row);
}

function renderGroupRow(
  list: HTMLElement,
  id: string,
  name: string,
  depth: number,
  onToggle: () => void,
  description?: string,
  /** When filtering, open ancestors even if they are not in `expanded`. */
  forceOpen = false,
): boolean {
  const open = forceOpen || expanded.has(id);
  const row = element("div", undefined, styles.group);
  row.style.paddingInlineStart = `${8 + depth * 14}px`;
  row.setAttribute("role", "button");
  row.setAttribute("aria-expanded", String(open));
  row.dataset.catalogGroup = id;
  if (description) row.title = description;
  row.appendChild(element("span", busy.has(id) ? "…" : open ? "▾" : "▸", styles.caret));
  row.appendChild(element("span", name, styles.groupName));
  row.addEventListener("click", onToggle);
  list.appendChild(row);
  return open;
}

/** A restricted node the user may not open, when its file asks for it to be hidden. */
function hiddenFromUser(node: CatalogNode): boolean {
  return (
    Boolean(node.allowedGroups) && node.hideWhenUnauthorized && !canAccessGroups(node.allowedGroups)
  );
}

function renderNodes(
  list: HTMLElement,
  source: CatalogSource,
  nodes: readonly CatalogNode[],
  depth: number,
  added: Map<string, GeoLibreLayer>,
  /** Non-empty filter: open every group in the filtered tree (all depths). */
  filtering = false,
): void {
  for (const node of nodes) {
    if (hiddenFromUser(node)) continue;
    if (node.kind === "group") {
      // While filtering, open every retained group — including nested subgroups
      // kept under a name-matched parent (those still have isOpen:false from the
      // file). Relying only on filterCatalog's isOpen stopped at one level.
      const open = renderGroupRow(
        list,
        node.id,
        node.name,
        depth,
        () => toggleCatalogGroup(node.id),
        node.description,
        filtering,
      );
      if (open) renderNodes(list, source, node.members, depth + 1, added, filtering);
      continue;
    }
    if (node.type === "esri-mapServer-group" && node.url) {
      // Never fetch from render (expand → notify → draw loop). Search prefetches
      // via setCatalogQuery; while filtering, force-open the nested folder.
      const open = renderGroupRow(
        list,
        node.id,
        node.name,
        depth,
        () => {
          toggleCatalogGroup(node.id);
          if (expanded.has(node.id)) void expandMapServerGroup(source.url, node.id);
        },
        node.description,
        filtering,
      );
      if (open) {
        const children = source.resolvedGroups.get(node.id) ?? [];
        renderNodes(list, source, children, depth + 1, added, filtering);
      }
      continue;
    }
    renderItem(list, source, node, depth, added);
  }
}

function buildPanel(container: HTMLElement): () => void {
  container.innerHTML = "";
  const panel = element("div", undefined, styles.panel);
  const hint = element("div", labels.hint, styles.status);
  const urlRow = element("div", undefined, styles.row);
  const urlInput = element("input", undefined, styles.input);
  urlInput.type = "url";
  urlInput.placeholder = labels.urlPlaceholder;
  const loadButton = element("button", labels.load, styles.button);
  loadButton.type = "button";
  const load = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    void loadCatalog(url).then((ok) => {
      if (ok) urlInput.value = "";
    });
  };
  loadButton.addEventListener("click", load);
  urlInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") load();
  });
  urlRow.append(urlInput, loadButton);
  const searchInput = element("input", undefined, styles.searchInput);
  searchInput.type = "search";
  searchInput.placeholder = labels.searchPlaceholder;
  searchInput.value = query;
  searchInput.addEventListener("input", () => setCatalogQuery(searchInput.value));
  const zoomRow = element("label", undefined, styles.checkRow);
  const zoomBox = element("input");
  zoomBox.type = "checkbox";
  zoomBox.checked = zoomOnAdd;
  zoomBox.addEventListener("change", () => setCatalogZoomOnAdd(zoomBox.checked));
  const zoomText = element("span", labels.zoomOnAdd);
  zoomRow.append(zoomBox, zoomText);
  const statusLine = element("div", "", styles.status);
  statusLine.setAttribute("aria-live", "polite");
  const tree = element("div", undefined, styles.tree);
  panel.append(hint, urlRow, searchInput, zoomRow, statusLine, tree);
  container.appendChild(panel);

  const draw = () => {
    hint.textContent = labels.hint;
    urlInput.placeholder = labels.urlPlaceholder;
    loadButton.textContent = labels.load;
    searchInput.placeholder = labels.searchPlaceholder;
    zoomText.textContent = labels.zoomOnAdd;
    zoomBox.checked = zoomOnAdd;
    statusLine.textContent = status ?? "";
    tree.innerHTML = "";
    const added = addedLayers();
    if (sources.length === 0) {
      tree.appendChild(element("div", labels.noCatalog, styles.status));
      return;
    }
    for (const source of sources) {
      const head = element("div", undefined, styles.source);
      const name = source.catalog?.roots[0]?.name ?? source.url;
      head.appendChild(element("span", source.loading ? labels.loading : name));
      head.title = source.url;
      if (source.catalog?.homeExtent) {
        const home = element("button", "⌂", styles.button);
        home.type = "button";
        home.title = labels.home;
        home.addEventListener("click", () => appRef?.fitBounds?.(source.catalog!.homeExtent!));
        head.appendChild(home);
      }
      const remove = element("button", "×", styles.button);
      remove.type = "button";
      remove.title = labels.removeSource;
      remove.addEventListener("click", () => removeCatalog(source.url));
      head.appendChild(remove);
      tree.appendChild(head);
      if (source.error) {
        tree.appendChild(
          element("div", `${labels.loadError(source.url)} ${source.error}`, styles.status),
        );
        continue;
      }
      if (!source.catalog) continue;
      // A single root group named like the catalog reads better unwrapped.
      const roots =
        source.catalog.roots.length === 1 && source.catalog.roots[0].kind === "group"
          ? (source.catalog.roots[0] as CatalogGroup).members
          : source.catalog.roots;
      const filtering = Boolean(query.trim());
      const visible = filterCatalog(roots, query, source.resolvedGroups);
      if (visible.length === 0) {
        tree.appendChild(element("div", labels.noMatches, styles.status));
        continue;
      }
      renderNodes(tree, source, visible, 0, added, filtering);
    }
  };
  rerender = draw;
  draw();
  return () => {
    if (rerender === draw) rerender = null;
  };
}

// --- Plugin ----------------------------------------------------------------

export function getTerriaCatalogProjectState(): Record<string, unknown> | undefined {
  if (sources.length === 0 && !zoomOnAdd) return undefined;
  return { sources: sources.map((s) => s.url), ...(zoomOnAdd ? { zoomOnAdd: true } : {}) };
}

export const terriaCatalogPlugin: GeoLibrePlugin = {
  id: TERRIA_CATALOG_PLUGIN_ID,
  name: "Catalog",
  version: "0.1.0",
  activeByDefault: false,
  engines: ["maplibre", "cesium"],
  activate: (app) => {
    appRef = app;
    unsubscribeStore ??= useAppStore.subscribe((state, previous) => {
      if (state.layers === previous.layers) return;
      rerender?.();
      // A project file may restore layers that ask for the session header;
      // after the store settles, hand it to them (a no-op when nothing differs).
      if (state.layers.length !== previous.layers.length)
        queueMicrotask(applyGeoportalSessionToLayers);
    });
    // Signing in or out changes which entries are open and which are locked,
    // which layers carry the session header, and what a popup may show.
    unsubscribeSession ??= subscribeGeoportalSession(() => {
      applyGeoportalSessionToLayers();
      notify();
    });
    applyGeoportalSessionToLayers();
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: () => labels.title,
        dock: "replace-layers",
        defaultWidth: 340,
        render: (container) => {
          disposePanel = buildPanel(container);
          return () => {
            disposePanel?.();
            disposePanel = null;
          };
        },
      }) ?? null;
    for (const url of deploymentCatalogUrls()) {
      if (!sources.some((s) => s.url === resolveUrl(url))) void loadCatalog(url);
    }
    app.openRightPanel?.(PANEL_ID);
  },
  deactivate: (app) => {
    app.closeRightPanel?.(PANEL_ID);
    disposePanel?.();
    disposePanel = null;
    unregisterPanel?.();
    unregisterPanel = null;
    unsubscribeStore?.();
    unsubscribeStore = null;
    unsubscribeSession?.();
    unsubscribeSession = null;
    appRef = null;
    loadGeneration += 1;
  },
  getProjectState: () => getTerriaCatalogProjectState(),
  applyProjectState: (_app, state) => {
    const raw = (state && typeof state === "object" ? state : {}) as {
      sources?: unknown;
      zoomOnAdd?: unknown;
    };
    zoomOnAdd = raw.zoomOnAdd === true;
    if (!Array.isArray(raw.sources)) return false;
    for (const url of raw.sources) {
      if (typeof url === "string" && !sources.some((s) => s.url === resolveUrl(url))) {
        void loadCatalog(url);
      }
    }
    return true;
  },
};

/** Forget every loaded catalog (tests). */
export function resetTerriaCatalog(): void {
  zoomOnAdd = false;
  sources = [];
  expanded.clear();
  busy.clear();
  query = "";
  status = null;
  loadGeneration += 1;
  notify();
}

export {
  SUPPORTED_CATALOG_ITEM_TYPES,
  catalogItems,
  filterCatalog,
  findCatalogNode,
  parseTerriaCatalog,
  parseTerriaCatalogText,
  stripJsonComments,
  type CatalogAccess,
  type CatalogFeatureInfo,
  type CatalogGroup,
  type CatalogItem,
  type CatalogNode,
  type QueryableProperty,
  type SupportedCatalogItemType,
  type TerriaCatalog,
} from "./catalog-model";
export {
  parseWmtsCapabilities,
  wmtsCapabilitiesUrl,
  wmtsTileTemplate,
  type WmtsCapabilities,
  type WmtsLayerInfo,
  type WmtsTileMatrixSetInfo,
} from "./wmts-capabilities";
