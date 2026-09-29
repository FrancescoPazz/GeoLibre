import {
  getElevationBandsSnapshot,
  getGlobeClippingSnapshot,
  getLineOfSightSnapshot,
  getMeasure3dSnapshot,
  getPlayPathSnapshot,
  getViewshedAreaSnapshot,
  subscribeElevationBands,
  subscribeGlobeClipping,
  subscribeLineOfSight,
  subscribeMeasure3d,
  subscribePlayPath,
  subscribeViewshedArea,
} from "@geolibre/plugins";
import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  layoutFloatingMapPanelMinimizedIcons,
  minimizedFloatingMapPanels,
  openFloatingMapPanels,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "../../hooks/floating-map-panel-layout";
import {
  isCoordsConverterPanelVisible,
  subscribeCoordsConverterPanel,
} from "../../lib/coords-converter-panel";
import {
  isMicrozonationPanelVisible,
  subscribeMicrozonationPanel,
} from "../../lib/microzonation-panel";
import { FLOATING_MAP_PANEL_ICON, FLOATING_MAP_PANEL_TITLE_KEY } from "./floating-map-panel-meta";
import { useFloatingMapPanelLayoutContext } from "./FloatingMapPanelLayoutContext";

function snapshotOpenSet(): FloatingMapPanelOpenSet {
  return {
    measure3d: getMeasure3dSnapshot().open,
    "play-path": getPlayPathSnapshot().open,
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
    "globe-clipping": getGlobeClippingSnapshot().open,
    "elevation-bands": getElevationBandsSnapshot().open,
    "coords-converter": isCoordsConverterPanelVisible(),
    microzonation: isMicrozonationPanelVisible(),
  };
}

function subscribeAllFloatingMapPanels(listener: () => void): () => void {
  const offs = [
    subscribeMeasure3d(listener),
    subscribePlayPath(listener),
    subscribeLineOfSight(listener),
    subscribeViewshedArea(listener),
    subscribeGlobeClipping(listener),
    subscribeElevationBands(listener),
    subscribeCoordsConverterPanel(listener),
    subscribeMicrozonationPanel(listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Fixed bottom-end stack for minimized floating tool panels. Bottom-right avoids
 * the bottom-left scale, bounds badge, and collaboration pill; top-left is the
 * Components ControlGrid (colorbar and siblings).
 */
export function FloatingMapPanelMinimizedDock() {
  const { t } = useTranslation();
  const { bounds, minimized, setMinimized, layoutVersion } = useFloatingMapPanelLayoutContext();

  const openKey = useSyncExternalStore(
    subscribeAllFloatingMapPanels,
    () => openFloatingMapPanels(snapshotOpenSet()).join(","),
    () => openFloatingMapPanels(snapshotOpenSet()).join(","),
  );

  const open = snapshotOpenSet();
  const ids = useMemo(
    () => minimizedFloatingMapPanels(open, minimized),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutVersion tracks minimized + bounds
    [openKey, layoutVersion],
  );

  const positions = useMemo(
    () => layoutFloatingMapPanelMinimizedIcons(open, bounds, minimized),
    [openKey, bounds, minimized, layoutVersion],
  );

  if (ids.length === 0) return null;

  return (
    <>
      {ids.map((id) => {
        const pos = positions[id];
        if (!pos) return null;
        const { Icon, className } = FLOATING_MAP_PANEL_ICON[id];
        const panelTitle = t(FLOATING_MAP_PANEL_TITLE_KEY[id] as never);
        return (
          <button
            key={id}
            type="button"
            className="geolibre-floating-map-panel-icon pointer-events-auto absolute z-30"
            style={{ left: pos.x, top: pos.y }}
            aria-label={t("toolbar.mapToolPanel.restoreNamed", { title: panelTitle })}
            title={t("toolbar.mapToolPanel.restoreNamed", { title: panelTitle })}
            data-testid={`${id}-panel-icon`}
            onClick={() => setMinimized(id, false)}
          >
            <Icon className={className} aria-hidden />
          </button>
        );
      })}
    </>
  );
}
