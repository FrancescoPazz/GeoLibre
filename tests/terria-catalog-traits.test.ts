import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  DEFAULT_LAYER_STYLE,
  USE_AUTHENTICATION_METADATA_KEY,
  setGeoportalSession,
  signOutGeoportal,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import {
  PER_PROFILE_FIELDS_METADATA_KEY,
  QUERYABLE_PROPERTIES_METADATA_KEY,
  SEARCH_FIELD_METADATA_KEY,
  addCatalogItem,
  catalogItems,
  loadCatalog,
  parseTerriaCatalog,
  popupConfigFromFeatureInfo,
  popupFieldsForProfile,
  resetTerriaCatalog,
  searchCatalogItems,
  setTerriaCatalogAdapters,
  terriaCatalogPlugin,
  type CatalogGroup,
  type CatalogItem,
} from "../packages/plugins/src/plugins/terria-catalog";
import {
  RER_POI_SOURCE_KIND,
  setRerPoiFetch,
  stopRerPoiLoader,
} from "../packages/plugins/src/plugins/rer-poi";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The traits the real Emilia-Romagna and Marche init files carry beyond
// "a service and its layers": who may open an entry, whether its service is
// asked with the session's Authorization, how its popup reads, what a query
// tool may filter on, and the region's own point-of-interest item type.

const CATALOG_URL = "https://geoportal.example.org/init/full.json";

const INIT = {
  workbench: [],
  catalog: [
    {
      type: "group",
      id: "root",
      name: "Catalogo",
      members: [
        {
          type: "group",
          id: "riservato",
          name: "Riservato",
          allowedGroups: ["Tecnici"],
          hideWhenUnauthorized: true,
          useAuthentication: true,
          members: [
            {
              type: "wms",
              id: "segreto",
              name: "Segreto",
              url: "https://gis.example.org/wms",
              layers: "s",
            },
            {
              type: "wms",
              id: "pubblico-nel-riservato",
              name: "Anche ai cittadini",
              url: "https://gis.example.org/wms",
              layers: "a",
              allowedGroups: ["Tecnici", "Cittadini"],
              useAuthentication: false,
            },
            {
              type: "wms",
              id: "nessuno",
              name: "Nessun gruppo",
              url: "https://gis.example.org/wms",
              layers: "n",
              allowedGroups: [],
            },
          ],
        },
        {
          type: "wms",
          id: "protetto-visibile",
          name: "Protetto ma elencato",
          url: "https://gis.example.org/wms",
          layers: "p",
          allowedGroups: ["Admin"],
        },
        {
          id: "interventi",
          name: "Interventi",
          type: "geojson",
          url: "https://gis.example.org/interventi.json",
          disableExport: true,
          clustering: { enabled: true },
          nameOfCatalogItemSearchField: "nome_intervento",
          featureInfoTemplate: {
            name: "{{nome_infrastruttura}}",
            partials: { nome_intervento: "Nome intervento", costo: "Costo (€)", data: "Data" },
            formats: {
              costo: { type: "number", useGrouping: true },
              data: { type: "dateTime", format: "dd-mm-yyyy" },
            },
            perProfileInfoFields: {
              undefined: ["nome_intervento"],
              Cittadino: ["nome_intervento", "costo"],
            },
            webServiceUrlProfileCheck: "https://gis.example.org/Account/Check",
          },
          queryableProperties: [
            {
              propertyName: "tipo",
              propertyLabel: "Tipo",
              propertyType: "enum",
              canAggregate: true,
            },
            {
              propertyName: "costo",
              propertyLabel: "Costo",
              propertyType: "number",
              propertyMeasureUnit: "€",
              sumOnAggregation: true,
            },
            {
              propertyName: "ripartizione",
              propertyLabel: "Ripartizione",
              propertyType: "dictionary",
              distributionOnAggregation: true,
              dictionaryKeyProperties: [
                {
                  key: "comuni",
                  alias: "comune",
                  queryProperty: "comune",
                  valueProperty: "percentuale",
                },
              ],
            },
            { propertyName: "junk" },
            { propertyLabel: "no name" },
          ],
          perPropertyStyles: [
            { properties: { stato: "A" }, style: { "marker-color": "#ff0000" } },
            { properties: { stato: "B" }, style: { "marker-color": "#00ff00" } },
          ],
          style: { fill: "#123456" },
        },
        { name: "Edifici", type: "3d-tiles", ionAssetId: 96188, id: "edifici" },
        {
          type: "rer-poi",
          id: "poi",
          name: "RER POI",
          url: "https://servizigis.example/geoags/rest/services/portale/rer3d_poi/MapServer/0",
          clustering: true,
          nameField: "NOME",
          levelIdField: "LEVEL_ID",
          queryableProperties: [
            { propertyName: "ORDINE", propertyLabel: "Tipologia", propertyType: "enum" },
          ],
          perPropertyStyles: [
            { properties: { ID_DOMINIO: 603 }, style: { "marker-symbol": "city" } },
          ],
        },
      ],
    },
  ],
};

