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
  setMeasure3dMode,
  setMeasure3dOptions,
} from "../packages/plugins/src/plugins/rer-3d-tools/measure-3d";
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

function makeGlobe(options: { primary?: boolean; metersPerPixel?: number } = {}) {
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
  const handle = {
    Cesium: {
      ...Cesium,
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
    destroy: () => {
      destroyed = true;
    },
  };
}

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
