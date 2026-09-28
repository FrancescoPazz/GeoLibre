import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumSceneHandle } from "@geolibre/map";
import {
  armLineOfSightNewLine,
  armLineOfSightObserverPlacement,
  clearLineOfSight,
  closeLineOfSightPanel,
  getLineOfSightSnapshot,
  openLineOfSightPanel,
  reattachLineOfSight,
  restoreLineOfSight,
} from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight";
import {
  getSightAndViewshedInputRegistrationTool,
  isSightAndViewshedPlacementActive,
  resetSightAndViewshedPlacement,
} from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight-viewshed-input";
import {
  VIEWSHED_AREA_DEBOUNCE_MS,
  armViewshedAreaPlacement,
  clearViewshedArea,
  closeViewshedAreaPanel,
  getViewshedAreaSnapshot,
  openViewshedAreaPanel,
  restoreViewshedArea,
} from "../packages/plugins/src/plugins/rer-3d-tools/viewshed-area";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

const ORIGIN = { lng: 11.0, lat: 44.3, alt: 0 };
const { Cartesian3 } = Cesium;

type ClickListener = (movement: { position: Cesium.Cartesian2 }) => void;
type MotionListener = (movement: { endPosition: Cesium.Cartesian2 }) => void;

const INPUT_TOOL_KEY = "__geolibreSightViewshedInputTool";
type InputTool = "line-of-sight" | "viewshed-area";

function setInputTool(tool: InputTool): void {
  (globalThis as Record<string, InputTool>)[INPUT_TOOL_KEY] = tool;
}

function openLoS(app: GeoLibreAppAPI): void {
  setInputTool("line-of-sight");
  openLineOfSightPanel(app);
}

function openVs(app: GeoLibreAppAPI): void {
  setInputTool("viewshed-area");
  openViewshedAreaPanel(app);
}

/** Re-register line-of-sight handlers after viewshed binds the same canvas. */
function refreshLoSInput(app: GeoLibreAppAPI): void {
  if (!getLineOfSightSnapshot().open) return;
  setInputTool("line-of-sight");
  reattachLineOfSight(app);
}

function restoreLoS(app: GeoLibreAppAPI, state: unknown): boolean {
  setInputTool("line-of-sight");
  return restoreLineOfSight(app, state);
}

function restoreVs(app: GeoLibreAppAPI, state: unknown): boolean {
  setInputTool("viewshed-area");
  return restoreViewshedArea(app, state);
}

