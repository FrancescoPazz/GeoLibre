import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as Cesium from "@cesium/engine";
import {
  angleArc,
  angleDegrees,
  circleRing,
  circleSegmentCount,
  computeMeasures,
  formatDegrees,
  formatMeters,
  formatSquareMeters,
  geodesicInterpolate,
  geodesicMeters,
  insertTolerance,
  nearestSegment,
  pointToSegment,
  polygonGeodeticAreaSqm,
  verticesCentroid,
} from "../packages/plugins/src/plugins/rer-3d-tools/draw-geometry";

// The measures the geoportal shows are checked against values that can be
// derived independently: the WGS84 equatorial degree, the polar quarter
// meridian, right angles, and small figures whose planar area is a good
// approximation of the geodetic one.

const { Cartesian3 } = Cesium;
const P = (lng: number, lat: number, alt = 0) => ({ lng, lat, alt });

/** One degree of longitude on the WGS84 equator. */
const EQUATORIAL_DEGREE_M = 111_319.4908;

describe("geodesicMeters", () => {
  it("measures one equatorial degree to the centimetre", () => {
    const meters = geodesicMeters(Cesium, P(0, 0), P(1, 0));
    assert.ok(Math.abs(meters - EQUATORIAL_DEGREE_M) < 0.01, `${meters}`);
  });

  it("measures the meridian quarter from the equator to the pole", () => {
    const meters = geodesicMeters(Cesium, P(0, 0), P(0, 90));
    assert.ok(Math.abs(meters - 10_001_965.73) < 1, `${meters}`);
  });

  it("ignores height: a raised point is the same distance away", () => {
    assert.equal(
      geodesicMeters(Cesium, P(11, 44, 0), P(11.1, 44, 0)),
      geodesicMeters(Cesium, P(11, 44, 900), P(11.1, 44, 2000)),
    );
  });

  it("interpolates the midpoint of a segment", () => {
    const mid = geodesicInterpolate(Cesium, P(0, 0, 100), P(1, 0, 300), 0.5);
    assert.ok(Math.abs(mid.lng - 0.5) < 1e-9);
    assert.ok(Math.abs(mid.lat) < 1e-9);
    assert.equal(mid.alt, 200);
  });
});

describe("polygonGeodeticAreaSqm", () => {
  it("is zero below three vertices", () => {
    assert.equal(polygonGeodeticAreaSqm(Cesium, [P(0, 0), P(0.01, 0)]), 0);
  });

  it("matches the planar area of a small quadrilateral to a tenth of a percent", () => {
    // 0.01° × 0.01° at the equator: ~1113 m east-west but ~1106 m north-south,
    // since a degree of latitude is shorter than a degree of longitude there.
    const s = 0.01;
    const ring = [P(0, 0), P(s, 0), P(s, s), P(0, s)];
    const eastWest = geodesicMeters(Cesium, P(0, 0), P(s, 0));
    const northSouth = geodesicMeters(Cesium, P(0, 0), P(0, s));
    const expected = eastWest * northSouth;
    const area = polygonGeodeticAreaSqm(Cesium, ring);
    assert.ok(Math.abs(area - expected) / expected < 0.001, `${area} vs ${expected}`);
  });

  it("fans from the first vertex, so a concave ring still sums its triangles", () => {
    // An L-shape: a square with a quarter cut away.
    const s = 0.01;
    const ring = [P(0, 0), P(s, 0), P(s, s / 2), P(s / 2, s / 2), P(s / 2, s), P(0, s)];
    const eastWest = geodesicMeters(Cesium, P(0, 0), P(s, 0));
    const northSouth = geodesicMeters(Cesium, P(0, 0), P(0, s));
    const expected = eastWest * northSouth * 0.75;
    const area = polygonGeodeticAreaSqm(Cesium, ring);
    assert.ok(Math.abs(area - expected) / expected < 0.002, `${area} vs ${expected}`);
  });

  it("contributes only floating-point noise for a collinear triangle", () => {
    // Heron on three geodesics that add up exactly leaves s − c at the
    // rounding floor, so the area is a few hundredths of a square metre
    // rather than zero — the same noise the formula has always produced.
    const area = polygonGeodeticAreaSqm(Cesium, [P(0, 0), P(0.01, 0), P(0.02, 0)]);
    assert.ok(area >= 0 && area < 0.1, `${area}`);
  });
});

