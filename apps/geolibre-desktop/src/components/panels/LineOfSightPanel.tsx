import {
  LINE_OF_SIGHT_HEIGHT_MAX,
  LINE_OF_SIGHT_HEIGHT_MIN,
  armLineOfSightNewLine,
  armLineOfSightObserverPlacement,
  armLineOfSightTargetPlacement,
  cancelLineOfSightPlacement,
  clearLineOfSight,
  closeLineOfSightPanel,
  getLineOfSightSnapshot,
  setLineOfSightSettings,
  subscribeLineOfSight,
  type LineOfSightState,
  type LngLatAlt,
} from "@geolibre/plugins";
import { Button, Input, Label } from "@geolibre/ui";
import { Check, Eraser, TriangleAlert } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingMapPanelPosition } from "../../hooks/useFloatingMapPanelPosition";
import { FLOATING_MAP_PANEL_ICON, FLOATING_MAP_PANEL_TEST_ID } from "./floating-map-panel-meta";
import { FloatingMapToolPanelShell } from "./FloatingMapToolPanelShell";

const PANEL_WIDTH = 300;

/**
 * Line of sight panel (Controls → Line of Sight).
 *
 * The plugin owns the globe work — picking, the sight-line entities, the
 * terrain test — so this component only renders its published snapshot and
 * writes the two heights back. It is mounted outside the renderer branch of
 * the shell, so it stays open across a 2D/3D switch and is where the user
 * learns that the tool needs the globe.
 */
export function LineOfSightPanel() {
  const state = useSyncExternalStore(
    subscribeLineOfSight,
    getLineOfSightSnapshot,
    getLineOfSightSnapshot,
  );
  if (!state.open) return null;
  return <LineOfSightCard state={state} />;
}

function formatMeters(meters: number, locale: string): string {
  if (meters >= 1000) {
    return `${(meters / 1000).toLocaleString(locale, { maximumFractionDigits: 2 })} km`;
  }
  return `${meters.toLocaleString(locale, { maximumFractionDigits: 1 })} m`;
}

function formatPoint(point: LngLatAlt, locale: string): string {
  const deg = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 5 });
  const alt = point.alt.toLocaleString(locale, { maximumFractionDigits: 0 });
  return `${deg(point.lat)}, ${deg(point.lng)} · ${alt} m`;
}

function LineOfSightCard({ state }: { state: LineOfSightState }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useFloatingMapPanelPosition(
    "line-of-sight",
    PANEL_WIDTH,
    cardRef,
  );
  const { Icon, className: iconClassName } = FLOATING_MAP_PANEL_ICON["line-of-sight"];

  const { phase, result, settings, placementActive, placementIntent } = state;
  const hint =
    phase === "unavailable"
      ? t("toolbar.lineOfSight.unavailable")
      : placementActive && placementIntent === "observer"
        ? t("toolbar.lineOfSight.clickObserver")
        : placementActive && placementIntent === "target"
          ? t("toolbar.lineOfSight.clickTarget")
          : phase === "observer"
            ? t("toolbar.lineOfSight.chooseObserver")
            : phase === "target"
              ? t("toolbar.lineOfSight.chooseTarget")
              : t("toolbar.lineOfSight.chooseNewLine");
  const showPlacementControls = phase !== "unavailable";

  return (
    <FloatingMapToolPanelShell
      id="line-of-sight"
      title={t("toolbar.lineOfSight.title")}
      icon={Icon}
      iconClassName={iconClassName}
      width={PANEL_WIDTH}
      cardRef={cardRef}
      position={position}
      setPosition={setPosition}
      onClose={() => closeLineOfSightPanel()}
      closeAriaLabel={t("toolbar.lineOfSight.close")}
      testId={FLOATING_MAP_PANEL_TEST_ID["line-of-sight"]}
      onMinimizedChange={(minimized) => {
        if (minimized) cancelLineOfSightPlacement();
      }}
      headerActions={
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.lineOfSight.clear")}
          title={t("toolbar.lineOfSight.clear")}
          disabled={!state.observer}
          onClick={() => clearLineOfSight()}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        <div
          className={
            phase === "unavailable"
              ? "flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
          data-testid="line-of-sight-hint"
        >
          {phase === "unavailable" && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span>{hint}</span>
        </div>

        {showPlacementControls && (
          <div className="flex flex-wrap gap-1.5" data-testid="line-of-sight-placement">
            <Button
              type="button"
              variant={placementActive && placementIntent === "observer" ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => armLineOfSightObserverPlacement()}
            >
              {t("toolbar.lineOfSight.placeObserver")}
            </Button>
            <Button
              type="button"
              variant={placementActive && placementIntent === "target" ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs"
              disabled={!state.observer}
              onClick={() => armLineOfSightTargetPlacement()}
            >
              {t("toolbar.lineOfSight.placeTarget")}
            </Button>
            {phase === "done" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => armLineOfSightNewLine()}
              >
                {t("toolbar.lineOfSight.startNewLine")}
              </Button>
            )}
            {placementActive && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => cancelLineOfSightPlacement()}
              >
                {t("toolbar.lineOfSight.cancelPlacement")}
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <HeightField
            id="line-of-sight-observer-height"
            label={t("toolbar.lineOfSight.observerHeight")}
            value={settings.observerHeight}
            onChange={(observerHeight) => setLineOfSightSettings({ observerHeight })}
            unit={t("toolbar.lineOfSight.meters")}
          />
          <HeightField
            id="line-of-sight-target-height"
            label={t("toolbar.lineOfSight.targetHeight")}
            value={settings.targetHeight}
            onChange={(targetHeight) => setLineOfSightSettings({ targetHeight })}
            unit={t("toolbar.lineOfSight.meters")}
          />
        </div>

        {result && (
          <div className="space-y-2" data-testid="line-of-sight-result">
            <div
              className={
                result.occluded
                  ? "flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-600 dark:text-red-400"
                  : "flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
              }
            >
              {result.occluded ? (
                <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <Check className="h-3.5 w-3.5 shrink-0" />
              )}
              {result.occluded
                ? t("toolbar.lineOfSight.occluded")
                : t("toolbar.lineOfSight.visible")}
            </div>
            <Row
              label={t("toolbar.lineOfSight.totalDistance")}
              value={formatMeters(result.totalMeters, locale)}
            />
            {result.occluded && (
              <Row
                label={t("toolbar.lineOfSight.visibleDistance")}
                value={formatMeters(result.visibleMeters, locale)}
              />
            )}
          </div>
        )}

        {(state.observer || state.target) && (
          <div className="space-y-1 text-xs text-muted-foreground">
            {state.observer && (
              <Row
                label={t("toolbar.lineOfSight.observer")}
                value={formatPoint(state.observer, locale)}
              />
            )}
            {state.target && (
              <Row
                label={t("toolbar.lineOfSight.target")}
                value={formatPoint(state.target, locale)}
              />
            )}
            {result?.hit && (
              <Row label={t("toolbar.lineOfSight.hitAt")} value={formatPoint(result.hit, locale)} />
            )}
          </div>
        )}
      </div>
    </FloatingMapToolPanelShell>
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

function HeightField({
  id,
  label,
  value,
  unit,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  unit: string;
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
        min={LINE_OF_SIGHT_HEIGHT_MIN}
        max={LINE_OF_SIGHT_HEIGHT_MAX}
        step={0.1}
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
