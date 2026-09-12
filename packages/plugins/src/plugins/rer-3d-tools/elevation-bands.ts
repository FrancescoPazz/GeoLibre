import { getElevationMeanSeaLevelDefault } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { GeoLibreAppAPI } from "../../types";
import type { Egm96Geoid } from "./egm96";

/**
 * Elevation bands: colour the globe's terrain by height, as translucent
 * bands between chosen heights — a quick "everything above 500 m in red"
 * over the imagery, for reading relief and flood or snow lines.
 *
 * The bands become a `createElevationBandMaterial` on the globe. Heights
 * are entered the way people read them, above mean sea level when the
 * geoid is available and that reference is chosen; the material wants
 * ellipsoidal heights, so the geoid undulation at the view's centre is
 * added before applying. Clearing restores the globe's default material —
 * the one thing the old panel never offered.
 */

export const ELEVATION_BANDS_TOOL_ID = "elevation-bands";

export interface ElevationBand {
  fromHeight: number;
  fromColor: string;
  toHeight: number;
  toColor: string;
}

export const ELEVATION_BANDS_MAX = 12;
export const DEFAULT_BAND_OPACITY = 0.5;

/** A first band people can edit rather than an empty list. */
export const DEFAULT_ELEVATION_BANDS: readonly ElevationBand[] = Object.freeze([
  { fromHeight: 0, fromColor: "#2563eb", toHeight: 500, toColor: "#22c55e" },
]);

export interface ElevationBandsState {
  open: boolean;
  bound: boolean;
  bands: ElevationBand[];
  opacity: number;
  /** A material built from these bands is on the globe. */
  applied: boolean;
  /** Heights are entered above mean sea level (needs the geoid). */
  aboveSeaLevel: boolean;
  geoidAvailable: boolean;
  /** The undulation added to the entered heights when applied, in metres. */
  geoidOffsetMeters: number | null;
}

let open = false;
let handle: CesiumSceneHandle | null = null;
let bands: ElevationBand[] = DEFAULT_ELEVATION_BANDS.map((b) => ({ ...b }));
let opacity = DEFAULT_BAND_OPACITY;
let aboveSeaLevel = getElevationMeanSeaLevelDefault();
let geoid: Egm96Geoid | undefined;
let geoidOffset: number | null = null;
let applied: { restore: () => void } | null = null;
let applyRequest = 0;
let snapshot: ElevationBandsState = buildSnapshot();
const listeners = new Set<() => void>();

function isLive(): boolean {
  return handle !== null && !handle.viewer.isDestroyed();
}

function buildSnapshot(): ElevationBandsState {
  return {
    open,
    bound: isLive(),
    bands: bands.map((b) => ({ ...b })),
    opacity,
    applied: applied !== null,
    aboveSeaLevel,
    geoidAvailable: geoid !== undefined,
    geoidOffsetMeters: applied ? geoidOffset : null,
  };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribeElevationBands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getElevationBandsSnapshot(): ElevationBandsState {
  return snapshot;
}

export function isElevationBandsPanelVisible(): boolean {
  return open;
}

function clampOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_BAND_OPACITY;
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.trim());
}

