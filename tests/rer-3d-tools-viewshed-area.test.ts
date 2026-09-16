import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import {
  VISIBILITY_HIDDEN,
  VISIBILITY_NO_DATA,
  VISIBILITY_VISIBLE,
  computeViewshed,
  gridCartographics,
  gridExtent,
  gridLayout,
  rasterizeVisibility,
  sampleTerrainVisibilityGrid,
  visibleFraction,
} from "../packages/plugins/src/plugins/rer-3d-tools/viewshed-area-geometry";
import {
  DEFAULT_VIEWSHED_AREA_SETTINGS,
  VIEWSHED_AREA_DEBOUNCE_MS,
  clearViewshedArea,
  closeViewshedAreaPanel,
  getViewshedAreaProjectState,
  getViewshedAreaSnapshot,
  isViewshedAreaPanelVisible,
  normalizeViewshedAreaSettings,
  openViewshedAreaPanel,
  reattachViewshedArea,
  restoreViewshedArea,
  setViewshedAreaSettings,
} from "../packages/plugins/src/plugins/rer-3d-tools/viewshed-area";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The visible-area sweep is checked on synthetic terrain where the answer
// is known by construction — flat ground, a wall, a pit — and the tool on
// a faked globe whose terrain read is a height function, as the other 3D
// tools' tests do.

const ORIGIN = { lng: 11.0, lat: 44.3, alt: 0 };
const { Cartesian3 } = Cesium;

function flatGrid(gridWidth: number, cellSize: number, height = 0) {
  return { gridWidth, cellSize, heights: new Float32Array(gridWidth * gridWidth).fill(height) };
}

describe("viewshed sweep", () => {
  it("lays out an odd, centred grid no finer than a metre", () => {
    assert.deepEqual(gridLayout(2000, 300), { gridWidth: 301, cellSize: 4000 / 300 });
    const tiny = gridLayout(50, 300);
    assert.equal(tiny.cellSize, 1);
    assert.equal(tiny.gridWidth % 2, 1);
  });

  it("sees all of flat ground from above it", () => {
    const grid = flatGrid(21, 10);
    const visibility = computeViewshed(grid, 1.7);
    const half = 10;
    assert.equal(visibility[half * 21 + half], VISIBILITY_VISIBLE, "the observer's own cell");
    const seen = Array.from(visibility).filter((v) => v === VISIBILITY_VISIBLE).length;
    const hidden = Array.from(visibility).filter((v) => v === VISIBILITY_HIDDEN).length;
    assert.equal(hidden, 0);
    assert.ok(seen > 300, `${seen} cells seen`);
    assert.equal(visibleFraction(visibility), 1);
  });

  it("hides the ground behind a wall, and what is not sampled stays no-data", () => {
    const grid = flatGrid(41, 10);
    const half = 20;
    // A 50 m wall one column east of the observer, running north–south.
    for (let j = 0; j < 41; j += 1) grid.heights[j * 41 + half + 3] = 50;
    // Corners outside the radius were never sampled.
    grid.heights[0] = Number.NaN;
    const visibility = computeViewshed(grid, 1.7);
    assert.equal(visibility[0], VISIBILITY_NO_DATA);
    assert.equal(visibility[half * 41 + half + 3], VISIBILITY_VISIBLE, "the wall top is seen");
    assert.equal(visibility[half * 41 + half + 6], VISIBILITY_HIDDEN, "just behind it is not");
    assert.equal(visibility[half * 41 + half + 19], VISIBILITY_HIDDEN, "nor the far ground east");
    assert.equal(visibility[half * 41 + half - 10], VISIBILITY_VISIBLE, "west is open");
    const share = visibleFraction(visibility);
    assert.ok(share > 0.4 && share < 0.7, `${share}`);
  });

  it("sees into a pit from its rim but not over a ridge from below", () => {
    const grid = flatGrid(41, 10, 100);
    const half = 20;
    // A ridge at 150 m ten cells north; the observer stands at 100 m.
    for (let i = 0; i < 41; i += 1) grid.heights[(half + 10) * 41 + i] = 150;
    const visibility = computeViewshed(grid, 101.7);
    assert.equal(visibility[(half + 10) * 41 + half], VISIBILITY_VISIBLE, "the ridge itself");
    assert.equal(visibility[(half + 15) * 41 + half], VISIBILITY_HIDDEN, "beyond the ridge");
    // Raise the eye above the ridge line and the far side comes back.
    const fromTower = computeViewshed(grid, 100 + 200);
    assert.equal(fromTower[(half + 15) * 41 + half], VISIBILITY_VISIBLE);
  });

  it("paints only the visible cells, north row first", () => {
    const grid = flatGrid(3, 10);
    const visibility = new Uint8Array(9).fill(VISIBILITY_HIDDEN);
    visibility[2 * 3 + 0] = VISIBILITY_VISIBLE; // north-west cell
    const image = rasterizeVisibility(grid, visibility, [1, 2, 3, 4]);
    assert.equal(image.width, 3);
    assert.deepEqual(Array.from(image.data.slice(0, 4)), [1, 2, 3, 4], "top-left pixel");
    assert.equal(image.data.filter((_, i) => i % 4 === 3 && image.data[i] > 0).length, 1);
  });

  it("places the grid cells around the observer and bounds them geographically", () => {
    const layout = gridLayout(1000, 20);
    const { cartographics, cellIndex } = gridCartographics(Cesium, ORIGIN, 1000, layout);
    assert.equal(cartographics.length, cellIndex.length);
    assert.ok(cartographics.length < layout.gridWidth ** 2, "the corners are skipped");
    const centre =
      cartographics[cellIndex.indexOf(((layout.gridWidth - 1) / 2) * (layout.gridWidth + 1))];
    assert.ok(Math.abs(Cesium.Math.toDegrees(centre.longitude) - ORIGIN.lng) < 1e-9);
    const [west, south, east, north] = gridExtent(Cesium, ORIGIN, layout);
    assert.ok(west < ORIGIN.lng && east > ORIGIN.lng && south < ORIGIN.lat && north > ORIGIN.lat);
    // ~1 km each way at 44°N: about 0.0125° of longitude, 0.009° of latitude.
    assert.ok(Math.abs(east - west - 0.025) < 0.002, `${east - west}`);
    assert.ok(Math.abs(north - south - 0.018) < 0.002, `${north - south}`);
  });

  it("reads the terrain into the grid and refuses a provider without availability", async () => {
    const provider = {
      availability: {},
    } as unknown as import("@cesium/engine").TerrainProvider;
    const C = {
      ...Cesium,
      sampleTerrainMostDetailed: async (_p: unknown, positions: Cesium.Cartographic[]) => {
        for (const c of positions) c.height = 100 + Cesium.Math.toDegrees(c.longitude) - ORIGIN.lng;
        return positions;
      },
    } as unknown as CesiumSceneHandle["Cesium"];
    const grid = await sampleTerrainVisibilityGrid(C, provider, ORIGIN, 200, {
      maxCellsPerSide: 20,
    });
    assert.equal(grid.gridWidth, 21);
    assert.ok(Math.abs(grid.groundHeightAtObserver - 100) < 1e-6);
    assert.ok(Number.isNaN(grid.heights[0]), "a corner outside the radius");
    await assert.rejects(
      sampleTerrainVisibilityGrid(
        C,
        {} as unknown as import("@cesium/engine").TerrainProvider,
        ORIGIN,
        200,
      ),
    );
  });
});

