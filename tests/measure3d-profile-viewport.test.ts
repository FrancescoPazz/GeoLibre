import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fitMeasure3dProfileViewport,
  minimumMeasure3dProfileSpan,
  panMeasure3dProfileViewport,
  visibleMeasure3dProfilePoints,
  zoomMeasure3dProfileViewport,
} from "../apps/geolibre-desktop/src/components/panels/measure3dProfileViewport";

const points = [
  { distance: 0, elevation: 100 },
  { distance: 10, elevation: 200 },
  { distance: 20, elevation: 100 },
];

describe("3D Measure profile viewport", () => {
  it("fits the full profile and keeps a cursor anchor stable while zooming", () => {
    const full = fitMeasure3dProfileViewport(points);
    assert.deepEqual(full, { start: 0, end: 20 });
    assert.deepEqual(zoomMeasure3dProfileViewport(full, points, 10, 0.5), {
      start: 5,
      end: 15,
    });
  });

  it("zooms about the viewport center when the anchor is not finite", () => {
    const full = fitMeasure3dProfileViewport(points);
    assert.deepEqual(zoomMeasure3dProfileViewport(full, points, NaN, 0.5), {
      start: 5,
      end: 15,
    });
  });

  it("caps zoom-out at the full profile and zoom-in at one sampled interval", () => {
    const view = { start: 5, end: 15 };
    assert.equal(minimumMeasure3dProfileSpan(points), 10);
    assert.deepEqual(zoomMeasure3dProfileViewport(view, points, 10, 10), {
      start: 0,
      end: 20,
    });
    assert.deepEqual(zoomMeasure3dProfileViewport(view, points, 10, 0.01), {
      start: 5,
      end: 15,
    });
  });

  it("pans within the profile extent", () => {
    assert.deepEqual(panMeasure3dProfileViewport({ start: 5, end: 15 }, points, 100), {
      start: 10,
      end: 20,
    });
    assert.deepEqual(panMeasure3dProfileViewport({ start: 5, end: 15 }, points, -100), {
      start: 0,
      end: 10,
    });
  });

  it("interpolates and rebases viewport boundaries for accurate local elevation", () => {
    assert.deepEqual(visibleMeasure3dProfilePoints(points, { start: 5, end: 15 }), [
      { distance: 0, elevation: 150 },
      { distance: 5, elevation: 200 },
      { distance: 10, elevation: 150 },
    ]);
  });
});
