import {
  getElevationBandsSnapshot,
  getLineOfSightSnapshot,
  getMeasure3dSnapshot,
  getPlayPathSnapshot,
  getViewshedAreaSnapshot,
  subscribeElevationBands,
  subscribeLineOfSight,
  subscribeMeasure3d,
  subscribePlayPath,
  subscribeViewshedArea,
} from "@geolibre/plugins";
import { useLayoutEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useOptionalFloatingMapPanelLayoutContext } from "../components/panels/FloatingMapPanelLayoutContext";
import {
  isCoordsConverterPanelVisible,
  subscribeCoordsConverterPanel,
} from "../lib/coords-converter-panel";
import {
  isMicrozonationPanelVisible,
  subscribeMicrozonationPanel,
} from "../lib/microzonation-panel";
import {
  FLOATING_MAP_PANEL_WIDTHS,
  UNBOUNDED_FLOATING_MAP_LAYOUT,
  floatingMapPanelWidths,
  openFloatingMapPanels,
  positionForOpenFloatingMapPanel,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "./floating-map-panel-layout";

export {
  FLOATING_MAP_PANEL_ORDER,
  FLOATING_MAP_PANEL_WIDTHS,
  UNBOUNDED_FLOATING_MAP_LAYOUT,
  layoutFloatingMapPanels,
  openFloatingMapPanels,
  panelFitsInBounds,
  positionForOpenFloatingMapPanel,
  floatingMapPanelWidths,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
  type FloatingMapLayoutBounds,
} from "./floating-map-panel-layout";

function snapshotOpenSet(): FloatingMapPanelOpenSet {
  return {
    measure3d: getMeasure3dSnapshot().open,
    "play-path": getPlayPathSnapshot().open,
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
    "elevation-bands": getElevationBandsSnapshot().open,
    "coords-converter": isCoordsConverterPanelVisible(),
    microzonation: isMicrozonationPanelVisible(),
  };
}

export function subscribeAllFloatingMapPanels(listener: () => void): () => void {
  const offs = [
    subscribeMeasure3d(listener),
    subscribePlayPath(listener),
    subscribeLineOfSight(listener),
    subscribeViewshedArea(listener),
    subscribeElevationBands(listener),
    subscribeCoordsConverterPanel(listener),
    subscribeMicrozonationPanel(listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}

function getOpenPanelsKey(): string {
  return openFloatingMapPanels(snapshotOpenSet()).join(",");
}

function fallbackPosition(id: FloatingMapPanelId, width?: number): { x: number; y: number } {
  const sizes = width !== undefined ? { widths: { [id]: width } } : {};
  return positionForOpenFloatingMapPanel(
    id,
    snapshotOpenSet(),
    UNBOUNDED_FLOATING_MAP_LAYOUT,
    sizes,
  );
}

/**
 * Floating position for a map tool card; re-slots when siblings open/close or
 * the map overlay is resized (wraps to new rows when needed).
 */
export function useFloatingMapPanelPosition(
  id: FloatingMapPanelId,
  width?: number,
  cardRef?: RefObject<HTMLElement | null>,
): [{ x: number; y: number }, (next: { x: number; y: number }) => void] {
  const layout = useOptionalFloatingMapPanelLayoutContext();
  const openKey = useSyncExternalStore(
    subscribeAllFloatingMapPanels,
    getOpenPanelsKey,
    getOpenPanelsKey,
  );

  const layoutVersion = layout?.layoutVersion ?? openKey;

  const [position, setPosition] = useState(() =>
    layout ? layout.getPosition(id) : fallbackPosition(id, width),
  );

  useLayoutEffect(() => {
    if (layout) {
      setPosition(layout.getPosition(id));
    } else {
      setPosition(fallbackPosition(id, width));
    }
  }, [layout, layoutVersion, id, width]);

  useLayoutEffect(() => {
    const el = cardRef?.current;
    if (!el || !layout) return;
    const report = () => layout.reportPanelHeight(id, el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [cardRef, id, layout, layoutVersion]);

  return [position, setPosition];
}

/** @deprecated Use {@link useFloatingMapPanelPosition} */
export function useRer3dToolPanelPosition(
  id: "line-of-sight" | "viewshed-area",
  width = FLOATING_MAP_PANEL_WIDTHS[id],
): [{ x: number; y: number }, (next: { x: number; y: number }) => void] {
  return useFloatingMapPanelPosition(id, width);
}