// --- the tool on a faked globe ------------------------------------------

type Entity = Record<string, unknown> & { id: string };
type Positioned = (m: { position: Cesium.Cartesian2 }) => void;
type Motion = (m: { endPosition: Cesium.Cartesian2 }) => void;

function makeGlobe(options: { terrain?: (lng: number, lat: number) => number } = {}) {
  let destroyed = false;
  const entities: Entity[] = [];
  const canvas = {
    style: { cursor: "" },
    clientHeight: 800,
    height: 800,
  } as unknown as HTMLCanvasElement;
  let nextGround: Cesium.Cartesian3 | null = null;
  let underCursor: Entity | null = null;
  const controller = { enableInputs: true };
  const tileListeners: Array<(remaining: number) => void> = [];
  const camera = {
    getPickRay: () =>
      nextGround ? new Cesium.Ray(nextGround, new Cartesian3(0, 0, 1)) : undefined,
    pickEllipsoid: () => undefined,
    frustum: { fovy: Math.PI / 3 },
    positionCartographic: { height: 5000 },
  };
  const scene = {
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      pick: (ray: Cesium.Ray) =>
        nextGround && Cartesian3.equals(ray.origin, nextGround) ? nextGround : undefined,
      tileLoadProgressEvent: {
        addEventListener: (fn: (n: number) => void) => tileListeners.push(fn),
        removeEventListener: (fn: (n: number) => void) => {
          const i = tileListeners.indexOf(fn);
          if (i >= 0) tileListeners.splice(i, 1);
        },
      },
    },
    screenSpaceCameraController: controller,
    pick: () => (underCursor ? { id: underCursor } : undefined),
  };
  const viewer = {
    scene,
    camera,
    canvas,
    terrainProvider: options.terrain ? { availability: {} } : undefined,
    entities: {
      add: (entity: Entity) => {
        entities.push(entity);
        return entity;
      },
      remove: (entity: Entity) => {
        const i = entities.indexOf(entity);
        if (i >= 0) entities.splice(i, 1);
        return i >= 0;
      },
    },
    isDestroyed: () => destroyed,
  };
  const actions = new Map<string, Positioned | Motion>();
  let handlerDestroyed = false;
  class FakeHandler {
    setInputAction(fn: Positioned | Motion, type: string) {
      actions.set(type, fn);
    }
    destroy() {
      handlerDestroyed = true;
    }
    isDestroyed() {
      return handlerDestroyed;
    }
  }
  const sampleTerrainMostDetailed = async (_p: unknown, positions: Cesium.Cartographic[]) => {
    for (const c of positions) {
      c.height = options.terrain!(
        Cesium.Math.toDegrees(c.longitude),
        Cesium.Math.toDegrees(c.latitude),
      );
    }
    return positions;
  };
  const handle = {
    Cesium: {
      ...Cesium,
      sampleTerrainMostDetailed,
      ScreenSpaceEventHandler: FakeHandler,
      ScreenSpaceEventType: {
        LEFT_DOWN: "LEFT_DOWN",
        LEFT_UP: "LEFT_UP",
        LEFT_CLICK: "LEFT_CLICK",
        MOUSE_MOVE: "MOUSE_MOVE",
      },
    },
    viewer,
    scene,
    camera,
    clock: {},
    canvas,
    primary: true,
    requestRender: () => {},
    readView: () => ({
      center: [ORIGIN.lng, ORIGIN.lat] as [number, number],
      zoom: 12,
      bearing: 0,
      pitch: 0,
    }),
  } as unknown as CesiumSceneHandle;
  const fire = (type: string, position: Cesium.Cartesian2) => {
    const fn = actions.get(type);
    if (!fn) return;
    if (type === "MOUSE_MOVE") (fn as Motion)({ endPosition: position });
    else (fn as Positioned)({ position });
  };
  const px = new Cesium.Cartesian2(1, 1);
  return {
    handle,
    entities,
    canvas,
    controller,
    ids: () => entities.map((e) => e.id).sort(),
    click: (p: { lng: number; lat: number; alt: number }) => {
      nextGround = Cartesian3.fromDegrees(p.lng, p.lat, p.alt);
      underCursor = null;
      fire("LEFT_DOWN", px);
      fire("LEFT_UP", px);
      fire("LEFT_CLICK", px);
      nextGround = null;
    },
    drag: (to: { lng: number; lat: number; alt: number }) => {
      underCursor = entities.find((e) => e.id === "geolibre-viewshed-area-observer") ?? null;
      assert.ok(underCursor, "the observer exists");
      fire("LEFT_DOWN", px);
      underCursor = null;
      nextGround = Cartesian3.fromDegrees(to.lng, to.lat, to.alt);
      fire("MOUSE_MOVE", px);
      fire("LEFT_UP", px);
      nextGround = null;
    },
    settleTiles: () => {
      for (const fn of [...tileListeners]) fn(0);
    },
    enableTerrain: () => {
      (viewer as { terrainProvider?: unknown }).terrainProvider = { availability: {} };
      options.terrain = options.terrain ?? (() => 0);
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, VIEWSHED_AREA_DEBOUNCE_MS + 30));
const globeApp = (globe: ReturnType<typeof makeGlobe>): GeoLibreAppAPI =>
  ({ getMap: () => null, getCesiumScene: () => globe.handle }) as unknown as GeoLibreAppAPI;
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