export function normalizeElevationBands(raw: unknown): ElevationBand[] {
  if (!Array.isArray(raw)) return DEFAULT_ELEVATION_BANDS.map((b) => ({ ...b }));
  const out: ElevationBand[] = [];
  for (const item of raw.slice(0, ELEVATION_BANDS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const { fromHeight, toHeight, fromColor, toColor } = item as Record<string, unknown>;
    if (typeof fromHeight !== "number" || typeof toHeight !== "number") continue;
    if (!Number.isFinite(fromHeight) || !Number.isFinite(toHeight)) continue;
    if (!isColor(fromColor)) continue;
    out.push({
      fromHeight,
      toHeight,
      fromColor: fromColor.trim(),
      toColor: isColor(toColor) ? toColor.trim() : fromColor.trim(),
    });
  }
  return out;
}

/**
 * The entries `createElevationBandMaterial` takes: one layer per band, its
 * two stops ordered by height (a band entered top-down is flipped, a flat
 * band is skipped), each colour at the chosen opacity, heights shifted by
 * `offset` to the ellipsoid.
 */
export function elevationBandLayers(
  C: CesiumSceneHandle["Cesium"],
  source: ElevationBand[],
  alpha: number,
  offset: number,
): Array<{
  entries: Array<{ height: number; color: InstanceType<CesiumSceneHandle["Cesium"]["Color"]> }>;
}> {
  const layers = [];
  for (const band of source) {
    if (band.fromHeight === band.toHeight) continue;
    const ascending = band.fromHeight < band.toHeight;
    const low = ascending
      ? band
      : {
          fromHeight: band.toHeight,
          fromColor: band.toColor,
          toHeight: band.fromHeight,
          toColor: band.fromColor,
        };
    let lowColor: InstanceType<typeof C.Color>;
    let highColor: InstanceType<typeof C.Color>;
    try {
      lowColor = C.Color.fromCssColorString(low.fromColor).withAlpha(alpha);
      highColor = C.Color.fromCssColorString(low.toColor).withAlpha(alpha);
    } catch {
      continue;
    }
    layers.push({
      entries: [
        { height: low.fromHeight + offset, color: lowColor },
        { height: low.toHeight + offset, color: highColor },
      ],
    });
  }
  return layers;
}

function clearMaterial(): void {
  const current = applied;
  applied = null;
  current?.restore();
}

/** Build the material from the current bands and put it on the globe. */
export async function applyElevationBands(): Promise<boolean> {
  if (!isLive()) return false;
  const request = ++applyRequest;
  let offset = 0;
  if (aboveSeaLevel && geoid) {
    const [lng, lat] = handle!.readView().center;
    try {
      offset = await geoid.height(lng, lat);
    } catch {
      offset = 0;
    }
    if (request !== applyRequest || !isLive()) return false;
  }
  const C = handle!.Cesium;
  const layers = elevationBandLayers(C, bands, opacity, offset);
  if (layers.length === 0) {
    clearMaterial();
    publish();
    return false;
  }
  const scene = handle!.scene;
  // Take the old bands off first so `previous` is the globe's own material,
  // not a band material of ours.
  clearMaterial();
  const previous = scene.globe.material;
  const material = C.createElevationBandMaterial({ scene, layers });
  scene.globe.material = material;
  geoidOffset = offset;
  applied = {
    restore: () => {
      if (!isLive()) return;
      if (handle!.scene.globe.material === material) handle!.scene.globe.material = previous;
      handle!.requestRender();
    },
  };
  handle!.requestRender();
  publish();
  return true;
}

/** Remove the bands, restoring the globe's default appearance. */
export function clearElevationBands(): void {
  applyRequest += 1;
  clearMaterial();
  publish();
}

export function setElevationBands(next: ElevationBand[]): void {
  bands = normalizeElevationBands(next);
  publish();
}

export function updateElevationBand(index: number, patch: Partial<ElevationBand>): void {
  if (index < 0 || index >= bands.length) return;
  const merged = { ...bands[index], ...patch };
  bands = bands.map((b, i) => (i === index ? merged : b));
  publish();
}

export function addElevationBand(): void {
  if (bands.length >= ELEVATION_BANDS_MAX) return;
  const last = bands[bands.length - 1];
  const span = last ? Math.max(1, Math.abs(last.toHeight - last.fromHeight)) : 500;
  const from = last ? Math.max(last.fromHeight, last.toHeight) : 0;
  bands = [
    ...bands,
    {
      fromHeight: from,
      fromColor: last?.toColor ?? "#ef4444",
      toHeight: from + span,
      toColor: last?.toColor ?? "#ef4444",
    },
  ];
  publish();
}

export function removeElevationBand(index: number): void {
  if (index < 0 || index >= bands.length) return;
  bands = bands.filter((_, i) => i !== index);
  publish();
}

export function setElevationBandsOpacity(value: number): void {
  opacity = clampOpacity(value);
  publish();
}

export function setElevationBandsAboveSeaLevel(enabled: boolean): void {
  aboveSeaLevel = enabled;
  publish();
}

/** The geoid the heights are referred to; shared with the other 3D tools. */
export function setElevationBandsGeoid(next: Egm96Geoid | undefined): void {
  geoid = next;
  publish();
}

/**
 * The globe the tool binds to: the primary one when the primary map is a
 * globe, else the first globe in a grid pane — the arrangement a geoportal
 * runs in, the 2D map primary and the globe beside it for the 3D tools.
 * Hosts that predate `getCesiumScenes` offer the primary globe only.
 */
function primaryGlobe(app: GeoLibreAppAPI): CesiumSceneHandle | null {
  const scenes = app.getCesiumScenes?.();
  if (scenes) return scenes[0] ?? null;
  return app.getCesiumScene?.() ?? null;
}

function attach(app: GeoLibreAppAPI): void {
  if (isLive()) return;
  handle = primaryGlobe(app);
}

function detach(): void {
  applyRequest += 1;
  clearMaterial();
  handle = null;
}

export function openElevationBandsPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  publish();
}

/** Close the panel; the bands come off the globe — colouring is a view, not a project edit. */
export function closeElevationBandsPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

export function reattachElevationBands(app: GeoLibreAppAPI): void {
  if (!open) return;
  const globe = primaryGlobe(app);
  if (isLive() && globe && handle!.viewer === globe.viewer) return;
  const wasApplied = applied !== null;
  detach();
  attach(app);
  if (wasApplied) void applyElevationBands();
  publish();
}

export function restoreElevationBands(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeElevationBandsPanel(app);
    bands = DEFAULT_ELEVATION_BANDS.map((b) => ({ ...b }));
    opacity = DEFAULT_BAND_OPACITY;
    aboveSeaLevel = getElevationMeanSeaLevelDefault();
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  bands = normalizeElevationBands(raw.bands);
  opacity = clampOpacity(typeof raw.opacity === "number" ? raw.opacity : DEFAULT_BAND_OPACITY);
  aboveSeaLevel =
    typeof raw.aboveSeaLevel === "boolean" ? raw.aboveSeaLevel : getElevationMeanSeaLevelDefault();
  if (raw.open === true) {
    openElevationBandsPanel(app);
    if (raw.applied === true) void applyElevationBands();
  } else {
    closeElevationBandsPanel(app);
  }
  return true;
}

export function getElevationBandsProjectState(): Record<string, unknown> | undefined {
  const defaultBands =
    bands.length === DEFAULT_ELEVATION_BANDS.length &&
    bands.every((b, i) => JSON.stringify(b) === JSON.stringify(DEFAULT_ELEVATION_BANDS[i]));
  if (
    !open &&
    defaultBands &&
    opacity === DEFAULT_BAND_OPACITY &&
    aboveSeaLevel === getElevationMeanSeaLevelDefault()
  ) {
    return undefined;
  }
  return { open, applied: applied !== null, bands, opacity, aboveSeaLevel };
}
