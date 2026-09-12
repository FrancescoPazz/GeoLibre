import {
  createQuickFilterMatcher,
  type GeoLibreLayer,
  type LayerQuickFilter,
} from "@geolibre/core";
import type { Feature, Geometry } from "geojson";
import type { QueryableProperty } from "./terria-catalog/catalog-model";

/**
 * Feature query over a layer's loaded features, as the old geoportal's
 * "QueryWindow" did it: the layer's `queryableProperties` say which
 * properties can be filtered on, which can group the features
 * (`canAggregate`), which can be summed (`sumOnAggregation`) and which hold
 * a dictionary that spreads a feature over several categories by percentage
 * (`distributionOnAggregation`). The filters are the layer's own quick
 * filters — the map and the query agree by construction.
 *
 * Pure functions over GeoJSON features; the panel is the app's.
 */

/** The layer metadata key the catalog puts the properties under. */
export const QUERYABLE_PROPERTIES_KEY = "queryableProperties";

/** Layer metadata key: the quick filters were seeded from the query properties. */
export const QUERY_FILTERS_SEEDED_KEY = "queryFiltersSeeded";

export const COUNT_FUNCTION = "count";

export interface QueryAggregationOptions {
  /** The `canAggregate` property whose values become the categories. */
  aggregationProperty: string;
  /** `count`, or the name of a `sumOnAggregation` property to sum per category. */
  aggregationFunction: string;
  /** A `distributionOnAggregation` dictionary property, when the layer has one. */
  distributionProperty?: string;
}

export interface QueryAggregationRow {
  name: string;
  value: number;
  /** Share of the total, one decimal, as the old chart showed it. */
  valuePerc: number;
}

export interface QueryOption {
  key: string;
  label: string;
}

export interface QueryFunctionOption extends QueryOption {
  measureUnit?: string;
  decimalPlaces: number;
}

export type QueryFeature = Feature<Geometry | null>;

/** The layer's queryable properties, or an empty list. */
export function queryablePropertiesOfLayer(layer: GeoLibreLayer): QueryableProperty[] {
  const raw = layer.metadata[QUERYABLE_PROPERTIES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is QueryableProperty =>
      Boolean(p) &&
      typeof p === "object" &&
      typeof (p as QueryableProperty).propertyName === "string",
  );
}

/** Whether a layer can be queried: it has query properties and vector features. */
export function isQueryableLayer(layer: GeoLibreLayer): boolean {
  return queryablePropertiesOfLayer(layer).length > 0;
}

/** The quick filters constraining `field` right now (switched on and answered). */
function isConstrained(filters: readonly LayerQuickFilter[] | undefined, field: string): boolean {
  if (!filters) return false;
  return filters.some((f) => {
    if (f.field !== field || f.enabled === false) return false;
    switch (f.kind) {
      case "categorical":
        return Boolean(f.values && f.values.length);
      case "range":
        return (f.min ?? null) !== null || (f.max ?? null) !== null;
      case "date":
        return Boolean(f.start || f.end);
      case "text":
        return Boolean(f.text?.trim());
      default:
        return false;
    }
  });
}

/**
 * The properties a chart can group by: those marked `canAggregate` that no
 * filter is narrowing to one value (grouping by a filtered property gives a
 * single slice, so the old window dropped them).
 */
export function aggregateFieldOptions(
  properties: readonly QueryableProperty[],
  filters?: readonly LayerQuickFilter[],
): QueryOption[] {
  return properties
    .filter((p) => p.canAggregate && !isConstrained(filters, p.propertyName))
    .map((p) => ({ key: p.propertyName, label: p.propertyLabel }));
}

/** What a chart can represent: the count, then a sum of each summable property. */
export function aggregateFunctionOptions(
  properties: readonly QueryableProperty[],
  countLabel = "Count",
  sumLabel: (label: string) => string = (label) => `Sum of ${label}`,
): QueryFunctionOption[] {
  return [
    { key: COUNT_FUNCTION, label: countLabel, decimalPlaces: 0 },
    ...properties
      .filter((p) => p.sumOnAggregation)
      .map((p) => ({
        key: p.propertyName,
        label: sumLabel(p.propertyLabel),
        measureUnit: p.propertyMeasureUnit,
        decimalPlaces: p.decimalPlaces ?? 0,
      })),
  ];
}

/** The dictionary property that spreads features over categories, if any. */
export function distributionProperty(properties: readonly QueryableProperty[]): string | undefined {
  return properties.find((p) => p.distributionOnAggregation)?.propertyName;
}

/** The columns of the query table: groupable and summable properties, in file order. */
export function queryTableColumns(properties: readonly QueryableProperty[]): QueryableProperty[] {
  return properties.filter((p) => p.canAggregate || p.sumOnAggregation);
}

/** The features the layer's quick filters let through. */
export function matchingFeatures(
  features: readonly QueryFeature[],
  filters: readonly LayerQuickFilter[] | undefined,
): QueryFeature[] {
  const matches = createQuickFilterMatcher(filters);
  return features.filter((f) => matches(f));
}

