export const RER3D_TOOL_PANEL_WIDTH = 300;
const EDGE_MARGIN = 12;
const PANEL_GAP = 12;

/** Side-by-side slot order when multiple rer-3d tool cards are open. */
export type Rer3dToolPanelId = "line-of-sight" | "viewshed-area";

export const RER3D_TOOL_PANEL_ORDER: Rer3dToolPanelId[] = ["line-of-sight", "viewshed-area"];

export type Rer3dToolPanelOpenSet = Record<Rer3dToolPanelId, boolean>;

export function openRer3dToolPanels(open: Rer3dToolPanelOpenSet): Rer3dToolPanelId[] {
  return RER3D_TOOL_PANEL_ORDER.filter((id) => open[id]);
}

/** Horizontal slot among currently open panels (0 = leftmost). */
export function computeRer3dToolPanelSlot(
  id: Rer3dToolPanelId,
  open: Rer3dToolPanelOpenSet,
): number {
  const panels = openRer3dToolPanels(open);
  const index = panels.indexOf(id);
  return Math.max(0, index);
}

export function positionForRer3dToolPanelSlot(
  slot: number,
  width = RER3D_TOOL_PANEL_WIDTH,
): { x: number; y: number } {
  return {
    x: EDGE_MARGIN + slot * (width + PANEL_GAP),
    y: EDGE_MARGIN,
  };
}

export function rer3dToolPanelPositionForOpenSet(
  id: Rer3dToolPanelId,
  open: Rer3dToolPanelOpenSet,
  width = RER3D_TOOL_PANEL_WIDTH,
): { x: number; y: number } {
  if (!open[id]) {
    return positionForRer3dToolPanelSlot(0, width);
  }
  return positionForRer3dToolPanelSlot(computeRer3dToolPanelSlot(id, open), width);
}
