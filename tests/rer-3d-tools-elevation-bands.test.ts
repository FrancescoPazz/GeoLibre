import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { Egm96Geoid } from "../packages/plugins/src/plugins/rer-3d-tools/egm96";
import {
  DEFAULT_BAND_OPACITY,
  DEFAULT_ELEVATION_BANDS,
  ELEVATION_BANDS_MAX,
  addElevationBand,
  applyElevationBands,
  clearElevationBands,
  closeElevationBandsPanel,
  elevationBandLayers,
  getElevationBandsProjectState,
  getElevationBandsSnapshot,
  isElevationBandsPanelVisible,
  normalizeElevationBands,
  openElevationBandsPanel,
  reattachElevationBands,
  removeElevationBand,
  restoreElevationBands,
  setElevationBands,
  setElevationBandsAboveSeaLevel,
  setElevationBandsGeoid,
  setElevationBandsOpacity,
  updateElevationBand,
} from "../packages/plugins/src/plugins/rer-3d-tools/elevation-bands";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Real Cesium colours; a faked globe whose `createElevationBandMaterial`
// records what it was asked for and hands back a token material, since the
// real one needs a WebGL context for its lookup texture.

const BOLOGNA = { lng: 11.34, lat: 44.49 };
const DEFAULT_MATERIAL = { name: "default" };

type BandLayers = Parameters<typeof Cesium.createElevationBandMaterial>[0]["layers"];

function makeGlobe() {
  let destroyed = false;
  const globe = { material: DEFAULT_MATERIAL as unknown };
  const scene = { globe };
  const built: BandLayers[] = [];
  let renders = 0;
  const handle = {
    Cesium: {
      ...Cesium,
      createElevationBandMaterial: (options: { scene: unknown; layers: BandLayers }) => {
        assert.equal(options.scene, scene);
        built.push(options.layers);
        return { name: `bands-${built.length}`, layers: options.layers };
      },
    },
    viewer: { scene, isDestroyed: () => destroyed },
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
    built,
    renders: () => renders,
    destroy: () => {
      destroyed = true;
    },
  };
}

function globeApp(globe: ReturnType<typeof makeGlobe>): GeoLibreAppAPI {
  return { getMap: () => null, getCesiumScene: () => globe.handle } as unknown as GeoLibreAppAPI;
}
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

/** A geoid that answers a fixed undulation and remembers where it was asked. */
function fakeGeoid(undulation: number): Egm96Geoid & { asked: Array<[number, number]> } {
  const asked: Array<[number, number]> = [];
  return {
    asked,
    heights: async (cartos) => cartos.map(() => undulation),
    height: async (lng, lat) => {
      asked.push([lng, lat]);
      return undulation;
    },
    heightSync: () => undulation,
    load: async () => {},
    loaded: () => true,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  closeElevationBandsPanel();
  setElevationBandsGeoid(undefined);
  restoreElevationBands(mapLessApp, undefined);
  setElevationBandsAboveSeaLevel(false);
});

describe("normalizeElevationBands", () => {
  it("keeps well-formed bands, fills a missing end colour, and caps the count", () => {
    const bands = normalizeElevationBands([
      { fromHeight: 0, fromColor: "#ff0000", toHeight: 100, toColor: "#00ff00" },
      { fromHeight: 100, fromColor: "#0000ff", toHeight: 200 },
      { fromHeight: "x", fromColor: "#0000ff", toHeight: 200 },
      { fromHeight: 0, fromColor: "blue", toHeight: 200 },
      null,
      { fromHeight: Infinity, fromColor: "#0000ff", toHeight: 200 },
    ]);
    assert.deepEqual(bands, [
      { fromHeight: 0, fromColor: "#ff0000", toHeight: 100, toColor: "#00ff00" },
      { fromHeight: 100, fromColor: "#0000ff", toHeight: 200, toColor: "#0000ff" },
    ]);
    const many = Array.from({ length: ELEVATION_BANDS_MAX + 5 }, (_, i) => ({
      fromHeight: i,
      fromColor: "#123456",
      toHeight: i + 1,
    }));
    assert.equal(normalizeElevationBands(many).length, ELEVATION_BANDS_MAX);
    assert.deepEqual(normalizeElevationBands("nope"), [...DEFAULT_ELEVATION_BANDS]);
  });
});

