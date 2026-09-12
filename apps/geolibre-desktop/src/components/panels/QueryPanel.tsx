import {
  clearQuickFilterValues,
  compileQuickFilters,
  isFeatureAllowedByProfile,
  useAppStore,
  type GeoLibreLayer,
  type LayerQuickFilter,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import {
  COUNT_FUNCTION,
  QUERY_FILTERS_SEEDED_KEY,
  aggregateFeatures,
  aggregateFieldOptions,
  aggregateFunctionOptions,
  aggregationCsv,
  distributionProperty,
  exportFeaturesCsv,
  isQueryableLayer,
  matchingFeatures,
  queryTableColumns,
  queryTableCsv,
  queryablePropertiesOfLayer,
  quickFiltersForQueryableProperties,
  type QueryAggregationRow,
  type QueryFeature,
} from "@geolibre/plugins";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@geolibre/ui";
import { Download, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useGeoportalSession } from "../../hooks/useGeoportalSession";
import { useQuickFilterProfiles } from "../../hooks/useQuickFilterProfiles";
import { downloadChartPng, triggerDownload } from "../../lib/chart-export";
import {
  closeQueryPanel,
  isQueryPanelVisible,
  queryPanelLayerId,
  setQueryPanelLayer,
  subscribeQueryPanel,
} from "../../lib/query-panel";
import { sanitizeExportFileName } from "../../lib/vector-export";
import { CHART_W, CHART_H, ChartView } from "./charts/chart-view";
import { QuickFilterControl } from "./QuickFilterControl";

type ChartModel = "pie" | "bars" | "pivot";
type Tab = "charts" | "table";

const PAGE_SIZE = 15;

// Stable empties, so a layer without filters or features does not hand the
// memos a fresh array on every render.
const NO_FILTERS: LayerQuickFilter[] = [];
const NO_FEATURES: QueryFeature[] = [];

/** The profile feature names the old geoportal gated the window and its downloads with. */
const QUERY_FEATURE = "QueryData";
const DOWNLOAD_FEATURE = "DownloadQueryData";

interface QueryPanelProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Query data (Controls → Query data): the old geoportal's query window over
 * a catalog layer whose entry declares `queryableProperties`. The filters
 * are the layer's quick filters, seeded from those properties, so the map
 * narrows with the query; the charts aggregate the matching features by a
 * groupable property (count, or the sum of a summable one, spread through
 * a dictionary property where the entry has one); the table lists them and
 * both can be saved. The profile gates the window and the downloads.
 */
export function QueryPanel({ mapControllerRef }: QueryPanelProps) {
  const open = useSyncExternalStore(subscribeQueryPanel, isQueryPanelVisible, isQueryPanelVisible);
  if (!open) return null;
  return <QueryDialog mapControllerRef={mapControllerRef} />;
}

/** Whether the map holds a layer the query panel can work on. */
export function useHasQueryableLayer(): boolean {
  return useAppStore((s) => s.layers.some(isQueryableLayer));
}

function QueryDialog({ mapControllerRef }: QueryPanelProps) {
  const { t } = useTranslation();
  const layers = useAppStore((s) => s.layers);
  const setLayerQuickFilters = useAppStore((s) => s.setLayerQuickFilters);
  const updateLayer = useAppStore((s) => s.updateLayer);
  const requestedId = useSyncExternalStore(
    subscribeQueryPanel,
    queryPanelLayerId,
    queryPanelLayerId,
  );
  useGeoportalSession(); // re-render on sign-in/out: the profile gates the window
  const allowed = isFeatureAllowedByProfile(QUERY_FEATURE);
  const canDownload = isFeatureAllowedByProfile(DOWNLOAD_FEATURE);

  const queryable = useMemo(() => layers.filter(isQueryableLayer), [layers]);
  const layer = queryable.find((l) => l.id === requestedId) ?? queryable[0] ?? null;
  const [tab, setTab] = useState<Tab>("charts");
  const [error, setError] = useState<string | null>(null);

  // Seed the layer's quick filters from its query properties once, so the
  // window opens with one control per property, as the old one did.
  useEffect(() => {
    if (!layer || layer.metadata[QUERY_FILTERS_SEEDED_KEY] === true) return;
    const seeded = quickFiltersForQueryableProperties(
      queryablePropertiesOfLayer(layer),
      layer.quickFilters ?? [],
    );
    updateLayer(layer.id, {
      quickFilters: seeded,
      metadata: { ...layer.metadata, [QUERY_FILTERS_SEEDED_KEY]: true },
    });
  }, [layer, updateLayer]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) closeQueryPanel();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" data-testid="query-panel">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Table2 className="h-4 w-4 text-sky-500" />
            {t("toolbar.queryData.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("toolbar.item.queryDataTooltip")}
          </DialogDescription>
        </DialogHeader>
        {!allowed ? (
          <p className="text-sm text-muted-foreground">{t("toolbar.queryData.notAllowed")}</p>
        ) : !layer ? (
          <p className="text-sm text-muted-foreground">{t("toolbar.queryData.noLayers")}</p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-xs">
              <span className="font-medium">{t("toolbar.queryData.layer")}</span>
              <select
                className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs"
                value={layer.id}
                onChange={(event) => setQueryPanelLayer(event.target.value)}
                data-testid="query-layer"
              >
                {queryable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-4 md:grid-cols-[260px_1fr]">
              <FiltersColumn
                layer={layer}
                mapControllerRef={mapControllerRef}
                onChange={(next) => setLayerQuickFilters(layer.id, next)}
              />
              <div className="min-w-0 space-y-3">
                <div className="flex gap-1 border-b border-border" role="tablist">
                  {(["charts", "table"] as Tab[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={tab === key}
                      className={`px-3 py-1.5 text-xs ${tab === key ? "border-b-2 border-primary font-medium" : "text-muted-foreground"}`}
                      onClick={() => setTab(key)}
                    >
                      {t(`toolbar.queryData.${key}`)}
                    </button>
                  ))}
                </div>
                {tab === "charts" ? (
                  <ChartsTab layer={layer} canDownload={canDownload} onError={setError} />
                ) : (
                  <TableTab layer={layer} canDownload={canDownload} onError={setError} />
                )}
                {error ? (
                  <p className="text-xs text-destructive" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FiltersColumn({
  layer,
  mapControllerRef,
  onChange,
}: {
  layer: GeoLibreLayer;
  mapControllerRef: RefObject<MapEngine | null>;
  onChange: (next: LayerQuickFilter[]) => void;
}) {
  const { t } = useTranslation();
  const { byField } = useQuickFilterProfiles(layer, mapControllerRef);
  const properties = queryablePropertiesOfLayer(layer);
  const labels = new Map(properties.map((p) => [p.propertyName, p.propertyLabel]));
  const filters = layer.quickFilters ?? NO_FILTERS;
  const shown = filters.filter((f) => labels.has(f.field));
  const features = layer.geojson?.features ?? NO_FEATURES;
  const matching = useMemo(() => matchingFeatures(features, filters).length, [features, filters]);
  const active = compileQuickFilters(filters) !== null;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{t("toolbar.queryData.filters")}</span>
        {active ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => onChange(clearQuickFilterValues(filters))}
          >
            {t("toolbar.queryData.clearFilters")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="query-matching">
        {features.length
          ? t("toolbar.queryData.matching", { matching, total: features.length })
          : t("toolbar.queryData.noFeatures")}
      </p>
      <div className="space-y-2">
        {shown.map((filter) => (
          <div key={filter.id}>
            <div className="mb-0.5 text-[11px] text-muted-foreground">
              {labels.get(filter.field)}
            </div>
            <QuickFilterControl
              filter={filter}
              profile={byField.get(filter.field)}
              idPrefix={`query-${layer.id}`}
              onChange={(next) => onChange(filters.map((f) => (f.id === next.id ? next : f)))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ChartsTab({
  layer,
  canDownload,
  onError,
}: {
  layer: GeoLibreLayer;
  canDownload: boolean;
  onError: (message: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const properties = queryablePropertiesOfLayer(layer);
  const filters = layer.quickFilters ?? NO_FILTERS;
  const [ignoreFilters, setIgnoreFilters] = useState(false);
  const [aggregationProperty, setAggregationProperty] = useState<string>("");
  const [aggregationFunction, setAggregationFunction] = useState<string>(COUNT_FUNCTION);
  const [model, setModel] = useState<ChartModel>("pie");
  const chartRef = useRef<HTMLDivElement>(null);

  const fieldOptions = aggregateFieldOptions(properties, filters);
  const functionOptions = aggregateFunctionOptions(
    properties,
    t("toolbar.queryData.count"),
    (label) => t("toolbar.queryData.sumOf", { label }),
  );
  const field = fieldOptions.find((o) => o.key === aggregationProperty) ?? fieldOptions[0];
  const fn = functionOptions.find((o) => o.key === aggregationFunction) ?? functionOptions[0];
  const filtersActive = compileQuickFilters(filters) !== null;

  const features = layer.geojson?.features ?? NO_FEATURES;
  const rows = useMemo<QueryAggregationRow[]>(() => {
    if (!field) return [];
    const source = ignoreFilters ? features : matchingFeatures(features, filters);
    return aggregateFeatures(source, properties, {
      aggregationProperty: field.key,
      aggregationFunction: fn.key,
      distributionProperty: distributionProperty(properties),
    });
  }, [features, filters, ignoreFilters, field, fn.key, properties]);

  const numberFormat = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        minimumFractionDigits: fn.decimalPlaces,
        maximumFractionDigits: fn.decimalPlaces,
      }),
    [i18n.language, fn.decimalPlaces],
  );
  const formatValue = (value: number) =>
    fn.measureUnit ? `${numberFormat.format(value)} ${fn.measureUnit}` : numberFormat.format(value);

  const base = `${sanitizeExportFileName(layer.name || "query")}-${field?.key ?? "chart"}`;
  const downloadChart = () => {
    const svg = chartRef.current?.querySelector("svg");
    if (!svg) return;
    onError(null);
    downloadChartPng(svg, CHART_W, CHART_H, `${base}.png`).catch(() =>
      onError(t("toolbar.queryData.exportError")),
    );
  };
  const downloadAggregation = () => {
    const csv = aggregationCsv(rows, {
      category: t("toolbar.queryData.category"),
      value: t("toolbar.queryData.value"),
      percentage: t("toolbar.queryData.percentage"),
    });
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${base}-pivot.csv`);
  };

  if (!field) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("toolbar.queryData.aggregationNotPossible")}
      </p>
    );
  }
  const selectClass = "h-7 min-w-0 rounded-md border border-input bg-background px-2 text-xs";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-0.5 text-xs">
          {t("toolbar.queryData.aggregateBy")}
          <select
            className={selectClass}
            value={field.key}
            onChange={(e) => setAggregationProperty(e.target.value)}
            data-testid="query-aggregate-by"
          >
            {fieldOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          {t("toolbar.queryData.represent")}
          <select
            className={selectClass}
            value={fn.key}
            onChange={(e) => setAggregationFunction(e.target.value)}
            data-testid="query-represent"
          >
            {functionOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-xs">
          {t("toolbar.queryData.chartModel")}
          <select
            className={selectClass}
            value={model}
            onChange={(e) => setModel(e.target.value as ChartModel)}
          >
            <option value="pie">{t("toolbar.queryData.pie")}</option>
            <option value="bars">{t("toolbar.queryData.bars")}</option>
            <option value="pivot">{t("toolbar.queryData.pivotTable")}</option>
          </select>
        </label>
        {filtersActive ? (
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={ignoreFilters}
              onChange={(e) => setIgnoreFilters(e.target.checked)}
            />
            {t("toolbar.queryData.ignoreFilters")}
          </label>
        ) : null}
      </div>
      {model === "pivot" ? (
        <PivotTable rows={rows} formatValue={formatValue} />
      ) : (
        <div ref={chartRef} data-testid="query-chart">
          <ChartView
            result={
              model === "pie"
                ? {
                    type: "pie",
                    category: field.label,
                    aggregation: fn.key === COUNT_FUNCTION ? "count" : "sum",
                    result: rows.length
                      ? {
                          slices: rows.map((r) => ({
                            label: r.name,
                            value: r.value,
                            count: r.value,
                          })),
                          total: rows.reduce((sum, r) => sum + r.value, 0),
                          otherCount: 0,
                        }
                      : null,
                  }
                : {
                    type: "bar",
                    category: field.label,
                    aggregation: fn.key === COUNT_FUNCTION ? "count" : "sum",
                    result: rows.length
                      ? {
                          bars: rows.map((r) => ({
                            label: r.name,
                            value: r.value,
                            count: r.value,
                          })),
                          maxValue: Math.max(0, ...rows.map((r) => r.value)),
                          minValue: Math.min(0, ...rows.map((r) => r.value)),
                          truncated: 0,
                        }
                      : null,
                  }
            }
          />
        </div>
      )}
      {canDownload ? (
        <div className="flex flex-wrap gap-2">
          {model !== "pivot" ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={downloadChart}
              disabled={!rows.length}
            >
              <Download className="me-1 h-3.5 w-3.5" />
              {t("toolbar.queryData.downloadChart")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={downloadAggregation}
            disabled={!rows.length}
          >
            <Download className="me-1 h-3.5 w-3.5" />
            {t("toolbar.queryData.downloadAggregation")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PivotTable({
  rows,
  formatValue,
}: {
  rows: QueryAggregationRow[];
  formatValue: (value: number) => string;
}) {
  const { t } = useTranslation();
  const [sort, setSort] = useState<{ key: keyof QueryAggregationRow; asc: boolean }>({
    key: "value",
    asc: false,
  });
  const sorted = [...rows].sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    const cmp =
      typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.asc ? cmp : -cmp;
  });
  const header = (key: keyof QueryAggregationRow, label: string, right = false) => (
    <th
      className={`cursor-pointer px-2 py-1 font-medium ${right ? "text-end" : "text-start"}`}
      onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}
    >
      {label}
      {sort.key === key ? (sort.asc ? " ▲" : " ▼") : ""}
    </th>
  );
  return (
    <div className="max-h-80 overflow-auto rounded-md border border-border">
      <table className="w-full text-xs" data-testid="query-pivot">
        <thead className="sticky top-0 bg-muted/60">
          <tr>
            {header("name", t("toolbar.queryData.category"))}
            {header("value", t("toolbar.queryData.value"), true)}
            {header("valuePerc", t("toolbar.queryData.percentage"), true)}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={row.name} className="odd:bg-muted/20">
              <td className="px-2 py-1">{row.name}</td>
              <td className="px-2 py-1 text-end tabular-nums">{formatValue(row.value)}</td>
              <td className="px-2 py-1 text-end tabular-nums">{row.valuePerc.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableTab({
  layer,
  canDownload,
  onError,
}: {
  layer: GeoLibreLayer;
  canDownload: boolean;
  onError: (message: string | null) => void;
}) {
  const { t, i18n } = useTranslation();
  const properties = queryablePropertiesOfLayer(layer);
  const columns = queryTableColumns(properties);
  const filters = layer.quickFilters ?? NO_FILTERS;
  const features = layer.geojson?.features ?? NO_FEATURES;
  const matching = useMemo(() => matchingFeatures(features, filters), [features, filters]);
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<{ field: string; asc: boolean } | null>(null);
  const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const sorted = useMemo(() => {
    if (!sortKey) return matching;
    const { field, asc } = sortKey;
    return [...matching].sort((a, b) => {
      const x = (a.properties as Record<string, unknown> | null)?.[field];
      const y = (b.properties as Record<string, unknown> | null)?.[field];
      const cmp =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x ?? "").localeCompare(String(y ?? ""));
      return asc ? cmp : -cmp;
    });
  }, [matching, sortKey]);
  const visible = sorted.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const numberFormat = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const cell = (value: unknown, column: (typeof columns)[number]) => {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.join(", ");
    if (column.sumOnAggregation || column.propertyType === "number") {
      const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
      if (Number.isFinite(n)) {
        const text = new Intl.NumberFormat(i18n.language, {
          minimumFractionDigits: column.decimalPlaces ?? 0,
          maximumFractionDigits: column.decimalPlaces ?? 0,
        }).format(n);
        return column.propertyMeasureUnit ? `${text} ${column.propertyMeasureUnit}` : text;
      }
    }
    return String(value);
  };
  const base = sanitizeExportFileName(layer.name || "query");
  const saveTable = () => {
    onError(null);
    const csv = queryTableCsv(sorted, columns);
    triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${base}-table.csv`);
  };
  const exportData = () => {
    onError(null);
    const geojson = JSON.stringify({ type: "FeatureCollection", features: matching });
    triggerDownload(new Blob([geojson], { type: "application/geo+json" }), `${base}.geojson`);
    triggerDownload(
      new Blob([exportFeaturesCsv(matching)], { type: "text/csv;charset=utf-8" }),
      `${base}.csv`,
    );
  };

  return (
    <div className="space-y-2">
      <div className="max-h-96 overflow-auto rounded-md border border-border">
        <table className="w-full text-xs" data-testid="query-table">
          <thead className="sticky top-0 bg-muted/60">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.propertyName}
                  className={`cursor-pointer whitespace-nowrap px-2 py-1 font-medium ${column.sumOnAggregation ? "text-end" : "text-start"}`}
                  onClick={() =>
                    setSortKey((s) => ({
                      field: column.propertyName,
                      asc: s?.field === column.propertyName ? !s.asc : true,
                    }))
                  }
                >
                  {column.propertyLabel}
                  {sortKey?.field === column.propertyName ? (sortKey.asc ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((feature, index) => (
              <tr key={String(feature.id ?? index)} className="odd:bg-muted/20">
                {columns.map((column) => (
                  <td
                    key={column.propertyName}
                    className={`px-2 py-1 ${column.sumOnAggregation ? "text-end tabular-nums" : ""}`}
                  >
                    {cell(
                      (feature.properties as Record<string, unknown> | null)?.[column.propertyName],
                      column,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{t("toolbar.queryData.rows", { count: matching.length })}</span>
        {pages > 1 ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              {t("toolbar.queryData.previous")}
            </Button>
            <span>
              {t("toolbar.queryData.page", {
                page: numberFormat.format(current + 1),
                pages: numberFormat.format(pages),
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              {t("toolbar.queryData.next")}
            </Button>
          </>
        ) : null}
        {canDownload ? (
          <span className="ms-auto flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={saveTable}
              disabled={!matching.length}
            >
              <Download className="me-1 h-3.5 w-3.5" />
              {t("toolbar.queryData.saveTable")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={exportData}
              disabled={!matching.length}
            >
              <Download className="me-1 h-3.5 w-3.5" />
              {t("toolbar.queryData.exportData")}
            </Button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
