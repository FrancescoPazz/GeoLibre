import {
  conversionsForInput,
  convertCoordinates,
  getCoordsConverterUrl,
  parseCoordinateInput,
  useAppStore,
  type ConvertedCoordinates,
  type CrsConversion,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { Button, Input } from "@geolibre/ui";
import { Copy, Crosshair, LocateFixed, Move3d, X } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { clamp } from "../../lib/clamp";
import {
  closeCoordsConverterPanel,
  isCoordsConverterPanelVisible,
  subscribeCoordsConverterPanel,
} from "../../lib/coords-converter-panel";

const PANEL_WIDTH = 360;
const EDGE_MARGIN = 12;
/** Zoom the "centre map" button flies to: the 0.005° box the old panel framed. */
const CENTER_ZOOM = 15;

/**
 * The deployment's coordinate conversion service, re-resolved on runtime
 * environment changes (`COORDS_CONVERTER_URL` at build time,
 * `VITE_COORDS_CONVERTER_URL` in Settings → Environment variables).
 */
export function useCoordsConverterUrl(): string | undefined {
  const [url, setUrl] = useState<string | undefined>(() => getCoordsConverterUrl());
  useEffect(() => {
    const refresh = () => setUrl(getCoordsConverterUrl());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return url;
}

interface CoordsConverterPanelProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Coordinate converter (Controls → Coordinate converter): type a position
 * as `latitude, longitude` or `x, y`, or drop a pin on the map, pick the
 * pair of reference systems, and the deployment's GeometryServer converts
 * it — with the NTv2 datum grids the server holds, which is why this is
 * not done in the browser. Copy either field, or centre the map on it.
 */
export function CoordsConverterPanel({ mapControllerRef }: CoordsConverterPanelProps) {
  const open = useSyncExternalStore(
    subscribeCoordsConverterPanel,
    isCoordsConverterPanelVisible,
    isCoordsConverterPanelVisible,
  );
  const serviceUrl = useCoordsConverterUrl();
  if (!open) return null;
  return <CoordsConverterCard mapControllerRef={mapControllerRef} serviceUrl={serviceUrl} />;
}

function CoordsConverterCard({
  mapControllerRef,
  serviceUrl,
}: CoordsConverterPanelProps & { serviceUrl: string | undefined }) {
  const { t } = useTranslation();
  const [position, setPosition] = useState(() => ({ x: EDGE_MARGIN, y: EDGE_MARGIN }));
  const [inputText, setInputText] = useState("");
  const [conversionKey, setConversionKey] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertedCoordinates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [placing, setPlacing] = useState(false);
  const disposePlacement = useRef<(() => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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

  const input = useMemo(() => parseCoordinateInput(inputText), [inputText]);
  const conversions = conversionsForInput(input?.cartographic ?? true);
  const keyOf = (c: CrsConversion) => `${c.from}>${c.to}`;
  // The chosen pair, or the first one that fits the input when the chosen
  // one no longer does (typing projected metres drops the WGS84-origin pairs).
  const conversion = conversions.find((c) => keyOf(c) === conversionKey) ?? conversions[0] ?? null;

  const stopPlacement = useCallback(() => {
    disposePlacement.current?.();
    disposePlacement.current = null;
    setPlacing(false);
  }, []);

  useEffect(
    () => () => {
      disposePlacement.current?.();
      abortRef.current?.abort();
    },
    [],
  );

  const pickOnMap = () => {
    if (placing) {
      stopPlacement();
      return;
    }
    const map = mapControllerRef.current;
    if (!map) return;
    const center = useAppStore.getState().mapView.center;
    const write = (lngLat: [number, number]) =>
      setInputText(`${lngLat[1].toFixed(6)}, ${lngLat[0].toFixed(6)}`);
    write(center);
    const dispose = map.startManualPlacement(center, {
      hint: t("toolbar.coordsConverter.pickHint"),
      doneLabel: t("common.done"),
      onMove: write,
      onDone: () => {
        disposePlacement.current = null;
        setPlacing(false);
      },
    });
    disposePlacement.current = dispose;
    setPlacing(true);
  };

  const convert = async () => {
    if (!serviceUrl || !input || !conversion) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const converted = await convertCoordinates(
        serviceUrl,
        conversion,
        input,
        fetch,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResult(converted);
    } catch (e) {
      if (controller.signal.aborted) return;
      setResult(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const reset = () => {
    abortRef.current?.abort();
    stopPlacement();
    setInputText("");
    setResult(null);
    setError(null);
    setBusy(false);
  };

  const copy = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard outside a secure context; nothing else to do.
    }
  };

  const centerOn = (lngLat: [number, number]) => {
    mapControllerRef.current?.flyTo({ center: lngLat, zoom: CENTER_ZOOM, duration: 2000 });
  };

  const inputLngLat: [number, number] | null = input?.cartographic
    ? [input.second, input.first]
    : null;
  const resultLngLat: [number, number] | null = result?.cartographic ? [result.x, result.y] : null;
  const fieldRow = "flex items-center gap-1";
  const iconButton = "h-7 w-7 shrink-0";

  return (
    <div
      className="absolute z-30 rounded-lg border border-border map-glass shadow-lg"
      style={{ left: position.x, top: position.y, width: PANEL_WIDTH }}
      role="dialog"
      aria-label={t("toolbar.coordsConverter.title")}
      data-testid="coords-converter-panel"
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Move3d className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.coordsConverter.title")}</span>
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto h-6 w-6"
          aria-label={t("toolbar.coordsConverter.close")}
          onClick={() => closeCoordsConverterPanel()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3 text-xs">
        {!serviceUrl && (
          <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-600 dark:text-amber-400">
            {t("toolbar.coordsConverter.unconfigured")}
          </p>
        )}

        <div className="space-y-1">
          <label className="text-muted-foreground" htmlFor="coords-converter-input">
            {t("toolbar.coordsConverter.input")}
          </label>
          <div className={fieldRow}>
            <Input
              id="coords-converter-input"
              className="h-7 font-mono text-xs"
              value={inputText}
              placeholder={t("toolbar.coordsConverter.inputPlaceholder")}
              title={t("toolbar.coordsConverter.inputHint")}
              onChange={(event) => setInputText(event.target.value)}
              data-testid="coords-converter-input"
            />
            <Button
              variant={placing ? "default" : "outline"}
              size="icon"
              className={iconButton}
              aria-label={t("toolbar.coordsConverter.pick")}
              title={t("toolbar.coordsConverter.pick")}
              onClick={pickOnMap}
            >
              <Crosshair className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={iconButton}
              aria-label={t("toolbar.coordsConverter.copy")}
              title={t("toolbar.coordsConverter.copy")}
              disabled={!inputText}
              onClick={() => void copy(inputText)}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={iconButton}
              aria-label={t("toolbar.coordsConverter.center")}
              title={t("toolbar.coordsConverter.center")}
              disabled={!inputLngLat}
              onClick={() => inputLngLat && centerOn(inputLngLat)}
            >
              <LocateFixed className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-muted-foreground">{t("toolbar.coordsConverter.inputHint")}</p>
        </div>

        <div className="space-y-1">
          <label className="text-muted-foreground" htmlFor="coords-converter-pair">
            {t("toolbar.coordsConverter.conversion")}
          </label>
          <select
            id="coords-converter-pair"
            className="h-7 w-full rounded border border-border bg-background px-1 text-xs"
            value={conversion ? keyOf(conversion) : ""}
            onChange={(event) => setConversionKey(event.target.value)}
          >
            {conversions.map((c) => (
              <option key={keyOf(c)} value={keyOf(c)}>
                {c.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={!serviceUrl || !input || !conversion || busy}
              onClick={() => void convert()}
            >
              {busy
                ? t("toolbar.coordsConverter.converting")
                : t("toolbar.coordsConverter.convert")}
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={reset}>
              {t("toolbar.coordsConverter.reset")}
            </Button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-muted-foreground" htmlFor="coords-converter-output">
            {t("toolbar.coordsConverter.result")}
          </label>
          <div className={fieldRow}>
            <Input
              id="coords-converter-output"
              className="h-7 font-mono text-xs"
              readOnly
              value={result?.text ?? ""}
              data-testid="coords-converter-output"
            />
            <Button
              variant="outline"
              size="icon"
              className={iconButton}
              aria-label={t("toolbar.coordsConverter.copy")}
              title={t("toolbar.coordsConverter.copy")}
              disabled={!result}
              onClick={() => result && void copy(result.text)}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className={iconButton}
              aria-label={t("toolbar.coordsConverter.center")}
              title={t("toolbar.coordsConverter.center")}
              disabled={!resultLngLat}
              onClick={() => resultLngLat && centerOn(resultLngLat)}
            >
              <LocateFixed className="h-3.5 w-3.5" />
            </Button>
          </div>
          {error ? (
            <p className="text-destructive" role="alert">
              {t("toolbar.coordsConverter.failed", { message: error })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("toolbar.coordsConverter.resultHint")}</p>
          )}
        </div>
      </div>
    </div>
  );
}
