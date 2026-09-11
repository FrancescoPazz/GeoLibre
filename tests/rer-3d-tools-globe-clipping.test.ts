import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import { DEFAULT_LAYER_STYLE, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { Feature, Geometry } from "geojson";
import {
  closeGlobeClippingPanel,
  featuresBoundingSphere,
  findTilesetForLayer,
  getGlobeClippingProjectState,
  getGlobeClippingSnapshot,
  isGlobeClippingPanelVisible,
  openGlobeClippingPanel,
  reattachGlobeClipping,
  restoreGlobeClipping,
  setGlobeClippingLayer,
  squareClippingPlanes,
  subscribeGlobeClipping,
} from "../packages/plugins/src/plugins/rer-3d-tools/globe-clipping";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Real Cesium maths for the planes and spheres; a faked globe whose
// primitives hold stand-in tilesets and whose tile-loading event can be
// raised by hand. Layers come from the real app store.

const { Cartesian3 } = Cesium;
const BOLOGNA = { lng: 11.34, lat: 44.49 };

/** A stand-in tileset: only what the module reads (`root`, `boundingSphere`, `resource.url`). */
class FakeTileset {
  root: object | undefined;
  boundingSphere: Cesium.BoundingSphere;
  resource: { url: string };
  constructor(url: string, sphere: Cesium.BoundingSphere, loaded = true) {
    this.resource = { url };
    this.boundingSphere = sphere;
    this.root = loaded ? {} : undefined;
  }
}

function makeGlobe() {
  let destroyed = false;
  const items: object[] = [];
  const globe = {
    ellipsoid: Cesium.Ellipsoid.WGS84,
    clippingPlanes: undefined as Cesium.ClippingPlaneCollection | undefined,
    backFaceCulling: true,
    showSkirts: true,
    tileLoadProgressEvent: new Cesium.Event(),
  };
  const scene = {
    globe,
    primitives: { length: 0, get: (i: number) => items[i] },
  };
  Object.defineProperty(scene.primitives, "length", { get: () => items.length });
  let renders = 0;
  const viewer = { scene, isDestroyed: () => destroyed };
  const handle = {
    Cesium: { ...Cesium, Cesium3DTileset: FakeTileset },
    viewer,
    scene,
    camera: {},
    clock: {},
    canvas: {},
    primary: true,
    requestRender: () => {
      renders += 1;
    },
    readView: () => ({ center: [BOLOGNA.lng, BOLOGNA.lat], zoom: 12, bearing: 0, pitch: 0 }),
  } as unknown as CesiumSceneHandle;
  return {
    handle,
    globe,
    addPrimitive: (p: object) => items.push(p),
    renders: () => renders,
    settleTiles: () => globe.tileLoadProgressEvent.raiseEvent(0),
    destroy: () => {
      destroyed = true;
    },
  };
}

function globeApp(
  globe: ReturnType<typeof makeGlobe>,
  features: Record<string, Feature<Geometry | null>[]> = {},
): GeoLibreAppAPI {
  return {
    getMap: () => null,
    getCesiumScene: () => globe.handle,
    getLayerFeatures: (id: string) => features[id] ?? [],
  } as unknown as GeoLibreAppAPI;
}
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

function layer(
  partial: Partial<GeoLibreLayer> & { id: string; type: GeoLibreLayer["type"] },
): GeoLibreLayer {
  return {
    name: partial.id,
    source: {},
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    ...partial,
  };
}

const sphereAt = (lng: number, lat: number, radius: number) =>
  new Cesium.BoundingSphere(Cartesian3.fromDegrees(lng, lat, 0), radius);

const square = (lng: number, lat: number, halfDeg: number): Feature<Geometry> => ({
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [lng - halfDeg, lat - halfDeg],
        [lng + halfDeg, lat - halfDeg],
        [lng + halfDeg, lat + halfDeg],
        [lng - halfDeg, lat + halfDeg],
        [lng - halfDeg, lat - halfDeg],
      ],
    ],
  },
});

beforeEach(() => {
  closeGlobeClippingPanel();
  restoreGlobeClipping(mapLessApp, undefined);
  useAppStore.setState({ layers: [] });
});

