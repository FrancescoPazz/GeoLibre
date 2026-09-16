import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FeatureCollection } from "geojson";
import {
  GpxCoordinateError,
  gpxHasContent,
  writeGpx,
} from "../apps/geolibre-desktop/src/lib/gpx-writer";

const SAMPLE: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: "hut",
      geometry: { type: "Point", coordinates: [11.1234567891, 44.5, 1210.25] },
      properties: { name: "Rifugio & Co", description: "A <hut>", time: "2026-06-01T10:00:00Z" },
    },
    {
      type: "Feature",
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [11, 44, 100],
            [11.001, 44.001, 120],
          ],
          [[11.002, 44.002]],
        ],
      },
      properties: { name: "Track", population: 5 },
    },
    {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      },
      properties: {},
    },
  ],
};

describe("writeGpx", () => {
  it("writes waypoints, tracks and rings as GPX 1.1", () => {
    const gpx = writeGpx(SAMPLE, 'My "track"');
    assert.ok(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"'));
    assert.ok(gpx.includes('xmlns="http://www.topografix.com/GPX/1/1"'));
    assert.ok(gpx.includes("<name>My &quot;track&quot;</name>"));
    // The waypoint: 7-decimal coordinates, elevation, time, escaped name/desc.
    assert.ok(gpx.includes('<wpt lat="44.5" lon="11.1234568">'));
    assert.ok(gpx.includes("<ele>1210.25</ele>"));
    assert.ok(gpx.includes("<time>2026-06-01T10:00:00.000Z</time>"));
    assert.ok(gpx.includes("<name>Rifugio &amp; Co</name>"));
    assert.ok(gpx.includes("<desc>A &lt;hut&gt;</desc>"));
    // The track: one segment per part, no attribute table.
    assert.equal(gpx.match(/<trk>/g)?.length, 2);
    assert.equal(gpx.match(/<trkseg>/g)?.length, 3);
    assert.ok(gpx.includes('<trkpt lat="44.001" lon="11.001">'));
    assert.ok(!gpx.includes("population"));
    // The ring is closed when walked as a track.
    assert.equal(gpx.match(/<trkpt lat="0" lon="0" \/>/g)?.length, 2);
    // Waypoints come before tracks.
    assert.ok(gpx.indexOf("<wpt") < gpx.indexOf("<trk>"));
    assert.ok(gpx.trimEnd().endsWith("</gpx>"));
  });

  it("names a feature with a coordinate that is not a number", () => {
    const bad: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: 7,
          geometry: { type: "Point", coordinates: [1, NaN] },
          properties: {},
        },
      ],
    };
    assert.throws(
      () => writeGpx(bad, "x"),
      (error: unknown) => error instanceof GpxCoordinateError && error.featureId === 7,
    );
  });

  it("knows an empty or unusable collection from a usable one", () => {
    assert.equal(gpxHasContent({ type: "FeatureCollection", features: [] }), false);
    assert.equal(
      gpxHasContent({
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: {} }],
      }),
      false,
    );
    assert.equal(gpxHasContent(SAMPLE), true);
  });
});
