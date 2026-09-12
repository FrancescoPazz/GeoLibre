import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createQuickFilterMatcher, type LayerQuickFilter } from "@geolibre/core";
import type { Feature, Point } from "geojson";
import {
  aggregateFeatures,
  aggregateFieldOptions,
  aggregateFunctionOptions,
  aggregationCsv,
  distinctValues,
  distributionProperty,
  exportFeaturesCsv,
  matchingFeatures,
  queryTableColumns,
  queryTableCsv,
  quickFiltersForQueryableProperties,
} from "../packages/plugins/src/plugins/feature-query";
import type { QueryableProperty } from "../packages/plugins/src/plugins/terria-catalog/catalog-model";

// The properties as the Marche "Interventi" item declares them: a type to
// group by, a cost to sum, a multi-value theme, a date, and a dictionary
// that spreads an intervention over its municipalities by percentage.
const PROPERTIES: QueryableProperty[] = [
  { propertyName: "tipo", propertyLabel: "Tipo", propertyType: "enum", canAggregate: true },
  {
    propertyName: "costo",
    propertyLabel: "Costo",
    propertyType: "number",
    propertyMeasureUnit: "€",
    decimalPlaces: 2,
    sumOnAggregation: true,
  },
  {
    propertyName: "temi",
    propertyLabel: "Temi",
    propertyType: "enum",
    canAggregate: true,
    enumMultiValue: true,
  },
  { propertyName: "data", propertyLabel: "Data", propertyType: "date" },
  { propertyName: "comune", propertyLabel: "Comune", propertyType: "enum", canAggregate: true },
  {
    propertyName: "ripartizione",
    propertyLabel: "Ripartizione",
    propertyType: "dictionary",
    distributionOnAggregation: true,
    dictionaryKeyProperties: [
      { key: "comuni", alias: "nome", queryProperty: "comune", valueProperty: "percentuale" },
    ],
  },
];

const feature = (props: Record<string, unknown>, lon = 12, lat = 43): Feature<Point> => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lon, lat] },
  properties: props,
});

const FEATURES = [
  feature({
    tipo: "strada",
    costo: 100,
    temi: ["a", "b"],
    data: "2024-03-01",
    comune: "Ancona",
    ripartizione: {
      comuni: [
        { nome: "Ancona", percentuale: 75 },
        { nome: "Jesi", percentuale: 25 },
      ],
    },
  }),
  feature({
    tipo: "ponte",
    costo: 300,
    temi: ["a"],
    data: "2024-06-15",
    comune: "Jesi",
    ripartizione: { comuni: [{ nome: "Jesi", percentuale: 100 }] },
  }),
  feature({
    tipo: "strada",
    costo: "50,5",
    temi: [],
    data: "2023-12-31",
    comune: "Ancona",
    ripartizione: { comuni: [{ nome: "Ancona", percentuale: 100 }] },
  }),
];

describe("feature query: options", () => {
  it("offers the groupable properties minus the constrained ones, count then sums, the dictionary", () => {
    assert.deepEqual(
      aggregateFieldOptions(PROPERTIES).map((o) => o.key),
      ["tipo", "temi", "comune"],
    );
    const filters: LayerQuickFilter[] = [
      { id: "f", field: "tipo", kind: "categorical", values: ["strada"] },
      { id: "g", field: "comune", kind: "categorical", values: [] },
      { id: "h", field: "temi", kind: "text", text: "", enabled: false },
    ];
    assert.deepEqual(
      aggregateFieldOptions(PROPERTIES, filters).map((o) => o.key),
      ["temi", "comune"],
      "an answered filter removes its field; an empty or muted one does not",
    );
    const functions = aggregateFunctionOptions(PROPERTIES, "Conta", (l) => `Somma ${l}`);
    assert.deepEqual(
      functions.map((f) => [f.key, f.label, f.measureUnit, f.decimalPlaces]),
      [
        ["count", "Conta", undefined, 0],
        ["costo", "Somma Costo", "€", 2],
      ],
    );
    assert.equal(distributionProperty(PROPERTIES), "ripartizione");
    assert.deepEqual(
      queryTableColumns(PROPERTIES).map((c) => c.propertyName),
      ["tipo", "costo", "temi", "comune"],
    );
  });

  it("seeds one quick filter per property by type and keeps those already there", () => {
    const seeded = quickFiltersForQueryableProperties(PROPERTIES, [
      { id: "mine", field: "tipo", kind: "categorical", values: ["ponte"] },
    ]);
    assert.deepEqual(
      seeded.map((f) => [f.field, f.kind, f.id]),
      [
        ["tipo", "categorical", "mine"],
        ["costo", "range", "query:costo"],
        ["temi", "text", "query:temi"],
        ["data", "date", "query:data"],
        ["comune", "categorical", "query:comune"],
      ],
    );
    assert.equal(seeded[2].operator, "contains", "a multi-value enum matches by containment");
    assert.equal(seeded[3].dateKind, "iso");
  });

  it("lists distinct values, splitting multi-value strings", () => {
    assert.deepEqual(distinctValues(FEATURES, PROPERTIES[0]), ["ponte", "strada"]);
    assert.deepEqual(distinctValues(FEATURES, PROPERTIES[2]), ["a", "b"]);
    assert.deepEqual(distinctValues([feature({ temi: "b, c ,a" })], PROPERTIES[2]), [
      "a",
      "b",
      "c",
    ]);
  });
});