describe("angleDegrees / angleArc", () => {
  const vertex = Cartesian3.fromDegrees(11, 44, 0);
  // Arms along the local east and north axes, so the angle is a right angle.
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(vertex);
  const along = (x: number, y: number) =>
    Cesium.Matrix4.multiplyByPoint(enu, new Cartesian3(x, y, 0), new Cartesian3());

  it("reports a right angle between east and north arms", () => {
    assert.equal(angleDegrees(Cesium, along(1000, 0), vertex, along(0, 1000)), 90);
  });

  it("reports a straight angle for opposite arms, rounded to two decimals", () => {
    assert.equal(angleDegrees(Cesium, along(1000, 0), vertex, along(-1000, 0)), 180);
    const forty5 = angleDegrees(Cesium, along(1000, 0), vertex, along(1000, 1000));
    assert.equal(forty5, 45);
  });

  it("sweeps an arc from the first arm to the second at a fraction of the shorter arm", () => {
    const a = along(1000, 0);
    const c = along(0, 500);
    const arc = angleArc(Cesium, a, vertex, c, 10, 0.6);
    assert.equal(arc.length, 11);
    for (const point of arc) {
      assert.ok(Math.abs(Cartesian3.distance(point, vertex) - 300) < 1e-6);
    }
    // The arc starts on arm a and ends on arm c.
    const dirA = Cartesian3.normalize(
      Cartesian3.subtract(a, vertex, new Cartesian3()),
      new Cartesian3(),
    );
    const first = Cartesian3.normalize(
      Cartesian3.subtract(arc[0], vertex, new Cartesian3()),
      new Cartesian3(),
    );
    assert.ok(Cartesian3.dot(dirA, first) > 0.9999);
    const dirC = Cartesian3.normalize(
      Cartesian3.subtract(c, vertex, new Cartesian3()),
      new Cartesian3(),
    );
    const last = Cartesian3.normalize(
      Cartesian3.subtract(arc[10], vertex, new Cartesian3()),
      new Cartesian3(),
    );
    assert.ok(Cartesian3.dot(dirC, last) > 0.9999);
  });

  it("draws no arc for a degenerate angle", () => {
    assert.deepEqual(angleArc(Cesium, vertex, vertex, along(1, 0)), []);
  });
});

describe("circleRing", () => {
  it("traces a closed ring whose points sit at the radius from the centre", () => {
    const center = P(11, 44, 0);
    const ring = circleRing(Cesium, center, 500, 64);
    assert.equal(ring.length, 65);
    assert.deepEqual(ring[0], ring[64]);
    for (const point of ring.slice(0, 64)) {
      // The trace uses the equatorial radius on a sphere; the ellipsoidal
      // geodesic differs from 500 m by well under a percent at 44° N.
      const r = geodesicMeters(Cesium, center, point);
      assert.ok(Math.abs(r - 500) / 500 < 0.01, `${r}`);
    }
  });

  it("uses one segment per ~20 m of perimeter, between 64 and 512", () => {
    assert.equal(circleSegmentCount(10), 64);
    assert.equal(circleSegmentCount(1000), Math.ceil((2 * Math.PI * 1000) / 20));
    assert.equal(circleSegmentCount(100_000), 512);
  });
});

describe("computeMeasures", () => {
  it("sums segments for a line and adds the closing edge and area for a closed polygon", () => {
    const s = 0.01;
    const points = [P(0, 0), P(s, 0), P(s, s), P(0, s)];
    const open = computeMeasures(Cesium, { mode: "polygon", points, closed: false });
    assert.equal(open.segmentMeters.length, 3);
    assert.equal(open.areaSqm, null);
    const closed = computeMeasures(Cesium, { mode: "polygon", points, closed: true });
    assert.equal(closed.segmentMeters.length, 4);
    assert.ok(closed.areaSqm && closed.areaSqm > 0);
    assert.ok(
      Math.abs(closed.totalMeters - closed.segmentMeters.reduce((a, b) => a + b, 0)) < 1e-9,
    );
  });

  it("gives an angle only once three points exist", () => {
    const two = computeMeasures(Cesium, {
      mode: "angle",
      points: [P(0, 0), P(0.01, 0)],
      closed: false,
    });
    assert.equal(two.angleDeg, null);
    const three = computeMeasures(Cesium, {
      mode: "angle",
      points: [P(0.01, 0), P(0, 0), P(0, 0.01)],
      closed: false,
    });
    assert.ok(three.angleDeg !== null && Math.abs(three.angleDeg - 90) < 0.05, `${three.angleDeg}`);
  });

  it("derives a circle's perimeter and area from its geodesic radius", () => {
    const m = computeMeasures(Cesium, {
      mode: "circle",
      points: [P(0, 0), P(0.01, 0)],
      closed: false,
    });
    const r = geodesicMeters(Cesium, P(0, 0), P(0.01, 0));
    assert.equal(m.circleRadiusMeters, r);
    assert.equal(m.circlePerimeterMeters, 2 * Math.PI * r);
    assert.equal(m.circleAreaSqm, Math.PI * r * r);
    assert.deepEqual(m.segmentMeters, []);
  });

  it("measures nothing for points", () => {
    const m = computeMeasures(Cesium, { mode: "point", points: [P(0, 0), P(1, 1)], closed: false });
    assert.equal(m.totalMeters, 0);
    assert.deepEqual(m.segmentMeters, []);
  });
});

