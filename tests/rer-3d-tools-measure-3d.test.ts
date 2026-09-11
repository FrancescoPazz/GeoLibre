import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import {
  CesiumDrawing,
  DEFAULT_DRAW_OPTIONS,
} from "../packages/plugins/src/plugins/rer-3d-tools/draw-engine";
import {
  geodesicMeters,
  type DrawGeometry,
  type DrawMeasures,
} from "../packages/plugins/src/plugins/rer-3d-tools/draw-geometry";
import {
  clearMeasure3d,
  closeMeasure3dPanel,
  getMeasure3dProjectState,
  getMeasure3dSnapshot,
  isMeasure3dPanelVisible,
  openMeasure3dPanel,
  reattachMeasure3d,
  restoreMeasure3d,
  setMeasure3dHover,
  setMeasure3dMode,
  setMeasure3dOptions,
  setMeasure3dSamplingStep,
  setMeasure3dGeoid,
  setMeasure3dHeightsAboveSeaLevel,
  saveMeasure3dAsLayer,
  measure3dSummary,
  exportMeasure3dSummary,
  PROFILE_SAMPLING_DEBOUNCE_MS,
} from "../packages/plugins/src/plugins/rer-3d-tools/measure-3d";
import { SAMPLING_STEP_SERIES } from "../packages/plugins/src/plugins/rer-3d-tools/terrain-profile";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import { restoreLineOfSight } from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// As with the line-of-sight tests: real Cesium maths, a faked widget. The
// fake's input handler records the four pointer actions the engine installs
// so a test can script clicks, moves and drags, and its `scene.pick` answers
// with whichever of the drawing's own entities the test puts under the cursor.

const { Cartesian3 } = Cesium;
const ORIGIN = { lng: 11.0, lat: 44.3 };
const P = (lng: number, lat: number, alt = 0) => ({ lng, lat, alt });
const at = (p: { lng: number; lat: number; alt: number }) =>
  Cartesian3.fromDegrees(p.lng, p.lat, p.alt);

type Entity = Record<string, unknown> & { id: string };
type Positioned = (m: { position: Cesium.Cartesian2 }) => void;
type Motion = (m: { endPosition: Cesium.Cartesian2 }) => void;

