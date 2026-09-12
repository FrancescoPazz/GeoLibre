import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { CesiumEngine, CesiumSceneHandle } from "@geolibre/map";
import {
  getPaneCesiumEngines,
  registerPaneCesiumEngine,
  subscribePaneCesiumEngines,
  unregisterPaneCesiumEngine,
} from "../packages/map/src/cesium-pane-registry";
import {
  closeLineOfSightPanel,
  getLineOfSightSnapshot,
  openLineOfSightPanel,
  reattachLineOfSight,
} from "../packages/plugins/src/plugins/rer-3d-tools/line-of-sight";
import type { GeoLibreAppAPI } from "../packages/plugins/src/types";

// A globe in a grid pane is what the 3D tools bind to while the 2D map stays
// primary. The registry is where a pane's CesiumCanvas publishes its engine;
// the host lists every globe through `getCesiumScenes`, primary first; and a
// tool takes the first one, whatever pane it is in.

const fakeEngine = (id: string) => ({ id }) as unknown as CesiumEngine;

afterEach(() => {
  for (const engine of getPaneCesiumEngines()) {
    const viewId = (engine as unknown as { id: string }).id;
    unregisterPaneCesiumEngine(viewId, engine);
  }
  closeLineOfSightPanel();
});

describe("pane Cesium engine registry", () => {
  it("lists pane engines in mount order and tells subscribers about changes", () => {
    let changes = 0;
    const unsubscribe = subscribePaneCesiumEngines(() => {
      changes += 1;
    });
    const a = fakeEngine("a");
    const b = fakeEngine("b");
    registerPaneCesiumEngine("a", a);
    registerPaneCesiumEngine("b", b);
    registerPaneCesiumEngine("a", a);
    assert.deepEqual(getPaneCesiumEngines(), [a, b]);
    assert.equal(changes, 2, "re-registering the same engine is not a change");

    // A remount of pane "a" replaces its engine in place — the pane keeps its
    // slot — and the old engine's late cleanup must not withdraw the new one.
    const a2 = fakeEngine("a");
    registerPaneCesiumEngine("a", a2);
    unregisterPaneCesiumEngine("a", a);
    assert.deepEqual(getPaneCesiumEngines(), [a2, b]);
    assert.equal(changes, 3);

    unregisterPaneCesiumEngine("b", b);
    unregisterPaneCesiumEngine("b", b);
    assert.deepEqual(getPaneCesiumEngines(), [a2]);
    assert.equal(changes, 4);
    unsubscribe();
    unregisterPaneCesiumEngine("a", a2);
    assert.equal(changes, 4, "unsubscribed");
  });
});

/** A minimal pane globe: enough of a handle for a tool to bind to and let go of. */
function paneGlobe(): { handle: CesiumSceneHandle; destroy: () => void } {
  let destroyed = false;
  const entities: object[] = [];
  const handle = {
    Cesium: {
      ...Cesium,
      ScreenSpaceEventHandler: class {
        setInputAction() {}
        destroy() {}
        isDestroyed() {
          return false;
        }
      },
      ScreenSpaceEventType: { LEFT_CLICK: "LEFT_CLICK", MOUSE_MOVE: "MOUSE_MOVE" },
    },
    viewer: {
      scene: {
        globe: { ellipsoid: Cesium.Ellipsoid.WGS84, tileLoadProgressEvent: new Cesium.Event() },
        screenSpaceCameraController: { enableInputs: true },
      },
      camera: {},
      canvas: { style: {} },
      entities: {
        add: (e: object) => {
          entities.push(e);
          return e;
        },
        remove: () => true,
      },
      isDestroyed: () => destroyed,
    },
    scene: {
      globe: { ellipsoid: Cesium.Ellipsoid.WGS84, tileLoadProgressEvent: new Cesium.Event() },
      screenSpaceCameraController: { enableInputs: true },
    },
    camera: {},
    clock: {},
    canvas: { style: {} },
    primary: false,
    requestRender: () => {},
    readView: () => ({ center: [11, 44], zoom: 10, bearing: 0, pitch: 0 }),
  } as unknown as CesiumSceneHandle;
  return {
    handle,
    destroy: () => {
      destroyed = true;
    },
  };
}

describe("3D tools on a pane globe", () => {
  it("bind to the first globe getCesiumScenes offers, even when it is not primary", () => {
    const pane = paneGlobe();
    const app = {
      getMap: () => null,
      getCesiumScene: () => null,
      getCesiumScenes: () => [pane.handle],
    } as unknown as GeoLibreAppAPI;
    openLineOfSightPanel(app);
    assert.equal(getLineOfSightSnapshot().phase, "observer", "bound to the pane globe");

    // The pane goes away: the host re-binds with no globe left.
    const noGlobes = { ...app, getCesiumScenes: () => [] } as unknown as GeoLibreAppAPI;
    reattachLineOfSight(noGlobes);
    assert.equal(getLineOfSightSnapshot().phase, "unavailable");

    // A host without getCesiumScenes still offers the primary globe only.
    const legacy = {
      getMap: () => null,
      getCesiumScene: () => pane.handle,
    } as unknown as GeoLibreAppAPI;
    reattachLineOfSight(legacy);
    assert.equal(getLineOfSightSnapshot().phase, "observer");
  });
});
