/**
 * Pure viewport maths for the 3D Measure elevation chart. Kept beside the
 * panel rather than the shared elevation-profile chart because this behaviour
 * is deliberately specific to 3D Measure.
 */

export interface Measure3dProfilePoint {
  distance: number;
  elevation: number;
}

export interface Measure3dProfileViewport {
  start: number;
  end: number;
}

function bounds(points: readonly Measure3dProfilePoint[]): Measure3dProfileViewport {
  const start = points[0]?.distance ?? 0;
  const end = points[points.length - 1]?.distance ?? start;
  return { start, end: Math.max(start, end) };
}

function span(viewport: Measure3dProfileViewport): number {
  return viewport.end - viewport.start;
}

/** Show the whole sampled path. */
export function fitMeasure3dProfileViewport(
  points: readonly Measure3dProfilePoint[],
): Measure3dProfileViewport {
  return bounds(points);
}

/** The closest useful zoom limit: never show less than one sampled interval. */
export function minimumMeasure3dProfileSpan(points: readonly Measure3dProfilePoint[]): number {
  const fullSpan = span(bounds(points));
  let smallest = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const interval = points[i].distance - points[i - 1].distance;
    if (interval > 0 && interval < smallest) smallest = interval;
  }
  return Number.isFinite(smallest) ? smallest : fullSpan;
}

/**
 * Zoom about an absolute distance, retaining its relative screen position
 * whenever the profile boundary permits it.
 */
export function zoomMeasure3dProfileViewport(
  viewport: Measure3dProfileViewport,
  points: readonly Measure3dProfilePoint[],
  anchor: number,
  factor: number,
): Measure3dProfileViewport {
  const full = bounds(points);
  const fullSpan = span(full);
  if (!(fullSpan > 0) || !(factor > 0) || !Number.isFinite(factor)) return full;

  const currentSpan = span(viewport);
  const minSpan = Math.min(fullSpan, minimumMeasure3dProfileSpan(points));
  const nextSpan = Math.min(fullSpan, Math.max(minSpan, currentSpan * factor));
  const anchorDistance = Number.isFinite(anchor) ? anchor : (viewport.start + viewport.end) / 2;
  const safeAnchor = Math.min(viewport.end, Math.max(viewport.start, anchorDistance));
  const fraction = currentSpan > 0 ? (safeAnchor - viewport.start) / currentSpan : 0.5;
  const unclampedStart = safeAnchor - nextSpan * fraction;
  const start = Math.min(full.end - nextSpan, Math.max(full.start, unclampedStart));
  return { start, end: start + nextSpan };
}

/** Move a viewport by an absolute distance, stopping at either end of the path. */
export function panMeasure3dProfileViewport(
  viewport: Measure3dProfileViewport,
  points: readonly Measure3dProfilePoint[],
  offset: number,
): Measure3dProfileViewport {
  const full = bounds(points);
  const viewportSpan = span(viewport);
  const start = Math.min(
    full.end - viewportSpan,
    Math.max(full.start, viewport.start + (Number.isFinite(offset) ? offset : 0)),
  );
  return { start, end: start + viewportSpan };
}

function interpolate(
  from: Measure3dProfilePoint,
  to: Measure3dProfilePoint,
  distance: number,
): Measure3dProfilePoint {
  const length = to.distance - from.distance;
  const fraction = length > 0 ? (distance - from.distance) / length : 0;
  return {
    distance,
    elevation: from.elevation + (to.elevation - from.elevation) * fraction,
  };
}

/**
 * Return viewport samples rebased to zero. Interpolated endpoints keep the
 * chart line and its vertical scale accurate even when the viewport falls
 * between sampled terrain points.
 */
export function visibleMeasure3dProfilePoints(
  points: readonly Measure3dProfilePoint[],
  viewport: Measure3dProfileViewport,
): Measure3dProfilePoint[] {
  if (points.length === 0) return [];
  const full = bounds(points);
  const start = Math.min(full.end, Math.max(full.start, viewport.start));
  const end = Math.min(full.end, Math.max(start, viewport.end));
  const visible: Measure3dProfilePoint[] = [];

  const pointAt = (distance: number): Measure3dProfilePoint => {
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].distance >= distance) {
        if (points[i].distance === distance) return points[i];
        return interpolate(points[i - 1], points[i], distance);
      }
    }
    return points[points.length - 1];
  };

  visible.push(pointAt(start));
  for (const point of points) {
    if (point.distance > start && point.distance < end) visible.push(point);
  }
  if (end > start) visible.push(pointAt(end));

  return visible.map((point) => ({
    distance: point.distance - start,
    elevation: point.elevation,
  }));
}

/** Find the source sample nearest a distance represented by the chart cursor. */
export function nearestMeasure3dProfileSample(
  distances: readonly number[],
  distance: number,
): number {
  if (distances.length === 0) return -1;
  let nearest = 0;
  let nearestDelta = Math.abs(distances[0] - distance);
  for (let i = 1; i < distances.length; i += 1) {
    const delta = Math.abs(distances[i] - distance);
    if (delta < nearestDelta) {
      nearest = i;
      nearestDelta = delta;
    }
  }
  return nearest;
}
