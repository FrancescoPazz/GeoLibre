import { getRuntimeEnvironment, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import { addArcGISLayer, fetchArcGISMapServiceSublayers } from "../arcgis-layer";
import {
  filterCatalog,
  findCatalogNode,
  parseTerriaCatalogText,
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
let unregisterPanel: (() => void) | null = null;
let disposePanel: (() => void) | null = null;
let rerender: (() => void) | null = null;
let unsubscribeStore: (() => void) | null = null;
let loadGeneration = 0;
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
  };
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
      type: "esri-mapServer",
      supported: true,
      url: node.url,
      layers: String(sub.id),
      attribution: node.attribution,
      opacity: node.opacity,
      inWorkbench: false,
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

async function addLayerFor(app: GeoLibreAppAPI, item: CatalogItem): Promise<string> {
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
        styles: item.styles,
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

/** Add the catalog item to the map as a layer tagged with its catalog id. */
export async function addCatalogItem(sourceUrl: string, itemId: string): Promise<string | null> {
  const app = appRef;
  const source = sourceOf(sourceUrl);
  const item = source ? findItem(source, itemId) : null;
  if (!app || !item || !item.supported) return null;
  const key = `${sourceUrl}|${itemId}`;
  if (addedLayers().has(key) || busy.has(itemId)) return null;
  busy.add(itemId);
  status = labels.adding(item.name);
  notify();
  try {
    const layerId = await addLayerFor(app, item);
    if (!appRef) return null;
    const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
    useAppStore.getState().updateLayer(layerId, {
      metadata: {
        ...(layer?.metadata ?? {}),
        [CATALOG_LAYER_METADATA_KEY]: { source: sourceUrl, item: itemId },
      },
    });
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

/** A catalog entry matched by the search box, with where it sits in the tree. */
export interface CatalogSearchMatch {
  sourceUrl: string;
  item: CatalogItem;
  /** Group names from the root down to the item's parent. */
  path: string[];
}

/**
 * Entries of every loaded catalog whose name contains `query`, for the
 * search box: supported items only (an entry nobody can open is noise
 * there), the sublayers of an already-expanded map-service group included,
 * up to `limit`.
 */
export function searchCatalogItems(query: string, limit = 6): CatalogSearchMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
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
        node.name.toLowerCase().includes(q)
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
      for (const child of children) {
        if (out.length >= limit) break;
        if (child.name.toLowerCase().includes(q))
          out.push({ sourceUrl: source.url, item: child, path });
      }
    }
  }
  return out.slice(0, limit);
}

export function setCatalogQuery(next: string): void {
  query = next;
  notify();
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
  const row = element(
    "div",
    undefined,
    styles.item +
      (isAdded ? styles.itemAdded : "") +
      (item.supported ? "" : styles.itemUnsupported),
  );
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
  if (item.supported) {
    row.addEventListener("click", () => {
      void toggleCatalogItem(source.url, item.id);
    });
    row.setAttribute("aria-label", `${isAdded ? labels.remove : labels.add}: ${item.name}`);
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
): boolean {
  const open = expanded.has(id);
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

function renderNodes(
  list: HTMLElement,
  source: CatalogSource,
  nodes: readonly CatalogNode[],
  depth: number,
  added: Map<string, GeoLibreLayer>,
): void {
  for (const node of nodes) {
    if (node.kind === "group") {
      const open = renderGroupRow(
        list,
        node.id,
        node.name,
        depth,
        () => toggleCatalogGroup(node.id),
        node.description,
      );
      if (open) renderNodes(list, source, node.members, depth + 1, added);
      continue;
    }
    if (node.type === "esri-mapServer-group" && node.url) {
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
      );
      if (open) {
        const children = source.resolvedGroups.get(node.id) ?? [];
        renderNodes(list, source, children, depth + 1, added);
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
  const searchInput = element("input", undefined, styles.input);
  searchInput.type = "search";
  searchInput.placeholder = labels.searchPlaceholder;
  searchInput.value = query;
  searchInput.addEventListener("input", () => setCatalogQuery(searchInput.value));
  const statusLine = element("div", "", styles.status);
  statusLine.setAttribute("aria-live", "polite");
  const tree = element("div", undefined, styles.tree);
  panel.append(hint, urlRow, searchInput, statusLine, tree);
  container.appendChild(panel);

  const draw = () => {
    hint.textContent = labels.hint;
    urlInput.placeholder = labels.urlPlaceholder;
    loadButton.textContent = labels.load;
    searchInput.placeholder = labels.searchPlaceholder;
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
      const visible = filterCatalog(roots, query);
      if (visible.length === 0) {
        tree.appendChild(element("div", labels.noMatches, styles.status));
        continue;
      }
      renderNodes(tree, source, visible, 0, added);
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
  if (sources.length === 0) return undefined;
  return { sources: sources.map((s) => s.url) };
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
      if (state.layers !== previous.layers) rerender?.();
    });
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
    appRef = null;
    loadGeneration += 1;
  },
  getProjectState: () => getTerriaCatalogProjectState(),
  applyProjectState: (_app, state) => {
    const raw = (state && typeof state === "object" ? state : {}) as { sources?: unknown };
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
  type CatalogGroup,
  type CatalogItem,
  type CatalogNode,
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
