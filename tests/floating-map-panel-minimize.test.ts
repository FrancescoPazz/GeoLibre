import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FLOATING_MAP_PANEL_ICON_GAP,
  FLOATING_MAP_PANEL_ICON_SIZE,
  FLOATING_MAP_PANEL_WIDTHS,
  layoutFloatingMapPanelMinimizedIcons,
  layoutFloatingMapPanels,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "../apps/geolibre-desktop/src/hooks/floating-map-panel-layout";

function open(over: Partial<FloatingMapPanelOpenSet>): FloatingMapPanelOpenSet {
  const base: FloatingMapPanelOpenSet = {
    measure3d: false,
    "play-path": false,
    "line-of-sight": false,
    "viewshed-area": false,
    "globe-clipping": false,
    "elevation-bands": false,
    "coords-converter": false,
    microzonation: false,
  };
  return { ...base, ...over };
}

const bounds = { width: 800, height: 600 };

describe("floating map panel minimize layout", () => {
  it("excludes minimized panels from expanded row layout", () => {
    const set = open({ measure3d: true, "viewshed-area": true, "globe-clipping": true });
    const minimized = { measure3d: true, "globe-clipping": true };
    const positions = layoutFloatingMapPanels(set, bounds, {}, minimized);
    assert.equal(Object.keys(positions).length, 1);
    assert.ok(positions["viewshed-area"]);
    assert.equal(positions["viewshed-area"]!.x, 12);
  });

  it("stacks minimized icons bottom-end without overlap", () => {
    const set = open({ measure3d: true, "play-path": true, "line-of-sight": true });
    const minimized = { measure3d: true, "play-path": true, "line-of-sight": true };
    const icons = layoutFloatingMapPanelMinimizedIcons(set, bounds, minimized);
    const ids: FloatingMapPanelId[] = ["measure3d", "play-path", "line-of-sight"];
    const ys = ids.map((id) => icons[id]!.y);
    assert.equal(new Set(ys).size, ys.length, "distinct vertical slots");
    for (const id of ids) {
      const pos = icons[id]!;
      assert.equal(pos.x, bounds.width - 12 - FLOATING_MAP_PANEL_ICON_SIZE);
      assert.ok(pos.y >= 12);
      assert.ok(pos.y + FLOATING_MAP_PANEL_ICON_SIZE <= bounds.height - 12);
    }
    assert.equal(ys[0] - ys[1], FLOATING_MAP_PANEL_ICON_SIZE + FLOATING_MAP_PANEL_ICON_GAP);
  });

  it("reflows expanded panels when a sibling minimizes", () => {
    const wide = { width: 2000, height: 600 };
    const set = open({ measure3d: true, microzonation: true });
    const withoutMinimize = layoutFloatingMapPanels(set, wide);
    const withMinimize = layoutFloatingMapPanels(set, wide, {}, { measure3d: true });
    assert.equal(withoutMinimize.microzonation!.x, 12 + FLOATING_MAP_PANEL_WIDTHS.measure3d + 12);
    assert.equal(withMinimize.microzonation!.x, 12);
  });
});