describe("catalog traits", () => {
  const catalog = parseTerriaCatalog(INIT);
  const items = catalogItems(catalog.roots);
  const item = (id: string) => items.find((i) => i.id === id) as CatalogItem;

  it("inherits access rules down the tree, a member's own value winning", () => {
    const root = catalog.roots[0] as CatalogGroup;
    const riservato = root.members[0] as CatalogGroup;
    assert.deepEqual(riservato.allowedGroups, ["Tecnici"]);
    assert.equal(riservato.hideWhenUnauthorized, true);
    assert.equal(riservato.useAuthentication, true);
    assert.deepEqual(item("segreto").allowedGroups, ["Tecnici"], "inherited from the group");
    assert.equal(item("segreto").hideWhenUnauthorized, true);
    assert.equal(item("segreto").useAuthentication, true);
    assert.deepEqual(
      item("pubblico-nel-riservato").allowedGroups,
      ["Tecnici", "Cittadini"],
      "its own list",
    );
    assert.deepEqual(
      item("nessuno").allowedGroups,
      [],
      "an empty list is a value, not an omission",
    );
    assert.equal(item("pubblico-nel-riservato").useAuthentication, false);
    assert.equal(item("interventi").allowedGroups, undefined, "public by default");
    assert.equal(item("interventi").hideWhenUnauthorized, false);
  });

  it("reads the vector item's popup, query, search, cluster, export and style traits", () => {
    const interventi = item("interventi");
    assert.equal(interventi.disableExport, true);
    assert.equal(interventi.clustering, true);
    assert.equal(interventi.searchField, "nome_intervento");
    assert.equal(interventi.featureInfo?.name, "{{nome_infrastruttura}}");
    assert.deepEqual(interventi.featureInfo?.perProfileInfoFields?.Cittadino, [
      "nome_intervento",
      "costo",
    ]);
    assert.equal(
      interventi.featureInfo?.webServiceUrlProfileCheck,
      "https://gis.example.org/Account/Check",
    );
    assert.deepEqual(
      interventi.queryableProperties?.map((q) => [
        q.propertyName,
        q.propertyType,
        q.canAggregate,
        q.sumOnAggregation,
      ]),
      [
        ["tipo", "enum", true, false],
        ["costo", "number", false, true],
        ["ripartizione", "dictionary", false, false],
        ["junk", "string", false, false],
      ],
    );
    assert.equal(interventi.queryableProperties?.[2].dictionaryKeyProperties?.[0].alias, "comune");
    assert.equal(interventi.perPropertyStyles?.length, 2);
    assert.deepEqual(interventi.style, { fill: "#123456" });
    assert.equal(item("edifici").ionAssetId, 96188);
    assert.equal(item("edifici").supported, true);
    assert.equal(item("poi").supported, true);
    assert.deepEqual(item("poi").extra.nameField, "NOME", "type-specific keys stay in extra");
    assert.equal(item("poi").extra.perPropertyStyles, undefined, "known keys do not");
  });

  it("turns a featureInfoTemplate into a popup config", () => {
    const popup = popupConfigFromFeatureInfo(item("interventi").featureInfo!);
    assert.equal(popup.titleField, "nome_infrastruttura");
    assert.deepEqual(popup.fields, [
      { field: "nome_intervento", label: "Nome intervento" },
      { field: "costo", label: "Costo (€)", kind: "number", format: { thousands: true } },
      { field: "data", label: "Data", kind: "date", format: { dateFormat: "datetime" } },
    ]);
    assert.equal(
      popupConfigFromFeatureInfo({ name: "Intervento" }).titleExpression,
      JSON.stringify("Intervento"),
    );
    assert.equal(
      popupConfigFromFeatureInfo({ name: "{{a}} {{b}}" }).titleField,
      undefined,
      "a template with several fields is left to the layer name",
    );
  });

  it("narrows the popup fields to what the profile may see", () => {
    const fields = popupConfigFromFeatureInfo(item("interventi").featureInfo!).fields;
    const perProfile = item("interventi").featureInfo!.perProfileInfoFields;
    assert.deepEqual(
      popupFieldsForProfile(fields, perProfile, null)?.map((f) => f.field),
      ["nome_intervento"],
      "anonymous",
    );
    assert.deepEqual(
      popupFieldsForProfile(fields, perProfile, "Cittadino")?.map((f) => f.field),
      ["nome_intervento", "costo"],
    );
    assert.deepEqual(
      popupFieldsForProfile(fields, perProfile, "Admin")?.map((f) => f.field),
      ["nome_intervento", "costo", "data"],
      "a profile the file does not name sees everything",
    );
    assert.deepEqual(
      popupFieldsForProfile(undefined, perProfile, "Cittadino")?.map((f) => f.field),
      ["nome_intervento", "costo"],
      "no partials: the allowance itself",
    );
    assert.equal(popupFieldsForProfile(undefined, undefined, null), undefined);
  });
});