describe("elevationBandLayers", () => {
  it("makes one two-stop layer per band, with the opacity and the offset applied", () => {
    const layers = elevationBandLayers(
      Cesium,
      [{ fromHeight: 100, fromColor: "#ff0000", toHeight: 500, toColor: "#0000ff" }],
      0.25,
      42,
    );
    assert.equal(layers.length, 1);
    const [low, high] = layers[0].entries;
    assert.equal(low.height, 142);
    assert.equal(high.height, 542);
    assert.ok(Cesium.Color.equals(low.color, new Cesium.Color(1, 0, 0, 0.25)));
    assert.ok(Cesium.Color.equals(high.color, new Cesium.Color(0, 0, 1, 0.25)));
  });

  it("orders a top-down band by height, skips flat and unparsable ones", () => {
    const layers = elevationBandLayers(
      Cesium,
      [
        { fromHeight: 900, fromColor: "#ffffff", toHeight: 300, toColor: "#000000" },
        { fromHeight: 50, fromColor: "#ffffff", toHeight: 50, toColor: "#000000" },
        { fromHeight: 0, fromColor: "not-a-colour", toHeight: 10, toColor: "#000000" },
      ],
      1,
      0,
    );
    assert.equal(layers.length, 1);
    assert.equal(layers[0].entries[0].height, 300);
    assert.ok(Cesium.Color.equals(layers[0].entries[0].color, Cesium.Color.BLACK));
    assert.equal(layers[0].entries[1].height, 900);
    assert.ok(Cesium.Color.equals(layers[0].entries[1].color, Cesium.Color.WHITE));
  });
});