/** One fake globe shared by both tools on the same canvas. */
function makeSharedGlobe() {
  let destroyed = false;
  const entities: Array<Record<string, unknown> & { id: string }> = [];
  const canvas = { style: { cursor: "" } } as unknown as HTMLCanvasElement;
  let nextGround: Cesium.Cartesian3 | null = null;
  let entityUnderPointer: string | null = null;
  const controller = { enableInputs: true };
  const tileListeners: Array<(remaining: number) => void> = [];
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
    pick: () => (entityUnderPointer ? { id: { id: entityUnderPointer } } : undefined),
  };
  const camera = {
    getPickRay: () =>
      nextGround ? new Cesium.Ray(nextGround, new Cartesian3(0, 0, 1)) : undefined,
    pickEllipsoid: () => undefined,
    frustum: { fovy: Math.PI / 3 },
    positionCartographic: { height: 5000 },
  };
  const viewer = {
    scene,
    camera,
    canvas,
    terrainProvider: { availability: {} },
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
  const losActions = new Map<string, ClickListener | MotionListener>();
  const vsActions = new Map<string, ClickListener | MotionListener>();
  let handlerCount = 0;
  class FakeHandler {
    readonly #actions: Map<string, ClickListener | MotionListener>;
    readonly #owner: InputTool;
    constructor() {
      handlerCount += 1;
      this.#owner =
        getSightAndViewshedInputRegistrationTool() ??
        (globalThis as Record<string, InputTool | undefined>)[INPUT_TOOL_KEY] ??
        "line-of-sight";
      this.#actions = this.#owner === "viewshed-area" ? vsActions : losActions;
    }
    setInputAction(fn: ClickListener | MotionListener, type: unknown) {
      const key = String(type);
      this.#actions.set(key, fn);
    }
    destroy() {}
    isDestroyed() {
      return false;
    }
  }
  const fire = (
    map: Map<string, ClickListener | MotionListener>,
    type: string,
    movement: object,
  ) => {
    const fn = map.get(type);
    if (!fn) return;
    if (type === "MOUSE_MOVE")
      (fn as MotionListener)(movement as { endPosition: Cesium.Cartesian2 });
    else (fn as ClickListener)(movement as { position: Cesium.Cartesian2 });
  };
  const INPUT_EVENT_KEYS: Record<string, string[]> = {
    LEFT_CLICK: ["LEFT_CLICK", "2"],
    LEFT_DOWN: ["LEFT_DOWN", "0"],
    LEFT_UP: ["LEFT_UP", "1"],
    MOUSE_MOVE: ["MOUSE_MOVE", "15"],
  };
  const fireAll = (type: string, movement: object) => {
    for (const key of INPUT_EVENT_KEYS[type] ?? [type]) {
      fire(losActions, key, movement);
      fire(vsActions, key, movement);
    }
  };
  const sampleTerrainMostDetailed = async (_p: unknown, positions: Cesium.Cartographic[]) => {
    for (const c of positions) c.height = 0;
    return positions;
  };
  const handle = {
    Cesium: {
      ...Cesium,
      sampleTerrainMostDetailed,
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
  const withGround = (point: Cesium.Cartesian3, fn: () => void) => {
    nextGround = point;
    fn();
    nextGround = null;
  };
  return {
    handle,
    canvas,
    controller,
    entities,
    handlerCount: () => handlerCount,
    clickGround: (lng: number, lat: number, alt: number) => {
      withGround(Cartesian3.fromDegrees(lng, lat, alt), () => {
        fireAll("LEFT_CLICK", { position: px });
      });
    },
    /** Simulates a ground click where scene.pick reports a tool overlay (e.g. viewshed fill). */
    clickGroundThroughOverlay: (lng: number, lat: number, alt: number, overlayEntityId: string) => {
      withGround(Cartesian3.fromDegrees(lng, lat, alt), () => {
        entityUnderPointer = overlayEntityId;
        fireAll("LEFT_CLICK", { position: px });
        entityUnderPointer = null;
      });
    },
    dragLineOfSight: (which: "observer" | "target", to: Cesium.Cartesian3) => {
      entityUnderPointer = `geolibre-line-of-sight-${which}`;
      fireAll("LEFT_DOWN", { position: px });
      entityUnderPointer = null;
      withGround(to, () => {
        fireAll("MOUSE_MOVE", { endPosition: px });
      });
      fireAll("LEFT_UP", { position: px });
    },
    clickOnEntity: (id: string) => {
      entityUnderPointer = id;
      fireAll("LEFT_CLICK", { position: px });
      entityUnderPointer = null;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

const mapLessApp = { getMap: () => null, getCesiumScene: () => null } as unknown as GeoLibreAppAPI;
const globeApp = (globe: ReturnType<typeof makeSharedGlobe>): GeoLibreAppAPI =>
  ({ getMap: () => null, getCesiumScene: () => globe.handle }) as unknown as GeoLibreAppAPI;

const settle = () => new Promise((r) => setTimeout(r, VIEWSHED_AREA_DEBOUNCE_MS + 30));

describe("line of sight and viewshed shared placement", () => {
  beforeEach(() => {
    restoreLoS(mapLessApp, undefined);
    restoreVs(mapLessApp, undefined);
    resetSightAndViewshedPlacement();
  });

  it("keeps each tool's state when the other places on empty ground", async () => {
    const globe = makeSharedGlobe();
    const app = globeApp(globe);
    openLoS(app);
    globe.clickGround(ORIGIN.lng, ORIGIN.lat, 500);
    globe.clickGround(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    openVs(app);
    refreshLoSInput(app);
    const losDone = getLineOfSightSnapshot();
    assert.equal(losDone.phase, "done");
    assert.equal(losDone.placementActive, false);

    armViewshedAreaPlacement();
    assert.equal(isSightAndViewshedPlacementActive("viewshed-area"), true);
    globe.clickGround(ORIGIN.lng + 0.02, ORIGIN.lat + 0.02, 0);
    await settle();
    const vs = getViewshedAreaSnapshot();
    assert.ok(vs.observer);
    assert.equal(getLineOfSightSnapshot().phase, "done");
    assert.ok(Math.abs((getLineOfSightSnapshot().target?.lng ?? 0) - (ORIGIN.lng + 0.05)) < 1e-9);

    armLineOfSightNewLine();
    assert.equal(isSightAndViewshedPlacementActive("line-of-sight"), true);
    assert.equal(getLineOfSightSnapshot().placementActive, true);
    assert.equal(getLineOfSightSnapshot().placementIntent, "observer");
    globe.clickGround(ORIGIN.lng + 0.2, ORIGIN.lat, 500);
    assert.equal(getLineOfSightSnapshot().phase, "target");
    await settle();
    assert.equal(getViewshedAreaSnapshot().status, "ready");
    assert.ok(
      Math.abs((getViewshedAreaSnapshot().observer?.lat ?? 0) - (ORIGIN.lat + 0.02)) < 1e-9,
    );
  });

  it("lets markers drag under the other tool's placement without moving the armed tool", () => {
    const globe = makeSharedGlobe();
    const app = globeApp(globe);
    openLoS(app);
    globe.clickGround(ORIGIN.lng, ORIGIN.lat, 500);
    globe.clickGround(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    openVs(app);
    refreshLoSInput(app);
    armViewshedAreaPlacement();
    assert.equal(globe.canvas.style.cursor, "crosshair");

    const before = getLineOfSightSnapshot().target?.lng ?? 0;
    globe.dragLineOfSight("target", Cartesian3.fromDegrees(ORIGIN.lng + 0.08, ORIGIN.lat, 500));
    assert.equal(globe.controller.enableInputs, true);
    assert.ok(Math.abs((getLineOfSightSnapshot().target?.lng ?? 0) - (ORIGIN.lng + 0.08)) < 1e-9);
    assert.notEqual(getLineOfSightSnapshot().target?.lng, before);
    assert.equal(getViewshedAreaSnapshot().observer, null);
    assert.equal(isSightAndViewshedPlacementActive("viewshed-area"), true);
    globe.clickOnEntity("geolibre-line-of-sight-target");
    assert.equal(getViewshedAreaSnapshot().observer, null, "entity clicks are not placement");
  });

  it("places line of sight through viewshed overlay graphics", async () => {
    const globe = makeSharedGlobe();
    const app = globeApp(globe);
    openVs(app);
    armViewshedAreaPlacement();
    globe.clickGround(ORIGIN.lng, ORIGIN.lat, 0);
    await settle();
    openLoS(app);
    refreshLoSInput(app);
    armLineOfSightObserverPlacement();
    assert.equal(isSightAndViewshedPlacementActive("line-of-sight"), true);
    globe.clickGroundThroughOverlay(
      ORIGIN.lng + 0.1,
      ORIGIN.lat,
      500,
      "geolibre-viewshed-area-area",
    );
    assert.equal(getLineOfSightSnapshot().phase, "target");
    assert.ok(Math.abs((getLineOfSightSnapshot().observer?.lng ?? 0) - (ORIGIN.lng + 0.1)) < 1e-9);
  });

  it("hands the crosshair to whichever tool owns placement and clears it on cancel", () => {
    const globe = makeSharedGlobe();
    const app = globeApp(globe);
    openLoS(app);
    assert.equal(globe.canvas.style.cursor, "crosshair");
    assert.equal(getLineOfSightSnapshot().placementActive, true);
    openVs(app);
    assert.equal(getViewshedAreaSnapshot().placementActive, true);
    assert.equal(globe.canvas.style.cursor, "crosshair");

    clearLineOfSight();
    armViewshedAreaPlacement();
    assert.equal(globe.canvas.style.cursor, "crosshair");
    closeViewshedAreaPanel(app);
    assert.equal(globe.canvas.style.cursor, "");
    closeLineOfSightPanel(app);
  });

  it("reopens restored results without arming either tool", async () => {
    const globe = makeSharedGlobe();
    const app = globeApp(globe);
    openLoS(app);
    globe.clickGround(ORIGIN.lng, ORIGIN.lat, 500);
    globe.clickGround(ORIGIN.lng + 0.05, ORIGIN.lat, 500);
    openVs(app);
    armViewshedAreaPlacement();
    globe.clickGround(ORIGIN.lng, ORIGIN.lat + 0.01, 0);
    await settle();

    const losSaved = getLineOfSightSnapshot();
    const vsSaved = getViewshedAreaSnapshot();
    restoreLoS(mapLessApp, undefined);
    restoreVs(mapLessApp, undefined);
    resetSightAndViewshedPlacement();

    const fresh = makeSharedGlobe();
    const freshApp = globeApp(fresh);
    restoreLoS(freshApp, {
      open: true,
      observer: losSaved.observer,
      target: losSaved.target,
    });
    restoreVs(freshApp, {
      open: true,
      observer: vsSaved.observer,
      radiusMeters: vsSaved.settings.radiusMeters,
    });
    assert.equal(getLineOfSightSnapshot().placementActive, false);
    assert.equal(getViewshedAreaSnapshot().placementActive, false);
    assert.equal(fresh.canvas.style.cursor, "");
    await settle();
    assert.equal(getLineOfSightSnapshot().phase, "done");
    assert.equal(getViewshedAreaSnapshot().phase, "done");
  });
});
