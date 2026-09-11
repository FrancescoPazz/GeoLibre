import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  CATALOG_LAYER_METADATA_KEY,
  addCatalogItem,
  catalogItems,
  deploymentCatalogUrls,
  expandMapServerGroup,
  filterCatalog,
  findCatalogNode,
  getTerriaCatalogProjectState,
  getTerriaCatalogState,
  loadCatalog,
  parseTerriaCatalog,
  parseTerriaCatalogText,
  parseWmtsCapabilities,
  removeCatalogItem,
  resetTerriaCatalog,
  setTerriaCatalogAdapters,
  stripJsonComments,
  terriaCatalogPlugin,
  toggleCatalogItem,
  wmtsCapabilitiesUrl,
  wmtsTileTemplate,
  type CatalogGroup,
} from "../packages/plugins/src/plugins/terria-catalog";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The catalog of a TerriaJS geoportal, read and opened through the host
// API. The fixtures are a trimmed copy of the Emilia-Romagna "catalogo
// rapido" init file and the real WMTS capabilities of one of its services.

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
const RER_INIT = fixture("terria-catalog-rer.json");
const WMTS_XML = fixture("wmts-capabilities-arcgis.xml");
const CATALOG_URL = "https://geoportal.example.org/init/rapido.json";
const WMTS_SERVICE =
  "https://servizigis.regione.emilia-romagna.it/arcgis/rest/services/cache/volorer_1976_78_wgs84wm/MapServer/WMTS";

describe("parseTerriaCatalog", () => {
  const catalog = parseTerriaCatalogText(RER_INIT);

  it("reads the tree with the file's types, ids, urls and sub-resources", () => {
    assert.equal(catalog.roots.length, 1);
    const root = catalog.roots[0] as CatalogGroup;
    assert.equal(root.kind, "group");
    assert.equal(root.name, "Catalogo rapido Regione Emilia-Romagna");
    assert.equal(root.members.length, 2);
    const items = catalogItems(catalog.roots);
    assert.equal(items.length, 8);
    const wms = items.find((i) => i.id === "DexQu5");
    assert.equal(wms?.type, "wms");
    assert.equal(wms?.layers, "DBTR_Ctr5");
    assert.ok(wms?.url?.startsWith("https://servizigis.regione.emilia-romagna.it/wms/"));
    const wmts = items.find((i) => i.id === "rer7678wmts");
    assert.equal(wmts?.type, "wmts");
    assert.equal(
      wmts?.layers,
      "cache_volorer_1976_78_wgs84wm",
      "a WMTS `layer` reads as the sub-resource",
    );
    const group = items.find((i) => i.type === "esri-mapServer-group");
    assert.equal(group?.id, "bMyL8M");
    assert.ok(
      items.every((i) => i.supported),
      "every type in this catalog is supported",
    );
  });

  it("carries the workbench and the home view", () => {
    assert.deepEqual(catalog.workbench, ["ttjh8y", "ySZw6F"]);
    assert.equal(findCatalogNode(catalog.roots, "ttjh8y")?.kind, "item");
    assert.ok(catalogItems(catalog.roots).find((i) => i.id === "ttjh8y")?.inWorkbench);
    assert.deepEqual(catalog.homeExtent, [9.278, 43.736, 12.81, 45.325]);
  });

  it("flags unknown types, gives id-less nodes a path id, and tolerates junk", () => {
    const parsed = parseTerriaCatalog({
      catalog: [
        { type: "group", name: "G", members: [{ type: "czml", name: "Track", url: "x" }, null, 3] },
        { name: "no type" },
        {
          type: "wms",
          id: "w",
          name: "W",
          url: "https://x/wms",
          layers: ["a", "b"],
          parameters: { format: "image/jpeg" },
        },
      ],
    });
    const group = parsed.roots[0] as CatalogGroup;
    assert.equal(group.members.length, 1);
    assert.equal(group.members[0].id, "/0/0");
    assert.equal((group.members[0] as { supported: boolean }).supported, false);
    assert.equal(parsed.roots.length, 2);
    const wms = parsed.roots[1] as { layers?: string; parameters?: Record<string, string> };
    assert.equal(wms.layers, "a,b");
    assert.deepEqual(wms.parameters, { format: "image/jpeg" });
    assert.deepEqual(parseTerriaCatalog(null), { roots: [], workbench: [], homeExtent: undefined });
    // A v7-era file nests under `items`.
    const v7 = parseTerriaCatalog({
      catalog: [
        {
          type: "group",
          name: "G",
          items: [{ type: "wms", name: "W", url: "https://x/wms", layers: "l" }],
        },
      ],
    });
    assert.equal(catalogItems(v7.roots).length, 1);
  });

  it("strips // and /* */ comments outside strings before parsing", () => {
    const text = `{
  "workbench": [],
  //"corsDomains": ["x"],
  "catalog": [{ "type": "group", "name": "a // not a comment", "members": [] }] /* trailing */
}`;
    assert.equal(stripJsonComments('"http://x" // c').trim(), '"http://x"');
    const parsed = parseTerriaCatalogText(text);
    assert.equal(parsed.roots[0].name, "a // not a comment");
  });

  it("filters by name, keeping the ancestors of a match and a matched group's whole subtree", () => {
    const ctr = filterCatalog(catalog.roots, "ctr");
    const names = catalogItems(ctr).map((i) => i.name);
    assert.deepEqual(names, ["DBTR_CTRMultiscala", "DBTR_CTRMultiscala", "DBTR CTR5k WMS"]);
    assert.equal((ctr[0] as CatalogGroup).isOpen, true, "ancestors open so the match is visible");
    const topo = filterCatalog(catalog.roots, "topografico");
    assert.equal(catalogItems(topo).length, 4, "a matched group keeps all its members");
    assert.deepEqual(filterCatalog(catalog.roots, "zzz"), []);
    assert.equal(filterCatalog(catalog.roots, "  ").length, 1);
  });
});

