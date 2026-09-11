import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import {
  SAMPLING_STEP_DISABLED,
  SAMPLING_STEP_SERIES,
  buildTerrainProfile,
  densifyPath,
  flightSamplingStep,
  measureSampledPath,
  profileSamplingStep,
  sampleTerrain,
  samplingStepRange,
  snapSamplingStep,
} from "../packages/plugins/src/plugins/rer-3d-tools/terrain-profile";
import { geodesicMeters } from "../packages/plugins/src/plugins/rer-3d-tools/draw-geometry";

// The sampling-step cases are the geoportal's own, kept verbatim so the
// resolution of a profile taken here matches one taken before the migration.
// The terrain read is faked with a height function so the distances can be
// checked against hand-derived values.

const P = (lng: number, lat: number, alt = 0) => ({ lng, lat, alt });

describe("sampling step", () => {
  it("offers the round 1-2-5 steps a user would pick by hand", () => {
    assert.deepEqual([...SAMPLING_STEP_SERIES], [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]);
    assert.equal(SAMPLING_STEP_DISABLED, 0);
  });

  it("snaps to the series up, down and nearest", () => {
    assert.equal(snapSamplingStep(0.3), 1);
    assert.equal(snapSamplingStep(9999), 2000);
    assert.equal(snapSamplingStep(30, "down"), 20);
    assert.equal(snapSamplingStep(30, "up"), 50);
    assert.equal(snapSamplingStep(30), 20);
    assert.equal(snapSamplingStep(40), 50);
    assert.equal(snapSamplingStep(50, "up"), 50);
  });

  it("has no range to offer without a path", () => {
    assert.deepEqual(samplingStepRange(undefined), [0, 0]);
    assert.deepEqual(samplingStepRange(0), [0, 0]);
    assert.deepEqual(samplingStepRange(-100), [0, 0]);
  });

  it("keeps a 100 km path between a thousand and ten samples", () => {
    assert.deepEqual(samplingStepRange(100_000), [100, 2000]);
  });

  it("scales the range down with the path", () => {
    assert.deepEqual(samplingStepRange(1000), [1, 100]);
  });

  it("still offers a few steps to choose from on a very short path", () => {
    assert.deepEqual(samplingStepRange(20), [1, 5]);
  });

  it("never asks for a step outside the series", () => {
    assert.deepEqual(samplingStepRange(10_000_000), [2000, 2000]);
    assert.deepEqual(samplingStepRange(0.5), [1, 5]);
  });

  it("only ever returns steps from the series", () => {
    for (const length of [1, 7, 33, 250, 1234, 56_789, 100_000, 987_654]) {
      const [min, max] = samplingStepRange(length);
      assert.ok(SAMPLING_STEP_SERIES.includes(min));
      assert.ok(SAMPLING_STEP_SERIES.includes(max));
      assert.ok(min <= max);
    }
  });

  it("profile: sits in the middle of the range when the zoom is unknown", () => {
    assert.equal(profileSamplingStep(undefined), 0);
    assert.equal(profileSamplingStep(0), 0);
    assert.equal(profileSamplingStep(100_000), 500);
    assert.equal(profileSamplingStep(1000), 10);
  });

  it("profile: ignores a zoom that says nothing useful", () => {
    const withoutZoom = profileSamplingStep(100_000);
    assert.equal(profileSamplingStep(100_000, 0), withoutZoom);
    assert.equal(profileSamplingStep(100_000, -5), withoutZoom);
    assert.equal(profileSamplingStep(100_000, NaN), withoutZoom);
    assert.equal(profileSamplingStep(100_000, Infinity), withoutZoom);
  });

  it("profile: samples more finely as the map is zoomed in, blending the zoom halfway", () => {
    const zoomedIn = profileSamplingStep(100_000, 1);
    const middle = profileSamplingStep(100_000);
    const zoomedOut = profileSamplingStep(100_000, 5000);
    assert.ok(zoomedIn < middle);
    assert.ok(middle <= zoomedOut);
    assert.equal(profileSamplingStep(100_000, 1), 100);
    for (const res of [0.5, 2, 30, 300, 3000]) {
      const [min, max] = samplingStepRange(100_000);
      const step = profileSamplingStep(100_000, res);
      assert.ok(step >= min && step <= max);
      assert.ok(SAMPLING_STEP_SERIES.includes(step));
    }
  });

  it("flight: follows the zoom rather than the path length, clamped by the range", () => {
    assert.equal(flightSamplingStep(undefined), 0);
    assert.equal(flightSamplingStep(100_000), profileSamplingStep(100_000));
    assert.equal(flightSamplingStep(100_000, 30), 200);
    assert.equal(flightSamplingStep(200_000, 30), 200);
    assert.ok(flightSamplingStep(100_000, 1) < flightSamplingStep(100_000));
    assert.ok(flightSamplingStep(100_000, 5000) > flightSamplingStep(100_000));
    const [min, max] = samplingStepRange(100_000);
    assert.equal(flightSamplingStep(100_000, 0.01), min);
    assert.equal(flightSamplingStep(100_000, 100_000), max);
  });
});

