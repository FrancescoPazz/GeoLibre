import {
  PLAY_SPEED_MAX,
  PLAY_SPEED_MIN,
  SAMPLING_STEP_DISABLED,
  SAMPLING_STEP_SERIES,
  closePlayPathPanel,
  getPlayPathSnapshot,
  pausePath,
  playPath,
  setPlayPathSamplingStep,
  setPlayPathSpeed,
  stopPath,
  subscribePlayPath,
  type PlayPathState,
} from "@geolibre/plugins";
import { Button, Slider } from "@geolibre/ui";
import { Pause, Play, Square, TriangleAlert } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingMapPanelPosition } from "../../hooks/useFloatingMapPanelPosition";
import { FLOATING_MAP_PANEL_ICON, FLOATING_MAP_PANEL_TEST_ID } from "./floating-map-panel-meta";
import { FloatingMapToolPanelShell } from "./FloatingMapToolPanelShell";

const PANEL_WIDTH = 300;

/**
 * Play Path panel (Controls → Play Path): fly the camera along the path
 * selected in the active layer. The plugin owns the flight; this renders its
 * published state and the controls.
 */
export function PlayPathPanel() {
  const state = useSyncExternalStore(subscribePlayPath, getPlayPathSnapshot, getPlayPathSnapshot);
  if (!state.open) return null;
  return <PlayPathCard state={state} />;
}

function PlayPathCard({ state }: { state: PlayPathState }) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useFloatingMapPanelPosition("play-path", PANEL_WIDTH, cardRef);
  const { Icon, className: iconClassName } = FLOATING_MAP_PANEL_ICON["play-path"];

  const {
    bound,
    available,
    routeLocked,
    playing,
    paused,
    countdown,
    currentIndex,
    pointCount,
    reverse,
    speed,
    samplingStepAuto,
    samplingStepM,
    samplingStepRange,
    pitchTooLow,
  } = state;
  const [min, max] = samplingStepRange;
  const steps = SAMPLING_STEP_SERIES.filter((step) => step >= min && step <= max);
  const active = playing || countdown !== null;
  const hint = !bound
    ? t("toolbar.playPath.unavailable")
    : !available
      ? t("toolbar.playPath.noPath")
      : countdown !== null
        ? t("toolbar.playPath.countdown", { seconds: countdown })
        : playing
          ? t("toolbar.playPath.flying", { current: currentIndex + 1, total: pointCount })
          : paused
            ? t("toolbar.playPath.paused", { current: currentIndex + 1, total: pointCount })
            : t("toolbar.playPath.ready");

  return (
    <FloatingMapToolPanelShell
      id="play-path"
      title={t("toolbar.playPath.title")}
      icon={Icon}
      iconClassName={iconClassName}
      width={PANEL_WIDTH}
      cardRef={cardRef}
      position={position}
      setPosition={setPosition}
      onClose={() => closePlayPathPanel()}
      closeAriaLabel={t("toolbar.playPath.close")}
      testId={FLOATING_MAP_PANEL_TEST_ID["play-path"]}
      headerActions={
        <>
          <Button
            variant={active ? "default" : "outline"}
            size="icon"
            className="ms-auto h-6 w-6"
            aria-label={active ? t("toolbar.playPath.pause") : t("toolbar.playPath.play")}
            title={active ? t("toolbar.playPath.pause") : t("toolbar.playPath.play")}
            disabled={!available}
            onClick={() => (active ? pausePath() : playPath())}
          >
            {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            aria-label={t("toolbar.playPath.stop")}
            title={t("toolbar.playPath.stop")}
            disabled={!active && !paused}
            onClick={() => stopPath()}
          >
            <Square className="h-3.5 w-3.5" />
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-3">
        <div
          className={
            !bound || !available
              ? "flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
              : "text-xs text-muted-foreground"
          }
          data-testid="play-path-hint"
        >
          {(!bound || !available) && <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span aria-live="polite">{hint}</span>
        </div>

        {available && (
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-violet-500 transition-[width]"
              style={{ width: `${pointCount > 1 ? (currentIndex / (pointCount - 1)) * 100 : 0}%` }}
            />
          </div>
        )}
        {available && reverse && (playing || paused) && (
          <div className="text-xs text-muted-foreground">{t("toolbar.playPath.reverse")}</div>
        )}

        {routeLocked && (
          <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("toolbar.playPath.routeLocked")}</span>
          </div>
        )}

        {bound && pitchTooLow && (
          <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("toolbar.playPath.pitchTooLow")}</span>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("toolbar.playPath.speed")}</span>
            <span className="tabular-nums">{speed.toFixed(2)}×</span>
          </div>
          <Slider
            min={PLAY_SPEED_MIN}
            max={PLAY_SPEED_MAX}
            step={0.25}
            value={[speed]}
            onValueChange={(value: number[]) => setPlayPathSpeed(value[0] ?? speed)}
            aria-label={t("toolbar.playPath.speed")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={samplingStepAuto}
              disabled={active}
              onChange={(event) =>
                setPlayPathSamplingStep(event.target.checked ? "auto" : samplingStepM || min)
              }
            />
            {t("toolbar.playPath.autoStep")}
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{t("toolbar.playPath.step")}</span>
            <select
              className="h-6 rounded border border-border bg-background px-1 text-xs"
              value={samplingStepM}
              disabled={samplingStepAuto || active || steps.length === 0}
              aria-label={t("toolbar.playPath.step")}
              onChange={(event) => setPlayPathSamplingStep(Number(event.target.value))}
            >
              <option value={SAMPLING_STEP_DISABLED}>{t("toolbar.playPath.verticesOnly")}</option>
              {steps.map((step) => (
                <option key={step} value={step}>
                  {step} m
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </FloatingMapToolPanelShell>
  );
}
