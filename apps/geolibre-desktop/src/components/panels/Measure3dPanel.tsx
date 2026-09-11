import {
  DRAW_MODES,
  clearMeasure3d,
  closeMeasure3dPanel,
  formatDegrees,
  formatMeters,
  formatSquareMeters,
  getMeasure3dSnapshot,
  setMeasure3dMode,
  setMeasure3dOptions,
  subscribeMeasure3d,
  type DrawMode,
  type Measure3dState,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import {
  Circle,
  Eraser,
  MapPin,
  Pentagon,
  Ruler,
  Spline,
  TriangleAlert,
  TriangleRight,
  X,
  type LucideIcon,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const PANEL_WIDTH = 300;
const EDGE_MARGIN = 12;

const MODE_ICON: Record<DrawMode, LucideIcon> = {
  line: Spline,
  polygon: Pentagon,
  point: MapPin,
  angle: TriangleRight,
  circle: Circle,
};

/**
 * 3D measure panel (Controls → 3D Measure).
 *
 * The plugin's drawing engine owns the globe work; this component picks the
 * mode, toggles the two options, clears, and renders the published measures.
 * Mounted outside the renderer branch of the shell so it survives a 2D/3D
 * switch and can say when the globe is needed.
 */
export function Measure3dPanel() {
  const state = useSyncExternalStore(
    subscribeMeasure3d,
    getMeasure3dSnapshot,
    getMeasure3dSnapshot,
  );
  if (!state.open) return null;
  return <Measure3dCard state={state} />;
}

function Measure3dCard({ state }: { state: Measure3dState }) {
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

  const { mode, options, geometry, measures, bound } = state;
  const hasFigure = geometry.points.length > 0;
  const hint = !bound
    ? t("toolbar.measure3d.unavailable")
    : hasFigure
      ? t(`toolbar.measure3d.hint.${mode}Next` as const)
      : t(`toolbar.measure3d.hint.${mode}` as const);

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.measure3d.title")}
      data-testid="measure-3d-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Ruler className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.measure3d.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.measure3d.clear")}
          title={t("toolbar.measure3d.clear")}
          disabled={!hasFigure}
          onClick={() => clearMeasure3d()}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.measure3d.close")}
          onClick={() => closeMeasure3dPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <div
          className="grid grid-cols-5 gap-1"
          role="radiogroup"
          aria-label={t("toolbar.measure3d.mode")}
        >
          {DRAW_MODES.map((m) => {
            const Icon = MODE_ICON[m];
            const label = t(`toolbar.measure3d.modes.${m}` as const);
            return (
              <Button
                key={m}
                variant={m === mode ? "default" : "outline"}
                size="icon"
                className="h-8 w-full"
                role="radio"
                aria-checked={m === mode}
                aria-label={label}
                title={label}
                onClick={() => setMeasure3dMode(m)}
              >
                <Icon className="h-4 w-4" />
              </Button>
            );
          })}
        </div>

        <div
          className={
            !bound
              ? "flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
          data-testid="measure-3d-hint"
        >
          {!bound && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{hint}</span>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={options.clampToGround}
              onChange={(event) => setMeasure3dOptions({ clampToGround: event.target.checked })}
            />
            {t("toolbar.measure3d.clampToGround")}
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={options.showLabels}
              onChange={(event) => setMeasure3dOptions({ showLabels: event.target.checked })}
            />
            {t("toolbar.measure3d.showLabels")}
          </label>
        </div>

        {hasFigure && (
          <div className="space-y-1" data-testid="measure-3d-result">
            <Row label={t("toolbar.measure3d.vertices")} value={String(geometry.points.length)} />
            {mode === "circle" && measures.circleRadiusMeters !== null && (
              <>
                <Row
                  label={t("toolbar.measure3d.radius")}
                  value={formatMeters(measures.circleRadiusMeters)}
                />
                <Row
                  label={t("toolbar.measure3d.perimeter")}
                  value={formatMeters(measures.circlePerimeterMeters ?? 0)}
                />
                <Row
                  label={t("toolbar.measure3d.area")}
                  value={formatSquareMeters(measures.circleAreaSqm ?? 0)}
                />
              </>
            )}
            {mode === "angle" && measures.angleDeg !== null && (
              <Row label={t("toolbar.measure3d.angle")} value={formatDegrees(measures.angleDeg)} />
            )}
            {(mode === "line" || mode === "polygon" || mode === "angle") &&
              measures.segmentMeters.length > 0 && (
                <Row
                  label={
                    mode === "polygon" && geometry.closed
                      ? t("toolbar.measure3d.perimeter")
                      : t("toolbar.measure3d.length")
                  }
                  value={formatMeters(measures.totalMeters)}
                />
              )}
            {mode === "polygon" && measures.areaSqm !== null && (
              <Row
                label={t("toolbar.measure3d.area")}
                value={formatSquareMeters(measures.areaSqm)}
              />
            )}
            {(mode === "line" || mode === "polygon") && measures.segmentMeters.length > 1 && (
              <div className="pt-1 text-xs text-muted-foreground">
                {t("toolbar.measure3d.segments")}:{" "}
                <span className="tabular-nums text-foreground">
                  {measures.segmentMeters.map((m) => formatMeters(m)).join(" · ")}
                </span>
              </div>
            )}
          </div>
        )}
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
