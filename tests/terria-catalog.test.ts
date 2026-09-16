import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  CATALOG_LAYER_METADATA_KEY,
  addCatalogItem,
  catalogItemStyleLabel,
  catalogItems,
  getCatalogItemStyle,
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
  searchCatalogItems,
  setCatalogQuery,
  setCatalogItemStyle,
  setCatalogZoomOnAdd,
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

  it("matches dettaglio in names and uso_del across spaces/underscores and urls", () => {
    const mini = parseTerriaCatalog({
      catalog: [
        {
          type: "group",
          name: "Root",
          members: [
            {
              type: "esri-mapServer",
              name: "Uso del Suolo dettaglio 2017",
              url: "https://example.org/portale/uso_del_suolo/MapServer",
              layers: "2017_uso_suolo",
              id: "dett",
            },
            {
              type: "esri-mapServer-group",
              name: "Uso del Suolo",
              url: "https://example.org/portale/uso_del_suolo/MapServer",
              id: "uso",
            },
          ],
        },
      ],
    });
    const dettaglio = filterCatalog(mini.roots, "dettaglio");
    assert.deepEqual(
      catalogItems(dettaglio).map((i) => i.name),
      ["Uso del Suolo dettaglio 2017"],
    );
    assert.equal((dettaglio[0] as CatalogGroup).isOpen, true);

    const uso = filterCatalog(mini.roots, "uso_del");
    assert.deepEqual(
      catalogItems(uso)
        .map((i) => i.name)
        .sort(),
      ["Uso del Suolo", "Uso del Suolo dettaglio 2017"].sort(),
    );
  });

  it("opens every nested group under a name-matched parent", () => {
    const mini = parseTerriaCatalog({
      catalog: [
        {
          type: "group",
          name: "Root",
          members: [
            {
              type: "group",
              name: "Level one",
              id: "l1",
              members: [
                {
                  type: "group",
                  name: "Level two",
                  id: "l2",
                  members: [
                    {
                      type: "group",
                      name: "Level three",
                      id: "l3",
                      members: [
                        {
                          type: "wms",
                          name: "Deep leaf",
                          id: "leaf",
                          url: "https://example.org/wms",
                          layers: "a",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    // Match the top folder only — descendants do not match the query; the full
    // subtree is kept and every nested group must be marked open.
    const filtered = filterCatalog(mini.roots, "level one");
    const l1 = filtered[0] as CatalogGroup;
    assert.equal(l1.name, "Root");
    assert.equal(l1.isOpen, true);
    const levelOne = l1.members[0] as CatalogGroup;
    assert.equal(levelOne.name, "Level one");
    assert.equal(levelOne.isOpen, true);
    const levelTwo = levelOne.members[0] as CatalogGroup;
    assert.equal(levelTwo.name, "Level two");
    assert.equal(levelTwo.isOpen, true);
    const levelThree = levelTwo.members[0] as CatalogGroup;
    assert.equal(levelThree.name, "Level three");
    assert.equal(levelThree.isOpen, true);
    assert.equal((levelThree.members[0] as { name: string }).name, "Deep leaf");
  });

  it("expands a map-server folder under a name-matched parent when sublayers are resolved", () => {
    const mini = parseTerriaCatalog({
      catalog: [
        {
          type: "group",
          name: "3 - Uso del Suolo",
          id: "uso-root",
          members: [
            {
              type: "esri-mapServer-group",
              name: "Uso del Suolo",
              id: "uso-ms",
              url: "https://example.org/portale/uso_del_suolo/MapServer",
            },
          ],
        },
      ],
    });
    const resolved = new Map([
      [
        "uso-ms",
        [
          {
            kind: "item" as const,
            id: "uso-ms/0",
            name: "2017_uso_suolo",
            type: "esri-mapServer",
            supported: true,
            url: "https://example.org/portale/uso_del_suolo/MapServer",
            layers: "0",
            styleNamesBeforeTitles: false,
            inWorkbench: false,
            hideWhenUnauthorized: false,
            useAuthentication: false,
            clustering: false,
            extra: {},
          },
          {
            kind: "item" as const,
            id: "uso-ms/1",
            name: "2020_uso_suolo",
            type: "esri-mapServer",
            supported: true,
            url: "https://example.org/portale/uso_del_suolo/MapServer",
            layers: "1",
            styleNamesBeforeTitles: false,
            inWorkbench: false,
            hideWhenUnauthorized: false,
            useAuthentication: false,
            clustering: false,
            extra: {},
          },
        ],
      ],
    ]);
    const filtered = filterCatalog(mini.roots, "uso", resolved);
    const root = filtered[0] as CatalogGroup;
    assert.equal(root.name, "3 - Uso del Suolo");
    assert.equal(root.isOpen, true);
    const folder = root.members[0] as CatalogGroup;
    assert.equal(folder.kind, "group");
    assert.equal(folder.name, "Uso del Suolo");
    assert.equal(folder.isOpen, true);
    assert.deepEqual(
      folder.members.map((m) => (m as { name: string }).name),
      ["2017_uso_suolo", "2020_uso_suolo"],
    );
  });

  it("includes already-resolved ArcGIS sublayers that match the query", () => {
    const groupId = "bMyL8M"; // DBTR Layers esri-mapServer-group in the fixture
    const resolved = new Map([
      [
        groupId,
        [
          {
            kind: "item" as const,
            id: `${groupId}/9`,
            name: "dettaglio",
            type: "esri-mapServer",
            supported: true,
            url: "https://example.org/MapServer",
            layers: "9",
            styleNamesBeforeTitles: false,
            inWorkbench: false,
            hideWhenUnauthorized: false,
            useAuthentication: false,
            clustering: false,
            extra: {},
          },
        ],
      ],
    ]);
    const filtered = filterCatalog(catalog.roots, "dettaglio", resolved);
    const items = catalogItems(filtered);
    assert.ok(
      items.some((i) => i.id === `${groupId}/9` && i.name === "dettaglio"),
      `sublayer should surface under its map-service group, got ${items.map((i) => i.name)}`,
    );
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

  it("finds entries by name for the search box, with their place in the tree", async () => {
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
    assert.deepEqual(searchCatalogItems("dbtr"), []);
    await loadCatalog(CATALOG_URL);
    const hits = searchCatalogItems("ctr5");
    assert.deepEqual(
      hits.map((h) => [h.item.id, h.path]),
      [
        [
          "DexQu5",
          ["Catalogo rapido Regione Emilia-Romagna", "2 - Database Topografico Regionale"],
        ],
      ],
    );
    assert.equal(
      searchCatalogItems("dbtr").length,
      5,
      "matches across groups, the group itself excluded",
    );
    assert.equal(searchCatalogItems("dbtr", 2).length, 2, "capped");
    assert.equal(searchCatalogItems("  ").length, 0);
    assert.ok(
      searchCatalogItems("DBTR Layers").length === 0,
      "a map-service group is not an entry to add by itself",
    );
    await expandMapServerGroup(CATALOG_URL, "bMyL8M");
    const sub = searchCatalogItems("provincia");
    assert.deepEqual(
      sub.map((h) => [h.item.id, h.path]),
      [["bMyL8M/1", ["DBTR Layers"]]],
    );
  });

  it("prefetches map-server folders when the catalog search query is set", async () => {
    const host = fakeHost();
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(CATALOG_URL);
    assert.equal(host.sublayerRequests.length, 0);
    setCatalogQuery("uso");
    await flush();
    assert.ok(
      host.sublayerRequests.length >= 1,
      `expected map-server prefetch on search, got ${host.sublayerRequests.length}`,
    );
    const hits = searchCatalogItems("provincia");
    assert.ok(
      hits.some((h) => h.item.id === "bMyL8M/1"),
      "sublayers become searchable after search prefetch",
    );
    setCatalogQuery("");
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

describe("WMS styles to use", () => {
  const STYLED_URL = "https://geoportal.example.org/init/styled.json";
  const STYLED_INIT = JSON.stringify({
    catalog: [
      {
        id: "styled",
        name: "Styled WMS",
        type: "wms",
        url: "https://example.org/wms",
        layers: "roads",
        stylesToUse: ["classic", " dark ", "classic", ""],
        availableStyles: [{ layerName: "roads", styles: [{ name: "dark", title: "Dark roads" }] }],
      },
      {
        id: "fixed",
        name: "Fixed WMS",
        type: "wms",
        url: "https://example.org/wms",
        layers: "rivers",
        styles: "blue",
        stylesToUse: ["blue", "green"],
        styleSelectableDimensionsUseNameBeforeTitle: true,
        availableStyles: [{ layerName: "rivers", styles: [{ name: "blue", title: "Blue" }] }],
      },
    ],
  });

  function styledHost() {
    const host = fakeHost();
    setTerriaCatalogAdapters({
      fetchText: async (url) => {
        if (url === STYLED_URL) return STYLED_INIT;
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    return host;
  }

  it("parses the traits: names deduplicated and trimmed, titles flattened", () => {
    const items = catalogItems(parseTerriaCatalogText(STYLED_INIT).roots);
    const styled = items.find((i) => i.id === "styled");
    assert.deepEqual(styled?.stylesToUse, ["classic", "dark"]);
    assert.equal(styled?.styleNamesBeforeTitles, false);
    assert.deepEqual(styled?.styleTitles, { dark: "Dark roads" });
    assert.equal(catalogItemStyleLabel(styled!, "dark"), "Dark roads");
    assert.equal(catalogItemStyleLabel(styled!, "classic"), "classic");
    const fixed = items.find((i) => i.id === "fixed");
    assert.equal(fixed?.styleNamesBeforeTitles, true);
    assert.equal(catalogItemStyleLabel(fixed!, "blue"), "blue", "names before titles");
    const plain = catalogItems(parseTerriaCatalogText(RER_INIT).roots).find(
      (i) => i.id === "DexQu5",
    );
    assert.equal(plain?.stylesToUse, undefined);
  });

  it("requests the first style to use unless the item fixes one", async () => {
    const host = styledHost();
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(STYLED_URL);
    assert.ok(await addCatalogItem(STYLED_URL, "styled"));
    assert.equal(host.added[0].options?.styles, "classic");
    assert.equal(getCatalogItemStyle(STYLED_URL, "styled"), "classic");
    assert.ok(await addCatalogItem(STYLED_URL, "fixed"));
    assert.equal(host.added[1].options?.styles, "blue");
  });

  it("redraws an added item with another listed style, in place, and refuses an unlisted one", async () => {
    const host = styledHost();
    useAppStore.getState().addLayer({
      id: "top",
      name: "Top",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(STYLED_URL);
    const first = await addCatalogItem(STYLED_URL, "styled");
    useAppStore.getState().addLayer({
      id: "above",
      name: "Above",
      type: "geojson",
      source: {},
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    assert.equal(
      await setCatalogItemStyle(STYLED_URL, "styled", "classic"),
      first,
      "same style, same layer",
    );
    const second = await setCatalogItemStyle(STYLED_URL, "styled", "dark");
    assert.ok(second && second !== first);
    assert.equal(host.added.at(-1)?.options?.styles, "dark");
    assert.deepEqual(
      useAppStore.getState().layers.map((l) => l.id),
      ["top", second, "above"],
      "the redrawn layer keeps its place",
    );
    assert.equal(getCatalogItemStyle(STYLED_URL, "styled"), "dark");
    const tag = useAppStore.getState().layers[1].metadata[CATALOG_LAYER_METADATA_KEY] as {
      style?: string;
    };
    assert.equal(tag.style, "dark");
    assert.equal(await setCatalogItemStyle(STYLED_URL, "styled", "neon"), null);
    // Not yet on the map: the style picks the style it is added with.
    assert.ok(await setCatalogItemStyle(STYLED_URL, "fixed", "green"));
    assert.equal(host.added.at(-1)?.options?.styles, "green");
  });
});

describe("Google tile maps items", () => {
  const GOOGLE_URL = "https://geoportal.example.org/init/google.json";
  const GOOGLE_INIT = JSON.stringify({
    catalog: [
      {
        id: "gsat",
        name: "Google satellite",
        type: "google-tile-maps",
        key: "k&ey",
        mapType: "satellite",
        language: "it",
        region: "IT",
      },
      { id: "nokey", name: "No key", type: "google-tile-maps" },
    ],
  });

  it("parses the key, map type, language and region", () => {
    const items = catalogItems(parseTerriaCatalogText(GOOGLE_INIT).roots);
    assert.deepEqual(items.find((i) => i.id === "gsat")?.googleTiles, {
      key: "k&ey",
      mapType: "satellite",
      language: "it",
      region: "IT",
    });
    assert.equal(items.find((i) => i.id === "nokey")?.googleTiles, undefined);
    assert.ok(items.every((i) => i.supported));
  });

  it("creates a session and adds the 2D tiles carrying it", async () => {
    const host = fakeHost();
    const posts: Array<{ url: string; body: unknown }> = [];
    setTerriaCatalogAdapters({
      fetchText: async (url) => {
        if (url === GOOGLE_URL) return GOOGLE_INIT;
        throw new Error(`unexpected fetch ${url}`);
      },
      postJson: async (url, body) => {
        posts.push({ url, body });
        return { session: "s/1", expiry: "999" };
      },
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(GOOGLE_URL);
    assert.ok(await addCatalogItem(GOOGLE_URL, "gsat"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://tile.googleapis.com/v1/createSession?key=k%26ey");
    assert.deepEqual(posts[0].body, { mapType: "satellite", language: "it", region: "IT" });
    const tiles = host.added.find((a) => a.kind === "xyz");
    assert.ok(tiles);
    assert.equal(
      tiles.url,
      "https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=s%2F1&key=k%26ey",
    );
    assert.equal(tiles.options?.attribution, "Google");
    assert.equal(tiles.options?.maxzoom, 22);
    assert.equal(await addCatalogItem(GOOGLE_URL, "nokey"), null, "no key, no layer");
    assert.ok(getTerriaCatalogState().status.includes("No key"));
  });
});

describe("zoom to an entry when it is added", () => {
  const BOXED_URL = "https://geoportal.example.org/init/boxed.json";
  const BOXED_INIT = JSON.stringify({
    catalog: [
      {
        id: "boxed",
        name: "Boxed",
        type: "open-street-map",
        url: "https://tiles.example.org/{z}/{x}/{y}.png",
        rectangle: { west: 9.2, south: 43.7, east: 12.8, north: 45.1 },
      },
      {
        id: "bad",
        name: "Bad box",
        type: "open-street-map",
        url: "https://tiles.example.org/{z}/{x}/{y}.png",
        rectangle: { west: 12, south: 44, east: 11, north: 45 },
      },
    ],
  });

  it("parses a sane rectangle and drops an inside-out one", () => {
    const items = catalogItems(parseTerriaCatalogText(BOXED_INIT).roots);
    assert.deepEqual(items.find((i) => i.id === "boxed")?.extent, [9.2, 43.7, 12.8, 45.1]);
    assert.equal(items.find((i) => i.id === "bad")?.extent, undefined);
  });

  it("flies to the extent only when the panel asks, and keeps the choice in the project", async () => {
    const host = fakeHost();
    setTerriaCatalogAdapters({
      fetchText: async (url) => {
        if (url === BOXED_URL) return BOXED_INIT;
        throw new Error(`unexpected fetch ${url}`);
      },
    });
    terriaCatalogPlugin.activate(host.app);
    await loadCatalog(BOXED_URL);
    assert.equal(getTerriaCatalogState().zoomOnAdd, false);
    assert.ok(await addCatalogItem(BOXED_URL, "boxed"));
    assert.equal(host.fitted.length, 0, "off by default");
    removeCatalogItem(BOXED_URL, "boxed");
    setCatalogZoomOnAdd(true);
    assert.ok(await addCatalogItem(BOXED_URL, "boxed"));
    assert.deepEqual(host.fitted, [[9.2, 43.7, 12.8, 45.1]]);
    assert.equal(getTerriaCatalogProjectState()?.zoomOnAdd, true);
    resetTerriaCatalog();
    assert.equal(getTerriaCatalogState().zoomOnAdd, false);
    terriaCatalogPlugin.applyProjectState?.(host.app, { sources: [], zoomOnAdd: true });
    assert.equal(getTerriaCatalogState().zoomOnAdd, true);
  });
});
