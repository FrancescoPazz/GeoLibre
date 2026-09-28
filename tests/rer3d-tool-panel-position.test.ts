import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RER3D_TOOL_PANEL_WIDTH,
  computeRer3dToolPanelSlot,
  openRer3dToolPanels,
  positionForRer3dToolPanelSlot,
  rer3dToolPanelPositionForOpenSet,
  type Rer3dToolPanelOpenSet,
} from "../apps/geolibre-desktop/src/hooks/rer3d-tool-panel-layout";

const WIDTH = RER3D_TOOL_PANEL_WIDTH;

function open(over: Partial<Rer3dToolPanelOpenSet>): Rer3dToolPanelOpenSet {
  return {
    "line-of-sight": false,
    "viewshed-area": false,
    ...over,
  };
}

describe("rer-3d tool panel layout", () => {
  it("lists open panels in fixed order", () => {
    assert.deepEqual(openRer3dToolPanels(open({ "viewshed-area": true })), ["viewshed-area"]);
    assert.deepEqual(openRer3dToolPanels(open({ "line-of-sight": true })), ["line-of-sight"]);
    assert.deepEqual(openRer3dToolPanels(open({ "line-of-sight": true, "viewshed-area": true })), [
      "line-of-sight",
      "viewshed-area",
    ]);
  });

  it("assigns slots so both panels sit side by side when open together", () => {
    const both = open({ "line-of-sight": true, "viewshed-area": true });
    assert.equal(computeRer3dToolPanelSlot("line-of-sight", both), 0);
    assert.equal(computeRer3dToolPanelSlot("viewshed-area", both), 1);

    const losPos = rer3dToolPanelPositionForOpenSet("line-of-sight", both, WIDTH);
    const vsPos = rer3dToolPanelPositionForOpenSet("viewshed-area", both, WIDTH);
    assert.equal(losPos.x, 12);
    assert.equal(vsPos.x, 12 + WIDTH + 12);
    assert.equal(losPos.y, vsPos.y);
  });

  it("uses slot 0 when only one panel is open", () => {
    const onlyVs = open({ "viewshed-area": true });
    assert.equal(computeRer3dToolPanelSlot("viewshed-area", onlyVs), 0);
    assert.equal(rer3dToolPanelPositionForOpenSet("viewshed-area", onlyVs, WIDTH).x, 12);

    const onlyLoS = open({ "line-of-sight": true });
    assert.equal(computeRer3dToolPanelSlot("line-of-sight", onlyLoS), 0);
  });

  it("positions columns from slot math", () => {
    assert.deepEqual(positionForRer3dToolPanelSlot(0, WIDTH), { x: 12, y: 12 });
    assert.deepEqual(positionForRer3dToolPanelSlot(1, WIDTH), { x: 324, y: 12 });
  });
});