function makeGlobe(
  options: {
    primary?: boolean;
    metersPerPixel?: number;
    /** A terrain height function; makes the globe's provider "detailed". */
    terrain?: (lng: number, lat: number) => number;
    /** Hold each terrain read until `releaseTerrain()` is called. */
    holdTerrain?: boolean;
  } = {},
) {
  let destroyed = false;
  const heldReads: Array<() => void> = [];
  const entities: Entity[] = [];
  const canvas = {
    style: { cursor: "" },
    clientHeight: 800,
    height: 800,
  } as unknown as HTMLCanvasElement;
  let nextGround: Cesium.Cartesian3 | null = null;
  let underCursor: Entity | null = null;
  const controller = { enableInputs: true };
  const mpp = options.metersPerPixel ?? 0;
  // A perspective frustum whose height/fovy produce the requested m/px.
  const fovy = Math.PI / 3;
  const cameraHeight = (mpp * 800) / (2 * Math.tan(fovy / 2));
  const camera = {
    getPickRay: () =>
      nextGround ? new Cesium.Ray(nextGround, new Cartesian3(0, 0, 1)) : undefined,
    pickEllipsoid: () => undefined,
    frustum: { fovy },
    positionCartographic: { height: cameraHeight },
  };
  const scene = {
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      pick: (ray: Cesium.Ray) =>
        nextGround && Cartesian3.equals(ray.origin, nextGround) ? nextGround : undefined,
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
    if (options.holdTerrain) await new Promise<void>((resolve) => heldReads.push(resolve));
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
    primary: options.primary ?? true,
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
    entity: (id: string) => entities.find((e) => e.id === id),
    /** Click on bare ground at `p`. */
    click: (p: { lng: number; lat: number; alt: number }) => {
      nextGround = at(p);
      underCursor = null;
      fire("LEFT_DOWN", px);
      fire("LEFT_UP", px);
      fire("LEFT_CLICK", px);
      nextGround = null;
    },
    /** Click on one of the drawing's vertex entities. */
    clickVertex: (index: number) => {
      underCursor = entities.find((e) => e.id === `geolibre-draw-vertex-${index}`) ?? null;
      assert.ok(underCursor, `vertex ${index} exists`);
      fire("LEFT_DOWN", px);
      fire("LEFT_UP", px);
      fire("LEFT_CLICK", px);
      underCursor = null;
    },
    /** Move the pointer over bare ground at `p`. */
    move: (p: { lng: number; lat: number; alt: number }) => {
      nextGround = at(p);
      underCursor = null;
      fire("MOUSE_MOVE", px);
      nextGround = null;
    },
    /** Press on a vertex, drag it to `to`, release. */
    drag: (index: number, to: { lng: number; lat: number; alt: number }) => {
      underCursor = entities.find((e) => e.id === `geolibre-draw-vertex-${index}`) ?? null;
      assert.ok(underCursor, `vertex ${index} exists`);
      fire("LEFT_DOWN", px);
      underCursor = null;
      nextGround = at(to);
      fire("MOUSE_MOVE", px);
      fire("LEFT_UP", px);
      nextGround = null;
    },
    handlerDestroyed: () => handlerDestroyed,
    releaseTerrain: () => {
      for (const release of heldReads.splice(0)) release();
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

const settle = (ms = PROFILE_SAMPLING_DEBOUNCE_MS + 30) => new Promise((r) => setTimeout(r, ms));

function globeApp(globe: ReturnType<typeof makeGlobe>): GeoLibreAppAPI {
  return { getMap: () => null, getCesiumScene: () => globe.handle } as unknown as GeoLibreAppAPI;
}
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

const A = P(ORIGIN.lng, ORIGIN.lat);
const B = P(ORIGIN.lng + 0.01, ORIGIN.lat);
const C = P(ORIGIN.lng + 0.01, ORIGIN.lat + 0.01);
const D = P(ORIGIN.lng, ORIGIN.lat + 0.01);

describe("CesiumDrawing", () => {
  function drawing(globe: ReturnType<typeof makeGlobe>) {
    const changes: Array<{ geometry: DrawGeometry; measures: DrawMeasures }> = [];
    const d = new CesiumDrawing(globe.handle, { ...DEFAULT_DRAW_OPTIONS }, (geometry, measures) =>
      changes.push({ geometry, measures }),
    );
    return { d, changes, last: () => changes[changes.length - 1] };
  }

  it("takes the pointer, and hands it back on destroy", () => {
    const globe = makeGlobe();
    globe.canvas.style.cursor = "grab";
    const { d } = drawing(globe);
    assert.equal(globe.canvas.style.cursor, "crosshair");
    d.destroy();
    assert.equal(globe.canvas.style.cursor, "grab");
    assert.equal(globe.handlerDestroyed(), true);
    assert.deepEqual(globe.ids(), []);
  });

  it("adds line vertices on click and labels each segment", () => {
    const globe = makeGlobe();
    const { d, last } = drawing(globe);
    globe.click(A);
    globe.click(B);
    globe.click(C);
    assert.equal(d.getGeometry().points.length, 3);
    assert.deepEqual(globe.ids(), [
      "geolibre-draw-label-0",
      "geolibre-draw-label-1",
      "geolibre-draw-line",
      "geolibre-draw-vertex-0",
      "geolibre-draw-vertex-1",
      "geolibre-draw-vertex-2",
    ]);
    const m = last().measures;
    assert.equal(m.segmentMeters.length, 2);
    assert.ok(Math.abs(m.segmentMeters[0] - geodesicMeters(Cesium, A, B)) < 1e-6);
    assert.equal(m.areaSqm, null);
  });

  it("hides labels and undrapes the line on request", () => {
    const globe = makeGlobe();
    const { d } = drawing(globe);
    globe.click(A);
    globe.click(B);
    d.setOptions({ showLabels: false, clampToGround: false });
    assert.ok(!globe.ids().some((id) => id.includes("label")));
    const line = globe.entity("geolibre-draw-line") as { polyline: { clampToGround: boolean } };
    assert.equal(line.polyline.clampToGround, false);
  });

  it("closes a polygon by clicking its first vertex, then fills and measures it", () => {
    const globe = makeGlobe();
    const { d, last } = drawing(globe);
    d.setMode("polygon");
    globe.click(A);
    globe.click(B);
    globe.clickVertex(0); // too early: two points cannot close
    assert.equal(d.getGeometry().closed, false);
    globe.click(C);
    globe.click(D);
    globe.clickVertex(0);
    const g = d.getGeometry();
    assert.equal(g.closed, true);
    assert.equal(g.points.length, 4);
    assert.ok(globe.ids().includes("geolibre-draw-fill"));
    assert.ok(globe.ids().includes("geolibre-draw-area-label"));
    assert.equal(last().measures.segmentMeters.length, 4);
    // ~798 m east-west at this latitude by ~1111 m north-south.
    const expected = geodesicMeters(Cesium, A, B) * geodesicMeters(Cesium, B, C);
    const area = last().measures.areaSqm ?? 0;
    assert.ok(Math.abs(area - expected) / expected < 0.005, `${area} vs ${expected}`);
    // A closed polygon takes no further vertices on bare ground…
    globe.click(P(ORIGIN.lng + 0.05, ORIGIN.lat + 0.05));
    assert.equal(d.getGeometry().points.length, 4);
  });

  it("inserts a vertex into the segment a click lands on", () => {
    const globe = makeGlobe();
    const { d } = drawing(globe);
    globe.click(A);
    globe.click(B);
    // Exactly on the A–B segment, a third of the way along.
    const mid = P(ORIGIN.lng + 0.0033, ORIGIN.lat, 0);
    globe.click(mid);
    const pts = d.getGeometry().points;
    assert.equal(pts.length, 3);
    assert.ok(Math.abs(pts[1].lng - mid.lng) < 1e-9, "inserted between A and B, not appended");
  });

  it("widens the insert tolerance with the camera height", () => {
    // 5 m off the segment: rejected at ground level (1 ‰ of ~1.1 km), taken at 2 m/px.
    const off = P(ORIGIN.lng + 0.005, ORIGIN.lat + 0.00004, 0);
    const tight = makeGlobe({ metersPerPixel: 0 });
    const t = drawing(tight);
    tight.click(A);
    tight.click(B);
    tight.click(off);
    assert.equal(t.d.getGeometry().points.length, 3);
    assert.ok(Math.abs(t.d.getGeometry().points[2].lat - off.lat) < 1e-12, "appended");
    const loose = makeGlobe({ metersPerPixel: 2 });
    const l = drawing(loose);
    loose.click(A);
    loose.click(B);
    loose.click(off);
    assert.ok(Math.abs(l.d.getGeometry().points[1].lat - off.lat) < 1e-12, "inserted");
  });

  it("drags a vertex with navigation suspended and re-enabled", () => {
    const globe = makeGlobe();
    const { d, changes } = drawing(globe);
    globe.click(A);
    globe.click(B);
    const before = changes.length;
    globe.drag(1, C);
    assert.equal(globe.controller.enableInputs, true, "inputs restored after the drag");
    const pts = d.getGeometry().points;
    assert.ok(Math.abs(pts[1].lat - C.lat) < 1e-12);
    assert.ok(changes.length > before, "the panel heard about the move");
  });

  it("stops an angle at three vertices and reports the angle", () => {
    const globe = makeGlobe();
    const { d, last } = drawing(globe);
    d.setMode("angle");
    globe.click(B);
    globe.click(A);
    globe.click(D);
    globe.click(C);
    assert.equal(d.getGeometry().points.length, 3);
    assert.ok(globe.ids().includes("geolibre-draw-arc"));
    assert.ok(globe.ids().includes("geolibre-draw-angle-label"));
    assert.ok(Math.abs((last().measures.angleDeg ?? 0) - 90) < 0.5);
  });

  it("previews a circle under the pointer, locks it on the second click, restarts on a third", () => {
    const globe = makeGlobe();
    const { d, last } = drawing(globe);
    d.setMode("circle");
    globe.click(A);
    assert.equal(globe.ids().includes("geolibre-draw-circle"), false);
    globe.move(B);
    assert.ok(globe.ids().includes("geolibre-draw-circle"), "the ring follows the pointer");
    assert.equal(globe.ids().includes("geolibre-draw-vertex-1"), false, "no edge vertex yet");
    globe.click(B);
    assert.ok(globe.ids().includes("geolibre-draw-vertex-1"));
    const r = last().measures.circleRadiusMeters;
    assert.ok(r && Math.abs(r - geodesicMeters(Cesium, A, B)) < 1e-6);
    globe.click(C);
    assert.equal(d.getGeometry().points.length, 1, "a third click starts a new circle");
  });

  it("keeps points bare of lines and labels", () => {
    const globe = makeGlobe();
    const { d } = drawing(globe);
    d.setMode("point");
    globe.click(A);
    globe.click(B);
    assert.deepEqual(globe.ids(), ["geolibre-draw-vertex-0", "geolibre-draw-vertex-1"]);
  });

  it("switching mode discards the figure", () => {
    const globe = makeGlobe();
    const { d } = drawing(globe);
    globe.click(A);
    d.setMode("polygon");
    assert.equal(d.getGeometry().points.length, 0);
    assert.deepEqual(globe.ids(), []);
  });
});

describe("measure-3d tool", () => {
  beforeEach(() => {
    restoreMeasure3d(mapLessApp, undefined);
    restoreLineOfSight(mapLessApp, undefined);
  });

  it("opens unbound on the 2D map and binds when the globe mounts", () => {
    openMeasure3dPanel(mapLessApp);
    assert.equal(isMeasure3dPanelVisible(), true);
    assert.equal(getMeasure3dSnapshot().bound, false);
    const globe = makeGlobe();
    reattachMeasure3d(globeApp(globe));
    assert.equal(getMeasure3dSnapshot().bound, true);
    assert.equal(globe.canvas.style.cursor, "crosshair");
  });

  it("publishes geometry and measures as the user draws", () => {
    const globe = makeGlobe();
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    const s = getMeasure3dSnapshot();
    assert.equal(s.geometry.points.length, 2);
    assert.equal(s.measures.segmentMeters.length, 1);
  });

  it("changes mode, options and clears through the store", () => {
    const globe = makeGlobe();
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    setMeasure3dMode("circle");
    assert.equal(getMeasure3dSnapshot().geometry.points.length, 0);
    assert.equal(getMeasure3dSnapshot().mode, "circle");
    setMeasure3dOptions({ showLabels: false });
    assert.equal(getMeasure3dSnapshot().options.showLabels, false);
    globe.click(A);
    globe.click(B);
    assert.ok(!globe.ids().some((id) => id.includes("label")));
    clearMeasure3d();
    assert.deepEqual(globe.ids(), []);
  });

  it("keeps the figure across close/reopen and redraws it on a rebuilt globe", () => {
    const first = makeGlobe();
    openMeasure3dPanel(globeApp(first));
    first.click(A);
    first.click(B);
    closeMeasure3dPanel(globeApp(first));
    assert.deepEqual(first.ids(), []);
    assert.equal(first.canvas.style.cursor, "");
    openMeasure3dPanel(globeApp(first));
    assert.equal(first.ids().length, 4);
    first.destroy();
    const second = makeGlobe();
    reattachMeasure3d(globeApp(second));
    assert.equal(second.ids().length, 4);
    assert.equal(getMeasure3dSnapshot().geometry.points.length, 2);
  });

  it("round-trips through project state", () => {
    const globe = makeGlobe();
    openMeasure3dPanel(globeApp(globe));
    setMeasure3dMode("polygon");
    setMeasure3dOptions({ clampToGround: false });
    globe.click(A);
    globe.click(B);
    globe.click(C);
    globe.clickVertex(0);
    const saved = getMeasure3dProjectState();
    assert.ok(saved);
    assert.equal(saved.mode, "polygon");
    assert.equal(saved.closed, true);
    assert.equal(saved.clampToGround, false);
    restoreMeasure3d(mapLessApp, undefined);
    assert.equal(getMeasure3dProjectState(), undefined);
    const reopened = makeGlobe();
    assert.equal(restoreMeasure3d(globeApp(reopened), saved), true);
    const s = getMeasure3dSnapshot();
    assert.equal(s.geometry.closed, true);
    assert.equal(s.options.clampToGround, false);
    assert.ok((s.measures.areaSqm ?? 0) > 0);
    assert.ok(reopened.ids().includes("geolibre-draw-fill"));
  });

  it("drops malformed points and an unknown mode", () => {
    restoreMeasure3d(mapLessApp, {
      open: false,
      mode: "hexagon",
      points: [
        { lng: 11, lat: 44 },
        { lng: "x", lat: 44 },
        { lng: 11, lat: 91, alt: 0 },
      ],
    });
    const s = getMeasure3dSnapshot();
    assert.equal(s.mode, "line");
    assert.equal(s.geometry.points.length, 1);
    assert.equal(s.geometry.points[0].alt, 0);
  });

  it("composes both tools in the plugin's project state", () => {
    assert.equal(rer3dToolsPlugin.getProjectState?.(), undefined);
    const globe = makeGlobe();
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    const state = rer3dToolsPlugin.getProjectState?.() as Record<string, unknown>;
    assert.ok(state.measure);
    assert.equal(state.lineOfSight, undefined);
    restoreMeasure3d(mapLessApp, undefined);
    assert.equal(rer3dToolsPlugin.applyProjectState?.(globeApp(globe), state), true);
    assert.equal(getMeasure3dSnapshot().geometry.points.length, 1);
    rer3dToolsPlugin.deactivate(globeApp(globe));
    assert.equal(isMeasure3dPanelVisible(), false);
  });
});

describe("measure-3d terrain profile", () => {
  beforeEach(() => {
    restoreMeasure3d(mapLessApp, undefined);
  });

  it("samples the terrain once the edits settle and publishes the profile", async () => {
    const globe = makeGlobe({ terrain: (lng) => 200 + (lng - ORIGIN.lng) * 10_000 });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    assert.equal(getMeasure3dSnapshot().profile, null, "one vertex has no profile");
    globe.click(B);
    assert.equal(getMeasure3dSnapshot().profile, null, "not before the debounce");
    await settle();
    const s = getMeasure3dSnapshot();
    assert.equal(s.sampling, false);
    assert.ok(s.profile, "a profile was published");
    assert.equal(s.profile.detailed, true);
    assert.ok(
      SAMPLING_STEP_SERIES.includes(s.samplingStepM),
      `step ${s.samplingStepM} from the series`,
    );
    assert.ok(s.profile.samples.length > 2, "the segment was densified");
    assert.ok(Math.abs(s.profile.samples[0].alt - 200) < 1e-6);
    assert.ok(s.profile.maxAlt > s.profile.minAlt);
    assert.ok(
      s.profile.totalGroundM > s.profile.totalGeodeticM,
      "climbing ground is longer than the geodesic",
    );
    // A–B is ~798 m at this latitude: a thousand samples need a 1 m step, ten need 50 m.
    assert.deepEqual(s.samplingStepRange, [1, 50]);
  });

  it("honours a manual step, snapped and clamped to the path's range, and returns to auto", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    setMeasure3dSamplingStep(20);
    await settle();
    assert.equal(getMeasure3dSnapshot().samplingStepAuto, false);
    assert.equal(getMeasure3dSnapshot().samplingStepM, 20);
    setMeasure3dSamplingStep(5000);
    await settle();
    assert.equal(getMeasure3dSnapshot().samplingStepM, 50, "clamped to the range's maximum");
    setMeasure3dSamplingStep("auto");
    await settle();
    const s = getMeasure3dSnapshot();
    assert.equal(s.samplingStepAuto, true);
    assert.ok(SAMPLING_STEP_SERIES.includes(s.samplingStepM));
    assert.equal(getMeasure3dProjectState()?.samplingStep, undefined, "auto persists no step");
  });

  it("marks the hovered sample on the globe and clears it", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    await settle();
    setMeasure3dHover(2);
    assert.equal(getMeasure3dSnapshot().hoverSample, 2);
    assert.ok(globe.ids().includes("geolibre-draw-marker"));
    setMeasure3dHover(null);
    assert.equal(getMeasure3dSnapshot().hoverSample, null);
    assert.ok(!globe.ids().includes("geolibre-draw-marker"));
    setMeasure3dHover(99_999);
    assert.equal(getMeasure3dSnapshot().hoverSample, null, "out of range is ignored");
  });

  it("discards a terrain read that finishes after a newer edit", async () => {
    const globe = makeGlobe({ terrain: () => 100, holdTerrain: true });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    await settle();
    assert.equal(getMeasure3dSnapshot().sampling, true, "the first read is held");
    // A newer edit while the first read is still out.
    globe.click(C);
    await settle();
    globe.releaseTerrain();
    await settle(30);
    const s = getMeasure3dSnapshot();
    assert.ok(s.profile, "the second read landed");
    assert.equal(s.profile.stopIndex.length, 3, "and it describes the three-vertex path");
  });

  it("drops the profile when the figure stops being a path", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    await settle();
    assert.ok(getMeasure3dSnapshot().profile);
    clearMeasure3d();
    assert.equal(getMeasure3dSnapshot().profile, null);
    setMeasure3dMode("point");
    globe.click(A);
    globe.click(B);
    await settle();
    assert.equal(getMeasure3dSnapshot().profile, null, "points are not a path");
  });
});