// --- Against the store -------------------------------------------------------

function host() {
  const added: Array<{ kind: string; name: string; options?: Record<string, unknown> }> = [];
  let next = 1;
  const addLayer = (
    kind: string,
    name: string,
    type: GeoLibreLayer["type"],
    source: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => {
    const id = `layer-${next++}`;
    added.push({ kind, name, options });
    useAppStore.getState().addLayer({
      id,
      name,
      type,
      source,
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: {},
    });
    return id;
  };
  const app = {
    getMap: () => null,
    getCesiumScene: () => null,
    getViewBounds: () => [11, 44, 12, 45],
    addGeoJsonLayer: (name: string, data: unknown, url?: string) =>
      addLayer("geojson", name, "geojson", { url }),
    addWmsLayer: (name: string, options: Record<string, unknown>) =>
      addLayer(
        "wms",
        name,
        "wms",
        { url: options.url, tiles: [`${options.url}?layers=${options.layers}`] },
        options,
      ),
    registerRightPanel: () => () => {},
    openRightPanel: () => true,
    closeRightPanel: () => {},
  } as unknown as GeoLibreAppAPI;
  setTerriaCatalogAdapters({
    fetchText: async (url) => {
      if (url === CATALOG_URL) return JSON.stringify(INIT);
      if (url.endsWith("interventi.json"))
        return JSON.stringify({ type: "FeatureCollection", features: [] });
      throw new Error(`unexpected fetch ${url}`);
    },
  });
  setRerPoiFetch(async () => new Response(JSON.stringify({ features: [] }), { status: 200 }));
  return { app, added };
}

beforeEach(() => {
  useAppStore.setState({ layers: [] });
  resetTerriaCatalog();
  signOutGeoportal();
});
afterEach(() => {
  for (const layer of useAppStore.getState().layers) stopRerPoiLoader(layer.id);
  terriaCatalogPlugin.deactivate({ closeRightPanel: () => {} } as unknown as GeoLibreAppAPI);
  setTerriaCatalogAdapters();
  setRerPoiFetch(null);
  resetTerriaCatalog();
  signOutGeoportal();
});

describe("catalog access and layer configuration", () => {
  it("refuses a restricted entry to a visitor, hides it from search, and opens it to the right group", async () => {
    const h = host();
    terriaCatalogPlugin.activate(h.app);
    await loadCatalog(CATALOG_URL);
    assert.equal(await addCatalogItem(CATALOG_URL, "segreto"), null);
    assert.equal(h.added.length, 0);
    assert.equal(searchCatalogItems("segreto").length, 0, "hidden entries are not searchable");
    assert.equal(searchCatalogItems("protetto").length, 1, "a listed-but-locked entry is");
    assert.equal(
      await addCatalogItem(CATALOG_URL, "protetto-visibile"),
      null,
      "locked to another group",
    );

    setGeoportalSession({ username: "t", authorization: "Basic tok", profile: "Tecnici" });
    assert.equal(searchCatalogItems("segreto").length, 1);
    const id = await addCatalogItem(CATALOG_URL, "segreto");
    assert.ok(id);
    const layer = useAppStore.getState().layers.find((l) => l.id === id)!;
    assert.equal(layer.metadata[USE_AUTHENTICATION_METADATA_KEY], true);
    assert.deepEqual(
      layer.source.requestHeaders,
      { Authorization: "Basic tok" },
      "the session header rides on the protected service",
    );
    assert.equal(
      await addCatalogItem(CATALOG_URL, "protetto-visibile"),
      null,
      "still the wrong group",
    );

    const open = await addCatalogItem(CATALOG_URL, "pubblico-nel-riservato");
    assert.ok(open, "a member naming its own groups uses those");
    const openLayer = useAppStore.getState().layers.find((l) => l.id === open)!;
    assert.equal(
      openLayer.metadata[USE_AUTHENTICATION_METADATA_KEY],
      undefined,
      "opted out of the group's authentication",
    );
    assert.equal(openLayer.source.requestHeaders, undefined);
    assert.equal(
      await addCatalogItem(CATALOG_URL, "nessuno"),
      null,
      "an empty list admits nobody, as in the fork",
    );
  });

  it("configures a vector item's popup, query properties, search field, cluster, export and colours", async () => {
    const h = host();
    terriaCatalogPlugin.activate(h.app);
    await loadCatalog(CATALOG_URL);
    const id = await addCatalogItem(CATALOG_URL, "interventi");
    assert.ok(id);
    const layer = useAppStore.getState().layers.find((l) => l.id === id)!;
    assert.equal(layer.popup?.titleField, "nome_infrastruttura");
    assert.deepEqual(
      layer.popup?.fields?.map((f) => f.field),
      ["nome_intervento"],
      "anonymous sees the anonymous subset",
    );
    assert.equal((layer.metadata[QUERYABLE_PROPERTIES_METADATA_KEY] as unknown[]).length, 4);
    assert.deepEqual(layer.metadata[PER_PROFILE_FIELDS_METADATA_KEY], {
      undefined: ["nome_intervento"],
      Cittadino: ["nome_intervento", "costo"],
    });
    assert.equal(layer.metadata[SEARCH_FIELD_METADATA_KEY], "nome_intervento");
    assert.equal(layer.capabilities?.export, false);
    assert.equal(layer.style.pointRenderer, "cluster");
    assert.equal(layer.style.vectorStyleMode, "categorized");
    assert.equal(layer.style.vectorStyleProperty, "stato");
    assert.deepEqual(layer.style.vectorStyleStops, [
      { value: "A", color: "#ff0000" },
      { value: "B", color: "#00ff00" },
    ]);
    assert.equal(layer.style.fillColor, "#123456");
  });

  it("adds an Ion tileset and a POI layer from their item types", async () => {
    const h = host();
    terriaCatalogPlugin.activate(h.app);
    await loadCatalog(CATALOG_URL);
    const tiles = await addCatalogItem(CATALOG_URL, "edifici");
    assert.ok(tiles);
    const tileset = useAppStore.getState().layers.find((l) => l.id === tiles)!;
    assert.equal(tileset.type, "3d-tiles");
    assert.equal(tileset.source.ionAssetId, 96188);
    assert.equal(tileset.metadata.sourceKind, "cesium-ion");

    const poi = await addCatalogItem(CATALOG_URL, "poi");
    assert.ok(poi);
    const poiLayer = useAppStore.getState().layers.find((l) => l.id === poi)!;
    assert.equal(poiLayer.metadata.sourceKind, RER_POI_SOURCE_KIND);
    assert.equal(poiLayer.style.pointRenderer, "cluster");
    assert.equal((poiLayer.metadata[QUERYABLE_PROPERTIES_METADATA_KEY] as unknown[]).length, 1);
    assert.equal((poiLayer.metadata.terriaCatalog as { item: string }).item, "poi");
  });
});

describe("session applied to layers", () => {
  it("adds and removes the header and re-narrows popup fields as the session changes", async () => {
    const h = host();
    terriaCatalogPlugin.activate(h.app);
    await loadCatalog(CATALOG_URL);
    setGeoportalSession({ username: "t", authorization: "Basic one", profile: "Tecnici" });
    const id = (await addCatalogItem(CATALOG_URL, "segreto"))!;
    const vector = (await addCatalogItem(CATALOG_URL, "interventi"))!;
    const layer = () => useAppStore.getState().layers.find((l) => l.id === id)!;
    const fields = () =>
      useAppStore
        .getState()
        .layers.find((l) => l.id === vector)!
        .popup?.fields?.map((f) => f.field);
    assert.deepEqual(layer().source.requestHeaders, { Authorization: "Basic one" });
    assert.deepEqual(
      fields(),
      ["nome_intervento", "costo", "data"],
      "Tecnici is not listed: sees everything",
    );

    setGeoportalSession({ username: "c", authorization: "Basic two", profile: "Cittadino" });
    assert.deepEqual(
      layer().source.requestHeaders,
      { Authorization: "Basic two" },
      "a new session replaces the header",
    );
    assert.deepEqual(fields(), ["nome_intervento", "costo"]);

    signOutGeoportal();
    assert.equal(layer().source.requestHeaders, undefined, "signing out drops the header");
    assert.deepEqual(fields(), ["nome_intervento"], "back to the anonymous subset");

    // A layer restored from a project file asks for the header once the store settles.
    useAppStore.getState().addLayer({
      id: "restored",
      name: "Restored",
      type: "wms",
      source: {
        url: "https://gis.example.org/wms",
        tiles: ["https://gis.example.org/wms?layers=s"],
      },
      visible: true,
      opacity: 1,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { [USE_AUTHENTICATION_METADATA_KEY]: true },
    });
    setGeoportalSession({ username: "t", authorization: "Basic three", profile: "Tecnici" });
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
    const restored = useAppStore.getState().layers.find((l) => l.id === "restored")!;
    assert.deepEqual(restored.source.requestHeaders, { Authorization: "Basic three" });
  });
});
