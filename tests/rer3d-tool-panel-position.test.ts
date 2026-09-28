import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FLOATING_MAP_PANEL_ESTIMATED_HEIGHTS,
  FLOATING_MAP_PANEL_WIDTHS,
  UNBOUNDED_FLOATING_MAP_LAYOUT,
  layoutFloatingMapPanels,
  openFloatingMapPanels,
  panelFitsInBounds,
  positionForOpenFloatingMapPanel,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "../apps/geolibre-desktop/src/hooks/floating-map-panel-layout";

function open(over: Partial<FloatingMapPanelOpenSet>): FloatingMapPanelOpenSet {
  const base: FloatingMapPanelOpenSet = {
    measure3d: false,
    "play-path": false,
    "line-of-sight": false,
    "viewshed-area": false,
    "elevation-bands": false,
    "coords-converter": false,
    microzonation: false,
  };
  return { ...base, ...over };
}

const LARGE_BOUNDS = UNBOUNDED_FLOATING_MAP_LAYOUT;

describe("floating map panel layout", () => {
  it("lists open panels in fixed order", () => {
    assert.deepEqual(openFloatingMapPanels(open({ "viewshed-area": true })), ["viewshed-area"]);
    assert.deepEqual(openFloatingMapPanels(open({ "line-of-sight": true })), ["line-of-sight"]);
    assert.deepEqual(
      openFloatingMapPanels(open({ "line-of-sight": true, "viewshed-area": true })),
      ["line-of-sight", "viewshed-area"],
    );
  });

  it("places line of sight and viewshed side by side when both are open", () => {
    const both = open({ "line-of-sight": true, "viewshed-area": true });
    const losPos = positionForOpenFloatingMapPanel("line-of-sight", both, LARGE_BOUNDS);
    const vsPos = positionForOpenFloatingMapPanel("viewshed-area", both, LARGE_BOUNDS);
    assert.equal(losPos.x, 12);
    assert.equal(vsPos.x, 12 + FLOATING_MAP_PANEL_WIDTHS["line-of-sight"] + 12);
    assert.equal(losPos.y, vsPos.y);
  });

  it("uses the left column when only one panel is open", () => {
    assert.equal(
      positionForOpenFloatingMapPanel(
        "viewshed-area",
        open({ "viewshed-area": true }),
        LARGE_BOUNDS,
      ).x,
      12,
    );
    assert.equal(
      positionForOpenFloatingMapPanel(
        "line-of-sight",
        open({ "line-of-sight": true }),
        LARGE_BOUNDS,
      ).x,
      12,
    );
  });

  it("cumulative width avoids overlap between measure3d and microzonation", () => {
    const set = open({ measure3d: true, microzonation: true });
    assert.equal(positionForOpenFloatingMapPanel("measure3d", set, LARGE_BOUNDS).x, 12);
    assert.equal(
      positionForOpenFloatingMapPanel("microzonation", set, LARGE_BOUNDS).x,
      12 + FLOATING_MAP_PANEL_WIDTHS.measure3d + 12,
    );
  });

  it("shifts later panels when earlier ones in order are open (wide container)", () => {
    const ids: FloatingMapPanelId[] = [
      "measure3d",
      "play-path",
      "line-of-sight",
      "viewshed-area",
      "elevation-bands",
      "coords-converter",
      "microzonation",
    ];
    const allOpen = open(
      Object.fromEntries(ids.map((id) => [id, true])) as FloatingMapPanelOpenSet,
    );
    let expectedX = 12;
    for (const id of ids) {
      assert.equal(positionForOpenFloatingMapPanel(id, allOpen, LARGE_BOUNDS).x, expectedX);
      expectedX += FLOATING_MAP_PANEL_WIDTHS[id] + 12;
    }
  });

  it("wraps to a second row when the next panel would cross the right edge", () => {
    const bounds = { width: 700, height: 800 };
    const set = open({ measure3d: true, "play-path": true, "line-of-sight": true });
    const los = positionForOpenFloatingMapPanel("line-of-sight", set, bounds);
    const m3 = positionForOpenFloatingMapPanel("measure3d", set, bounds);
    const pp = positionForOpenFloatingMapPanel("play-path", set, bounds);
    assert.equal(m3.y, 12);
    assert.equal(pp.y, 12);
    assert.ok(los.y > 12, "line-of-sight should wrap to row 2");
    const margin = 12;
    for (const [id, pos] of [
      ["measure3d", m3],
      ["play-path", pp],
      ["line-of-sight", los],
    ] as const) {
      const w = FLOATING_MAP_PANEL_WIDTHS[id];
      assert.ok(pos.x + w <= bounds.width - margin, `${id} horizontal overflow`);
    }
  });

  it("keeps every open panel inside bounds after wrap and clamp", () => {
    const bounds = { width: 500, height: 600 };
    const ids: FloatingMapPanelId[] = [
      "measure3d",
      "play-path",
      "line-of-sight",
      "viewshed-area",
      "elevation-bands",
      "coords-converter",
      "microzonation",
    ];
    const allOpen = open(
      Object.fromEntries(ids.map((id) => [id, true])) as FloatingMapPanelOpenSet,
    );
    const positions = layoutFloatingMapPanels(allOpen, bounds);
    for (const id of ids) {
      const pos = positions[id];
      assert.ok(pos, id);
      const w = FLOATING_MAP_PANEL_WIDTHS[id];
      const h = FLOATING_MAP_PANEL_ESTIMATED_HEIGHTS[id];
      assert.ok(panelFitsInBounds(pos!.x, pos!.y, w, h, bounds), id);
      assert.ok(pos!.x + w <= bounds.width - 12, `${id} right edge`);
    }
  });
});