describe("WMTS capabilities", () => {
  it("reads layers, styles, resource templates and matrix sets from an ArcGIS WMTS document", () => {
    const caps = parseWmtsCapabilities(WMTS_XML);
    assert.equal(caps.layers.length, 1);
    const layer = caps.layers[0];
    assert.equal(layer.identifier, "cache_volorer_1976_78_wgs84wm");
    assert.equal(layer.style, "default");
    assert.deepEqual(layer.tileMatrixSets, ["default028mm", "GoogleMapsCompatible"]);
    assert.ok(layer.resourceUrls["image/jpgpng"]?.includes("{TileMatrix}/{TileRow}/{TileCol}"));
    assert.deepEqual(
      caps.tileMatrixSets.map((s) => [s.identifier, s.matrices.length]),
      [
        ["default028mm", 24],
        ["GoogleMapsCompatible", 19],
      ],
    );
    assert.ok(caps.tileMatrixSets.every((s) => /3857/.test(s.supportedCrs)));
  });

  it("turns a layer into an XYZ template on the GoogleMapsCompatible grid", () => {
    const tile = wmtsTileTemplate(
      parseWmtsCapabilities(WMTS_XML),
      "cache_volorer_1976_78_wgs84wm",
      WMTS_SERVICE,
    );
    assert.deepEqual(tile, {
      template: `${WMTS_SERVICE}/tile/1.0.0/cache_volorer_1976_78_wgs84wm/default/GoogleMapsCompatible/{z}/{y}/{x}`,
      format: "image/jpgpng",
      maxZoom: 18,
    });
    assert.equal(wmtsTileTemplate(parseWmtsCapabilities(WMTS_XML), "nope", WMTS_SERVICE), null);
  });

  it("falls back to a KVP GetTile request when the document has no REST template", () => {
    const xml = `<Capabilities><Contents>
      <Layer><ows:Title>T</ows:Title><ows:Identifier>lyr</ows:Identifier>
        <Style isDefault="true"><ows:Identifier>plain</ows:Identifier></Style>
        <Format>image/png</Format>
        <TileMatrixSetLink><TileMatrixSet>EPSG:3857</TileMatrixSet></TileMatrixSetLink>
      </Layer>
      <TileMatrixSet><ows:Identifier>EPSG:3857</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
        <TileMatrix><ows:Identifier>0</ows:Identifier></TileMatrix><TileMatrix><ows:Identifier>1</ows:Identifier></TileMatrix>
      </TileMatrixSet>
      <TileMatrixSet><ows:Identifier>EPSG:4326</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::4326</ows:SupportedCRS>
        <TileMatrix><ows:Identifier>EPSG:4326:0</ows:Identifier></TileMatrix>
      </TileMatrixSet>
    </Contents></Capabilities>`;
    const tile = wmtsTileTemplate(parseWmtsCapabilities(xml), "lyr", "https://tiles.example/wmts");
    assert.ok(tile);
    const url = new URL(tile.template.replace(/\{[xyz]\}/g, "0"));
    assert.equal(url.searchParams.get("REQUEST"), "GetTile");
    assert.equal(url.searchParams.get("LAYER"), "lyr");
    assert.equal(url.searchParams.get("STYLE"), "plain");
    assert.equal(url.searchParams.get("TILEMATRIXSET"), "EPSG:3857");
    assert.ok(tile.template.endsWith("&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}"));
    assert.equal(tile.maxZoom, 1);
    assert.equal(
      wmtsCapabilitiesUrl("https://tiles.example/wmts?x=1"),
      "https://tiles.example/wmts?x=1&service=WMTS&version=1.0.0&request=GetCapabilities",
    );
  });
});

