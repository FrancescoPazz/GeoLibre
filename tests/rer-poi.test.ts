import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useAppStore } from "@geolibre/core";
import {
  DEFAULT_RER_POI_OPTIONS,
  RER_POI_SOURCE_KIND,
  addRerPoiLayer,
  createRerPoiLayer,
  isRerPoiLoaderActive,
  levelsForZoom,
  padExtent,
  rerPoiDistinctUrl,
  rerPoiFeatureStyle,
  rerPoiOptionsFromCatalogItem,
  rerPoiQueryUrl,
  rerPoiWhere,
  restoreRerPoiLayers,
  setRerPoiFetch,
  stopRerPoiLoader,
  styleRerPoiFeatures,
  type RerPoiOptions,
} from "../packages/plugins/src/plugins/rer-poi";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The RER points of interest: a level-filtered, view-bound ArcGIS point
// layer. The query shape follows the old catalog item; the loader runs
// against the real store and a fake service.

const URL_ = "https://servizigis.example/geoags/rest/services/portale/rer3d_poi/MapServer/0";
const BASE: RerPoiOptions = {
  ...DEFAULT_RER_POI_OPTIONS,
  url: URL_,
  name: "RER POI",
  perPropertyStyles: [
    { properties: { ID_DOMINIO: 603 }, style: { "marker-symbol": "city" } },
    {
      properties: { ID_DOMINIO: 9 },
      style: { "marker-symbol": "mountain", "marker-color": "#ff00ff" },
    },
  ],
  dynamicRequestDebounceMs: 1,
};

