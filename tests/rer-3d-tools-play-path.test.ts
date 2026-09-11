import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import { geodesicMeters } from "../packages/plugins/src/plugins/rer-3d-tools/draw-geometry";
import {
  openMeasure3dPanel,
  restoreMeasure3d,
  setMeasure3dSamplingStep,
} from "../packages/plugins/src/plugins/rer-3d-tools/measure-3d";
import {
  PLAY_COUNTDOWN_SECONDS,
  PLAY_MIN_RANGE_METERS,
  closePlayPathPanel,
  getPlayPathProjectState,
  getPlayPathSnapshot,
  isPlayPathPanelVisible,
  lookAtCameraPosition,
  openPlayPathPanel,
  pausePath,
  playPath,
  reattachPlayPath,
  resamplePathForFlight,
  restorePlayPath,
  setPlayPathSamplingStep,
  setPlayPathSpeed,
  setPlayPathTiming,
  stopPath,
  subscribePlayPath,
} from "../packages/plugins/src/plugins/rer-3d-tools/play-path";
import { rer3dToolsPlugin } from "../packages/plugins/src/plugins/rer-3d-tools";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// Real Cesium maths, a faked globe: the camera records every flight and
// completes it on the next microtask, the globe reports its tiles loaded,
// and the countdown ticks in milliseconds. The path comes from the 3D
// Measure tool, driven here through the same fake globe's click handler.

const { Cartesian3 } = Cesium;
const ORIGIN = { lng: 11.0, lat: 44.3 };
const P = (lng: number, lat: number, alt = 0) => ({ lng, lat, alt });
const A = P(ORIGIN.lng, ORIGIN.lat, 100);
const B = P(ORIGIN.lng + 0.01, ORIGIN.lat, 200);
const Cp = P(ORIGIN.lng + 0.02, ORIGIN.lat, 150);

type Positioned = (m: { position: Cesium.Cartesian2 }) => void;

interface Flight {
  destination: Cesium.Cartesian3;
  heading: number;
  pitch: number;
  duration: number;
}