describe("segment hit-testing", () => {
  const a = Cartesian3.fromDegrees(0, 0, 0);
  const b = Cartesian3.fromDegrees(0.01, 0, 0);

  it("measures the perpendicular distance and the foot's position along the segment", () => {
    const mid = Cartesian3.lerp(a, b, 0.5, new Cartesian3());
    const up = Cartesian3.normalize(mid, new Cartesian3());
    const above = Cartesian3.add(
      mid,
      Cartesian3.multiplyByScalar(up, 10, new Cartesian3()),
      new Cartesian3(),
    );
    const { meters, t } = pointToSegment(Cesium, above, a, b);
    assert.ok(Math.abs(meters - 10) < 1e-6);
    assert.ok(Math.abs(t - 0.5) < 1e-9);
  });

  it("clamps the foot to the segment ends", () => {
    const beyond = Cartesian3.lerp(a, b, 1.5, new Cartesian3());
    assert.equal(pointToSegment(Cesium, beyond, a, b).t, 1);
  });

  it("finds the segment a click lands on and where to insert", () => {
    const points = [P(0, 0), P(0.01, 0), P(0.02, 0)];
    const onSecond = Cartesian3.fromDegrees(0.015, 0.00001, 0);
    const hit = nearestSegment(Cesium, points, onSecond, () => 5);
    assert.ok(hit);
    assert.equal(hit.insertAt, 2);
  });

  it("ignores a click too far from every segment, or at a vertex", () => {
    const points = [P(0, 0), P(0.01, 0)];
    assert.equal(
      nearestSegment(Cesium, points, Cartesian3.fromDegrees(0.005, 0.001, 0), () => 5),
      null,
    );
    assert.equal(
      nearestSegment(Cesium, points, a, () => 5),
      null,
    );
  });

  it("tests the closing edge of a closed ring", () => {
    const points = [P(0, 0), P(0.01, 0), P(0.01, 0.01), P(0, 0.01)];
    const onClosing = Cartesian3.fromDegrees(0, 0.005, 0);
    assert.equal(
      nearestSegment(Cesium, points, onClosing, () => 5, false),
      null,
    );
    const hit = nearestSegment(Cesium, points, onClosing, () => 5, true);
    assert.ok(hit);
    assert.equal(hit.insertAt, 4);
  });

  it("widens the per-mille tolerance to a few pixels when zoomed out", () => {
    const tight = insertTolerance(0);
    assert.equal(tight(1000), 1);
    const loose = insertTolerance(10);
    assert.equal(loose(1000), 80);
    assert.equal(loose(1_000_000), 1000);
  });
});

describe("formatting and centroid", () => {
  it("formats the way the geoportal always has", () => {
    assert.equal(formatMeters(12.345), "12.35 m");
    assert.equal(formatMeters(999.999), "1000.00 m");
    assert.equal(formatMeters(1234.5), "1.23 km");
    assert.equal(formatSquareMeters(123.45), "123.5 m²");
    assert.equal(formatSquareMeters(12_345), "1.23 ha");
    assert.equal(formatSquareMeters(2_500_000), "2.50 km²");
    assert.equal(formatDegrees(45.678), "45.68°");
  });

  it("puts the area label at the mean of the vertices", () => {
    assert.deepEqual(verticesCentroid([P(0, 0, 0), P(2, 4, 100)]), P(1, 2, 50));
    assert.equal(verticesCentroid([]), null);
  });
});