function numberOf(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value.replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function categoryName(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/**
 * Group the features by the aggregation property and count them or sum a
 * property per group — the old geoportal's aggregation, with its three ways
 * of bucketing a feature: through a dictionary that spreads it over several
 * categories by percentage, through a multi-value property (an array, each
 * value counting a fraction towards the percentages), or by one value.
 */
export function aggregateFeatures(
  features: readonly QueryFeature[],
  properties: readonly QueryableProperty[],
  options: QueryAggregationOptions,
): QueryAggregationRow[] {
  const { aggregationProperty, aggregationFunction } = options;
  const isCount = aggregationFunction === COUNT_FUNCTION;
  const distribution =
    !isCount && options.distributionProperty
      ? properties
          .find((p) => p.propertyName === options.distributionProperty)
          ?.dictionaryKeyProperties?.find((d) => d.queryProperty === aggregationProperty)
      : undefined;
  const totals: Record<string, number> = {};
  const shares: Record<string, number> = {};
  for (const feature of features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const amount = isCount ? 1 : numberOf(props[aggregationFunction]);
    const name = props[aggregationProperty];
    const dictionary =
      distribution && options.distributionProperty
        ? (props[options.distributionProperty] as Record<string, unknown> | undefined)?.[
            distribution.key
          ]
        : undefined;
    if (distribution && Array.isArray(dictionary)) {
      for (const entry of dictionary as Array<Record<string, unknown>>) {
        const alias = categoryName(entry[distribution.alias]);
        const share = numberOf(entry[distribution.valueProperty]) * 0.01;
        totals[alias] = (totals[alias] ?? 0) + amount * share;
      }
    } else if (Array.isArray(name)) {
      for (const each of name) {
        const key = categoryName(each);
        totals[key] = (totals[key] ?? 0) + amount;
        shares[key] = (shares[key] ?? 0) + 1 / name.length;
      }
    } else {
      const key = categoryName(name);
      totals[key] = (totals[key] ?? 0) + amount;
      shares[key] = (shares[key] ?? 0) + 1;
    }
  }
  const total = isCount
    ? features.length
    : Object.values(totals).reduce((sum, value) => sum + value, 0);
  return Object.entries(totals).map(([name, value]) => ({
    name,
    value,
    valuePerc:
      total > 0
        ? Math.round(((isCount ? (shares[name] ?? 0) : value) / total + Number.EPSILON) * 1000) / 10
        : 0,
  }));
}

/** Distinct values of a property among the features, multi-value strings split on commas. */
export function distinctValues(
  features: readonly QueryFeature[],
  property: QueryableProperty,
): string[] {
  const values = new Set<string>();
  for (const feature of features) {
    const raw = (feature.properties as Record<string, unknown> | null)?.[property.propertyName];
    if (raw === null || raw === undefined || raw === "") continue;
    if (Array.isArray(raw)) {
      for (const each of raw) values.add(categoryName(each));
    } else if (property.enumMultiValue && typeof raw === "string") {
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (trimmed) values.add(trimmed);
      }
    } else {
      values.add(categoryName(raw));
    }
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}

/**
 * Quick filters for the query properties, one per property the file lists:
 * a pick-list for an enumeration (a "contains" text match when a feature can
 * hold several values), a range for a number, a from/to for a date, a text
 * match for the rest. Filters the layer already has on those fields are kept.
 */
export function quickFiltersForQueryableProperties(
  properties: readonly QueryableProperty[],
  existing: readonly LayerQuickFilter[] = [],
): LayerQuickFilter[] {
  const out: LayerQuickFilter[] = [...existing];
  for (const property of properties) {
    if (existing.some((f) => f.field === property.propertyName)) continue;
    const id = `query:${property.propertyName}`;
    const base = { id, field: property.propertyName, enabled: true };
    switch (property.propertyType) {
      case "enum":
        out.push(
          property.enumMultiValue
            ? { ...base, kind: "text", operator: "contains", text: "" }
            : { ...base, kind: "categorical", values: [] },
        );
        break;
      case "number":
        out.push({ ...base, kind: "range", min: null, max: null });
        break;
      case "date":
        out.push({ ...base, kind: "date", start: null, end: null, dateKind: "iso" });
        break;
      case "dictionary":
        break;
      default:
        out.push({ ...base, kind: "text", operator: "equals", text: "" });
    }
  }
  return out;
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(", ")
        : String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The query table as CSV: the columns' labels, then one row per feature. */
export function queryTableCsv(
  features: readonly QueryFeature[],
  columns: readonly QueryableProperty[],
): string {
  const header = columns.map((c) => csvCell(c.propertyLabel)).join(",");
  const rows = features.map((f) =>
    columns
      .map((c) => csvCell((f.properties as Record<string, unknown> | null)?.[c.propertyName]))
      .join(","),
  );
  return [header, ...rows].join("\n");
}

/** The aggregation as CSV: category, value, percentage. */
export function aggregationCsv(
  rows: readonly QueryAggregationRow[],
  labels: { category: string; value: string; percentage: string },
): string {
  const header = [labels.category, labels.value, labels.percentage].map(csvCell).join(",");
  return [
    header,
    ...rows.map((r) => [csvCell(r.name), String(r.value), String(r.valuePerc)].join(",")),
  ].join("\n");
}

/**
 * The matching features with a `lat`/`lon` pair, as the old "export data"
 * wrote them: the GeoJSON is the features themselves; the CSV lists every
 * property plus the coordinates of point features.
 */
export function exportFeaturesCsv(features: readonly QueryFeature[]): string {
  if (!features.length) return "0 features\n";
  const first = features[0];
  const keys = Object.keys((first.properties ?? {}) as Record<string, unknown>);
  const header = [...keys, "lat", "lon"].map(csvCell).join(";");
  const rows = features.map((f) => {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const point = f.geometry?.type === "Point" ? f.geometry.coordinates : null;
    return [
      ...keys.map((k) => csvCell(props[k])),
      point ? String(point[1]) : "",
      point ? String(point[0]) : "",
    ].join(";");
  });
  return [header, ...rows].join("\n");
}