describe("squareClippingPlanes", () => {
  it("builds four vertical planes at the half-width, unioned, in the ENU frame of the centre", () => {
    const center = Cartesian3.fromDegrees(BOLOGNA.lng, BOLOGNA.lat, 0);
    const planes = squareClippingPlanes(Cesium, center, 250);
    assert.equal(planes.length, 4);
    assert.equal(planes.unionClippingRegions, true);
    assert.equal(planes.enabled, true);
    const normals = [];
    for (let i = 0; i < planes.length; i += 1) {
      const plane = planes.get(i);
      assert.equal(plane.distance, 250);
      assert.equal(plane.normal.z, 0, "planes are vertical (no up component)");
      normals.push(`${plane.normal.x},${plane.normal.y}`);
    }
    assert.deepEqual(normals.sort(), ["-1,0", "0,-1", "0,1", "1,0"]);
    const expected = Cesium.Transforms.eastNorthUpToFixedFrame(center);
    assert.ok(Cesium.Matrix4.equalsEpsilon(planes.modelMatrix, expected, 1e-9));
  });
});

describe("featuresBoundingSphere", () => {
  it("centres on the bbox and reaches its farthest corner", () => {
    const sphere = featuresBoundingSphere(Cesium, [square(BOLOGNA.lng, BOLOGNA.lat, 0.01)]);
    assert.ok(sphere);
    const carto = Cesium.Cartographic.fromCartesian(sphere.center);
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) - BOLOGNA.lng) < 1e-9);
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - BOLOGNA.lat) < 1e-9);
    // 0.01° of latitude ≈ 1.11 km, 0.01° of longitude at 44.5° ≈ 0.79 km → ~1.37 km to the corner.
    assert.ok(sphere.radius > 1300 && sphere.radius < 1400, `radius ${sphere.radius}`);
  });

  it("includes the height span and walks every geometry kind", () => {
    const features: Feature<Geometry | null>[] = [
      {
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [BOLOGNA.lng, BOLOGNA.lat, -300] },
      },
      { type: "Feature", properties: {}, geometry: null },
      {
        type: "Feature",
        properties: {},
        geometry: {
          type: "GeometryCollection",
          geometries: [{ type: "MultiPoint", coordinates: [[BOLOGNA.lng, BOLOGNA.lat, 100]] }],
        },
      },
    ];
    const sphere = featuresBoundingSphere(Cesium, features);
    assert.ok(sphere);
    assert.equal(sphere.radius, 200, "half the -300..100 span, no horizontal extent");
    assert.equal(
      featuresBoundingSphere(Cesium, [{ type: "Feature", properties: {}, geometry: null }]),
      null,
    );
    assert.equal(featuresBoundingSphere(Cesium, []), null);
  });
});

describe("findTilesetForLayer", () => {
  it("matches by URL, then by Ion asset id, then falls back to a lone tileset", () => {
    const globe = makeGlobe();
    const a = new FakeTileset("https://tiles.example/a/tileset.json", sphereAt(11, 44, 10));
    const b = new FakeTileset(
      "https://assets.ion.cesium.com/123456/tileset.json",
      sphereAt(12, 45, 10),
    );
    globe.addPrimitive({ notATileset: true });
    globe.addPrimitive(a);
    globe.addPrimitive(b);
    const C = globe.handle.Cesium;
    const scene = globe.handle.scene;
    assert.equal(
      findTilesetForLayer(
        C,
        scene,
        layer({
          id: "x",
          type: "3d-tiles",
          source: { url: "https://tiles.example/a/tileset.json?token=t" },
        }),
      ),
      a,
    );
    assert.equal(
      findTilesetForLayer(
        C,
        scene,
        layer({
          id: "y",
          type: "3d-tiles",
          source: { ionAssetId: 123456 },
          metadata: { sourceKind: "cesium-ion" },
        }),
      ),
      b,
    );
    assert.equal(
      findTilesetForLayer(
        C,
        scene,
        layer({ id: "z", type: "3d-tiles", source: { url: "https://elsewhere/" } }),
      ),
      null,
    );

    const lone = makeGlobe();
    lone.addPrimitive(a);
    assert.equal(
      findTilesetForLayer(C, lone.handle.scene, layer({ id: "z", type: "3d-tiles", source: {} })),
      a,
    );
  });
});