describe("measure-3d heights above sea level", () => {
  beforeEach(() => {
    restoreMeasure3d(mapLessApp, undefined);
    setMeasure3dGeoid(undefined);
  });

  it("is off, and the toggle inert, until the host supplies a geoid", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openMeasure3dPanel(globeApp(globe));
    assert.equal(getMeasure3dSnapshot().geoidAvailable, false);
    assert.equal(
      getMeasure3dSnapshot().heightsAboveSeaLevel,
      false,
      "no deployment default in tests",
    );
    globe.click(A);
    globe.click(B);
    setMeasure3dHeightsAboveSeaLevel(true);
    await settle();
    assert.ok(
      Math.abs((getMeasure3dSnapshot().profile?.minAlt ?? 0) - 100) < 1e-6,
      "no geoid, ellipsoidal heights",
    );
  });

  it("subtracts the geoid undulation once supplied and enabled, and restores it from the project", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    openMeasure3dPanel(globeApp(globe));
    globe.click(A);
    globe.click(B);
    setMeasure3dGeoid(async (positions) => positions.map(() => 40));
    assert.equal(getMeasure3dSnapshot().geoidAvailable, true);
    setMeasure3dHeightsAboveSeaLevel(true);
    await settle();
    let s = getMeasure3dSnapshot();
    assert.ok(
      Math.abs((s.profile?.minAlt ?? 0) - 60) < 1e-6,
      "100 m ellipsoidal − 40 m undulation",
    );
    assert.equal(getMeasure3dProjectState()?.meanSeaLevel, true);
    setMeasure3dHeightsAboveSeaLevel(false);
    await settle();
    s = getMeasure3dSnapshot();
    assert.ok(Math.abs((s.profile?.minAlt ?? 0) - 100) < 1e-6);
    const saved = { ...getMeasure3dProjectState(), meanSeaLevel: true };
    const reopened = makeGlobe({ terrain: () => 100 });
    restoreMeasure3d(globeApp(reopened), saved);
    await settle();
    assert.equal(getMeasure3dSnapshot().heightsAboveSeaLevel, true);
    assert.ok(Math.abs((getMeasure3dSnapshot().profile?.minAlt ?? 0) - 60) < 1e-6);
  });
});

