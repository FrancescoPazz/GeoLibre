import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import type { Feature } from "geojson";
import {
  computeMeasures,
  geodesicMeters,
} from "../packages/plugins/src/plugins/rer-3d-tools/draw-geometry";
import {
  buildMeasureFeatureCollection,
  measureFileStem,
  measureSummaryKind,
  measureSummaryProperties,
  measureSummaryText,
  pathBearingDegrees,
} from "../packages/plugins/src/plugins/rer-3d-tools/measure-export";
import { buildTerrainProfile } from "../packages/plugins/src/plugins/rer-3d-tools/terrain-profile";

const P = (lng: number, lat: number, alt = 0) => ({ lng, lat, alt });
const A = P(11, 44.3, 100);
const B = P(11.01, 44.3, 150);
const C3 = P(11.01, 44.31, 120);

function props(f: Feature): Record<string, unknown> {
  return (f.properties ?? {}) as Record<string, unknown>;
}

describe("measureSummaryKind / pathBearingDegrees", () => {
  it("names the figure the way the summary does", () => {
    assert.equal(measureSummaryKind({ mode: "point", points: [A], closed: false }), "points");
    assert.equal(measureSummaryKind({ mode: "line", points: [A, B], closed: false }), "line");
    assert.equal(measureSummaryKind({ mode: "polygon", points: [A, B], closed: false }), "line");
    assert.equal(
      measureSummaryKind({ mode: "polygon", points: [A, B, C3], closed: true }),
      "polygon",
    );
    assert.equal(measureSummaryKind({ mode: "angle", points: [A, B, C3], closed: false }), "angle");
    assert.equal(measureSummaryKind({ mode: "circle", points: [A, B], closed: false }), "circle");
  });

  it("gives the initial bearing from first to last vertex, clockwise from north", () => {
    const east = pathBearingDegrees(Cesium, [P(0, 0), P(1, 0)]);
    assert.ok(east !== null && Math.abs(east - 90) < 1e-6);
    const north = pathBearingDegrees(Cesium, [P(0, 0), P(0, 1)]);
    assert.ok(north !== null && Math.abs(north) < 1e-6);
    const west = pathBearingDegrees(Cesium, [P(0, 0), P(-1, 0)]);
    assert.ok(west !== null && Math.abs(west - 270) < 1e-6);
    assert.equal(pathBearingDegrees(Cesium, [A]), null);
    assert.equal(pathBearingDegrees(Cesium, [A, A]), null);
  });
});

describe("buildMeasureFeatureCollection", () => {
  it("emits the line, one vertex point per stop with distances, and no profile without one", () => {
    const geometry = { mode: "line" as const, points: [A, B, C3], closed: false };
    const measures = computeMeasures(Cesium, geometry);
    const fc = buildMeasureFeatureCollection(Cesium, geometry, measures, null);
    assert.equal(fc.features.length, 4);
    const [figure, v1, v2, v3] = fc.features;
    assert.equal(figure.geometry.type, "LineString");
    assert.equal(props(figure).kind, "line");
    assert.equal(props(figure).feature, "figure");
    assert.equal(props(figure).geodetic_distance_m, Math.round(measures.totalMeters * 100) / 100);
    assert.equal(props(figure).alt_min_m, 100);
    assert.equal(props(figure).alt_max_m, 150);
    assert.equal(props(figure).alt_diff_m, 20);
    assert.equal(typeof props(figure).bearing_deg, "number");
    assert.equal(props(figure).air_distance_m, undefined, "no profile, no air distance");
    assert.deepEqual(
      [v1, v2, v3].map((v) => props(v).vertex),
      [1, 2, 3],
    );
    assert.equal(props(v1).geodetic_from_start_m, 0);
    assert.equal(
      props(v2).segment_geodetic_m,
      Math.round(geodesicMeters(Cesium, A, B) * 100) / 100,
    );
    assert.equal(props(v3).geodetic_from_start_m, Math.round(measures.totalMeters * 100) / 100);
    // Heights ride in the coordinates.
    assert.deepEqual((v2.geometry as { coordinates: number[] }).coordinates, [11.01, 44.3, 150]);
  });

  it("closes a polygon ring and reports its area", () => {
    const geometry = { mode: "polygon" as const, points: [A, B, C3], closed: true };
    const measures = computeMeasures(Cesium, geometry);
    const fc = buildMeasureFeatureCollection(Cesium, geometry, measures, null);
    const figure = fc.features[0];
    assert.equal(figure.geometry.type, "Polygon");
    const ring = (figure.geometry as { coordinates: number[][][] }).coordinates[0];
    assert.equal(ring.length, 4);
    assert.deepEqual(ring[0], ring[3]);
    assert.ok((props(figure).geodetic_area_m2 as number) > 0);
    assert.equal(props(figure).geodetic_perimeter_m, Math.round(measures.totalMeters * 100) / 100);
    assert.equal(
      props(figure).alt_diff_m,
      undefined,
      "a ring has no start-to-end height difference",
    );
  });

  it("traces a circle as a polygon with its centre", () => {
    const geometry = { mode: "circle" as const, points: [A, B], closed: false };
    const measures = computeMeasures(Cesium, geometry);
    const fc = buildMeasureFeatureCollection(Cesium, geometry, measures, null);
    assert.equal(fc.features.length, 2);
    assert.equal(fc.features[0].geometry.type, "Polygon");
    assert.equal(
      props(fc.features[0]).circle_radius_m,
      Math.round(measures.circleRadiusMeters! * 100) / 100,
    );
    assert.equal(fc.features[1].geometry.type, "Point");
    assert.equal(props(fc.features[1]).feature, "centre");
  });

  it("lists bare points without a figure, and an angle with its degrees", () => {
    const points = buildMeasureFeatureCollection(
      Cesium,
      { mode: "point", points: [A, B], closed: false },
      computeMeasures(Cesium, { mode: "point", points: [A, B], closed: false }),
      null,
    );
    assert.equal(points.features.length, 2);
    assert.ok(points.features.every((f) => f.geometry.type === "Point"));
    const angleGeometry = { mode: "angle" as const, points: [B, A, C3], closed: false };
    const angle = buildMeasureFeatureCollection(
      Cesium,
      angleGeometry,
      computeMeasures(Cesium, angleGeometry),
      null,
    );
    assert.equal(angle.features[0].geometry.type, "LineString");
    assert.equal(typeof props(angle.features[0]).angle_deg, "number");
  });

  it("adds the sampled profile as a line with heights and carries air/ground distances", async () => {
    const geometry = { mode: "line" as const, points: [A, B], closed: false };
    const measures = computeMeasures(Cesium, geometry);
    const C = {
      ...Cesium,
      sampleTerrainMostDetailed: async (_p: unknown, positions: Cesium.Cartographic[]) => {
        for (const c of positions) c.height = 100;
        return positions;
      },
    } as unknown as typeof Cesium;
    const profile = await buildTerrainProfile(C, { availability: {} } as never, geometry.points, {
      stepMeters: 100,
    });
    const fc = buildMeasureFeatureCollection(Cesium, geometry, measures, profile);
    const last = fc.features[fc.features.length - 1];
    assert.equal(props(last).feature, "profile");
    assert.equal(last.geometry.type, "LineString");
    assert.equal(props(last).sample_count, profile.samples.length);
    assert.equal(props(last).sampling_step_m, 100);
    const figure = fc.features[0];
    assert.equal(props(figure).air_distance_m, Math.round(profile.totalAirM * 100) / 100);
    assert.equal(props(figure).ground_distance_m, Math.round(profile.totalGroundM * 100) / 100);
    assert.equal(props(figure).terrain_sampled, true);
    assert.equal(
      props(fc.features[2]).segment_ground_m,
      Math.round(profile.segmentGroundM[1] * 100) / 100,
    );
  });

  it("returns an empty collection for an empty figure", () => {
    const geometry = { mode: "line" as const, points: [], closed: false };
    assert.equal(
      buildMeasureFeatureCollection(Cesium, geometry, computeMeasures(Cesium, geometry), null)
        .features.length,
      0,
    );
  });
});

