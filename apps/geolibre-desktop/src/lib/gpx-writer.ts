import type { Feature, FeatureCollection, GeoJsonProperties, Position } from "geojson";

/**
 * GeoJSON → GPX 1.1. Points become waypoints, lines become tracks (one
 * segment per part of a MultiLineString), and polygon rings become tracks
 * too — GPX has no area, and a ring walked as a track is what a GPS unit
 * would record along the boundary. A feature's `name` and `description`
 * (or `desc`) fill the GPX elements of the same name; the third coordinate
 * becomes `<ele>`; a `time` property in ISO 8601 becomes `<time>`. Every
 * other property is dropped: GPX has no attribute table, and the export
 * menu offers GeoJSON or CSV for that.
 */

const GPX_NAMESPACE = "http://www.topografix.com/GPX/1/1";

export class GpxCoordinateError extends Error {
  constructor(
    readonly featureIndex: number,
    readonly featureId: string | number | undefined,
  ) {
    super(`Feature ${featureId ?? featureIndex} has a coordinate that is not a finite number.`);
    this.name = "GpxCoordinateError";
  }
}

class InvalidCoordinateError extends Error {}

function xmlSafeText(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "\uFFFD")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indent(lines: string[], spaces: number): string[] {
  const pad = " ".repeat(spaces);
  return lines.map((line) => `${pad}${line}`);
}

/** Plain decimals to 7 places (about a centimetre), trailing zeros dropped. */
function num(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const text = value.toFixed(7).replace(/\.?0+$/, "");
  return text === "-0" ? "0" : text;
}

/** `<wpt>`/`<trkpt>` attributes and children for one position. */
function pointLines(tag: "wpt" | "trkpt", position: Position, children: string[] = []): string[] {
  if (position.length < 2 || position.slice(0, 3).some((v) => !Number.isFinite(v))) {
    throw new InvalidCoordinateError();
  }
  const [lon, lat, ele] = position;
  const open = `<${tag} lat="${num(lat)}" lon="${num(lon)}">`;
  const inner = [...(ele !== undefined ? [`<ele>${num(ele)}</ele>`] : []), ...children];
  if (inner.length === 0) return [`<${tag} lat="${num(lat)}" lon="${num(lon)}" />`];
  return [open, ...indent(inner, 2), `</${tag}>`];
}

function text(properties: GeoJsonProperties, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = properties?.[key];
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    return String(value);
  }
  return null;
}

function timeElement(properties: GeoJsonProperties): string | null {
  const raw = text(properties, "time", "timestamp");
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : `<time>${date.toISOString()}</time>`;
}

/** The name/desc children shared by waypoints and tracks. */
function descriptionLines(properties: GeoJsonProperties): string[] {
  const name = text(properties, "name", "title");
  const desc = text(properties, "description", "desc");
  return [
    ...(name ? [`<name>${xmlSafeText(name)}</name>`] : []),
    ...(desc ? [`<desc>${xmlSafeText(desc)}</desc>`] : []),
  ];
}

function trackLines(segments: Position[][], properties: GeoJsonProperties): string[] {
  const usable = segments.filter((segment) => segment.length > 0);
  if (usable.length === 0) return [];
  const body = usable.flatMap((segment) => [
    "<trkseg>",
    ...indent(
      segment.flatMap((position) => pointLines("trkpt", position)),
      2,
    ),
    "</trkseg>",
  ]);
  return ["<trk>", ...indent([...descriptionLines(properties), ...body], 2), "</trk>"];
}

function closedRing(ring: Position[]): Position[] {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  const same = first.length === last.length && first.every((c, i) => c === last[i]);
  return same ? ring : [...ring, first];
}

/** Waypoints first (GPX orders `wpt` before `trk`), then tracks, for one feature. */
function featureGpx(feature: Feature): { waypoints: string[]; tracks: string[] } {
  const properties = feature.properties ?? {};
  const waypoints: string[] = [];
  const tracks: string[] = [];
  const geometry = feature.geometry;
  const visit = (g: typeof geometry): void => {
    if (!g) return;
    switch (g.type) {
      case "Point":
        waypoints.push(
          ...pointLines("wpt", g.coordinates, [
            ...(timeElement(properties) ? [timeElement(properties) as string] : []),
            ...descriptionLines(properties),
          ]),
        );
        break;
      case "MultiPoint":
        for (const position of g.coordinates) {
          waypoints.push(...pointLines("wpt", position, descriptionLines(properties)));
        }
        break;
      case "LineString":
        tracks.push(...trackLines([g.coordinates], properties));
        break;
      case "MultiLineString":
        tracks.push(...trackLines(g.coordinates, properties));
        break;
      case "Polygon":
        tracks.push(...trackLines(g.coordinates.map(closedRing), properties));
        break;
      case "MultiPolygon":
        for (const polygon of g.coordinates) {
          tracks.push(...trackLines(polygon.map(closedRing), properties));
        }
        break;
      case "GeometryCollection":
        for (const child of g.geometries) visit(child);
        break;
    }
  };
  visit(geometry);
  return { waypoints, tracks };
}

/** Convert a GeoJSON FeatureCollection to a GPX 1.1 document named `documentName`. */
export function writeGpx(geojson: FeatureCollection, documentName: string): string {
  const waypoints: string[] = [];
  const tracks: string[] = [];
  geojson.features.forEach((feature, index) => {
    try {
      const part = featureGpx(feature);
      waypoints.push(...part.waypoints);
      tracks.push(...part.tracks);
    } catch (error) {
      if (error instanceof InvalidCoordinateError) throw new GpxCoordinateError(index, feature.id);
      throw error;
    }
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="GeoLibre" xmlns="${GPX_NAMESPACE}">`,
    "  <metadata>",
    `    <name>${xmlSafeText(documentName)}</name>`,
    "  </metadata>",
    ...indent(waypoints, 2),
    ...indent(tracks, 2),
    "</gpx>",
  ].join("\n");
}

/** Whether a collection has anything GPX can carry (a point, a line or a ring). */
export function gpxHasContent(geojson: FeatureCollection): boolean {
  return geojson.features.some((feature) => {
    try {
      const part = featureGpx(feature);
      return part.waypoints.length > 0 || part.tracks.length > 0;
    } catch {
      return false;
    }
  });
}
