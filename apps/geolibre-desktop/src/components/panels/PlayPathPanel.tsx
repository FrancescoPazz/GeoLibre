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
import { Pause, Play, Route, Square, TriangleAlert, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";

const PANEL_WIDTH = 300;
const EDGE_MARGIN = 12;

/**
 * Play Path panel (Controls → Play Path): fly the camera along the path
 * drawn with 3D Measure. The plugin owns the flight; this renders its
 * published state and the controls.
 */
export function PlayPathPanel() {
  const state = useSyncExternalStore(subscribePlayPath, getPlayPathSnapshot, getPlayPathSnapshot);
  if (!state.open) return null;
  return <PlayPathCard state={state} />;
}

function PlayPathCard({ state }: { state: PlayPathState }) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(() => ({ x: EDGE_MARGIN, y: EDGE_MARGIN }));

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button,input,select,label,[role=slider]")) return;
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

  const {
    bound,
    available,
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
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.playPath.title")}
      data-testid="play-path-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Route className="h-4 w-4 text-violet-500" />
        <span className="text-sm font-medium">{t("toolbar.playPath.title")}</span>
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
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={t("toolbar.playPath.close")}
          onClick={() => closePlayPathPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

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
    </div>
  );
}
