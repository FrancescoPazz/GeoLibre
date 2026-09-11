import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import {
  EGM96_COLUMNS,
  EGM96_GRID_BYTES,
  EGM96_ROWS,
  createEgm96Geoid,
  decodeEgm96Grid,
  egm96UndulationMeters,
} from "../packages/plugins/src/plugins/rer-3d-tools/egm96";

// A synthetic grid stands in for the real WW15MGH.DAC: each node holds a
// value derived from its row and column, so interpolation, wrap-around and
// clamping can be checked exactly without the 2 MB file.

function syntheticGridBuffer(valueAt: (row: number, column: number) => number): ArrayBuffer {
  const buffer = new ArrayBuffer(EGM96_GRID_BYTES);
  const view = new DataView(buffer);
  for (let r = 0; r < EGM96_ROWS; r += 1) {
    for (let c = 0; c < EGM96_COLUMNS; c += 1) {
      view.setInt16((r * EGM96_COLUMNS + c) * 2, valueAt(r, c), false);
    }
  }
  return buffer;
}

const deg = (d: number) => (d * Math.PI) / 180;

describe("decodeEgm96Grid", () => {
  it("reads big-endian centimetres into a row-major grid", () => {
    const grid = decodeEgm96Grid(syntheticGridBuffer((r, c) => (r === 3 && c === 5 ? -1234 : 0)));
    assert.equal(grid.length, EGM96_ROWS * EGM96_COLUMNS);
    assert.equal(grid[3 * EGM96_COLUMNS + 5], -1234);
  });

  it("refuses a file of the wrong size", () => {
    assert.throws(() => decodeEgm96Grid(new ArrayBuffer(10)), /expected 2076480 bytes/);
  });
});

describe("egm96UndulationMeters", () => {
  // Value = 20 × row + column centimetres (linear, and within int16), so nodes
  // and midpoints interpolate exactly.
  const grid = decodeEgm96Grid(syntheticGridBuffer((r, c) => 20 * r + c));

  it("returns the node value at a grid node", () => {
    // Row 0 is the north pole; row 360 is the equator; column 4 is 1° E.
    assert.equal(egm96UndulationMeters(grid, deg(1), deg(0)), (20 * 360 + 4) / 100);
    assert.equal(egm96UndulationMeters(grid, 0, Math.PI / 2), 0);
  });

  it("interpolates bilinearly between nodes", () => {
    // Halfway between columns 4 and 5 on the equator row.
    const half = egm96UndulationMeters(grid, deg(1.125), deg(0));
    assert.ok(Math.abs(half - (20 * 360 + 4.5) / 100) < 1e-9);
    // Halfway between rows 360 and 361 (0.125° south of the equator), column 0.
    const rowHalf = egm96UndulationMeters(grid, 0, deg(-0.125));
    assert.ok(Math.abs(rowHalf - (20 * 360.5) / 100) < 1e-9);
  });

  it("wraps longitude at the antimeridian and accepts negative longitudes", () => {
    const west = egm96UndulationMeters(grid, deg(-0.25), deg(0));
    const east = egm96UndulationMeters(grid, deg(359.75), deg(0));
    assert.equal(west, east);
    assert.equal(west, (20 * 360 + 1439) / 100);
    // Just past the last column the interpolation reaches back to column 0.
    const between = egm96UndulationMeters(grid, deg(359.875), deg(0));
    assert.ok(Math.abs(between - (20 * 360 + (1439 + 0) / 2) / 100) < 1e-9);
  });

  it("clamps latitude at the poles", () => {
    assert.equal(egm96UndulationMeters(grid, 0, deg(95)), 0);
    assert.equal(egm96UndulationMeters(grid, 0, deg(-95)), (20 * 720) / 100);
  });
});

describe("createEgm96Geoid", () => {
  const buffer = syntheticGridBuffer(() => 4200);
  function fakeFetch(fail = false) {
    let calls = 0;
    const impl = async (_url: string) => {
      calls += 1;
      return {
        ok: !fail,
        status: fail ? 503 : 200,
        arrayBuffer: async () => buffer.slice(0),
      };
    };
    return { impl, calls: () => calls };
  }

  it("fetches the grid once and answers the GeoidHeights contract", async () => {
    const f = fakeFetch();
    const geoid = createEgm96Geoid("/geoid/WW15MGH.DAC", f.impl);
    assert.equal(geoid.loaded(), false);
    const positions = [
      Cesium.Cartographic.fromDegrees(11, 44),
      Cesium.Cartographic.fromDegrees(12, 45),
    ];
    const [a, b] = await Promise.all([geoid.heights(positions), geoid.height(11, 44)]);
    assert.deepEqual(a, [42, 42]);
    assert.equal(b, 42);
    assert.equal(f.calls(), 1, "concurrent callers share one fetch");
    assert.equal(geoid.loaded(), true);
    await geoid.height(0, 0);
    assert.equal(f.calls(), 1, "the grid is kept");
  });

  it("does not cache a failed fetch", async () => {
    const f = fakeFetch(true);
    const geoid = createEgm96Geoid("/geoid/WW15MGH.DAC", f.impl);
    await assert.rejects(geoid.height(0, 0), /HTTP 503/);
    await assert.rejects(geoid.height(0, 0));
    assert.equal(f.calls(), 2, "each call retried");
    assert.equal(geoid.loaded(), false);
  });
});