describe("measureSummaryText", () => {
  it("writes the line summary the geoportal downloads", () => {
    const geometry = { mode: "line" as const, points: [A, B], closed: false };
    const measures = computeMeasures(Cesium, geometry);
    const text = measureSummaryText(Cesium, "Percorso 1", geometry, measures, null);
    const lines = text.split("\n");
    assert.equal(lines[0], "name: Percorso 1");
    assert.equal(lines[1], "kind: line");
    assert.ok(lines.includes("alt_min: 100.00 m"));
    assert.ok(lines.includes("alt_max: 150.00 m"));
    assert.ok(lines.includes("alt_diff: 50.00 m"));
    assert.ok(lines.some((l) => /^bearing: \d+\.\d°$/.test(l)));
    assert.ok(lines.includes(`geodetic_distance: ${measures.totalMeters.toFixed(2)} m`));
    assert.ok(!lines.some((l) => l.startsWith("air_distance")), "no profile, no air distance");
  });

  it("writes area in km2 and ha for a polygon, and radius/area for a circle", () => {
    const polygon = { mode: "polygon" as const, points: [A, B, C3], closed: true };
    const pm = computeMeasures(Cesium, polygon);
    const pt = measureSummaryText(Cesium, "Area", polygon, pm, null);
    assert.ok(pt.includes(`geodetic_area: ${(pm.areaSqm! / 1_000_000).toFixed(6)} km2`));
    assert.ok(pt.includes(`geodetic_area: ${(pm.areaSqm! * 0.0001).toFixed(4)} ha`));
    assert.ok(pt.includes(`geodetic_perimeter: ${pm.totalMeters.toFixed(2)} m`));
    const circle = { mode: "circle" as const, points: [A, B], closed: false };
    const cm = computeMeasures(Cesium, circle);
    const ct = measureSummaryText(Cesium, "Cerchio", circle, cm, null);
    assert.ok(ct.includes(`circle_radius: ${cm.circleRadiusMeters!.toFixed(2)} m`));
    assert.ok(ct.includes("circle_area:"));
  });

  it("shares its numbers with the layer properties", () => {
    const geometry = { mode: "line" as const, points: [A, B], closed: false };
    const measures = computeMeasures(Cesium, geometry);
    const p = measureSummaryProperties(Cesium, geometry, measures, null);
    const text = measureSummaryText(Cesium, "x", geometry, measures, null);
    assert.ok(
      text.includes(`geodetic_distance: ${(p.geodetic_distance_m as number).toFixed(2)} m`),
    );
  });
});

describe("measureFileStem", () => {
  it("keeps letters, digits, dash and underscore, and never returns an empty stem", () => {
    assert.equal(measureFileStem("Misura 3D — Linea"), "Misura_3D_Linea");
    assert.equal(measureFileStem("  percorso/1  "), "percorso_1");
    assert.equal(measureFileStem("***"), "measure");
  });
});