describe("measure-3d save and summary", () => {
  beforeEach(() => {
    restoreMeasure3d(mapLessApp, undefined);
  });

  function recordingApp(globe: ReturnType<typeof makeGlobe>) {
    const layers: Array<{ name: string; features: number }> = [];
    const files: Array<{ filename: string; content: string }> = [];
    const app = {
      getMap: () => null,
      getCesiumScene: () => globe.handle,
      addGeoJsonLayer: (name: string, data: { features: unknown[] }) => {
        layers.push({ name, features: data.features.length });
        return `layer-${layers.length}`;
      },
      exportTextFile: (filename: string, content: string) => {
        files.push({ filename, content });
      },
    } as unknown as GeoLibreAppAPI;
    return { app, layers, files };
  }

  it("adds the measurement to the project as a layer through the host", async () => {
    const globe = makeGlobe({ terrain: () => 100 });
    const { app, layers } = recordingApp(globe);
    openMeasure3dPanel(app);
    assert.equal(saveMeasure3dAsLayer("Misura"), null, "nothing to save yet");
    globe.click(A);
    globe.click(B);
    await settle();
    const id = saveMeasure3dAsLayer("Misura 3D — Linea");
    assert.equal(id, "layer-1");
    // The figure, its two vertices, and the sampled profile line.
    assert.deepEqual(layers, [{ name: "Misura 3D — Linea", features: 4 }]);
  });

  it("writes the summary through the host with a file-safe name", () => {
    const globe = makeGlobe();
    const { app, files } = recordingApp(globe);
    openMeasure3dPanel(app);
    assert.equal(measure3dSummary("x"), null);
    assert.equal(exportMeasure3dSummary("x"), false);
    globe.click(A);
    globe.click(B);
    const text = measure3dSummary("Percorso 1");
    assert.ok(text?.startsWith("name: Percorso 1\nkind: line"));
    assert.equal(exportMeasure3dSummary("Percorso 1"), true);
    assert.equal(files[0].filename, "Percorso_1_summary.txt");
    assert.equal(files[0].content, text);
  });
});