describe("densifyPath", () => {
  it("walks each segment at the step and marks where the vertices sit", () => {
    // ~1113 m east then ~1106 m north at the equator, step 250 m.
    const points = [P(0, 0), P(0.01, 0), P(0.01, 0.01)];
    const { cartographics, stopIndex, segmentGeodeticM } = densifyPath(Cesium, points, 250);
    assert.deepEqual(stopIndex, [0, 5, 10]);
    assert.equal(cartographics.length, 11);
    assert.equal(segmentGeodeticM[0], 0);
    assert.ok(Math.abs(segmentGeodeticM[1] - geodesicMeters(Cesium, points[0], points[1])) < 1e-6);
    // Interpolated positions sit on the segment, 250 m apart.
    const second = cartographics[1];
    assert.ok(Math.abs(Cesium.Math.toDegrees(second.latitude)) < 1e-9);
    const first = cartographics[0];
    const geodesic = new Cesium.EllipsoidGeodesic(first, second);
    assert.ok(Math.abs(geodesic.surfaceDistance - 250) < 1e-6);
  });

  it("uses only the vertices when sampling is disabled", () => {
    const points = [P(0, 0), P(0.01, 0), P(0.01, 0.01)];
    const { cartographics, stopIndex } = densifyPath(Cesium, points, SAMPLING_STEP_DISABLED);
    assert.equal(cartographics.length, 3);
    assert.deepEqual(stopIndex, [0, 1, 2]);
  });

  it("adds the closing edge of a closed ring", () => {
    const points = [P(0, 0), P(0.01, 0), P(0.01, 0.01)];
    const { stopIndex, segmentGeodeticM } = densifyPath(Cesium, points, 0, true);
    assert.equal(stopIndex.length, 4);
    assert.equal(segmentGeodeticM.length, 4);
  });

  it("handles an empty and a single-point path", () => {
    assert.deepEqual(densifyPath(Cesium, [], 10).cartographics, []);
    assert.equal(densifyPath(Cesium, [P(0, 0)], 10).cartographics.length, 1);
  });
});

/** A terrain whose height is a function of position, answered like Cesium's. */
function fakeTerrain(heightAt: (lngDeg: number, latDeg: number) => number) {
  const calls: number[] = [];
  const C = {
    ...Cesium,
    sampleTerrainMostDetailed: async (_provider: unknown, positions: Cesium.Cartographic[]) => {
      calls.push(positions.length);
      for (const p of positions) {
        p.height = heightAt(Cesium.Math.toDegrees(p.longitude), Cesium.Math.toDegrees(p.latitude));
      }
      return positions;
    },
  } as unknown as typeof Cesium;
  const provider = { availability: {} } as unknown as Cesium.TerrainProvider;
  return { C, provider, calls };
}

