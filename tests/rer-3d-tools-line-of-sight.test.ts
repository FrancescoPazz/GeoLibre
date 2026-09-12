import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import {
  LINE_OF_SIGHT_ORIGIN_SKIP_METERS,
  computeLineOfSight,
  lineOfSightResultEqual,
  raiseByMeters,
  targetTolerance,
} from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight-geometry";
import {
  DEFAULT_LINE_OF_SIGHT_SETTINGS,
  clearLineOfSight,
  closeLineOfSightPanel,
  getLineOfSightProjectState,
  getLineOfSightSnapshot,
  isLineOfSightPanelVisible,
  normalizeLineOfSightSettings,
  openLineOfSightPanel,
  reattachLineOfSight,
  restoreLineOfSight,
  setLineOfSightSettings,
  subscribeLineOfSight,
} from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// The Cesium maths is real — Cartesian3, Cartographic, Ray — and only the
// scene, the widget and its input handler, which need a GPU and a DOM, are
// faked. That is the same split the environment-plugin tests use, and it is
// what lets the intersection test be checked against true geodesic geometry.

const { Cartesian3 } = Cesium;

/** A point in the Apennines, on the ellipsoid. */
const ORIGIN = { lng: 11.0, lat: 44.3 };

function at(lng: number, lat: number, alt: number): Cesium.Cartesian3 {
  return Cartesian3.fromDegrees(lng, lat, alt);
}

/**
 * A fake globe whose `pick` reports the first of the configured obstacles the
 * ray passes within `radius` of, at the point of closest approach — enough to
 * stand in for terrain without a mesh.
 */
function makeScene(obstacles: Array<{ position: Cesium.Cartesian3; radius: number }> = []) {
  const globe = {
    ellipsoid: Cesium.Ellipsoid.WGS84,
    pick: (ray: Cesium.Ray, _scene: unknown): Cesium.Cartesian3 | undefined => {
      let best: { t: number; point: Cesium.Cartesian3 } | null = null;
      for (const obstacle of obstacles) {
        const toObstacle = Cartesian3.subtract(obstacle.position, ray.origin, new Cartesian3());
        const t = Cartesian3.dot(toObstacle, ray.direction);
        if (t < 0) continue;
        const closest = Cesium.Ray.getPoint(ray, t, new Cartesian3());
        if (Cartesian3.distance(closest, obstacle.position) > obstacle.radius) continue;
        if (!best || t < best.t) best = { t, point: closest };
      }
      return best?.point;
    },
    tileLoadProgressEvent: new Cesium.Event(),
  };
  return { globe } as unknown as Cesium.Scene & { globe: typeof globe };
}