describe("feature query: matching and aggregation", () => {
  it("matches features with the same expression engine as the map", () => {
    const filters: LayerQuickFilter[] = [
      { id: "t", field: "tipo", kind: "categorical", values: ["strada"] },
      { id: "d", field: "data", kind: "date", start: "2024-01-01", end: null },
    ];
    const matcher = createQuickFilterMatcher(filters);
    assert.deepEqual(FEATURES.map(matcher), [true, false, false]);
    assert.equal(matchingFeatures(FEATURES, filters).length, 1);
    assert.equal(matchingFeatures(FEATURES, undefined).length, 3, "no filter: everything");
    assert.equal(
      matchingFeatures(FEATURES, [{ id: "r", field: "costo", kind: "range", min: 60, max: null }])
        .length,
      2,
      "the comma decimal is not a number to the map either",
    );
  });

  it("counts per category, with a multi-value property sharing the percentages", () => {
    const rows = aggregateFeatures(FEATURES, PROPERTIES, {
      aggregationProperty: "tipo",
      aggregationFunction: "count",
    });
    assert.deepEqual(rows, [
      { name: "strada", value: 2, valuePerc: 66.7 },
      { name: "ponte", value: 1, valuePerc: 33.3 },
    ]);
    const themes = aggregateFeatures(FEATURES, PROPERTIES, {
      aggregationProperty: "temi",
      aggregationFunction: "count",
    });
    assert.deepEqual(
      themes,
      [
        { name: "a", value: 2, valuePerc: 50 },
        { name: "b", value: 1, valuePerc: 16.7 },
      ],
      "feature 1 counts half towards a and half towards b; feature 3 has no theme",
    );
  });

  it("sums a property per category and spreads it through the dictionary", () => {
    const sums = aggregateFeatures(FEATURES, PROPERTIES, {
      aggregationProperty: "tipo",
      aggregationFunction: "costo",
    });
    assert.deepEqual(
      sums,
      [
        { name: "strada", value: 150.5, valuePerc: 33.4 },
        { name: "ponte", value: 300, valuePerc: 66.6 },
      ],
      "a comma decimal is read as a number",
    );
    const spread = aggregateFeatures(FEATURES, PROPERTIES, {
      aggregationProperty: "comune",
      aggregationFunction: "costo",
      distributionProperty: "ripartizione",
    });
    assert.deepEqual(
      spread,
      [
        { name: "Ancona", value: 125.5, valuePerc: 27.9 },
        { name: "Jesi", value: 325, valuePerc: 72.1 },
      ],
      "75 % of the first cost goes to Ancona, 25 % to Jesi",
    );
    const counted = aggregateFeatures(FEATURES, PROPERTIES, {
      aggregationProperty: "comune",
      aggregationFunction: "count",
      distributionProperty: "ripartizione",
    });
    assert.deepEqual(
      counted.map((r) => r.name),
      ["Ancona", "Jesi"],
      "a count ignores the dictionary, as the old window did",
    );
    assert.deepEqual(
      aggregateFeatures([], PROPERTIES, {
        aggregationProperty: "tipo",
        aggregationFunction: "count",
      }),
      [],
    );
  });

  it("writes the table, the aggregation and the export as CSV", () => {
    const table = queryTableCsv(FEATURES.slice(0, 1), queryTableColumns(PROPERTIES));
    assert.equal(table, 'Tipo,Costo,Temi,Comune\nstrada,100,"a, b",Ancona');
    const agg = aggregationCsv([{ name: 'a "b"', value: 1.5, valuePerc: 50 }], {
      category: "Categoria",
      value: "Valore",
      percentage: "Percentuale",
    });
    assert.equal(agg, 'Categoria,Valore,Percentuale\n"a ""b""",1.5,50');
    const exported = exportFeaturesCsv([feature({ id: "x", nome: "Via; larga" }, 12.5, 43.25)]);
    assert.equal(exported, 'id;nome;lat;lon\nx;"Via; larga";43.25;12.5');
    assert.equal(exportFeaturesCsv([]), "0 features\n");
  });
});
