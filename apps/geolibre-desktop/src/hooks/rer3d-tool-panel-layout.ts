/** @deprecated Import from `./floating-map-panel-layout` instead. */
import {
  FLOATING_MAP_PANEL_ORDER,
  FLOATING_MAP_PANEL_WIDTHS,
  openFloatingMapPanels,
  positionForOpenFloatingMapPanel,
  type FloatingMapPanelOpenSet,
} from "./floating-map-panel-layout";

export {
  FLOATING_MAP_PANEL_EDGE_MARGIN,
  FLOATING_MAP_PANEL_ORDER,
  FLOATING_MAP_PANEL_WIDTHS,
  openFloatingMapPanels,
  positionForOpenFloatingMapPanel,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "./floating-map-panel-layout";

export const RER3D_TOOL_PANEL_WIDTH = FLOATING_MAP_PANEL_WIDTHS["line-of-sight"];
export const RER3D_TOOL_PANEL_ORDER = FLOATING_MAP_PANEL_ORDER.filter(
  (id): id is "line-of-sight" | "viewshed-area" => id === "line-of-sight" || id === "viewshed-area",
);

export type Rer3dToolPanelId = "line-of-sight" | "viewshed-area";
export type Rer3dToolPanelOpenSet = FloatingMapPanelOpenSet;

export const openRer3dToolPanels = openFloatingMapPanels;
export const rer3dToolPanelPositionForOpenSet = positionForOpenFloatingMapPanel;
