import {
  closeGlobeClippingPanel,
  getGlobeClippingSnapshot,
  setGlobeClippingLayer,
  subscribeGlobeClipping,
  type GlobeClippingState,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { Eraser, Scissors, TriangleAlert, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const PANEL_WIDTH = 300;
const EDGE_MARGIN = 12;

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
  const [position, setPosition] = useState(() => ({ x: EDGE_MARGIN, y: EDGE_MARGIN }));

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select,label")) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const card = handle.parentElement;
      const bounds = card?.parentElement?.getBoundingClientRect();
      const cardHeight = card?.getBoundingClientRect().height ?? 80;
      const maxX = Math.max(
        EDGE_MARGIN,
        (bounds?.width ?? window.innerWidth) - PANEL_WIDTH - EDGE_MARGIN,
      );
      const maxY = Math.max(
        EDGE_MARGIN,
        (bounds?.height ?? window.innerHeight) - cardHeight - EDGE_MARGIN,
      );
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), EDGE_MARGIN, maxX),
        y: clamp(origin.y + (move.clientY - startY), EDGE_MARGIN, maxY),
      });
    };
    const handleUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleUp);
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

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
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.globeClipping.title")}
      data-testid="globe-clipping-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Scissors className="h-4 w-4 text-orange-500" />
        <span className="text-sm font-medium">{t("toolbar.globeClipping.title")}</span>
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
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.globeClipping.close")}
          onClick={() => closeGlobeClippingPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

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
    </div>
  );
}
