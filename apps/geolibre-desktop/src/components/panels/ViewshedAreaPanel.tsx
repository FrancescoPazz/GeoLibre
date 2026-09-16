import {
  VIEWSHED_AREA_HEIGHT_MAX,
  VIEWSHED_AREA_HEIGHT_MIN,
  VIEWSHED_AREA_RADIUS_MAX,
  VIEWSHED_AREA_RADIUS_MIN,
  clearViewshedArea,
  closeViewshedAreaPanel,
  getViewshedAreaSnapshot,
  setViewshedAreaSettings,
  subscribeViewshedArea,
  type LngLatAlt,
  type ViewshedAreaState,
} from "@geolibre/plugins";
import { Button, Input, Label, Slider } from "@geolibre/ui";
import { Eraser, Radar, TriangleAlert, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const PANEL_WIDTH = 300;
const EDGE_MARGIN = 12;

/**
 * Viewshed area panel (Controls → Viewshed area).
 *
 * The plugin owns the globe work — the observer click, the terrain grid,
 * the sweep and the draped tint — so this component renders its published
 * snapshot and writes the three settings back. Mounted outside the renderer
 * branch of the shell, like the Line of Sight panel it is the companion of,
 * so it survives a 2D/3D switch and can say when the globe is needed.
 */
export function ViewshedAreaPanel() {
  const state = useSyncExternalStore(
    subscribeViewshedArea,
    getViewshedAreaSnapshot,
    getViewshedAreaSnapshot,
  );
  if (!state.open) return null;
  return <ViewshedAreaCard state={state} />;
}

function formatPoint(point: LngLatAlt, locale: string): string {
  const deg = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 5 });
  return `${deg(point.lat)}, ${deg(point.lng)}`;
}

function ViewshedAreaCard({ state }: { state: ViewshedAreaState }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [position, setPosition] = useState(() => ({ x: EDGE_MARGIN, y: EDGE_MARGIN }));

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select,[role=slider]")) return;
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

  const { phase, settings, status, visibleFraction, cellSizeMeters, observer } = state;
  const hint =
    phase === "unavailable"
      ? t("toolbar.viewshedArea.unavailable")
      : phase === "observer"
        ? t("toolbar.viewshedArea.clickObserver")
        : t("toolbar.viewshedArea.moveObserver");
  const statusText =
    status === "computing"
      ? t("toolbar.viewshedArea.computing")
      : status === "no-terrain"
        ? t("toolbar.viewshedArea.noTerrain")
        : status === "failed"
          ? t("toolbar.viewshedArea.failed")
          : null;

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.viewshedArea.title")}
      data-testid="viewshed-area-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Radar className="h-4 w-4 text-emerald-500" />
        <span className="text-sm font-medium">{t("toolbar.viewshedArea.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.viewshedArea.clear")}
          title={t("toolbar.viewshedArea.clear")}
          disabled={!observer}
          onClick={() => clearViewshedArea()}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.viewshedArea.close")}
          onClick={() => closeViewshedAreaPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <div
          className={
            phase === "unavailable"
              ? "flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
          data-testid="viewshed-area-hint"
        >
          {phase === "unavailable" && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{hint}</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            id="viewshed-area-observer-height"
            label={t("toolbar.viewshedArea.observerHeight")}
            unit={t("toolbar.viewshedArea.meters")}
            value={settings.observerHeight}
            min={VIEWSHED_AREA_HEIGHT_MIN}
            max={VIEWSHED_AREA_HEIGHT_MAX}
            step={0.1}
            onChange={(observerHeight) => setViewshedAreaSettings({ observerHeight })}
          />
          <NumberField
            id="viewshed-area-radius"
            label={t("toolbar.viewshedArea.radius")}
            unit={t("toolbar.viewshedArea.meters")}
            value={settings.radiusMeters}
            min={VIEWSHED_AREA_RADIUS_MIN}
            max={VIEWSHED_AREA_RADIUS_MAX}
            step={100}
            onChange={(radiusMeters) => setViewshedAreaSettings({ radiusMeters })}
          />
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">{t("toolbar.viewshedArea.opacity")}</span>
          <Slider
            aria-label={t("toolbar.viewshedArea.opacity")}
            min={0.1}
            max={1}
            step={0.05}
            value={[settings.opacity]}
            onValueChange={([opacity]) => setViewshedAreaSettings({ opacity })}
            className="flex-1"
          />
          <span className="w-9 text-end tabular-nums">{Math.round(settings.opacity * 100)}%</span>
        </div>

        {statusText && (
          <div
            className={
              status === "computing"
                ? "text-xs text-muted-foreground"
                : "flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
            }
            data-testid="viewshed-area-status"
          >
            {status !== "computing" && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{statusText}</span>
          </div>
        )}

        {(observer || visibleFraction !== null) && (
          <div className="space-y-1 text-xs" data-testid="viewshed-area-result">
            {visibleFraction !== null && (
              <Row
                label={t("toolbar.viewshedArea.visibleShare")}
                value={`${(visibleFraction * 100).toLocaleString(locale, { maximumFractionDigits: 0 })}%`}
              />
            )}
            {cellSizeMeters !== null && (
              <Row
                label={t("toolbar.viewshedArea.cellSize")}
                value={`${cellSizeMeters.toLocaleString(locale, { maximumFractionDigits: 1 })} m`}
              />
            )}
            {observer && (
              <Row
                label={t("toolbar.viewshedArea.observer")}
                value={formatPoint(observer, locale)}
              />
            )}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">{t("toolbar.viewshedArea.caveat")}</p>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function NumberField({
  id,
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label} ({unit})
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        className="h-7 text-xs"
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
}