describe("deploymentCatalogUrls", () => {
  it("splits on commas and whitespace and keeps only URLs and paths", () => {
    assert.deepEqual(deploymentCatalogUrls({}), []);
    assert.deepEqual(
      deploymentCatalogUrls({
        VITE_CATALOG_URLS: " https://a/x.json, /init/b.json  ftp://no javascript:1 ",
      }),
      ["https://a/x.json", "/init/b.json"],
    );
    assert.deepEqual(deploymentCatalogUrls({ CATALOG_URLS: "./c.json" }), ["./c.json"]);
  });
});

// --- The plugin against a fake host ---------------------------------------

interface Added {
  kind: string;
  name: string;
  url?: string;
  options?: Record<string, unknown>;
}

function fakeHost() {
  const added: Added[] = [];
  let nextId = 1;
  const addLayer = (
    kind: string,
    name: string,
    url?: string,
    options?: Record<string, unknown>,
  ) => {
    const id = `layer-${nextId++}`;
    added.push({ kind, name, url, options });
    const layer: GeoLibreLayer = {
      id,
      name,
      type:
        kind === "wms"
          ? "wms"
          : kind === "wmts"
            ? "wmts"
            : kind === "geojson"
              ? "geojson"
              : "arcgis",
      source: { url },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    };
    useAppStore.getState().addLayer(layer);
    return id;
  };
  const fitted: unknown[] = [];
  const app = {
    getMap: () => null,
    getCesiumScene: () => null,
    addGeoJsonLayer: (name: string, _data: unknown, url?: string) => addLayer("geojson", name, url),
    addTileLayer: (name: string, url: string, options?: Record<string, unknown>) =>
      addLayer("xyz", name, url, options),
    addWmtsLayer: (name: string, url: string, options?: Record<string, unknown>) =>
      addLayer("wmts", name, url, options),
    addWmsLayer: (name: string, options: Record<string, unknown>) =>
      addLayer("wms", name, options.url as string, options),
    fitBounds: (bounds: unknown) => fitted.push(bounds),
    registerRightPanel: () => () => {},
    openRightPanel: () => true,
    closeRightPanel: () => {},
  } as unknown as GeoLibreAppAPI;
  const fetched: string[] = [];
  const sublayerRequests: string[] = [];
  setTerriaCatalogAdapters({
    fetchText: async (url) => {
      fetched.push(url);
      if (url === CATALOG_URL) return RER_INIT;
      if (url.includes("request=GetCapabilities")) return WMTS_XML;
      if (url.endsWith("/broken.json")) throw new Error("HTTP 404");
      throw new Error(`unexpected fetch ${url}`);
    },
    addArcGis: async (_app, options) => {
      return addLayer(
        "arcgis",
        options.name ?? "arcgis",
        options.url,
        options as unknown as Record<string, unknown>,
      );
    },
    fetchArcGisSublayers: async ({ url }) => {
      sublayerRequests.push(url);
      return [
        { id: 0, name: "Comune_Ed_2021_5k" },
        { id: 1, name: "Provincia" },
      ];
    },
  });
  return { app, added, fitted, fetched, sublayerRequests };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

beforeEach(() => {
  useAppStore.setState({ layers: [] });
  resetTerriaCatalog();
});
afterEach(() => {
  terriaCatalogPlugin.deactivate({
    closeRightPanel: () => {},
  } as unknown as GeoLibreAppAPI);
  setTerriaCatalogAdapters();
  resetTerriaCatalog();
});

describe("terria catalog plugin", () => {
  it("loads a catalog, adds its workbench to an empty project and goes to the home view", async () => {
    const host = fakeHost();
    terriaCatalogPlugin.activate(host.app);
    assert.equal(await loadCatalog(CATALOG_URL), true);
    await flush();
    const state = getTerriaCatalogState();
    assert.equal(state.sources.length, 1);
    assert.equal(state.sources[0].loaded, true);
    // The workbench names two cached ArcGIS map services: added, tagged, in order.
    assert.deepEqual(
      host.added.map((a) => `${a.kind}:${a.name}`),
      ["arcgis:DBTR_CTRMultiscala", "arcgis:Mappa DBTR"],
    );
    const layers = useAppStore.getState().layers;
    assert.deepEqual(
      layers.map((l) => (l.metadata[CATALOG_LAYER_METADATA_KEY] as { item: string }).item),
      ["ttjh8y", "ySZw6F"],
    );
    assert.deepEqual(
      Object.keys(state.added).sort(),
      [`${CATALOG_URL}|ttjh8y`, `${CATALOG_URL}|ySZw6F`].sort(),
    );
    assert.deepEqual(host.fitted, [[9.278, 43.736, 12.81, 45.325]]);
    assert.deepEqual(getTerriaCatalogProjectState(), { sources: [CATALOG_URL] });
  });

  it("leaves a project that already has layers alone", async () => {
    const host = fakeHost();
    useAppStore.getState().addLayer({
      id: "mine",
      name: "Mine",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(CATALOG_URL);
    await flush();
    assert.equal(host.added.length, 0);
    assert.equal(host.fitted.length, 0);
    assert.equal(useAppStore.getState().layers.length, 1);
  });

  it("adds a WMS item with its request parameters, and a WMTS item through its capabilities", async () => {
    const host = fakeHost();
    useAppStore.getState().addLayer({
      id: "keep",
      name: "Keep",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(CATALOG_URL);
    assert.ok(await addCatalogItem(CATALOG_URL, "DexQu5"));
    const wms = host.added.find((a) => a.kind === "wms");
    assert.ok(wms);
    assert.equal(wms.options?.url, "https://servizigis.regione.emilia-romagna.it/wms/DBTR_Ctr5");
    assert.equal(wms.options?.layers, "DBTR_Ctr5");
    assert.equal(wms.options?.transparent, true);

    assert.ok(await addCatalogItem(CATALOG_URL, "rer7678wmts"));
    const wmts = host.added.find((a) => a.kind === "wmts");
    assert.ok(wmts);
    assert.equal(
      wmts.url,
      `${WMTS_SERVICE}/tile/1.0.0/cache_volorer_1976_78_wgs84wm/default/GoogleMapsCompatible/{z}/{y}/{x}`,
    );
    assert.equal(wmts.options?.maxzoom, 18);
    assert.ok(
      host.fetched.some((u) => u.startsWith(WMTS_SERVICE) && u.includes("GetCapabilities")),
    );
  });

  it("does not add an item twice, and removes it again on toggle", async () => {
    const host = fakeHost();
    useAppStore.getState().addLayer({
      id: "keep",
      name: "Keep",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(CATALOG_URL);
    const id = await addCatalogItem(CATALOG_URL, "DexQu5");
    assert.ok(id);
    assert.equal(await addCatalogItem(CATALOG_URL, "DexQu5"), null);
    assert.equal(host.added.length, 1);
    await toggleCatalogItem(CATALOG_URL, "DexQu5");
    assert.ok(!useAppStore.getState().layers.some((l) => l.id === id), "toggle removed the layer");
    assert.equal(removeCatalogItem(CATALOG_URL, "DexQu5"), false);
    await toggleCatalogItem(CATALOG_URL, "DexQu5");
    assert.equal(host.added.length, 2, "toggle added it back");
  });

  it("expands an ArcGIS map-service group into one item per sublayer, and resolves sublayer names to ids", async () => {
    const host = fakeHost();
    useAppStore.getState().addLayer({
      id: "keep",
      name: "Keep",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(CATALOG_URL);
    const children = await expandMapServerGroup(CATALOG_URL, "bMyL8M");
    assert.deepEqual(
      children.map((c) => [c.id, c.name, c.layers, c.type]),
      [
        ["bMyL8M/0", "Comune_Ed_2021_5k", "0", "esri-mapServer"],
        ["bMyL8M/1", "Provincia", "1", "esri-mapServer"],
      ],
    );
    assert.equal((await expandMapServerGroup(CATALOG_URL, "bMyL8M")).length, 2);
    assert.equal(host.sublayerRequests.length, 1, "the service is asked once");

    assert.ok(await addCatalogItem(CATALOG_URL, "bMyL8M/1"));
    const child = host.added.at(-1);
    assert.equal(child?.options?.sublayers, "1");
    assert.equal(child?.options?.zoomTo, false);
  });

  it("reports a catalog that cannot be loaded and keeps the others", async () => {
    const host = fakeHost();
    terriaCatalogPlugin.activate(host.app);
    assert.equal(await loadCatalog("https://geoportal.example.org/init/broken.json"), false);
    const state = getTerriaCatalogState();
    assert.equal(state.sources[0].error, "HTTP 404");
    assert.match(state.status ?? "", /Could not load the catalog/);
    assert.equal(await loadCatalog(CATALOG_URL), true);
    assert.equal(getTerriaCatalogState().sources.length, 2);
  });

  it("restores its catalogs from the project state", async () => {
    const host = fakeHost();
    terriaCatalogPlugin.activate(host.app);
    assert.equal(
      terriaCatalogPlugin.applyProjectState?.(host.app, { sources: [CATALOG_URL] }),
      true,
    );
    await flush();
    await flush();
    assert.equal(getTerriaCatalogState().sources[0]?.loaded, true);
    assert.equal(terriaCatalogPlugin.applyProjectState?.(host.app, "junk"), false);
  });
});