describe("globe clipping tool", () => {
  it("lists only clippable layers, and only while open", () => {
    useAppStore.setState({
      layers: [
        layer({ id: "tiles", type: "3d-tiles", name: "Tunnel" }),
        layer({ id: "pts", type: "geojson", name: "Boreholes" }),
        layer({ id: "wms", type: "wms", name: "Ortho" }),
      ],
    });
    assert.deepEqual(getGlobeClippingSnapshot().layers, []);
    const globe = makeGlobe();
    openGlobeClippingPanel(globeApp(globe));
    assert.equal(isGlobeClippingPanelVisible(), true);
    assert.deepEqual(
      getGlobeClippingSnapshot().layers.map((l) => l.id),
      ["tiles", "pts"],
    );
    assert.equal(getGlobeClippingSnapshot().bound, true);
  });

  it("cuts a hole sized from a GeoJSON layer's features and restores the globe when cleared", () => {
    useAppStore.setState({ layers: [layer({ id: "pts", type: "geojson" })] });
    const globe = makeGlobe();
    globe.globe.showSkirts = true;
    openGlobeClippingPanel(globeApp(globe, { pts: [square(BOLOGNA.lng, BOLOGNA.lat, 0.001)] }));
    setGlobeClippingLayer("pts");
    const snap = getGlobeClippingSnapshot();
    assert.equal(snap.activeLayerId, "pts");
    assert.equal(snap.pending, false);
    assert.ok(snap.halfWidthMeters && snap.halfWidthMeters > 100 && snap.halfWidthMeters < 150);
    assert.ok(globe.globe.clippingPlanes instanceof Cesium.ClippingPlaneCollection);
    assert.equal(globe.globe.clippingPlanes.length, 4);
    assert.equal(globe.globe.backFaceCulling, false);
    assert.equal(globe.globe.showSkirts, false);
    assert.ok(globe.renders() > 0);

    const hole = globe.globe.clippingPlanes;
    setGlobeClippingLayer(null);
    assert.equal(globe.globe.clippingPlanes, undefined);
    assert.equal(globe.globe.backFaceCulling, true);
    assert.equal(globe.globe.showSkirts, true);
    assert.equal(hole.enabled, false, "the old collection is switched off before being dropped");
    assert.equal(getGlobeClippingSnapshot().halfWidthMeters, null);
  });

  it("uses the loaded tileset's sphere for 3D Tiles, waiting for the root tile when it is not there yet", () => {
    useAppStore.setState({
      layers: [
        layer({
          id: "tiles",
          type: "3d-tiles",
          source: { url: "https://tiles.example/t/tileset.json" },
        }),
      ],
    });
    const globe = makeGlobe();
    const tileset = new FakeTileset(
      "https://tiles.example/t/tileset.json",
      sphereAt(BOLOGNA.lng, BOLOGNA.lat, 320),
      false,
    );
    globe.addPrimitive(tileset);
    openGlobeClippingPanel(globeApp(globe));
    setGlobeClippingLayer("tiles");
    assert.equal(getGlobeClippingSnapshot().pending, true);
    assert.equal(globe.globe.clippingPlanes, undefined);

    tileset.root = {};
    globe.settleTiles();
    const snap = getGlobeClippingSnapshot();
    assert.equal(snap.pending, false);
    assert.equal(snap.halfWidthMeters, 320);
    assert.equal(globe.globe.clippingPlanes?.get(0).distance, 320);
  });

  it("moves the hole to another layer and drops it when its layer leaves the project", () => {
    const tiles = layer({
      id: "tiles",
      type: "3d-tiles",
      source: { url: "https://tiles.example/t/tileset.json" },
    });
    const pts = layer({ id: "pts", type: "geojson" });
    useAppStore.setState({ layers: [tiles, pts] });
    const globe = makeGlobe();
    globe.addPrimitive(
      new FakeTileset(
        "https://tiles.example/t/tileset.json",
        sphereAt(BOLOGNA.lng, BOLOGNA.lat, 50),
      ),
    );
    openGlobeClippingPanel(
      globeApp(globe, { pts: [square(BOLOGNA.lng + 0.1, BOLOGNA.lat, 0.001)] }),
    );
    setGlobeClippingLayer("tiles");
    assert.equal(getGlobeClippingSnapshot().halfWidthMeters, 50);
    setGlobeClippingLayer("pts");
    assert.notEqual(getGlobeClippingSnapshot().halfWidthMeters, 50);
    assert.equal(getGlobeClippingSnapshot().activeLayerId, "pts");

    let notified = 0;
    const unsubscribe = subscribeGlobeClipping(() => {
      notified += 1;
    });
    useAppStore.setState({ layers: [tiles] });
    unsubscribe();
    assert.ok(notified > 0, "store changes are published");
    assert.equal(getGlobeClippingSnapshot().activeLayerId, null);
    assert.equal(globe.globe.clippingPlanes, undefined);
    assert.deepEqual(
      getGlobeClippingSnapshot().layers.map((l) => l.id),
      ["tiles"],
    );
  });

  it("fills the hole on close and re-cuts it on reattach to a new globe", () => {
    useAppStore.setState({ layers: [layer({ id: "pts", type: "geojson" })] });
    const features = { pts: [square(BOLOGNA.lng, BOLOGNA.lat, 0.001)] };
    const first = makeGlobe();
    openGlobeClippingPanel(globeApp(first, features));
    setGlobeClippingLayer("pts");
    assert.ok(first.globe.clippingPlanes);

    const second = makeGlobe();
    reattachGlobeClipping(globeApp(second, features));
    assert.equal(first.globe.clippingPlanes, undefined, "the old globe is restored");
    assert.ok(second.globe.clippingPlanes, "the hole follows to the new globe");
    assert.equal(getGlobeClippingSnapshot().activeLayerId, "pts");

    closeGlobeClippingPanel();
    assert.equal(second.globe.clippingPlanes, undefined);
    assert.equal(second.globe.backFaceCulling, true);
    assert.equal(isGlobeClippingPanelVisible(), false);
  });

  it("reports unbound without a globe and does nothing to it", () => {
    useAppStore.setState({ layers: [layer({ id: "pts", type: "geojson" })] });
    openGlobeClippingPanel(mapLessApp);
    setGlobeClippingLayer("pts");
    const snap = getGlobeClippingSnapshot();
    assert.equal(snap.bound, false);
    assert.equal(snap.activeLayerId, "pts");
    assert.equal(snap.pending, true);
  });

  it("round-trips through the project state", () => {
    useAppStore.setState({ layers: [layer({ id: "pts", type: "geojson" })] });
    assert.equal(getGlobeClippingProjectState(), undefined);
    const globe = makeGlobe();
    openGlobeClippingPanel(globeApp(globe, { pts: [square(BOLOGNA.lng, BOLOGNA.lat, 0.001)] }));
    setGlobeClippingLayer("pts");
    assert.deepEqual(getGlobeClippingProjectState(), { open: true, layerId: "pts" });

    closeGlobeClippingPanel();
    const again = makeGlobe();
    assert.equal(
      restoreGlobeClipping(globeApp(again, { pts: [square(BOLOGNA.lng, BOLOGNA.lat, 0.001)] }), {
        open: true,
        layerId: "pts",
      }),
      true,
    );
    assert.equal(isGlobeClippingPanelVisible(), true);
    assert.ok(again.globe.clippingPlanes, "the hole is cut again from the saved layer");
    assert.equal(restoreGlobeClipping(mapLessApp, undefined), false);
    assert.equal(isGlobeClippingPanelVisible(), false);
    assert.equal(again.globe.clippingPlanes, undefined);
  });

  it("is part of the composite plugin's state and is closed on deactivate", () => {
    useAppStore.setState({ layers: [layer({ id: "pts", type: "geojson" })] });
    const globe = makeGlobe();
    const app = globeApp(globe, { pts: [square(BOLOGNA.lng, BOLOGNA.lat, 0.001)] });
    openGlobeClippingPanel(app);
    setGlobeClippingLayer("pts");
    const state = rer3dToolsPlugin.getProjectState?.(app) as Record<string, unknown>;
    assert.deepEqual(state.globeClipping, { open: true, layerId: "pts" });
    rer3dToolsPlugin.deactivate?.(app);
    assert.equal(isGlobeClippingPanelVisible(), false);
    assert.equal(globe.globe.clippingPlanes, undefined);
  });
});
