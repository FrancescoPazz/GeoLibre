import type { BoundingSphere, Cartesian3, Cesium3DTileset, Scene } from "@cesium/engine";
import { cesiumIonAssetId, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { CesiumSceneHandle } from "@geolibre/map";
import type { Feature, Geometry, Position } from "geojson";
import type { GeoLibreAppAPI } from "../../types";
import { geodesicMeters } from "./draw-geometry";

/**
 * Globe clipping: cut a square hole in the terrain around one layer so what
 * lies beneath the surface — a tunnel tileset, an underground model, a
 * borehole file — can be seen from above.
 *
 * The hole is a `ClippingPlaneCollection` on the globe: four vertical
 * planes in the layer's east-north-up frame at half-width equal to its
 * bounding sphere's radius, unioned so the *inside* is what gets cut away,
 * with back-face culling and skirts switched off so the cut reads as a pit
 * rather than a see-through. One layer at a time owns the hole; choosing
 * another moves it. The sphere comes from the loaded tileset for 3D Tiles
 * (found among the scene's primitives) and from the features for GeoJSON.
 */

export const GLOBE_CLIPPING_TOOL_ID = "globe-clipping";

/** Layer kinds the hole can be sized from. */
export const CLIPPABLE_LAYER_TYPES: ReadonlySet<GeoLibreLayer["type"]> = new Set([
  "3d-tiles",
  "geojson",
]);

export interface ClippableLayer {
  id: string;
  name: string;
  type: GeoLibreLayer["type"];
}

export interface GlobeClippingState {
  open: boolean;
  bound: boolean;
  layers: ClippableLayer[];
  /** The layer the hole is cut around, or null for none. */
  activeLayerId: string | null;
  /** The hole is requested but its layer has not produced a sphere yet. */
  pending: boolean;
  /** Half-width of the hole in metres, once applied. */
  halfWidthMeters: number | null;
}

type CesiumNs = CesiumSceneHandle["Cesium"];

let open = false;
let handle: CesiumSceneHandle | null = null;
let hostApp: GeoLibreAppAPI | null = null;
let activeLayerId: string | null = null;
let applied: { layerId: string; halfWidth: number; restore: () => void } | null = null;
let retryRelease: (() => void) | null = null;
let projectUnsubscribe: (() => void) | null = null;
let snapshot: GlobeClippingState = buildSnapshot();
const listeners = new Set<() => void>();

function isLive(): boolean {
  return handle !== null && !handle.viewer.isDestroyed();
}

function storeLayers(): GeoLibreLayer[] {
  return useAppStore.getState().layers;
}

function clippableLayers(): ClippableLayer[] {
  return storeLayers()
    .filter((layer) => CLIPPABLE_LAYER_TYPES.has(layer.type))
    .map((layer) => ({ id: layer.id, name: layer.name, type: layer.type }));
}

function buildSnapshot(): GlobeClippingState {
  return {
    open,
    bound: isLive(),
    layers: open ? clippableLayers() : [],
    activeLayerId,
    pending: activeLayerId !== null && applied?.layerId !== activeLayerId,
    halfWidthMeters: applied?.halfWidth ?? null,
  };
}

function publish(): void {
  snapshot = buildSnapshot();
  for (const listener of listeners) listener();
}

export function subscribeGlobeClipping(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable reference for `useSyncExternalStore`. */
export function getGlobeClippingSnapshot(): GlobeClippingState {
  return snapshot;
}

export function isGlobeClippingPanelVisible(): boolean {
  return open;
}

/** Bounding sphere of a GeoJSON feature set: centred on its bbox, radius to the farthest corner. */
export function featuresBoundingSphere(
  C: CesiumNs,
  features: Feature<Geometry | null>[],
): BoundingSphere | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let minAlt = Infinity;
  let maxAlt = -Infinity;
  const visit = (position: Position) => {
    const [lng, lat, alt = 0] = position;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    minAlt = Math.min(minAlt, alt);
    maxAlt = Math.max(maxAlt, alt);
  };
  const walk = (coords: unknown) => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number") visit(coords as Position);
    else for (const c of coords) walk(c);
  };
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "GeometryCollection")
      for (const part of g.geometries) walk((part as { coordinates?: unknown }).coordinates);
    else walk((g as { coordinates?: unknown }).coordinates);
  }
  if (!Number.isFinite(west) || !Number.isFinite(south)) return null;
  const center = { lng: (west + east) / 2, lat: (south + north) / 2, alt: (minAlt + maxAlt) / 2 };
  const corner = { lng: east, lat: north, alt: maxAlt };
  const horizontal = geodesicMeters(C, center, corner);
  const vertical = (maxAlt - minAlt) / 2;
  const radius = Math.max(1, Math.hypot(horizontal, vertical));
  return new C.BoundingSphere(C.Cartesian3.fromDegrees(center.lng, center.lat, center.alt), radius);
}