describe("line-of-sight geometry", () => {
  it("raises a point along the ellipsoid normal by the requested metres", () => {
    const ground = at(ORIGIN.lng, ORIGIN.lat, 100);
    const raised = raiseByMeters(Cesium, ground, 30);
    const carto = Cesium.Cartographic.fromCartesian(raised);
    assert.ok(Math.abs(carto.height - 130) < 1e-6);
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.longitude) - ORIGIN.lng) < 1e-9);
    assert.ok(Math.abs(Cesium.Math.toDegrees(carto.latitude) - ORIGIN.lat) < 1e-9);
    // Zero is a clone, not the same object, so callers may mutate freely.
    const same = raiseByMeters(Cesium, ground, 0);
    assert.notEqual(same, ground);
    assert.ok(Cartesian3.equals(same, ground));
  });

  it("reports a clear line when nothing is in the way", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    const result = computeLineOfSight(Cesium, makeScene(), observer, target);
    assert.equal(result.occluded, false);
    assert.equal(result.hit, null);
    assert.ok(Math.abs(result.totalMeters - Cartesian3.distance(observer, target)) < 1e-6);
    assert.equal(result.visibleMeters, result.totalMeters);
  });

  it("reports the distance to the first terrain hit when the view is blocked", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    // A hill exactly a quarter of the way along, on the line itself.
    const hill = Cartesian3.lerp(observer, target, 0.25, new Cartesian3());
    const result = computeLineOfSight(
      Cesium,
      makeScene([{ position: hill, radius: 5 }]),
      observer,
      target,
    );
    assert.equal(result.occluded, true);
    assert.ok(result.hit, "the hit position is reported");
    const expected = Cartesian3.distance(observer, hill);
    assert.ok(
      Math.abs(result.visibleMeters - expected) < 1,
      `expected ~${expected}, got ${result.visibleMeters}`,
    );
    assert.ok(result.visibleMeters < result.totalMeters);
  });

  it("does not count the ground the target stands on as an obstacle", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    // Terrain met a few centimetres short of the target, as a mesh reports
    // for a point picked on its own surface.
    const graze = Cartesian3.lerp(observer, target, 0.9999, new Cartesian3());
    const result = computeLineOfSight(
      Cesium,
      makeScene([{ position: graze, radius: 5 }]),
      observer,
      target,
    );
    assert.equal(result.occluded, false);
    assert.equal(result.visibleMeters, result.totalMeters);
  });

  it("does not count the observer's own footprint as an obstacle", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    // An intersection right at the origin, inside the skipped stretch.
    const footprint = Cartesian3.lerp(observer, target, 0.00001, new Cartesian3());
    const result = computeLineOfSight(
      Cesium,
      makeScene([{ position: footprint, radius: 0.1 }]),
      observer,
      target,
    );
    assert.equal(result.occluded, false);
  });

  it("treats a degenerate line as clear rather than dividing by zero", () => {
    const point = at(ORIGIN.lng, ORIGIN.lat, 500);
    const result = computeLineOfSight(Cesium, makeScene(), point, point);
    assert.equal(result.occluded, false);
    assert.equal(result.totalMeters, 0);
    assert.equal(result.visibleMeters, 0);
  });

  it("scales the target tolerance with distance but never below the floor", () => {
    assert.equal(targetTolerance(10), 1);
    assert.equal(targetTolerance(30_000), 150);
    assert.ok(LINE_OF_SIGHT_ORIGIN_SKIP_METERS > 0);
  });

  it("compares results by what the user would see", () => {
    const a = { totalMeters: 1000, visibleMeters: 400, occluded: true, hit: null };
    assert.equal(lineOfSightResultEqual(a, { ...a, visibleMeters: 400.001 }), true);
    assert.equal(lineOfSightResultEqual(a, { ...a, visibleMeters: 401 }), false);
    assert.equal(lineOfSightResultEqual(a, { ...a, occluded: false }), false);
    assert.equal(lineOfSightResultEqual(null, null), true);
    assert.equal(lineOfSightResultEqual(a, null), false);
  });
});

// --- The tool's lifecycle against a fake globe -------------------------------

type ClickListener = (movement: { position: Cesium.Cartesian2 }) => void;