describe("sampleTerrain / measureSampledPath", () => {
  it("reads heights from the terrain and reports a detailed profile", async () => {
    const { C, provider, calls } = fakeTerrain((lng) => 100 + lng * 1000);
    const cartos = [
      Cesium.Cartographic.fromDegrees(0, 0),
      Cesium.Cartographic.fromDegrees(0.01, 0),
    ];
    const { sampled, detailed } = await sampleTerrain(C, provider, cartos);
    assert.equal(detailed, true);
    assert.deepEqual(calls, [2]);
    assert.ok(Math.abs(sampled[0].height - 100) < 1e-9);
    assert.ok(Math.abs(sampled[1].height - 110) < 1e-9);
    assert.equal(cartos[0].height, 0, "the input is not mutated");
  });

  it("keeps the vertices' own heights without availability data, and on a failed read", async () => {
    const cartos = [
      Cesium.Cartographic.fromDegrees(0, 0, 42),
      Cesium.Cartographic.fromDegrees(0.01, 0, 42),
    ];
    const flat = await sampleTerrain(Cesium, {} as Cesium.TerrainProvider, cartos);
    assert.equal(flat.detailed, false);
    assert.equal(flat.sampled[0].height, 42);
    const failing = {
      ...Cesium,
      sampleTerrainMostDetailed: async () => {
        throw new Error("tile failed");
      },
    } as unknown as typeof Cesium;
    const kept = await sampleTerrain(
      failing,
      { availability: {} } as unknown as Cesium.TerrainProvider,
      cartos,
    );
    assert.equal(kept.detailed, true);
    assert.equal(kept.sampled[1].height, 42);
  });

  it("subtracts the geoid undulation when a geoid is given", async () => {
    const { C, provider } = fakeTerrain(() => 100);
    const cartos = [Cesium.Cartographic.fromDegrees(11, 44)];
    const { sampled } = await sampleTerrain(C, provider, cartos, async (ps) => ps.map(() => 42));
    assert.ok(Math.abs(sampled[0].height - 58) < 1e-9);
  });

  it("derives geodesic, air and ground distances from a sampled path", async () => {
    // A ridge: the ground rises 100 m to the middle vertex and falls back. The
    // peak is a vertex, so it is always a sample whatever the step.
    const points = [P(0, 0), P(0.005, 0), P(0.01, 0)];
    const { C, provider } = fakeTerrain((lng) =>
      Math.max(0, 100 * (1 - Math.abs(lng - 0.005) / 0.005)),
    );
    const profile = await buildTerrainProfile(C, provider, points, { stepMeters: 100 });
    const geodesic = geodesicMeters(Cesium, points[0], points[2]);
    assert.ok(Math.abs(profile.totalGeodeticM - geodesic) < 1e-6);
    // Two straight ramps of ~556 m horizontal and 100 m rise: the air line
    // (chords between vertices) and the ground (samples on the ramps) both
    // come to ~2 × 565 m, longer than the geodesic they stand on.
    const expectedGround = 2 * Math.hypot(geodesic / 2, 100);
    assert.ok(profile.totalAirM > profile.totalGeodeticM);
    assert.ok(
      Math.abs(profile.totalAirM - expectedGround) < 0.05,
      `${profile.totalAirM} vs ${expectedGround}`,
    );
    assert.ok(
      Math.abs(profile.totalGroundM - expectedGround) < 0.05,
      `${profile.totalGroundM} vs ${expectedGround}`,
    );
    assert.ok(Math.abs(profile.maxAlt - 100) < 1e-6);
    assert.ok(Math.abs(profile.minAlt) < 1e-6);
    assert.equal(profile.samplingStepM, 100);
    assert.equal(profile.detailed, true);
    // Samples carry a cumulative ground distance.
    const last = profile.samples[profile.samples.length - 1];
    assert.ok(Math.abs(last.distanceM - profile.totalGroundM) < 1e-9);
    assert.equal(profile.samples[0].distanceM, 0);
    assert.equal(profile.stopIndex.length, 3);
    assert.equal(profile.stopIndex[2], profile.samples.length - 1);
    assert.ok(
      Math.abs(profile.samples[profile.stopIndex[1]].alt - 100) < 1e-6,
      "the peak vertex is a sample",
    );
    assert.equal(profile.segmentAirM.length, 3);
    assert.ok(Math.abs(profile.segmentAirM[1] - Math.hypot(geodesic / 2, 100)) < 0.05);
  });

  it("falls back to geodesic ground distances when the terrain is not detailed", () => {
    const sampled = [
      Cesium.Cartographic.fromDegrees(0, 0),
      Cesium.Cartographic.fromDegrees(0.01, 0),
    ];
    const geodesic = geodesicMeters(Cesium, P(0, 0), P(0.01, 0));
    const profile = measureSampledPath(Cesium, sampled, [0, 1], [0, geodesic], false, 0);
    assert.equal(profile.segmentGroundM[1], geodesic);
    assert.ok(Math.abs(profile.totalGroundM - geodesic) < 1e-9);
  });
});