/** The scene's loaded tileset drawing `layer`, matched by URL, or the only one there is. */
export function findTilesetForLayer(
  C: CesiumNs,
  scene: Scene,
  layer: Pick<GeoLibreLayer, "source" | "metadata" | "sourcePath">,
): Cesium3DTileset | null {
  const candidates: Cesium3DTileset[] = [];
  const primitives = scene.primitives;
  for (let i = 0; i < primitives.length; i += 1) {
    const p = primitives.get(i);
    if (p instanceof C.Cesium3DTileset) candidates.push(p);
  }
  const url =
    typeof layer.source?.url === "string"
      ? layer.source.url
      : typeof layer.sourcePath === "string"
        ? layer.sourcePath
        : null;
  const ionAssetId = cesiumIonAssetId(layer);
  const byUrl = candidates.find((t) => {
    const resourceUrl = t.resource?.url ?? "";
    if (url && resourceUrl.startsWith(url.split("?")[0])) return true;
    if (ionAssetId !== null && resourceUrl.includes(`/${ionAssetId}/`)) return true;
    return false;
  });
  if (byUrl) return byUrl;
  return candidates.length === 1 ? candidates[0] : null;
}

/** The four vertical planes of a square hole of `halfWidth` metres around `center`. */
export function squareClippingPlanes(C: CesiumNs, center: Cartesian3, halfWidth: number) {
  return new C.ClippingPlaneCollection({
    modelMatrix: C.Transforms.eastNorthUpToFixedFrame(center),
    planes: [
      new C.ClippingPlane(new C.Cartesian3(1, 0, 0), halfWidth),
      new C.ClippingPlane(new C.Cartesian3(-1, 0, 0), halfWidth),
      new C.ClippingPlane(new C.Cartesian3(0, 1, 0), halfWidth),
      new C.ClippingPlane(new C.Cartesian3(0, -1, 0), halfWidth),
    ],
    unionClippingRegions: true,
    edgeWidth: 1,
    edgeColor: C.Color.WHITE,
    enabled: true,
  });
}

function sphereForLayer(layer: GeoLibreLayer): BoundingSphere | null {
  if (!isLive()) return null;
  const C = handle!.Cesium;
  if (layer.type === "3d-tiles") {
    const tileset = findTilesetForLayer(C, handle!.scene, layer);
    if (!tileset || !tileset.root) return null;
    return tileset.boundingSphere;
  }
  if (layer.type === "geojson") {
    const features = hostApp?.getLayerFeatures?.(layer.id) ?? layer.geojson?.features ?? [];
    return featuresBoundingSphere(C, features as Feature<Geometry | null>[]);
  }
  return null;
}

function releaseHole(): void {
  const current = applied;
  applied = null;
  current?.restore();
}

function cutHole(layer: GeoLibreLayer, sphere: BoundingSphere): void {
  releaseHole();
  const C = handle!.Cesium;
  const globe = handle!.scene.globe;
  const previous = {
    planes: globe.clippingPlanes,
    backFaceCulling: globe.backFaceCulling,
    showSkirts: globe.showSkirts,
  };
  globe.clippingPlanes = squareClippingPlanes(C, sphere.center, sphere.radius);
  globe.backFaceCulling = false;
  globe.showSkirts = false;
  applied = {
    layerId: layer.id,
    halfWidth: sphere.radius,
    restore: () => {
      if (!isLive()) return;
      const g = handle!.scene.globe;
      if (g.clippingPlanes && g.clippingPlanes !== previous.planes)
        g.clippingPlanes.enabled = false;
      g.clippingPlanes = previous.planes;
      g.backFaceCulling = previous.backFaceCulling;
      g.showSkirts = previous.showSkirts;
      handle!.requestRender();
    },
  };
  handle!.requestRender();
}