describe("rer-poi query shape", () => {
  it("reads the catalog entry's traits with the old defaults", () => {
    const options = rerPoiOptionsFromCatalogItem({
      name: "RER POI",
      url: URL_,
      clustering: true,
      perPropertyStyles: BASE.perPropertyStyles,
      extra: {
        levelIdField: "LEVEL_ID",
        labelFontSize: 12,
        cameraTiltLimitDegrees: 60,
        where: "REG='ER'",
      },
    });
    assert.ok(options);
    assert.equal(options.clustering, true);
    assert.equal(options.labelFontSize, 12);
    assert.equal(options.where, "REG='ER'");
    assert.equal(options.nameField, "NOME");
    assert.equal(options.dynamicRequestDebounceMs, 350);
    assert.equal(rerPoiOptionsFromCatalogItem({ name: "x" }), null);
  });

  it("asks for the levels at or below the zoom, as a quoted IN list, within the configured bounds", () => {
    const known = [1, 3, 5, 7, 8, 10, 12];
    assert.deepEqual(levelsForZoom(known, 8.4, {}), [1, 3, 5, 7, 8]);
    assert.deepEqual(levelsForZoom(known, 8.6, {}), [1, 3, 5, 7, 8]);
    assert.deepEqual(levelsForZoom(known, 20, { maxLevelId: 10 }), [1, 3, 5, 7, 8, 10]);
    assert.deepEqual(levelsForZoom(known, 8, { minLevelId: 5 }), [5, 7, 8]);
    assert.equal(rerPoiWhere({ levelIdField: "LEVEL_ID" }, [1, 3]), "(LEVEL_ID IN ('1','3'))");
    assert.equal(
      rerPoiWhere({ where: "REG='ER'", levelIdField: "LEVEL_ID" }, [7]),
      "(REG='ER') AND (LEVEL_ID IN ('7'))",
    );
    assert.equal(rerPoiWhere({ levelIdField: "LEVEL_ID" }, []), "1=1");
  });

  it("pads the extent by the ratio and clamps it to the world", () => {
    assert.deepEqual(padExtent([10, 40, 12, 42], 0.5), [9, 39, 13, 43]);
    assert.deepEqual(padExtent([-179, 89, 179, 90], 0.5), [-180, 88.5, 180, 90]);
  });

  it("builds the GeoJSON page query and the distinct-values query", () => {
    const url = new URL(rerPoiQueryUrl(BASE, [1, 7], [11.2, 44.4, 11.5, 44.6], 1000));
    assert.equal(url.pathname.endsWith("/MapServer/0/query"), true);
    assert.equal(url.searchParams.get("f"), "geojson");
    assert.equal(url.searchParams.get("where"), "(LEVEL_ID IN ('1','7'))");
    assert.equal(url.searchParams.get("geometry"), "11.200000,44.400000,11.500000,44.600000");
    assert.equal(url.searchParams.get("geometryType"), "esriGeometryEnvelope");
    assert.equal(url.searchParams.get("spatialRel"), "esriSpatialRelIntersects");
    assert.equal(url.searchParams.get("outSR"), "4326");
    assert.equal(url.searchParams.get("resultRecordCount"), "1000");
    assert.equal(url.searchParams.get("resultOffset"), "1000");
    const distinct = new URL(rerPoiDistinctUrl(`${URL_}?f=html`, "LEVEL_ID"));
    assert.equal(distinct.searchParams.get("returnDistinctValues"), "true");
    assert.equal(distinct.searchParams.get("outFields"), "LEVEL_ID");
    assert.equal(distinct.searchParams.get("returnGeometry"), "false");
    assert.throws(
      () => rerPoiQueryUrl({ ...BASE, url: "https://x/MapServer" }, [], [0, 0, 1, 1], 0),
      /layer of a MapServer/,
    );
  });

  it("colours each point from its domain style, the default otherwise", () => {
    assert.deepEqual(rerPoiFeatureStyle({ ID_DOMINIO: 9 }, BASE), {
      "marker-color": "#ff00ff",
      "marker-symbol": "mountain",
    });
    assert.deepEqual(rerPoiFeatureStyle({ ID_DOMINIO: "603" }, BASE), {
      "marker-color": "royalblue",
      "marker-symbol": "city",
    });
    assert.deepEqual(rerPoiFeatureStyle({ ID_DOMINIO: 1 }, BASE), { "marker-color": "royalblue" });
    const styled = styleRerPoiFeatures(
      [
        {
          type: "Feature",
          properties: { ID_DOMINIO: 9, NOME: "Cimone" },
          geometry: { type: "Point", coordinates: [10.7, 44.2] },
        },
      ],
      BASE,
    );
    assert.equal(styled[0].properties?.["marker-color"], "#ff00ff");
    assert.equal(styled[0].properties?.NOME, "Cimone");
  });

  it("builds a pin-styled, labelled GeoJSON layer that remembers its options", () => {
    const layer = createRerPoiLayer({ ...BASE, clustering: true }, "poi");
    assert.equal(layer.type, "geojson");
    assert.equal(layer.style.simpleStyleEnabled, true);
    assert.equal(layer.style.markerShape, "pin");
    assert.equal(layer.style.pointRenderer, "cluster");
    assert.equal(layer.style.labels.field, "NOME");
    assert.equal(
      layer.style.labels.enabled,
      false,
      "labels come on once few enough points are loaded",
    );
    assert.equal(layer.metadata.sourceKind, RER_POI_SOURCE_KIND);
    assert.equal((layer.metadata.rerPoi as RerPoiOptions).url, URL_);
    assert.equal(layer.capabilities?.create, false);
  });
});

// --- The loader against the store and a fake service --------------------------

function fakeService(
  points: Array<{ level: number; name: string; domain: number; lng: number; lat: number }>,
) {
  const asked: URL[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    asked.push(url);
    if (url.searchParams.get("returnDistinctValues") === "true") {
      const field = url.searchParams.get("outFields") ?? "";
      const values = [
        ...new Set(points.map((p) => (field === "LEVEL_ID" ? String(p.level) : String(p.domain)))),
      ];
      return new Response(
        JSON.stringify({ features: values.map((v) => ({ attributes: { [field]: v } })) }),
        { status: 200 },
      );
    }
    const where = url.searchParams.get("where") ?? "";
    const levels = [...where.matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));
    const [w, s, e, n] = (url.searchParams.get("geometry") ?? "0,0,0,0").split(",").map(Number);
    const features = points
      .filter(
        (p) => levels.includes(p.level) && p.lng >= w && p.lng <= e && p.lat >= s && p.lat <= n,
      )
      .map((p) => ({
        type: "Feature",
        properties: { NOME: p.name, LEVEL_ID: String(p.level), ID_DOMINIO: p.domain },
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
      }));
    return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200 });
  };
  setRerPoiFetch(fetchImpl);
  return { asked };
}

