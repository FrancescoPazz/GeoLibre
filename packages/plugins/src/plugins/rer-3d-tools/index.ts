import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import {
  closeLineOfSightPanel,
  getLineOfSightProjectState,
  reattachLineOfSight,
  restoreLineOfSight,
} from "./line-of-sight";
import {
  closeMeasure3dPanel,
  getMeasure3dProjectState,
  openMeasure3dPanel,
  reattachMeasure3d,
  restoreMeasure3d,
} from "./measure-3d";

/**
 * 3D tools for the Cesium globe.
 *
 * One plugin, declared for both engines, that gathers the terrain-aware tools
 * a 3D geoportal needs: 3D measuring (line, polygon, points, angle, circle)
 * and line of sight, with terrain-sampled profiles, globe clipping, path
 * fly-through and elevation colouring to follow. They are Cesium-native
 * (entities, `globe.pick`, terrain sampling through `getCesiumScene()`)
 * because none of the 2D drawing or measuring plugins run on the globe;
 * declaring `maplibre` too keeps the panels reachable — with a hint — while
 * the 2D map is primary, so switching renderer brings a tool to life without
 * reopening it.
 *
 * Each tool is its own module with its own panel state; the plugin object
 * only composes them for activation and the project file.
 */

export const RER_3D_TOOLS_PLUGIN_ID = "rer-3d-tools";

/** Re-bind every tool to the current primary globe after an engine mounts. */
export function reattachRer3dTools(app: GeoLibreAppAPI): void {
  reattachMeasure3d(app);
  reattachLineOfSight(app);
}

export const rer3dToolsPlugin: GeoLibrePlugin = {
  id: RER_3D_TOOLS_PLUGIN_ID,
  name: "3D Tools",
  version: "0.2.0",
  activeByDefault: false,
  engines: ["maplibre", "cesium"],
  activate: (app: GeoLibreAppAPI) => openMeasure3dPanel(app),
  deactivate: (app: GeoLibreAppAPI) => {
    closeMeasure3dPanel(app);
    closeLineOfSightPanel(app);
  },
  // Each tool persists its panel flag and figure under its own key, so a
  // reopened project shows the same drawings; the numbers are recomputed
  // against whatever terrain the globe has when it mounts.
  getProjectState: () => {
    const measure = getMeasure3dProjectState();
    const lineOfSight = getLineOfSightProjectState();
    if (!measure && !lineOfSight) return undefined;
    return { ...(measure ? { measure } : {}), ...(lineOfSight ? { lineOfSight } : {}) };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    const raw = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
    const measure = restoreMeasure3d(app, raw.measure);
    const lineOfSight = restoreLineOfSight(app, raw.lineOfSight);
    return measure || lineOfSight;
  },
};

export {
  DEFAULT_LINE_OF_SIGHT_SETTINGS,
  LINE_OF_SIGHT_HEIGHT_MAX,
  LINE_OF_SIGHT_HEIGHT_MIN,
  LINE_OF_SIGHT_TOOL_ID,
  clearLineOfSight,
  closeLineOfSightPanel,
  getLineOfSightProjectState,
  getLineOfSightSnapshot,
  isLineOfSightPanelVisible,
  normalizeLineOfSightSettings,
  openLineOfSightPanel,
  reattachLineOfSight,
  restoreLineOfSight,
  setLineOfSightSettings,
  subscribeLineOfSight,
  type LineOfSightPhase,
  type LineOfSightSettings,
  type LineOfSightState,
} from "./line-of-sight";
export {
  LINE_OF_SIGHT_ORIGIN_SKIP_METERS,
  LINE_OF_SIGHT_TARGET_TOLERANCE_MIN_METERS,
  LINE_OF_SIGHT_TARGET_TOLERANCE_RATIO,
  computeLineOfSight,
  lineOfSightResultEqual,
  pickGroundPosition,
  raiseByMeters,
  targetTolerance,
  type LineOfSightResult,
  type LngLatAlt,
} from "./line-of-sight-geometry";
export {
  DRAW_MODES,
  MEASURE_3D_TOOL_ID,
  PROFILE_SAMPLING_DEBOUNCE_MS,
  clearMeasure3d,
  closeMeasure3dPanel,
  getMeasure3dProjectState,
  getMeasure3dSnapshot,
  isMeasure3dPanelVisible,
  normalizeDrawOptions,
  openMeasure3dPanel,
  reattachMeasure3d,
  restoreMeasure3d,
  setMeasure3dGeoid,
  setMeasure3dHover,
  setMeasure3dMode,
  setMeasure3dOptions,
  setMeasure3dSamplingStep,
  subscribeMeasure3d,
  type Measure3dState,
} from "./measure-3d";
export {
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
  type BuildProfileOptions,
  type GeoidHeights,
  type ProfileSample,
  type SnapMode,
  type TerrainProfile,
} from "./terrain-profile";
export { CesiumDrawing, DEFAULT_DRAW_OPTIONS, type DrawOptions } from "./draw-engine";
export {
  INSERT_TOLERANCE_PIXELS,
  INSERT_TOLERANCE_RATIO,
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
  type DrawGeometry,
  type DrawMeasures,
  type DrawMode,
} from "./draw-geometry";