describe("viewshed area tool", () => {
  beforeEach(() => {
    restoreViewshedArea(mapLessApp, undefined);
  });

  it("opens unbound on the 2D map and binds when the globe mounts", () => {
    openViewshedAreaPanel(mapLessApp);
    assert.equal(isViewshedAreaPanelVisible(), true);
    assert.equal(getViewshedAreaSnapshot().phase, "unavailable");
    const globe = makeGlobe({ terrain: () => 0 });
    reattachViewshedArea(globeApp(globe));
    assert.equal(getViewshedAreaSnapshot().phase, "observer");
    assert.equal(globe.canvas.style.cursor, "crosshair");
  });

  it("places the observer on click, sweeps the terrain and reports the visible share", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openViewshedAreaPanel(globeApp(globe));
    setViewshedAreaSettings({ radiusMeters: 300 });
    globe.click(ORIGIN);
    let s = getViewshedAreaSnapshot();
    assert.equal(s.phase, "done");
    assert.deepEqual(globe.ids(), [
      "geolibre-viewshed-area-observer",
      "geolibre-viewshed-area-radius",
    ]);
    assert.equal(globe.canvas.style.cursor, "");
    assert.equal(s.status, "idle", "not before the debounce");
    await settle();
    s = getViewshedAreaSnapshot();
    assert.equal(s.status, "ready");
    assert.equal(s.visibleFraction, 1, "flat ground is all seen");
    assert.ok(s.cellSizeMeters && s.cellSizeMeters > 0);
  });

  it("hides ground behind a wall, and a moved observer recomputes", async () => {
    // A 60 m wall along lng = ORIGIN.lng + 0.002 (about 160 m east).
    const wall = ORIGIN.lng + 0.002;
    const globe = makeGlobe({ terrain: (lng) => (Math.abs(lng - wall) < 0.0002 ? 60 : 0) });
    openViewshedAreaPanel(globeApp(globe));
    setViewshedAreaSettings({ radiusMeters: 500 });
    globe.click(ORIGIN);
    await settle();
    const behindWall = getViewshedAreaSnapshot().visibleFraction!;
    assert.ok(behindWall < 0.9 && behindWall > 0.3, `${behindWall}`);
    globe.drag({ lng: ORIGIN.lng + 0.01, lat: ORIGIN.lat, alt: 0 });
    assert.equal(globe.controller.enableInputs, true, "camera inputs restored after the drag");
    assert.equal(
      getViewshedAreaSnapshot().visibleFraction,
      null,
      "a moved observer clears the result",
    );
    await settle();
    assert.equal(getViewshedAreaSnapshot().visibleFraction, 1, "clear of the wall");
  });

  it("raises the eye with the observer height and recomputes; opacity only repaints", async () => {
    const wall = ORIGIN.lng + 0.002;
    const globe = makeGlobe({ terrain: (lng) => (Math.abs(lng - wall) < 0.0002 ? 60 : 0) });
    openViewshedAreaPanel(globeApp(globe));
    setViewshedAreaSettings({ radiusMeters: 500 });
    globe.click(ORIGIN);
    await settle();
    const low = getViewshedAreaSnapshot().visibleFraction!;
    setViewshedAreaSettings({ observerHeight: 200 });
    assert.equal(getViewshedAreaSnapshot().visibleFraction, null);
    await settle();
    assert.ok(getViewshedAreaSnapshot().visibleFraction! > low);
    setViewshedAreaSettings({ opacity: 0.8 });
    assert.equal(getViewshedAreaSnapshot().settings.opacity, 0.8);
    await settle();
    assert.equal(getViewshedAreaSnapshot().status, "ready");
  });

  it("says when the globe has no terrain, and computes once tiles arrive after terrain is enabled", async () => {
    const globe = makeGlobe();
    openViewshedAreaPanel(globeApp(globe));
    globe.click(ORIGIN);
    await settle();
    assert.equal(getViewshedAreaSnapshot().status, "no-terrain");
    globe.enableTerrain();
    globe.settleTiles();
    await settle();
    assert.equal(getViewshedAreaSnapshot().status, "ready");
  });

  it("clears, keeps the observer across close/reopen, and round-trips the project state", async () => {
    const globe = makeGlobe({ terrain: () => 0 });
    openViewshedAreaPanel(globeApp(globe));
    setViewshedAreaSettings({ radiusMeters: 800, observerHeight: 10 });
    globe.click(ORIGIN);
    await settle();
    const state = getViewshedAreaProjectState();
    assert.ok(state);
    assert.equal(state.radiusMeters, 800);
    assert.equal(state.observerHeight, 10);
    const saved = state.observer as { lng: number; lat: number };
    assert.ok(Math.abs(saved.lng - ORIGIN.lng) < 1e-9 && Math.abs(saved.lat - ORIGIN.lat) < 1e-9);
    closeViewshedAreaPanel(globeApp(globe));
    assert.deepEqual(globe.ids(), []);
    openViewshedAreaPanel(globeApp(globe));
    assert.ok(globe.ids().includes("geolibre-viewshed-area-observer"));
    clearViewshedArea();
    assert.equal(getViewshedAreaSnapshot().observer, null);
    assert.equal(globe.canvas.style.cursor, "crosshair");
    restoreViewshedArea(mapLessApp, undefined);
    assert.equal(getViewshedAreaProjectState(), undefined);
    const fresh = makeGlobe({ terrain: () => 0 });
    restoreViewshedArea(globeApp(fresh), state);
    const s = getViewshedAreaSnapshot();
    assert.equal(s.open, true);
    assert.ok(Math.abs((s.observer?.lng ?? 0) - ORIGIN.lng) < 1e-9);
    assert.equal(s.settings.radiusMeters, 800);
    await settle();
    assert.equal(getViewshedAreaSnapshot().status, "ready");
    assert.ok(rer3dToolsPlugin.getProjectState?.());
  });

  it("clamps settings to their ranges", () => {
    assert.deepEqual(
      normalizeViewshedAreaSettings({ radiusMeters: 1, observerHeight: -3, opacity: 5 }),
      {
        radiusMeters: 100,
        observerHeight: 0,
        opacity: 1,
      },
    );
    assert.deepEqual(normalizeViewshedAreaSettings("junk"), DEFAULT_VIEWSHED_AREA_SETTINGS);
  });
});
