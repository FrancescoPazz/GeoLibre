import {
  ELEVATION_BANDS_MAX,
  addElevationBand,
  applyElevationBands,
  clearElevationBands,
  closeElevationBandsPanel,
  getElevationBandsSnapshot,
  removeElevationBand,
  setElevationBandsAboveSeaLevel,
  setElevationBandsOpacity,
  subscribeElevationBands,
  updateElevationBand,
  type ElevationBandsState,
} from "@geolibre/plugins";
import { Button, Slider } from "@geolibre/ui";
import { Eraser, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useFloatingMapPanelPosition } from "../../hooks/useFloatingMapPanelPosition";
import { FLOATING_MAP_PANEL_ICON, FLOATING_MAP_PANEL_TEST_ID } from "./floating-map-panel-meta";
import { FloatingMapToolPanelShell } from "./FloatingMapToolPanelShell";

const PANEL_WIDTH = 340;

/**
 * Elevation bands panel (Controls → Elevation bands): colour the globe's
 * terrain between chosen heights. The plugin owns the material; this
 * renders its published state and the band editor.
 */
export function ElevationBandsPanel() {
  const state = useSyncExternalStore(
    subscribeElevationBands,
    getElevationBandsSnapshot,
    getElevationBandsSnapshot,
  );
  if (!state.open) return null;
  return <ElevationBandsCard state={state} />;
}

function ElevationBandsCard({ state }: { state: ElevationBandsState }) {
  const { t } = useTranslation();
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useFloatingMapPanelPosition(
    "elevation-bands",
    PANEL_WIDTH,
    cardRef,
  );
  const { Icon, className: iconClassName } = FLOATING_MAP_PANEL_ICON["elevation-bands"];

  const { bound, bands, opacity, applied, aboveSeaLevel, geoidAvailable, geoidOffsetMeters } =
    state;
  const numberField =
    "h-7 w-20 rounded border border-border bg-background px-1 text-xs tabular-nums";
  const colorField = "h-7 w-8 cursor-pointer rounded border border-border bg-background p-0.5";

  return (
    <FloatingMapToolPanelShell
      id="elevation-bands"
      title={t("toolbar.elevationBands.title")}
      icon={Icon}
      iconClassName={iconClassName}
      width={PANEL_WIDTH}
      cardRef={cardRef}
      position={position}
      setPosition={setPosition}
      onClose={() => closeElevationBandsPanel()}
      closeAriaLabel={t("toolbar.elevationBands.close")}
      testId={FLOATING_MAP_PANEL_TEST_ID["elevation-bands"]}
      headerActions={
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.elevationBands.clear")}
          title={t("toolbar.elevationBands.clear")}
          disabled={!applied}
          onClick={() => clearElevationBands()}
        >
          <Eraser className="h-3.5 w-3.5" />
        </Button>
      }
    >
      <div className="space-y-3 p-3">
        {!bound && (
          <div
            className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-600 dark:text-amber-400"
            data-testid="elevation-bands-hint"
          >
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span aria-live="polite">{t("toolbar.elevationBands.unavailable")}</span>
          </div>
        )}

        <div className="space-y-1.5" data-testid="elevation-bands-list">
          <div className="grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-1 text-[11px] text-muted-foreground">
            <span>{t("toolbar.elevationBands.from")}</span>
            <span />
            <span>{t("toolbar.elevationBands.to")}</span>
            <span />
            <span />
          </div>
          {bands.map((band, index) => (
            <div
              key={index}
              className="grid grid-cols-[1fr_auto_1fr_auto_auto] items-center gap-1"
              data-testid="elevation-band-row"
            >
              <input
                type="number"
                className={numberField}
                value={band.fromHeight}
                step={10}
                aria-label={t("toolbar.elevationBands.fromHeight", { index: index + 1 })}
                onChange={(event) =>
                  updateElevationBand(index, { fromHeight: Number(event.target.value) })
                }
              />
              <input
                type="color"
                className={colorField}
                value={band.fromColor}
                aria-label={t("toolbar.elevationBands.fromColor", { index: index + 1 })}
                onChange={(event) => updateElevationBand(index, { fromColor: event.target.value })}
              />
              <input
                type="number"
                className={numberField}
                value={band.toHeight}
                step={10}
                aria-label={t("toolbar.elevationBands.toHeight", { index: index + 1 })}
                onChange={(event) =>
                  updateElevationBand(index, { toHeight: Number(event.target.value) })
                }
              />
              <input
                type="color"
                className={colorField}
                value={band.toColor}
                aria-label={t("toolbar.elevationBands.toColor", { index: index + 1 })}
                onChange={(event) => updateElevationBand(index, { toColor: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                aria-label={t("toolbar.elevationBands.remove", { index: index + 1 })}
                title={t("toolbar.elevationBands.remove", { index: index + 1 })}
                onClick={() => removeElevationBand(index)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-xs"
            disabled={bands.length >= ELEVATION_BANDS_MAX}
            onClick={() => addElevationBand()}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("toolbar.elevationBands.add")}
          </Button>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{t("toolbar.elevationBands.opacity")}</span>
            <span className="tabular-nums">{Math.round(opacity * 100)}%</span>
          </div>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[opacity]}
            onValueChange={(value: number[]) => setElevationBandsOpacity(value[0] ?? opacity)}
            aria-label={t("toolbar.elevationBands.opacity")}
          />
        </div>

        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={aboveSeaLevel && geoidAvailable}
            disabled={!geoidAvailable}
            onChange={(event) => setElevationBandsAboveSeaLevel(event.target.checked)}
          />
          {t("toolbar.elevationBands.aboveSeaLevel")}
          {applied && geoidOffsetMeters !== null && geoidOffsetMeters !== 0 && (
            <span className="ms-auto tabular-nums text-muted-foreground">
              {t("toolbar.elevationBands.offset", { meters: geoidOffsetMeters.toFixed(1) })}
            </span>
          )}
        </label>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!bound || bands.length === 0}
            onClick={() => void applyElevationBands()}
          >
            {t("toolbar.elevationBands.apply")}
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {applied ? t("toolbar.elevationBands.applied") : t("toolbar.elevationBands.notApplied")}
          </span>
        </div>
      </div>
    </FloatingMapToolPanelShell>
  );
}
