import {
  buildChartGeometry,
  formatMeters,
  setMeasure3dHover,
  type TerrainProfile,
} from "@geolibre/plugins";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  fitMeasure3dProfileViewport,
  nearestMeasure3dProfileSample,
  panMeasure3dProfileViewport,
  visibleMeasure3dProfilePoints,
  zoomMeasure3dProfileViewport,
  type Measure3dProfileViewport,
} from "./measure3dProfileViewport";

const CHART_WIDTH = 296;
const CHART_HEIGHT = 110;
const WHEEL_ZOOM_RATE = 0.002;

interface DragState {
  startX: number;
  viewport: Measure3dProfileViewport;
}

/** The isolated, zoomable elevation graph used only by the 3D Measure panel. */
export function Measure3dProfileChart({
  profile,
  hover,
}: {
  profile: TerrainProfile;
  hover: number | null;
}) {
  const { t } = useTranslation();
  const points = useMemo(
    () =>
      profile.samples.map((sample) => ({
        distance: sample.distanceM,
        elevation: sample.alt,
      })),
    [profile]
  );
  const [viewport, setViewport] = useState(() =>
    fitMeasure3dProfileViewport(points)
  );
  const drag = useRef<DragState | null>(null);
  const chartRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState(false);
  const clipId = useId().replace(/:/g, "");

  useEffect(() => {
    setViewport(fitMeasure3dProfileViewport(points));
    return () => setMeasure3dHover(null);
  }, [points]);

  const chartPoints = useMemo(
    () => visibleMeasure3dProfilePoints(points, viewport),
    [points, viewport]
  );
  const chart = useMemo(
    () => buildChartGeometry(chartPoints, CHART_WIDTH, CHART_HEIGHT),
    [chartPoints]
  );
  const airPath = useMemo(
    () =>
      profile.stopIndex
        .map((index, i) => {
          const sample = profile.samples[index];
          if (!sample) return "";
          return `${i === 0 ? "M" : "L"}${chart
            .xScale(sample.distanceM - viewport.start)
            .toFixed(2)} ${chart.yScale(sample.alt).toFixed(2)}`;
        })
        .join(" "),
    [chart, profile, viewport.start]
  );
  const fullSpan =
    points[points.length - 1]?.distance - (points[0]?.distance ?? 0);
  const canPan = viewport.end - viewport.start < fullSpan;
  const hovered = hover !== null ? profile.samples[hover] : undefined;

  const distanceAtEvent = (event: { clientX: number }) => {
    const rect = chartRef.current?.getBoundingClientRect();
    const renderedWidth = rect?.width || CHART_WIDTH;
    const svgX = ((event.clientX - (rect?.left ?? 0)) / renderedWidth) * CHART_WIDTH;
    const plotWidth = CHART_WIDTH - chart.padding.left - chart.padding.right;
    const fraction = Math.min(
      1,
      Math.max(0, (svgX - chart.padding.left) / plotWidth)
    );
    return viewport.start + fraction * (viewport.end - viewport.start);
  };

  const updateHover = (event: {
    clientX: number;
  }) => {
    const index = nearestMeasure3dProfileSample(
      profile.samples.map((sample) => sample.distanceM),
      distanceAtEvent(event)
    );
    setMeasure3dHover(index >= 0 ? index : null);
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // React clears `currentTarget` after the handler returns. Read the cursor
    // anchor before scheduling the state update so the updater never touches a
    // released synthetic event (which would make the enclosing panel's error
    // boundary replace it).
    const anchor = distanceAtEvent(event);
    const factor = Math.exp(event.deltaY * WHEEL_ZOOM_RATE);
    setViewport((current) =>
      zoomMeasure3dProfileViewport(
        current,
        points,
        anchor,
        factor
      )
    );
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    // Panning the profile belongs to the chart, not the globe behind its
    // floating panel.
    event.stopPropagation();
    if (!canPan || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, viewport };
    setDragging(true);
    setMeasure3dHover(null);
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.stopPropagation();
    const activeDrag = drag.current;
    if (!activeDrag) {
      updateHover(event);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width || CHART_WIDTH;
    const offset =
      ((activeDrag.startX - event.clientX) / width) *
      (activeDrag.viewport.end - activeDrag.viewport.start);
    setViewport(
      panMeasure3dProfileViewport(activeDrag.viewport, points, offset)
    );
  };

  const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.stopPropagation();
    if (!drag.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    drag.current = null;
    setDragging(false);
    updateHover(event);
  };

  if (profile.samples.length < 2) return null;

  return (
    <div className="space-y-1">
      <svg
        ref={chartRef}
        width="100%"
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        role="img"
        aria-label={t("toolbar.measure3d.profile.chart")}
        className={`rounded border border-border bg-background/60 ${
          canPan ? "cursor-grab" : ""
        } ${dragging ? "cursor-grabbing" : ""}`}
        style={{ touchAction: "none" }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onPointerLeave={() => {
          if (!drag.current) setMeasure3dHover(null);
        }}
        data-testid="measure-3d-chart"
        data-viewport-start={viewport.start.toFixed(3)}
        data-viewport-end={viewport.end.toFixed(3)}
      >
        <defs>
          <clipPath id={clipId}>
            <rect
              x={chart.padding.left}
              y={chart.padding.top}
              width={CHART_WIDTH - chart.padding.left - chart.padding.right}
              height={CHART_HEIGHT - chart.padding.top - chart.padding.bottom}
            />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
          <path d={chart.areaPath} className="fill-emerald-500/20" />
          <path
            d={chart.linePath}
            className="fill-none stroke-emerald-500"
            strokeWidth={1.5}
          />
          <path
            d={airPath}
            className="fill-none stroke-red-500"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
          {hovered && (
            <>
              <line
                x1={chart.xScale(hovered.distanceM - viewport.start)}
                x2={chart.xScale(hovered.distanceM - viewport.start)}
                y1={chart.padding.top}
                y2={CHART_HEIGHT - chart.padding.bottom}
                className="stroke-foreground/50"
                strokeWidth={1}
              />
              <circle
                cx={chart.xScale(hovered.distanceM - viewport.start)}
                cy={chart.yScale(hovered.alt)}
                r={3}
                className="fill-amber-500 stroke-background"
              />
            </>
          )}
        </g>
        <text
          x={chart.padding.left}
          y={CHART_HEIGHT - 4}
          className="fill-muted-foreground text-[9px]"
        >
          {formatMeters(viewport.start)}
        </text>
        <text
          x={CHART_WIDTH - chart.padding.right}
          y={CHART_HEIGHT - 4}
          textAnchor="end"
          className="fill-muted-foreground text-[9px]"
        >
          {formatMeters(viewport.end)}
        </text>
        <text
          x={2}
          y={chart.padding.top + 8}
          className="fill-muted-foreground text-[9px]"
        >
          {chart.maxElevation.toFixed(0)}
        </text>
        <text
          x={2}
          y={CHART_HEIGHT - chart.padding.bottom}
          className="fill-muted-foreground text-[9px]"
        >
          {chart.minElevation.toFixed(0)}
        </text>
      </svg>
      <div
        className="h-4 text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {hovered
          ? `${formatMeters(hovered.distanceM)} · ${hovered.alt.toFixed(1)} m`
          : t("toolbar.measure3d.profile.hoverHint")}
      </div>
    </div>
  );
}
