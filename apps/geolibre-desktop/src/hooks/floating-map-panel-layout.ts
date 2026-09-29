export const FLOATING_MAP_PANEL_EDGE_MARGIN = 12;
const PANEL_GAP = 12;
export const FLOATING_MAP_ROW_GAP = 12;

/** Matches maplibre-gl-components control grid collapsed control size. */
export const FLOATING_MAP_PANEL_ICON_SIZE = 29;
/** Matches `.maplibre-gl-control-grid-content > * { margin: 4px }` spacing. */
export const FLOATING_MAP_PANEL_ICON_GAP = 4;

/** Map floating tool cards laid out left-to-right when multiple are open. */
export type FloatingMapPanelId =
  | "measure3d"
  | "play-path"
  | "line-of-sight"
  | "viewshed-area"
  | "globe-clipping"
  | "elevation-bands"
  | "coords-converter"
  | "microzonation";

export const FLOATING_MAP_PANEL_ORDER: FloatingMapPanelId[] = [
  "measure3d",
  "play-path",
  "line-of-sight",
  "viewshed-area",
  "globe-clipping",
  "elevation-bands",
  "coords-converter",
  "microzonation",
];

export const FLOATING_MAP_PANEL_WIDTHS: Record<FloatingMapPanelId, number> = {
  measure3d: 320,
  "play-path": 300,
  "line-of-sight": 300,
  "viewshed-area": 300,
  "globe-clipping": 300,
  "elevation-bands": 340,
  "coords-converter": 360,
  microzonation: 460,
};

export const FLOATING_MAP_PANEL_ESTIMATED_HEIGHTS: Record<FloatingMapPanelId, number> = {
  measure3d: 400,
  "play-path": 280,
  "line-of-sight": 320,
  "viewshed-area": 360,
  "globe-clipping": 260,
  "elevation-bands": 380,
  "coords-converter": 340,
  microzonation: 420,
};

export type FloatingMapPanelOpenSet = Record<FloatingMapPanelId, boolean>;

export type FloatingMapPanelMinimizedSet = Partial<Record<FloatingMapPanelId, boolean>>;

/** Open panels that are not minimized to the icon dock. */
export function expandedFloatingMapPanelOpenSet(
  open: FloatingMapPanelOpenSet,
  minimized: FloatingMapPanelMinimizedSet = {},
): FloatingMapPanelOpenSet {
  const expanded = { ...open };
  for (const id of FLOATING_MAP_PANEL_ORDER) {
    if (minimized[id]) expanded[id] = false;
  }
  return expanded;
}

export function minimizedFloatingMapPanels(
  open: FloatingMapPanelOpenSet,
  minimized: FloatingMapPanelMinimizedSet = {},
): FloatingMapPanelId[] {
  return FLOATING_MAP_PANEL_ORDER.filter((id) => open[id] && minimized[id]);
}

export type FloatingMapLayoutBounds = { width: number; height: number };

export type FloatingMapLayoutSizes = {
  widths?: Partial<Record<FloatingMapPanelId, number>>;
  heights?: Partial<Record<FloatingMapPanelId, number>>;
};

export const UNBOUNDED_FLOATING_MAP_LAYOUT: FloatingMapLayoutBounds = {
  width: 10_000,
  height: 10_000,
};

export function openFloatingMapPanels(open: FloatingMapPanelOpenSet): FloatingMapPanelId[] {
  return FLOATING_MAP_PANEL_ORDER.filter((id) => open[id]);
}

export function floatingMapPanelWidths(
  override?: Partial<Record<FloatingMapPanelId, number>>,
): Record<FloatingMapPanelId, number> {
  return { ...FLOATING_MAP_PANEL_WIDTHS, ...override };
}

export function floatingMapPanelHeights(
  override?: Partial<Record<FloatingMapPanelId, number>>,
): Record<FloatingMapPanelId, number> {
  return { ...FLOATING_MAP_PANEL_ESTIMATED_HEIGHTS, ...override };
}

export function panelFitsInBounds(
  x: number,
  y: number,
  width: number,
  height: number,
  bounds: FloatingMapLayoutBounds,
): boolean {
  const margin = FLOATING_MAP_PANEL_EDGE_MARGIN;
  return (
    x >= margin &&
    y >= margin &&
    x + width <= bounds.width - margin &&
    y + height <= bounds.height - margin
  );
}

function clampPanelPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  bounds: FloatingMapLayoutBounds,
): { x: number; y: number } {
  const margin = FLOATING_MAP_PANEL_EDGE_MARGIN;
  const maxX = Math.max(margin, bounds.width - width - margin);
  const maxY = Math.max(margin, bounds.height - height - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

/** Row-major layout with wrap and clamp so panels stay inside the map overlay. */
export function layoutFloatingMapPanels(
  open: FloatingMapPanelOpenSet,
  bounds: FloatingMapLayoutBounds,
  sizes: FloatingMapLayoutSizes = {},
  minimized: FloatingMapPanelMinimizedSet = {},
): Partial<Record<FloatingMapPanelId, { x: number; y: number }>> {
  open = expandedFloatingMapPanelOpenSet(open, minimized);
  const widths = floatingMapPanelWidths(sizes.widths);
  const heights = floatingMapPanelHeights(sizes.heights);
  const positions: Partial<Record<FloatingMapPanelId, { x: number; y: number }>> = {};

  let x = FLOATING_MAP_PANEL_EDGE_MARGIN;
  let y = FLOATING_MAP_PANEL_EDGE_MARGIN;
  let rowMaxHeight = 0;

  for (const panelId of FLOATING_MAP_PANEL_ORDER) {
    if (!open[panelId]) continue;
    const w = widths[panelId];
    const h = heights[panelId];
    if (
      x > FLOATING_MAP_PANEL_EDGE_MARGIN &&
      x + w + FLOATING_MAP_PANEL_EDGE_MARGIN > bounds.width
    ) {
      y += rowMaxHeight + FLOATING_MAP_ROW_GAP;
      x = FLOATING_MAP_PANEL_EDGE_MARGIN;
      rowMaxHeight = 0;
    }
    const raw = { x, y };
    positions[panelId] = clampPanelPosition(raw.x, raw.y, w, h, bounds);
    x += w + PANEL_GAP;
    rowMaxHeight = Math.max(rowMaxHeight, h);
  }

  return positions;
}

/** Position for one panel (uses shared row-major layout). */
/**
 * Bottom-end vertical stack for minimized tool panel icons (avoids bottom-left
 * scale/collab/bounds badges and top-left ControlGrid).
 */
export function layoutFloatingMapPanelMinimizedIcons(
  open: FloatingMapPanelOpenSet,
  bounds: FloatingMapLayoutBounds,
  minimized: FloatingMapPanelMinimizedSet = {},
): Partial<Record<FloatingMapPanelId, { x: number; y: number }>> {
  const ids = minimizedFloatingMapPanels(open, minimized);
  const positions: Partial<Record<FloatingMapPanelId, { x: number; y: number }>> = {};
  const margin = FLOATING_MAP_PANEL_EDGE_MARGIN;
  const size = FLOATING_MAP_PANEL_ICON_SIZE;
  const gap = FLOATING_MAP_PANEL_ICON_GAP;
  const x = Math.max(margin, bounds.width - margin - size);
  let y = bounds.height - margin - size;
  for (const id of ids) {
    positions[id] = { x, y: Math.max(margin, y) };
    y -= size + gap;
  }
  return positions;
}

export function positionForOpenFloatingMapPanel(
  id: FloatingMapPanelId,
  open: FloatingMapPanelOpenSet,
  bounds: FloatingMapLayoutBounds = UNBOUNDED_FLOATING_MAP_LAYOUT,
  sizes: FloatingMapLayoutSizes = {},
  minimized: FloatingMapPanelMinimizedSet = {},
): { x: number; y: number } {
  const positions = layoutFloatingMapPanels(open, bounds, sizes, minimized);
  return (
    positions[id] ?? {
      x: FLOATING_MAP_PANEL_EDGE_MARGIN,
      y: FLOATING_MAP_PANEL_EDGE_MARGIN,
    }
  );
}

/** @deprecated Use {@link FloatingMapPanelId} */
export type Rer3dToolPanelId = "line-of-sight" | "viewshed-area";