/** A fake widget: entities, a canvas, a camera whose pick rays hit a scripted spot. */
function makeGlobe(
  options: {
    primary?: boolean;
    obstacles?: Array<{ position: Cesium.Cartesian3; radius: number }>;
  } = {},
) {
  let destroyed = false;
  const scene = makeScene(options.obstacles);
  const entities: Array<Record<string, unknown> & { id: string }> = [];
  const canvas = { style: { cursor: "" } } as unknown as HTMLCanvasElement;
  /** What the next click lands on; tests set it before firing a click. */
  let nextPick: Cesium.Cartesian3 | null = null;
  const camera = {
    getPickRay: () => (nextPick ? new Cesium.Ray(nextPick, new Cartesian3(0, 0, 1)) : undefined),
    pickEllipsoid: () => undefined,
  };
  // `pickGlobeHit` asks `scene.globe.pick` with the camera's ray; make that
  // ray report the scripted point regardless of the obstacles.
  const realPick = scene.globe.pick;
  scene.globe.pick = (ray: Cesium.Ray, s: unknown) => {
    if (nextPick && Cartesian3.equals(ray.origin, nextPick)) return nextPick;
    return realPick(ray, s);
  };
  const viewer = {
    scene,
    camera,
    canvas,
    entities: {
      add: (entity: Record<string, unknown> & { id: string }) => {
        entities.push(entity);
        return entity;
      },
      remove: (entity: Record<string, unknown> & { id: string }) => {
        const i = entities.indexOf(entity);
        if (i >= 0) entities.splice(i, 1);
        return i >= 0;
      },
    },
    isDestroyed: () => destroyed,
  };
  const handlers: ClickListener[] = [];
  const actions = new Map<string, (movement: Record<string, Cesium.Cartesian2>) => void>();
  /** The entity id `scene.pick` answers with for the next pointer event. */
  let entityUnderPointer: string | null = null;
  (scene as unknown as { pick: (p: Cesium.Cartesian2) => unknown }).pick = () =>
    entityUnderPointer ? { id: { id: entityUnderPointer } } : undefined;
  (
    scene as unknown as { screenSpaceCameraController: { enableInputs: boolean } }
  ).screenSpaceCameraController = {
    enableInputs: true,
  };
  let handlerDestroyed = false;
  class FakeHandler {
    setInputAction(fn: ClickListener, type: unknown) {
      if (type === "LEFT_CLICK") handlers.push(fn);
      actions.set(String(type), fn as (movement: Record<string, Cesium.Cartesian2>) => void);
    }
    destroy() {
      handlerDestroyed = true;
    }
    isDestroyed() {
      return handlerDestroyed;
    }
  }
  let renders = 0;
  const handle = {
    Cesium: {
      ...Cesium,
      ScreenSpaceEventHandler: FakeHandler,
      ScreenSpaceEventType: {
        LEFT_CLICK: "LEFT_CLICK",
        LEFT_DOWN: "LEFT_DOWN",
        LEFT_UP: "LEFT_UP",
        MOUSE_MOVE: "MOUSE_MOVE",
      },
    },
    viewer,
    scene,
    camera,
    clock: {},
    canvas,
    primary: options.primary ?? true,
    requestRender: () => {
      renders += 1;
    },
    readView: () => ({
      center: [ORIGIN.lng, ORIGIN.lat] as [number, number],
      zoom: 12,
      bearing: 0,
      pitch: 0,
    }),
  } as unknown as CesiumSceneHandle;
  return {
    handle,
    scene,
    entities,
    canvas,
    click: (point: Cesium.Cartesian3) => {
      nextPick = point;
      for (const fn of handlers) fn({ position: new Cesium.Cartesian2(1, 1) });
      nextPick = null;
    },
    settleTiles: () => scene.globe.tileLoadProgressEvent.raiseEvent(0),
    /** Press on the named point, move it to `to`, release. */
    drag: (which: "observer" | "target", to: Cesium.Cartesian3) => {
      const px = new Cesium.Cartesian2(1, 1);
      entityUnderPointer = `geolibre-line-of-sight-${which}`;
      actions.get("LEFT_DOWN")?.({ position: px });
      entityUnderPointer = null;
      nextPick = to;
      actions.get("MOUSE_MOVE")?.({ startPosition: px, endPosition: px });
      nextPick = null;
      actions.get("LEFT_UP")?.({ position: px });
    },
    pressOnPoint: (which: "observer" | "target") => {
      entityUnderPointer = `geolibre-line-of-sight-${which}`;
      actions.get("LEFT_DOWN")?.({ position: new Cesium.Cartesian2(1, 1) });
    },
    cameraInputs: () =>
      (scene as unknown as { screenSpaceCameraController: { enableInputs: boolean } })
        .screenSpaceCameraController.enableInputs,
    clickOnPoint: (which: "observer" | "target") => {
      entityUnderPointer = `geolibre-line-of-sight-${which}`;
      for (const fn of handlers) fn({ position: new Cesium.Cartesian2(1, 1) });
      entityUnderPointer = null;
    },
    handlerCount: () => handlers.length,
    handlerDestroyed: () => handlerDestroyed,
    renders: () => renders,
    destroy: () => {
      destroyed = true;
    },
  };
}

function globeApp(globe: ReturnType<typeof makeGlobe>): GeoLibreAppAPI {
  return { getMap: () => null, getCesiumScene: () => globe.handle } as unknown as GeoLibreAppAPI;
}

/** The 2D map is primary: no globe to bind to. */
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

function ids(globe: ReturnType<typeof makeGlobe>): string[] {
  return globe.entities.map((e) => e.id).sort();
}