/**
 * Try to cut the hole for the active layer. A tileset has no sphere until
 * its root tile loads, so on a miss the attempt is repeated whenever the
 * globe's tile loading settles, until it lands or the layer is deselected.
 */
function apply(): void {
  retryRelease?.();
  retryRelease = null;
  if (!isLive() || !activeLayerId) {
    releaseHole();
    publish();
    return;
  }
  const layer = storeLayers().find((l) => l.id === activeLayerId);
  if (!layer || !CLIPPABLE_LAYER_TYPES.has(layer.type)) {
    activeLayerId = null;
    releaseHole();
    publish();
    return;
  }
  const sphere = sphereForLayer(layer);
  if (sphere) {
    cutHole(layer, sphere);
    publish();
    return;
  }
  releaseHole();
  const event = handle!.scene.globe?.tileLoadProgressEvent;
  if (event) {
    const listener = (remaining: number) => {
      if (remaining === 0 && activeLayerId === layer.id) apply();
    };
    event.addEventListener(listener);
    retryRelease = () => event.removeEventListener(listener);
  }
  publish();
}

/** Cut the hole around `layerId`, or remove it with `null`. */
export function setGlobeClippingLayer(layerId: string | null): void {
  activeLayerId = layerId;
  apply();
}

function primaryGlobe(app: GeoLibreAppAPI): CesiumSceneHandle | null {
  const globe = app.getCesiumScene?.() ?? null;
  return globe?.primary ? globe : null;
}

function attach(app: GeoLibreAppAPI): void {
  hostApp = app;
  if (isLive()) return;
  handle = primaryGlobe(app);
  // Follow the project's layers so the list and the hole track additions,
  // removals and renames without the host having to tell us.
  projectUnsubscribe ??= useAppStore.subscribe((state, previous) => {
    if (state.layers !== previous.layers) refreshGlobeClippingLayers();
  });
  apply();
}

function detach(): void {
  retryRelease?.();
  retryRelease = null;
  releaseHole();
  handle = null;
  projectUnsubscribe?.();
  projectUnsubscribe = null;
}

export function openGlobeClippingPanel(app: GeoLibreAppAPI): void {
  open = true;
  attach(app);
  publish();
}

/** Close the panel; the hole is filled in — clipping is a view, not a project edit. */
export function closeGlobeClippingPanel(_app?: GeoLibreAppAPI): void {
  open = false;
  detach();
  publish();
}

/** Re-read the project's layers; drops the hole if its layer is gone. */
export function refreshGlobeClippingLayers(): void {
  if (!open) return;
  if (activeLayerId && !clippableLayers().some((l) => l.id === activeLayerId)) {
    activeLayerId = null;
    apply();
    return;
  }
  publish();
}

export function reattachGlobeClipping(app: GeoLibreAppAPI): void {
  if (!open) return;
  hostApp = app;
  const globe = primaryGlobe(app);
  if (isLive() && globe && handle!.viewer === globe.viewer) return;
  detach();
  attach(app);
  publish();
}

export function restoreGlobeClipping(app: GeoLibreAppAPI, state: unknown): boolean {
  if (!state || typeof state !== "object") {
    closeGlobeClippingPanel(app);
    activeLayerId = null;
    publish();
    return false;
  }
  const raw = state as Record<string, unknown>;
  activeLayerId = typeof raw.layerId === "string" ? raw.layerId : null;
  if (raw.open === true) openGlobeClippingPanel(app);
  else closeGlobeClippingPanel(app);
  return true;
}

export function getGlobeClippingProjectState(): Record<string, unknown> | undefined {
  if (!open && !activeLayerId) return undefined;
  return { open, ...(activeLayerId ? { layerId: activeLayerId } : {}) };
}