function appWithView(bounds: [number, number, number, number]): GeoLibreAppAPI {
  return { getMap: () => null, getViewBounds: () => bounds } as unknown as GeoLibreAppAPI;
}

const setView = (zoom: number, pitch = 0) =>
  useAppStore.setState((s) => ({ mapView: { ...s.mapView, zoom, pitch } }));
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  useAppStore.setState({ layers: [] });
  setView(8);
});
afterEach(() => {
  for (const layer of useAppStore.getState().layers) stopRerPoiLoader(layer.id);
  setRerPoiFetch(null);
});

describe("rer-poi loader", () => {
  const POINTS = [
    { level: 7, name: "BOLOGNA", domain: 603, lng: 11.34, lat: 44.49 },
    { level: 10, name: "Casalecchio", domain: 602, lng: 11.28, lat: 44.48 },
    { level: 13, name: "Monte Cimone", domain: 9, lng: 10.7, lat: 44.19 },
    { level: 7, name: "PARMA", domain: 603, lng: 10.33, lat: 44.8 },
  ];

  it("fills the layer with the levels at the zoom inside the padded view, and labels them when few", async () => {
    const service = fakeService(POINTS);
    const app = appWithView([11.2, 44.4, 11.5, 44.6]);
    const id = addRerPoiLayer(app, BASE);
    await tick();
    const layer = useAppStore.getState().layers.find((l) => l.id === id)!;
    assert.deepEqual(
      layer.geojson?.features.map((f) => f.properties?.NOME),
      ["BOLOGNA"],
      "zoom 8: level 7 only, in view",
    );
    assert.equal(layer.geojson?.features[0].properties?.["marker-color"], "royalblue");
    assert.equal(layer.style.labels.enabled, true, "one point is below the label threshold");
    assert.equal(
      service.asked[0].searchParams.get("returnDistinctValues"),
      "true",
      "the level range is asked first",
    );

    setView(11);
    await tick();
    const zoomed = useAppStore.getState().layers.find((l) => l.id === id)!;
    assert.deepEqual(
      zoomed.geojson?.features.map((f) => f.properties?.NOME),
      ["BOLOGNA", "Casalecchio"],
    );
  });

  it("does not ask again for a view inside the last served extent at the same levels", async () => {
    const service = fakeService(POINTS);
    const app = appWithView([11.2, 44.4, 11.5, 44.6]);
    addRerPoiLayer(app, BASE);
    await tick();
    const before = service.asked.length;
    useAppStore.setState((s) => ({ mapView: { ...s.mapView, center: [11.34, 44.49] } }));
    await tick();
    assert.equal(service.asked.length, before, "the padded extent still covers the view");
  });

  it("holds off while the camera is tilted past the limit, and hides labels above the threshold", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      level: 7,
      name: `P${i}`,
      domain: 1,
      lng: 11.3 + i * 0.001,
      lat: 44.5,
    }));
    const service = fakeService(many);
    const app = appWithView([11.2, 44.4, 11.6, 44.6]);
    setView(8, 75);
    const id = addRerPoiLayer(app, BASE);
    await tick();
    assert.equal(service.asked.length, 0, "no request while tilted past 60°");
    setView(8, 30);
    await tick();
    const layer = useAppStore.getState().layers.find((l) => l.id === id)!;
    assert.equal(layer.geojson?.features.length, 150);
    assert.equal(layer.style.labels.enabled, false, "150 points is past the label threshold");
  });

  it("stops when the layer is removed, and restores loaders for saved layers", async () => {
    fakeService(POINTS);
    const app = appWithView([11.2, 44.4, 11.5, 44.6]);
    const id = addRerPoiLayer(app, BASE);
    assert.equal(isRerPoiLoaderActive(id), true);
    useAppStore.getState().removeLayer(id);
    await tick();
    assert.equal(isRerPoiLoaderActive(id), false);

    const saved = createRerPoiLayer(BASE, "saved");
    useAppStore.setState({ layers: [saved] });
    restoreRerPoiLayers(app);
    assert.equal(isRerPoiLoaderActive("saved"), true);
    await tick();
    assert.equal(useAppStore.getState().layers[0].geojson?.features.length, 1);
  });
});