describe("line-of-sight tool", () => {
  beforeEach(() => {
    restoreLineOfSight(mapLessApp, undefined);
  });

  it("declares both engines and is off by default", () => {
    assert.deepEqual(rer3dToolsPlugin.engines, ["maplibre", "cesium"]);
    assert.equal(rer3dToolsPlugin.activeByDefault, false);
  });

  it("opens as unavailable on the 2D map and comes alive when the globe mounts", () => {
    openLineOfSightPanel(mapLessApp);
    assert.equal(isLineOfSightPanelVisible(), true);
    assert.equal(getLineOfSightSnapshot().phase, "unavailable");
    const globe = makeGlobe();
    reattachLineOfSight(globeApp(globe));
    assert.equal(getLineOfSightSnapshot().phase, "observer");
    assert.equal(globe.handlerCount(), 1);
    assert.equal(globe.canvas.style.cursor, "crosshair");
  });

  it("binds to a grid pane's globe when that is the only one", () => {
    // The geoportal arrangement: the 2D map primary, the globe in a pane.
    const pane = makeGlobe({ primary: false });
    openLineOfSightPanel(globeApp(pane));
    assert.equal(getLineOfSightSnapshot().phase, "observer");
    assert.equal(pane.handlerCount(), 1);
  });

  it("lets a placed point be dragged, with the camera held still meanwhile", () => {
    const globe = makeGlobe();
    openLineOfSightPanel(globeApp(globe));
    globe.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    globe.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    assert.equal(getLineOfSightSnapshot().phase, "done");
    const before = getLineOfSightSnapshot().result?.totalMeters ?? 0;

    globe.pressOnPoint("target");
    assert.equal(globe.cameraInputs(), false, "the globe does not pan under the drag");
    globe.drag("target", at(ORIGIN.lng + 0.1, ORIGIN.lat, 500));
    assert.equal(globe.cameraInputs(), true, "inputs restored on release");
    const after = getLineOfSightSnapshot();
    assert.equal(after.phase, "done");
    assert.ok(Math.abs((after.target?.lng ?? 0) - (ORIGIN.lng + 0.1)) < 1e-9);
    assert.ok((after.result?.totalMeters ?? 0) > before * 1.5, "the line followed the point");

    globe.drag("observer", at(ORIGIN.lng + 0.02, ORIGIN.lat, 500));
    assert.ok(Math.abs((getLineOfSightSnapshot().observer?.lng ?? 0) - (ORIGIN.lng + 0.02)) < 1e-9);

    // A click that lands on a point is not a new measurement.
    globe.clickOnPoint("observer");
    assert.equal(getLineOfSightSnapshot().phase, "done");
    assert.ok(Math.abs((getLineOfSightSnapshot().observer?.lng ?? 0) - (ORIGIN.lng + 0.02)) < 1e-9);
  });

  it("walks observer → target → result, drawing the sight line", () => {
    const globe = makeGlobe();
    const notifications: string[] = [];
    const unsubscribe = subscribeLineOfSight(() =>
      notifications.push(getLineOfSightSnapshot().phase),
    );
    openLineOfSightPanel(globeApp(globe));

    globe.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    assert.equal(getLineOfSightSnapshot().phase, "target");
    assert.deepEqual(ids(globe), ["geolibre-line-of-sight-observer"]);
    assert.equal(globe.canvas.style.cursor, "crosshair");

    globe.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    const state = getLineOfSightSnapshot();
    assert.equal(state.phase, "done");
    assert.ok(state.result);
    assert.equal(state.result.occluded, false);
    assert.deepEqual(ids(globe), [
      "geolibre-line-of-sight-observer",
      "geolibre-line-of-sight-target",
      "geolibre-line-of-sight-visible",
    ]);
    // Placement is over, so the pointer is handed back.
    assert.equal(globe.canvas.style.cursor, "");
    assert.ok(notifications.includes("target") && notifications.includes("done"));
    unsubscribe();
  });

  it("draws the hidden remainder in its own entity when terrain blocks the view", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    const hill = Cartesian3.lerp(observer, target, 0.4, new Cartesian3());
    const globe = makeGlobe({ obstacles: [{ position: hill, radius: 5 }] });
    openLineOfSightPanel(globeApp(globe));
    globe.click(observer);
    globe.click(target);
    const { result } = getLineOfSightSnapshot();
    assert.ok(result?.occluded);
    assert.ok(result.hit);
    assert.ok(ids(globe).includes("geolibre-line-of-sight-hidden"));
  });

  it("applies the observer and target heights to the test", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    // A wall on the direct line between the ground points. Raising the
    // observer high enough lifts the sight line over it.
    const wall = Cartesian3.lerp(observer, target, 0.5, new Cartesian3());
    const globe = makeGlobe({ obstacles: [{ position: wall, radius: 20 }] });
    openLineOfSightPanel(globeApp(globe));
    setLineOfSightSettings({ observerHeight: 0, targetHeight: 0 });
    globe.click(observer);
    globe.click(target);
    assert.equal(getLineOfSightSnapshot().result?.occluded, true);
    setLineOfSightSettings({ observerHeight: 200 });
    assert.equal(getLineOfSightSnapshot().result?.occluded, false);
    assert.equal(getLineOfSightSnapshot().settings.observerHeight, 200);
  });

  it("re-asks the terrain once tile loading settles", () => {
    const observer = at(ORIGIN.lng, ORIGIN.lat, 500);
    const target = at(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    const obstacles: Array<{ position: Cesium.Cartesian3; radius: number }> = [];
    const globe = makeGlobe({ obstacles });
    openLineOfSightPanel(globeApp(globe));
    globe.click(observer);
    globe.click(target);
    assert.equal(getLineOfSightSnapshot().result?.occluded, false);
    // A finer tile arrives with a ridge on it.
    obstacles.push({
      position: Cartesian3.lerp(observer, target, 0.6, new Cartesian3()),
      radius: 5,
    });
    globe.settleTiles();
    assert.equal(getLineOfSightSnapshot().result?.occluded, true);
  });

  it("starts over from a new observer on a third click, and clears on demand", () => {
    const globe = makeGlobe();
    openLineOfSightPanel(globeApp(globe));
    globe.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    globe.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    globe.click(at(ORIGIN.lng + 0.1, ORIGIN.lat, 500));
    const state = getLineOfSightSnapshot();
    assert.equal(state.phase, "target");
    assert.equal(state.target, null);
    assert.equal(state.result, null);
    assert.deepEqual(ids(globe), ["geolibre-line-of-sight-observer"]);
    clearLineOfSight();
    assert.equal(getLineOfSightSnapshot().phase, "observer");
    assert.deepEqual(ids(globe), []);
  });

  it("removes its entities and handler on close, and keeps the points for reopening", () => {
    const globe = makeGlobe();
    openLineOfSightPanel(globeApp(globe));
    globe.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    globe.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    closeLineOfSightPanel(globeApp(globe));
    assert.equal(isLineOfSightPanelVisible(), false);
    assert.deepEqual(ids(globe), []);
    assert.equal(globe.handlerDestroyed(), true);
    assert.equal(globe.canvas.style.cursor, "");
    openLineOfSightPanel(globeApp(globe));
    assert.equal(getLineOfSightSnapshot().phase, "done");
    assert.equal(ids(globe).length, 3);
  });

  it("rebinds to a rebuilt globe on reattach and keeps an unchanged one", () => {
    const first = makeGlobe();
    openLineOfSightPanel(globeApp(first));
    first.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    first.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    reattachLineOfSight(globeApp(first));
    assert.equal(first.handlerCount(), 1, "an unchanged globe is not rebound");
    // A renderer swap destroys the widget and mounts a new one.
    first.destroy();
    const second = makeGlobe();
    reattachLineOfSight(globeApp(second));
    assert.equal(ids(second).length, 3, "the sight line is redrawn on the new globe");
    assert.equal(getLineOfSightSnapshot().phase, "done");
  });

  it("round-trips through project state and recomputes against the new globe", () => {
    const globe = makeGlobe();
    openLineOfSightPanel(globeApp(globe));
    setLineOfSightSettings({ observerHeight: 10, targetHeight: 2 });
    globe.click(at(ORIGIN.lng, ORIGIN.lat, 500));
    globe.click(at(ORIGIN.lng + 0.05, ORIGIN.lat, 500));
    const saved = getLineOfSightProjectState();
    assert.ok(saved);
    assert.equal(saved.open, true);
    assert.equal(saved.observerHeight, 10);
    assert.ok(saved.observer && saved.target);

    restoreLineOfSight(mapLessApp, undefined);
    assert.equal(getLineOfSightProjectState(), undefined, "a fresh tool persists nothing");

    const reopened = makeGlobe();
    assert.equal(restoreLineOfSight(globeApp(reopened), saved), true);
    const state = getLineOfSightSnapshot();
    assert.equal(state.open, true);
    assert.equal(state.phase, "done");
    assert.equal(state.settings.targetHeight, 2);
    assert.ok(state.result);
    assert.equal(ids(reopened).length, 3);
  });

  it("ignores a malformed saved state rather than restoring half of it", () => {
    const globe = makeGlobe();
    restoreLineOfSight(globeApp(globe), {
      open: true,
      observerHeight: "tall",
      observer: { lng: 11, lat: 200, alt: 0 },
      target: { lng: 11.1, lat: 44, alt: 0 },
    });
    const state = getLineOfSightSnapshot();
    assert.equal(state.settings.observerHeight, DEFAULT_LINE_OF_SIGHT_SETTINGS.observerHeight);
    assert.equal(state.observer, null, "a latitude beyond ±90 is not a point");
    assert.equal(state.target, null, "a target without an observer is meaningless");
    assert.equal(state.phase, "observer");
  });

  it("clamps heights into range", () => {
    assert.deepEqual(normalizeLineOfSightSettings({ observerHeight: -5, targetHeight: 1e9 }), {
      observerHeight: 0,
      targetHeight: 10_000,
    });
    assert.deepEqual(normalizeLineOfSightSettings("nonsense"), DEFAULT_LINE_OF_SIGHT_SETTINGS);
  });
});