function makeGlobe(
  options: { cameraAt?: Cesium.Cartesian3; pitchDeg?: number; holdTiles?: boolean } = {},
) {
  let destroyed = false;
  const entities: Array<Record<string, unknown> & { id: string }> = [];
  const canvas = {
    style: { cursor: "" },
    clientHeight: 800,
    height: 800,
  } as unknown as HTMLCanvasElement;
  let nextGround: Cesium.Cartesian3 | null = null;
  const flights: Flight[] = [];
  let cancelled = 0;
  let pending: { complete: () => void; cancel: () => void } | null = null;
  const camera = {
    positionWC: options.cameraAt ?? Cartesian3.fromDegrees(ORIGIN.lng - 0.01, ORIGIN.lat, 2000),
    positionCartographic: { height: 2000 },
    pitch: Cesium.Math.toRadians(options.pitchDeg ?? -45),
    frustum: { fovy: Math.PI / 3 },
    getPickRay: () =>
      nextGround ? new Cesium.Ray(nextGround, new Cartesian3(0, 0, 1)) : undefined,
    pickEllipsoid: () => undefined,
    flyTo: (o: {
      destination: Cesium.Cartesian3;
      orientation: { heading: number; pitch: number };
      duration: number;
      complete?: () => void;
      cancel?: () => void;
    }) => {
      flights.push({
        destination: o.destination,
        heading: o.orientation.heading,
        pitch: o.orientation.pitch,
        duration: o.duration,
      });
      camera.positionWC = o.destination;
      pending = { complete: o.complete ?? (() => {}), cancel: o.cancel ?? (() => {}) };
      // Complete on the next microtask unless cancelled first.
      const mine = pending;
      queueMicrotask(() => {
        if (pending === mine) {
          pending = null;
          mine.complete();
        }
      });
    },
    cancelFlight: () => {
      if (pending) {
        const p = pending;
        pending = null;
        cancelled += 1;
        p.cancel();
      }
    },
  };
  const scene = {
    globe: {
      ellipsoid: Cesium.Ellipsoid.WGS84,
      pick: (ray: Cesium.Ray) =>
        nextGround && Cartesian3.equals(ray.origin, nextGround) ? nextGround : undefined,
      tileLoadProgressEvent: new Cesium.Event(),
      tilesLoaded: !options.holdTiles,
    },
    screenSpaceCameraController: { enableInputs: true },
    pick: () => undefined,
  };
  const viewer = {
    scene,
    camera,
    canvas,
    terrainProvider: undefined,
    entities: {
      add: (e: Record<string, unknown> & { id: string }) => {
        entities.push(e);
        return e;
      },
      remove: (e: Record<string, unknown> & { id: string }) => {
        const i = entities.indexOf(e);
        if (i >= 0) entities.splice(i, 1);
        return i >= 0;
      },
    },
    isDestroyed: () => destroyed,
  };
  const actions = new Map<string, Positioned>();
  class FakeHandler {
    setInputAction(fn: Positioned, type: string) {
      actions.set(type, fn);
    }
    destroy() {}
    isDestroyed() {
      return false;
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
    primary: true,
    requestRender: () => {},
    readView: () => ({
      center: [ORIGIN.lng, ORIGIN.lat] as [number, number],
      zoom: 12,
      bearing: 0,
      pitch: 0,
    }),
  } as unknown as CesiumSceneHandle;
  const px = new Cesium.Cartesian2(1, 1);
  return {
    handle,
    flights,
    cancelled: () => cancelled,
    /** Let the flight advance past its wait for tiles. */
    settleTiles: () => scene.globe.tileLoadProgressEvent.raiseEvent(0),
    click: (p: { lng: number; lat: number; alt: number }) => {
      nextGround = at(p);
      actions.get("LEFT_DOWN")?.({ position: px });
      actions.get("LEFT_UP")?.({ position: px });
      actions.get("LEFT_CLICK")?.({ position: px });
      nextGround = null;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}
const at = (p: { lng: number; lat: number; alt: number }) =>
  Cartesian3.fromDegrees(p.lng, p.lat, p.alt);

function globeApp(globe: ReturnType<typeof makeGlobe>): GeoLibreAppAPI {
  return { getMap: () => null, getCesiumScene: () => globe.handle } as unknown as GeoLibreAppAPI;
}
const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

/** Wait until the snapshot satisfies `predicate`, or fail after `limitMs`. */
async function until(predicate: () => boolean, limitMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > limitMs) throw new Error("timed out waiting for play-path state");
    await tick();
  }
}

/** Draw a three-vertex line with the measure tool on the fake globe. */
function drawPath(globe: ReturnType<typeof makeGlobe>) {
  openMeasure3dPanel(globeApp(globe));
  setMeasure3dSamplingStep(0); // vertices only: no profile read to wait for
  globe.click(A);
  globe.click(B);
  globe.click(Cp);
}

describe("resamplePathForFlight", () => {
  it("splits long segments into equal parts and interpolates heights", () => {
    const out = resamplePathForFlight(Cesium, [A, B], 250);
    // ~798 m / 250 → 4 parts → 3 interior points.
    assert.equal(out.length, 5);
    assert.ok(Math.abs(out[2].alt - 150) < 1e-9, "the midpoint sits halfway up");
    const step = geodesicMeters(Cesium, out[0], out[1]);
    for (let i = 1; i < out.length; i += 1) {
      assert.ok(Math.abs(geodesicMeters(Cesium, out[i - 1], out[i]) - step) < 1e-3);
    }
    assert.deepEqual(out[0], A);
    assert.deepEqual(out[4], B);
  });

  it("keeps short segments and copies the points when the step is zero", () => {
    assert.equal(resamplePathForFlight(Cesium, [A, B], 5000).length, 2);
    const copy = resamplePathForFlight(Cesium, [A, B], 0);
    assert.deepEqual(copy, [A, B]);
    assert.notEqual(copy[0], A);
  });
});

describe("lookAtCameraPosition", () => {
  it("puts the camera behind the target along the heading, tilted down by the pitch", () => {
    const target = at(A);
    const range = 1000;
    const pitch = Cesium.Math.toRadians(-30);
    // Heading north: the camera sits south of the target.
    const pos = lookAtCameraPosition(Cesium, target, 0, pitch, range);
    assert.ok(Math.abs(Cartesian3.distance(pos, target) - range) < 1e-6);
    const enu = Cesium.Matrix4.inverse(
      Cesium.Transforms.eastNorthUpToFixedFrame(target),
      new Cesium.Matrix4(),
    );
    const local = Cesium.Matrix4.multiplyByPoint(enu, pos, new Cartesian3());
    assert.ok(Math.abs(local.x) < 1e-6, "no east offset for a northward heading");
    assert.ok(local.y < 0, "south of the target");
    assert.ok(Math.abs(local.y + range * Math.cos(Math.PI / 6)) < 1e-6);
    assert.ok(Math.abs(local.z - range * Math.sin(Math.PI / 6)) < 1e-6, "above by range·sin(30°)");
    // Heading east: the camera sits west.
    const west = Cesium.Matrix4.multiplyByPoint(
      enu,
      lookAtCameraPosition(Cesium, target, Math.PI / 2, pitch, range),
      new Cartesian3(),
    );
    assert.ok(west.x < 0 && Math.abs(west.y) < 1e-6);
  });
});

describe("play-path tool", () => {
  beforeEach(() => {
    setPlayPathTiming({ countdownTickMs: 2, tileSettleTimeoutMs: 20 });
    restorePlayPath(mapLessApp, undefined);
    restoreMeasure3d(mapLessApp, undefined);
  });

  it("declares itself unavailable without a globe or without a path", () => {
    openPlayPathPanel(mapLessApp);
    assert.equal(isPlayPathPanelVisible(), true);
    assert.deepEqual(
      [getPlayPathSnapshot().bound, getPlayPathSnapshot().available],
      [false, false],
    );
    assert.equal(playPath(), false);
    const globe = makeGlobe();
    reattachPlayPath(globeApp(globe));
    assert.deepEqual([getPlayPathSnapshot().bound, getPlayPathSnapshot().available], [true, false]);
    assert.equal(playPath(), false, "no path drawn yet");
  });

  it("follows the measure tool's path and picks a flight step from the series", () => {
    const globe = makeGlobe();
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    const s = getPlayPathSnapshot();
    assert.equal(s.available, true);
    assert.ok(s.samplingStepM > 0, "an auto step was chosen for a ~1.6 km path");
    assert.deepEqual(s.samplingStepRange, [2, 100]);
  });

  it("counts down, then flies every sample in order, waiting for tiles, and finishes", async () => {
    const globe = makeGlobe();
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    setPlayPathSamplingStep(0); // vertices only → 3 samples
    const phases: string[] = [];
    const unsubscribe = subscribePlayPath(() => {
      const s = getPlayPathSnapshot();
      phases.push(
        s.countdown !== null ? `c${s.countdown}` : s.playing ? `p${s.currentIndex}` : "idle",
      );
    });
    assert.equal(playPath(), true);
    assert.equal(getPlayPathSnapshot().countdown, PLAY_COUNTDOWN_SECONDS);
    assert.equal(getPlayPathSnapshot().pointCount, 3);
    await until(
      () =>
        !getPlayPathSnapshot().playing &&
        getPlayPathSnapshot().countdown === null &&
        globe.flights.length >= 3,
    );
    unsubscribe();
    assert.ok(
      phases.includes("c3") && phases.includes("c2") && phases.includes("c1"),
      phases.join(","),
    );
    assert.equal(globe.flights.length, 3, "one flight per sample");
    assert.equal(
      getPlayPathSnapshot().reverse,
      false,
      "the camera started nearer the first vertex",
    );
    // Each flight looks along the path: heading east (~90°) between the samples.
    for (const f of globe.flights) assert.ok(Math.abs(Cesium.Math.toDegrees(f.heading) - 90) < 1);
    // The pitch is the one the view had, and the range never below the floor.
    assert.ok(Math.abs(Cesium.Math.toDegrees(globe.flights[0].pitch) + 45) < 1e-6);
    const range = Cartesian3.distance(globe.flights[0].destination, at(A));
    assert.ok(range >= PLAY_MIN_RANGE_METERS);
    assert.equal(getPlayPathSnapshot().currentIndex, 2, "ends on the last sample");
  });

  it("clamps a hand-picked flight step to the range the path allows", () => {
    const globe = makeGlobe();
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    setPlayPathSamplingStep(500);
    assert.equal(getPlayPathSnapshot().samplingStepM, 100, "~1.6 km allows at most 100 m");
    setPlayPathSamplingStep(3);
    assert.equal(getPlayPathSnapshot().samplingStepM, 2, "snapped to the series");
  });

  it("flies backwards when the camera starts nearer the end of the path", async () => {
    const globe = makeGlobe({
      cameraAt: Cartesian3.fromDegrees(ORIGIN.lng + 0.03, ORIGIN.lat, 2000),
    });
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    setPlayPathSamplingStep(0);
    playPath();
    await until(
      () =>
        !getPlayPathSnapshot().playing &&
        getPlayPathSnapshot().countdown === null &&
        globe.flights.length >= 3,
    );
    assert.equal(getPlayPathSnapshot().reverse, true);
    assert.ok(
      Math.abs(
        Cartesian3.distance(globe.flights[0].destination, at(Cp)) -
          Cartesian3.distance(globe.flights[0].destination, at(Cp)),
      ) < 1e-9,
    );
    // Looking west along the path on the way back.
    assert.ok(Math.abs(Cesium.Math.toDegrees(globe.flights[0].heading) - 270) < 1);
  });

  it("pauses at the current sample and resumes from it; stop flies back to the start", async () => {
    const globe = makeGlobe({ holdTiles: true });
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    setPlayPathSamplingStep(0);
    setPlayPathTiming({ countdownTickMs: 1, tileSettleTimeoutMs: 10_000 });
    playPath();
    await until(() => getPlayPathSnapshot().playing);
    // The first flight completed and the loop now waits for tiles; release
    // it once so the camera advances to the second sample and waits again.
    await tick();
    globe.settleTiles();
    await until(() => getPlayPathSnapshot().currentIndex >= 1);
    pausePath();
    const s = getPlayPathSnapshot();
    assert.equal(s.playing, false);
    assert.equal(s.paused, true);
    const pausedAt = s.currentIndex;
    const flightsAtPause = globe.flights.length;
    await tick(10);
    assert.equal(globe.flights.length, flightsAtPause, "no flights while paused");
    assert.equal(playPath(), true, "resumes without a countdown");
    assert.equal(getPlayPathSnapshot().countdown, null);
    await tick();
    globe.settleTiles();
    await until(
      () => getPlayPathSnapshot().currentIndex > pausedAt || !getPlayPathSnapshot().playing,
    );
    stopPath();
    assert.equal(getPlayPathSnapshot().playing, false);
    assert.equal(getPlayPathSnapshot().paused, false);
    const back = globe.flights[globe.flights.length - 1];
    assert.ok(
      Math.abs(
        Cartesian3.distance(back.destination, at(A)) -
          Cartesian3.distance(globe.flights[0].destination, at(A)),
      ) < 1e-6,
      "returns to the start at the same range",
    );
  });

  it("cancels the countdown on pause and the flight on close", async () => {
    const globe = makeGlobe({ holdTiles: true });
    drawPath(globe);
    openPlayPathPanel(globeApp(globe));
    setPlayPathTiming({ countdownTickMs: 50, tileSettleTimeoutMs: 10_000 });
    playPath();
    assert.equal(getPlayPathSnapshot().countdown, PLAY_COUNTDOWN_SECONDS);
    pausePath();
    assert.equal(getPlayPathSnapshot().countdown, null);
    await tick(120);
    assert.equal(globe.flights.length, 0, "a paused countdown never takes off");
    setPlayPathTiming({ countdownTickMs: 1 });
    playPath();
    await until(() => getPlayPathSnapshot().playing);
    closePlayPathPanel(globeApp(globe));
    assert.equal(isPlayPathPanelVisible(), false);
    assert.equal(getPlayPathSnapshot().playing, false);
    // The loop was waiting for tiles; releasing them now must not fly on.
    const flightsAtClose = globe.flights.length;
    globe.settleTiles();
    await tick(10);
    assert.equal(globe.flights.length, flightsAtClose, "a closed tool flies no further");
  });

  it("clamps the speed and persists speed and step, never a flight", () => {
    setPlayPathSpeed(10);
    assert.equal(getPlayPathSnapshot().speed, 4);
    setPlayPathSpeed(0.1);
    assert.equal(getPlayPathSnapshot().speed, 0.25);
    setPlayPathSpeed(2);
    setPlayPathSamplingStep(30);
    const saved = getPlayPathProjectState();
    assert.deepEqual(saved, { open: false, speed: 2, samplingStepAuto: false, samplingStep: 20 });
    restorePlayPath(mapLessApp, undefined);
    assert.equal(getPlayPathProjectState(), undefined);
    restorePlayPath(mapLessApp, saved);
    assert.equal(getPlayPathSnapshot().speed, 2);
    assert.equal(getPlayPathSnapshot().samplingStepAuto, false);
  });

  it("is composed into the plugin's project state and reattach", () => {
    const globe = makeGlobe();
    openPlayPathPanel(globeApp(globe));
    setPlayPathSpeed(1.5);
    const state = rer3dToolsPlugin.getProjectState?.() as Record<string, unknown>;
    assert.ok(state.playPath);
    rer3dToolsPlugin.deactivate(globeApp(globe));
    assert.equal(isPlayPathPanelVisible(), false);
    assert.equal(rer3dToolsPlugin.applyProjectState?.(globeApp(globe), state), true);
    assert.equal(isPlayPathPanelVisible(), true);
    assert.equal(getPlayPathSnapshot().speed, 1.5);
  });
});
