/**
 * Line of Sight, Viewshed Area, and 3D Measure share a Cesium canvas but retain
 * separate ScreenSpaceEventHandlers. Cesium delivers a click to each handler,
 * so this coordinator gives empty-ground placement to exactly one sight tool
 * while 3D Measure defers when that placement is armed. Each tool still
 * recognises and drags its own graphics; cursor priority is resolved here.
 */

export type SightAndViewshedToolId = "line-of-sight" | "viewshed-area";

export type Rer3dCanvasToolId = SightAndViewshedToolId | "measure-3d";

const MEASURE_3D_TOOL_ID: Rer3dCanvasToolId = "measure-3d";

interface CanvasRegistration {
  canvas: HTMLCanvasElement;
  previousCursor: string;
  tools: Set<Rer3dCanvasToolId>;
}

let activeTool: SightAndViewshedToolId | null = null;
/** Whether 3D Measure is actively placing vertices (crosshair + clicks). */
let measureDrawingPointerActive = false;
/** Set when a sight tool consumes a ground click that disarms placement in the same event. */
let suppressMeasureGroundClick = false;
const listeners = new Set<() => void>();
const rewireListeners = new Set<(tool: SightAndViewshedToolId) => void>();
const canvases = new Map<HTMLCanvasElement, CanvasRegistration>();
/** Which tool is creating a ScreenSpaceEventHandler (for test doubles). */
let inputRegistrationTool: SightAndViewshedToolId | null = null;

export function getSightAndViewshedInputRegistrationTool(): SightAndViewshedToolId | null {
  return inputRegistrationTool;
}

export function runWithSightAndViewshedInputTool<T>(
  tool: SightAndViewshedToolId,
  work: () => T,
): T {
  const previous = inputRegistrationTool;
  inputRegistrationTool = tool;
  try {
    return work();
  } finally {
    inputRegistrationTool = previous;
  }
}

function refreshCursor(registration: CanvasRegistration): void {
  if (activeTool && registration.tools.has(activeTool)) {
    registration.canvas.style.cursor = "crosshair";
    return;
  }
  if (!activeTool && measureDrawingPointerActive && registration.tools.has(MEASURE_3D_TOOL_ID)) {
    registration.canvas.style.cursor = "crosshair";
    return;
  }
  registration.canvas.style.cursor = registration.previousCursor;
}

function publish(): void {
  for (const listener of listeners) listener();
}

function refreshAll(): void {
  for (const registration of canvases.values()) refreshCursor(registration);
}

export function subscribeSightAndViewshedPlacement(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fired when a second tool binds the same canvas; each tool re-registers its handler. */
export function subscribeSightAndViewshedInputRewire(
  listener: (tool: SightAndViewshedToolId) => void,
): () => void {
  rewireListeners.add(listener);
  return () => rewireListeners.delete(listener);
}

export function isSightAndViewshedPlacementActive(tool: SightAndViewshedToolId): boolean {
  return activeTool === tool;
}

export function isSightAndViewshedPlacementArmed(): boolean {
  return activeTool !== null;
}

/** Call when a sight tool finishes empty-ground placement on this click (especially when disarming). */
export function markSightAndViewshedGroundClickHandled(): void {
  suppressMeasureGroundClick = true;
}

/** Whether 3D Measure should ignore a left click (handlers run in registration order). */
export function shouldMeasureDeferGroundClick(): boolean {
  if (isSightAndViewshedPlacementArmed()) return true;
  if (suppressMeasureGroundClick) {
    suppressMeasureGroundClick = false;
    return true;
  }
  return false;
}

export function activateSightAndViewshedPlacement(tool: SightAndViewshedToolId): void {
  if (activeTool === tool) return;
  activeTool = tool;
  refreshAll();
  publish();
}

export function cancelSightAndViewshedPlacement(tool: SightAndViewshedToolId): void {
  if (activeTool !== tool) return;
  activeTool = null;
  refreshAll();
  publish();
}

function registerRer3dCanvas(tool: Rer3dCanvasToolId, canvas: HTMLCanvasElement): () => void {
  let registration = canvases.get(canvas);
  if (!registration) {
    registration = { canvas, previousCursor: canvas.style.cursor, tools: new Set() };
    canvases.set(canvas, registration);
  }
  registration.tools.add(tool);
  refreshCursor(registration);
  if (tool !== MEASURE_3D_TOOL_ID && registration.tools.size > 1) {
    for (const listener of rewireListeners) listener(tool);
  }

  return () => {
    const current = canvases.get(canvas);
    if (!current) return;
    current.tools.delete(tool);
    if (current.tools.size === 0) {
      canvas.style.cursor = current.previousCursor;
      canvases.delete(canvas);
      return;
    }
    refreshCursor(current);
  };
}

/** Register a bound sight tool and restore the original cursor after the last one leaves. */
export function registerSightAndViewshedCanvas(
  tool: SightAndViewshedToolId,
  canvas: HTMLCanvasElement,
): () => void {
  return registerRer3dCanvas(tool, canvas);
}

/** Register 3D Measure on the canvas for shared cursor priority. */
export function registerMeasure3dCanvas(canvas: HTMLCanvasElement): () => void {
  return registerRer3dCanvas(MEASURE_3D_TOOL_ID, canvas);
}

/** Sync whether measure should show the crosshair while its panel is bound to the globe. */
export function setMeasure3dDrawingPointerActive(active: boolean): void {
  if (measureDrawingPointerActive === active) return;
  measureDrawingPointerActive = active;
  refreshAll();
}

/** Runtime reset used by each tool's project-reset lifecycle. */
export function resetSightAndViewshedPlacement(): void {
  if (!activeTool) return;
  activeTool = null;
  refreshAll();
  publish();
}

const LINE_OF_SIGHT_MARKER_IDS = new Set([
  "geolibre-line-of-sight-observer",
  "geolibre-line-of-sight-target",
]);
const VIEWSHED_MARKER_IDS = new Set(["geolibre-viewshed-area-observer"]);

/** Any entity drawn by either tool (markers, lines, filled viewshed, and so on). */
export function isSightAndViewshedEntity(id: unknown): boolean {
  return (
    typeof id === "string" &&
    (id.startsWith("geolibre-line-of-sight-") || id.startsWith("geolibre-viewshed-area-"))
  );
}

/** Draggable endpoint markers. Overlays do not block the other tool's empty-ground placement. */
export function isSightAndViewshedMarkerEntity(id: unknown): boolean {
  if (typeof id !== "string") return false;
  return LINE_OF_SIGHT_MARKER_IDS.has(id) || VIEWSHED_MARKER_IDS.has(id);
}

/** Non-marker graphics (sight lines, viewshed fill, radius ring). */
export function isSightAndViewshedOverlayEntity(id: unknown): boolean {
  return isSightAndViewshedEntity(id) && !isSightAndViewshedMarkerEntity(id);
}

/** Any entity drawn by 3D Measure (vertices, lines, labels, fill). */
export function isMeasureDrawEntity(id: unknown): boolean {
  return typeof id === "string" && id.startsWith("geolibre-draw");
}