describe("elevation bands tool", () => {
  it("edits the band list within its bounds", () => {
    assert.deepEqual(getElevationBandsSnapshot().bands, [...DEFAULT_ELEVATION_BANDS]);
    addElevationBand();
    let { bands } = getElevationBandsSnapshot();
    assert.equal(bands.length, 2);
    assert.equal(bands[1].fromHeight, 500, "continues from the top of the last band");
    assert.equal(bands[1].toHeight, 1000, "with the same span");
    assert.equal(bands[1].fromColor, bands[0].toColor);

    updateElevationBand(1, { toHeight: 1500, toColor: "#ffffff" });
    updateElevationBand(7, { toHeight: 9 });
    bands = getElevationBandsSnapshot().bands;
    assert.equal(bands[1].toHeight, 1500);
    assert.equal(bands[1].toColor, "#ffffff");

    removeElevationBand(0);
    removeElevationBand(5);
    bands = getElevationBandsSnapshot().bands;
    assert.equal(bands.length, 1);
    assert.equal(bands[0].toHeight, 1500);

    for (let i = 0; i < ELEVATION_BANDS_MAX + 3; i += 1) addElevationBand();
    assert.equal(getElevationBandsSnapshot().bands.length, ELEVATION_BANDS_MAX);

    setElevationBandsOpacity(3);
    assert.equal(getElevationBandsSnapshot().opacity, 1);
    setElevationBandsOpacity(Number.NaN);
    assert.equal(getElevationBandsSnapshot().opacity, DEFAULT_BAND_OPACITY);
    setElevationBandsOpacity(0.3);
    assert.equal(getElevationBandsSnapshot().opacity, 0.3);
  });

  it("puts a band material on the globe and restores the default on clear", async () => {
    const globe = makeGlobe();
    openElevationBandsPanel(globeApp(globe));
    assert.equal(getElevationBandsSnapshot().bound, true);
    setElevationBands([
      { fromHeight: 200, fromColor: "#ff0000", toHeight: 800, toColor: "#00ff00" },
    ]);
    setElevationBandsOpacity(0.4);
    assert.equal(await applyElevationBands(), true);
    assert.equal(globe.built.length, 1);
    assert.equal(
      globe.built[0][0].entries[0].height,
      200,
      "no geoid: heights go through unchanged",
    );
    assert.equal(globe.built[0][0].entries[0].color.alpha, 0.4);
    assert.notEqual(globe.globe.material, DEFAULT_MATERIAL);
    assert.equal(getElevationBandsSnapshot().applied, true);
    assert.equal(getElevationBandsSnapshot().geoidOffsetMeters, 0);
    assert.ok(globe.renders() > 0);

    // Re-applying replaces the material rather than stacking a restore chain.
    assert.equal(await applyElevationBands(), true);
    assert.equal(globe.built.length, 2);
    clearElevationBands();
    assert.equal(globe.globe.material, DEFAULT_MATERIAL);
    assert.equal(getElevationBandsSnapshot().applied, false);
  });

  it("shifts the heights by the geoid undulation at the view centre when referred to sea level", async () => {
    const globe = makeGlobe();
    const geoid = fakeGeoid(40.4);
    setElevationBandsGeoid(geoid);
    assert.equal(getElevationBandsSnapshot().geoidAvailable, true);
    openElevationBandsPanel(globeApp(globe));
    setElevationBands([{ fromHeight: 0, fromColor: "#ff0000", toHeight: 100, toColor: "#00ff00" }]);
    setElevationBandsAboveSeaLevel(true);
    assert.equal(await applyElevationBands(), true);
    assert.deepEqual(geoid.asked, [[BOLOGNA.lng, BOLOGNA.lat]]);
    assert.ok(Math.abs(globe.built[0][0].entries[0].height - 40.4) < 1e-9);
    assert.ok(Math.abs(globe.built[0][0].entries[1].height - 140.4) < 1e-9);
    assert.ok(Math.abs((getElevationBandsSnapshot().geoidOffsetMeters ?? 0) - 40.4) < 1e-9);

    setElevationBandsAboveSeaLevel(false);
    assert.equal(await applyElevationBands(), true);
    assert.equal(globe.built[1][0].entries[0].height, 0);
    assert.equal(getElevationBandsSnapshot().geoidOffsetMeters, 0);
  });

  it("does nothing without a globe, or when every band is empty", async () => {
    openElevationBandsPanel(mapLessApp);
    assert.equal(getElevationBandsSnapshot().bound, false);
    assert.equal(await applyElevationBands(), false);

    const globe = makeGlobe();
    openElevationBandsPanel(globeApp(globe));
    setElevationBands([{ fromHeight: 5, fromColor: "#ff0000", toHeight: 5, toColor: "#00ff00" }]);
    assert.equal(await applyElevationBands(), false);
    assert.equal(globe.built.length, 0);
    assert.equal(globe.globe.material, DEFAULT_MATERIAL);
  });

  it("takes the material off on close, and carries it to a new globe on reattach", async () => {
    const first = makeGlobe();
    openElevationBandsPanel(globeApp(first));
    await applyElevationBands();
    assert.notEqual(first.globe.material, DEFAULT_MATERIAL);

    const second = makeGlobe();
    reattachElevationBands(globeApp(second));
    await tick();
    assert.equal(first.globe.material, DEFAULT_MATERIAL, "the old globe is restored");
    assert.notEqual(second.globe.material, DEFAULT_MATERIAL, "the bands follow to the new globe");
    assert.equal(getElevationBandsSnapshot().applied, true);

    reattachElevationBands(globeApp(second));
    assert.equal(second.built.length, 1, "reattaching to the same globe is a no-op");

    closeElevationBandsPanel();
    assert.equal(second.globe.material, DEFAULT_MATERIAL);
    assert.equal(isElevationBandsPanelVisible(), false);
  });

  it("round-trips through the project state, re-applying a saved material", async () => {
    assert.equal(getElevationBandsProjectState(), undefined);
    const globe = makeGlobe();
    openElevationBandsPanel(globeApp(globe));
    setElevationBands([
      { fromHeight: 0, fromColor: "#ff0000", toHeight: 1000, toColor: "#0000ff" },
    ]);
    setElevationBandsOpacity(0.7);
    await applyElevationBands();
    assert.deepEqual(getElevationBandsProjectState(), {
      open: true,
      applied: true,
      bands: [{ fromHeight: 0, fromColor: "#ff0000", toHeight: 1000, toColor: "#0000ff" }],
      opacity: 0.7,
      aboveSeaLevel: false,
    });

    const saved = getElevationBandsProjectState();
    closeElevationBandsPanel();
    const again = makeGlobe();
    assert.equal(restoreElevationBands(globeApp(again), saved), true);
    await tick();
    assert.equal(isElevationBandsPanelVisible(), true);
    assert.equal(again.built.length, 1);
    assert.equal(again.built[0][0].entries[1].height, 1000);
    assert.equal(getElevationBandsSnapshot().opacity, 0.7);

    assert.equal(restoreElevationBands(mapLessApp, undefined), false);
    assert.equal(isElevationBandsPanelVisible(), false);
    assert.equal(again.globe.material, DEFAULT_MATERIAL);
    assert.deepEqual(getElevationBandsSnapshot().bands, [...DEFAULT_ELEVATION_BANDS]);
    assert.equal(getElevationBandsProjectState(), undefined);
  });

  it("is part of the composite plugin's state and is closed on deactivate", async () => {
    const globe = makeGlobe();
    const app = globeApp(globe);
    openElevationBandsPanel(app);
    await applyElevationBands();
    const state = rer3dToolsPlugin.getProjectState?.(app) as Record<string, unknown>;
    assert.equal((state.elevationBands as Record<string, unknown>).applied, true);
    rer3dToolsPlugin.deactivate?.(app);
    assert.equal(isElevationBandsPanelVisible(), false);
    assert.equal(globe.globe.material, DEFAULT_MATERIAL);
  });
});
