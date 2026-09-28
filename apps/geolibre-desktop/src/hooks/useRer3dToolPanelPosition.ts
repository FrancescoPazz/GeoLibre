import {
  getLineOfSightSnapshot,
  getViewshedAreaSnapshot,
  subscribeLineOfSight,
  subscribeViewshedArea,
} from "@geolibre/plugins";
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import {
  RER3D_TOOL_PANEL_WIDTH,
  computeRer3dToolPanelSlot,
  openRer3dToolPanels,
  positionForRer3dToolPanelSlot,
  type Rer3dToolPanelId,
  type Rer3dToolPanelOpenSet,
} from "./rer3d-tool-panel-layout";

export {
  RER3D_TOOL_PANEL_ORDER,
  RER3D_TOOL_PANEL_WIDTH,
  computeRer3dToolPanelSlot,
  openRer3dToolPanels,
  positionForRer3dToolPanelSlot,
  rer3dToolPanelPositionForOpenSet,
  type Rer3dToolPanelId,
  type Rer3dToolPanelOpenSet,
} from "./rer3d-tool-panel-layout";

function openPanelsFromSnapshots(): Rer3dToolPanelId[] {
  return openRer3dToolPanels({
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
  });
}

function subscribeBoth(listener: () => void): () => void {
  const offLoS = subscribeLineOfSight(listener);
  const offVs = subscribeViewshedArea(listener);
  return () => {
    offLoS();
    offVs();
  };
}

function getOpenPanelsKey(): string {
  return openPanelsFromSnapshots().join(",");
}

function snapshotOpenSet(): Rer3dToolPanelOpenSet {
  return {
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
  };
}

/**
 * Floating position for a rer-3d tool card; re-slots horizontally when a sibling
 * panel opens or closes so cards do not stack on the same corner.
 */
export function useRer3dToolPanelPosition(
  id: Rer3dToolPanelId,
  width = RER3D_TOOL_PANEL_WIDTH,
): [{ x: number; y: number }, (next: { x: number; y: number }) => void] {
  useSyncExternalStore(subscribeBoth, getOpenPanelsKey, getOpenPanelsKey);

  const open = snapshotOpenSet();
  const slot = computeRer3dToolPanelSlot(id, open);

  const [position, setPosition] = useState(() => positionForRer3dToolPanelSlot(slot, width));

  useLayoutEffect(() => {
    setPosition(positionForRer3dToolPanelSlot(slot, width));
  }, [slot, width]);

  return [position, setPosition];
}
