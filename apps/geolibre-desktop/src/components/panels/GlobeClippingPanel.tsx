import {
  closeGlobeClippingPanel,
  getGlobeClippingSnapshot,
  setGlobeClippingLayer,
  subscribeGlobeClipping,
  type GlobeClippingState,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { Eraser, Scissors, TriangleAlert } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingMapPanelPosition } from "../../hooks/useFloatingMapPanelPosition";
import { FLOATING_MAP_PANEL_ICON, FLOATING_MAP_PANEL_TEST_ID } from "./floating-map-panel-meta";
import { FloatingMapToolPanelShell } from "./FloatingMapToolPanelShell";

const PANEL_WIDTH = 300;

/**
 * Globe clipping panel (Controls → Globe clipping): cut a hole in the
 * terrain around a 3D Tiles or GeoJSON layer so what lies beneath the
 * surface can be seen. The plugin owns the clipping planes; this renders
 * its published state and the layer choice.
 */
export function GlobeClippingPanel() {
  const state = useSyncExternalStore(
    subscribeGlobeClipping,
    getGlobeClippingSnapshot,
    getGlobeClippingSnapshot,
  );
  if (!state.open) return null;
  return <GlobeClippingCard state={state} />;
}

function GlobeClippingCard({ state }: { state: GlobeClippingState }) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useFloatingMapPanelPosition(
    "globe-clipping",
    PANEL_WIDTH,
    cardRef,
  );
  const { Icon, className: iconClassName } = FLOATING_MAP_PANEL_ICON["globe-clipping"];

  const { bound, layers, activeLayerId, pending, halfWidthMeters } = state;
  const warning = !bound
    ? t("toolbar.globeClipping.unavailable")
    : layers.length === 0
      ? t("toolbar.globeClipping.noLayers")
      : null;
  const status = !activeLayerId
    ? t("toolbar.globeClipping.pickLayer")
    : pending
      ? t("toolbar.globeClipping.waiting")
      : t("toolbar.globeClipping.cut", { size: Math.round((halfWidthMeters ?? 0) * 2) });

  return (
    <FloatingMapToolPanelShell
      id="globe-clipping"
      title={t("toolbar.globeClipping.title")}
      icon={Icon}
      iconClassName={iconClassName}
      width={PANEL_WIDTH}
      cardRef={cardRef}
      position={position}
      setPosition={setPosition}
      onClose={() => closeGlobeClippingPanel()}
      closeAriaLabel={t("toolbar.globeClipping.close")}
      testId={FLOATING_MAP_PANEL_TEST_ID["globe-clipping"]}
      headerActions={
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.globeClipping.clear")}
          title={t("toolbar.globeClipping.clear")}
          disabled={!activeLayerId}
          onClick={() => setGlobeClippingLayer(null)}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        {warning ? (
          <div
            className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
            data-testid="globe-clipping-hint"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span aria-live="polite">{warning}</span>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground" data-testid="globe-clipping-hint">
            <span aria-live="polite">{status}</span>
          </div>
        )}

        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("toolbar.globeClipping.layer")}</span>
          <select
            className="h-7 rounded border border-border bg-background px-1 text-xs"
            value={activeLayerId ?? ""}
            disabled={layers.length === 0}
            aria-label={t("toolbar.globeClipping.layer")}
            onChange={(event) => setGlobeClippingLayer(event.target.value || null)}
          >
            <option value="">{t("toolbar.globeClipping.none")}</option>
            {layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
        </label>

        <p className="text-xs text-muted-foreground">{t("toolbar.globeClipping.help")}</p>
      </div>
    </FloatingMapToolPanelShell>
  );
}
