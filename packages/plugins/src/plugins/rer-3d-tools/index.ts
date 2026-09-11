import type { GeoLibreAppAPI, GeoLibrePlugin } from "../../types";
import {
  closeElevationBandsPanel,
  getElevationBandsProjectState,
  reattachElevationBands,
  restoreElevationBands,
} from "./elevation-bands";
import {
  closeGlobeClippingPanel,
  getGlobeClippingProjectState,
  reattachGlobeClipping,
  restoreGlobeClipping,
} from "./globe-clipping";
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
import {
  closePlayPathPanel,
  getPlayPathProjectState,
  reattachPlayPath,
  restorePlayPath,
} from "./play-path";

/**
 * 3D tools for the Cesium globe.
 *
 * One plugin, declared for both engines, that gathers the terrain-aware tools
 * a 3D geoportal needs: 3D measuring (line, polygon, points, angle, circle)
 * with terrain-sampled profiles, line of sight, path fly-through, globe
 * clipping and elevation colouring. They are Cesium-native
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
  reattachPlayPath(app);
  reattachLineOfSight(app);
  reattachGlobeClipping(app);
  reattachElevationBands(app);
}

export const rer3dToolsPlugin: GeoLibrePlugin = {
  id: RER_3D_TOOLS_PLUGIN_ID,
  name: "3D Tools",
  version: "0.3.0",
  activeByDefault: false,
  engines: ["maplibre", "cesium"],
  activate: (app: GeoLibreAppAPI) => openMeasure3dPanel(app),
  deactivate: (app: GeoLibreAppAPI) => {
    closePlayPathPanel(app);
    closeMeasure3dPanel(app);
    closeLineOfSightPanel(app);
    closeGlobeClippingPanel(app);
    closeElevationBandsPanel(app);
  },
  // Each tool persists its panel flag and figure under its own key, so a
  // reopened project shows the same drawings; the numbers are recomputed
  // against whatever terrain the globe has when it mounts.
  getProjectState: () => {
    const measure = getMeasure3dProjectState();
    const playPath = getPlayPathProjectState();
    const lineOfSight = getLineOfSightProjectState();
    const globeClipping = getGlobeClippingProjectState();
    const elevationBands = getElevationBandsProjectState();
    if (!measure && !playPath && !lineOfSight && !globeClipping && !elevationBands) {
      return undefined;
    }
    return {
      ...(measure ? { measure } : {}),
      ...(playPath ? { playPath } : {}),
      ...(lineOfSight ? { lineOfSight } : {}),
      ...(globeClipping ? { globeClipping } : {}),
      ...(elevationBands ? { elevationBands } : {}),
    };
  },
  applyProjectState: (app: GeoLibreAppAPI, state: unknown) => {
    const raw = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
    // The measure figure first: Play Path reads its path.
    const measure = restoreMeasure3d(app, raw.measure);
    const playPath = restorePlayPath(app, raw.playPath);
    const lineOfSight = restoreLineOfSight(app, raw.lineOfSight);
    const globeClipping = restoreGlobeClipping(app, raw.globeClipping);
    const elevationBands = restoreElevationBands(app, raw.elevationBands);
    return measure || playPath || lineOfSight || globeClipping || elevationBands;
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
  exportMeasure3dSummary,
  getMeasure3dProjectState,
  getMeasure3dSnapshot,
  isMeasure3dPanelVisible,
  measure3dSummary,
  normalizeDrawOptions,
  openMeasure3dPanel,
  saveMeasure3dAsLayer,
  reattachMeasure3d,
  restoreMeasure3d,
  setMeasure3dGeoid,
  setMeasure3dHeightsAboveSeaLevel,
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
export {
  DEFAULT_PITCH_THRESHOLD_DEG,
  DEFAULT_PLAY_SPEED,
  PLAY_COUNTDOWN_SECONDS,
  PLAY_MIN_RANGE_METERS,
  PLAY_PATH_TOOL_ID,
  PLAY_RETURN_SECONDS,
  PLAY_SPEED_MAX,
  PLAY_SPEED_MIN,
  PLAY_STEP_SECONDS,
  closePlayPathPanel,
  getPlayPathProjectState,
  getPlayPathSnapshot,
  isPlayPathPanelVisible,
  lookAtCameraPosition,
  openPlayPathPanel,
  pausePath,
  playPath,
  reattachPlayPath,
  resamplePathForFlight,
  restorePlayPath,
  setPlayPathPitchThreshold,
  setPlayPathSamplingStep,
  setPlayPathSpeed,
  setPlayPathTiming,
  stopPath,
  subscribePlayPath,
  type PlayPathState,
  type PlayPathTiming,
} from "./play-path";
export {
  buildMeasureFeatureCollection,
  measureFileStem,
  measureSummaryKind,
  measureSummaryProperties,
  measureSummaryText,
  pathBearingDegrees,
  type MeasureSummaryKind,
} from "./measure-export";
export {
  EGM96_COLUMNS,
  EGM96_GRID_BYTES,
  EGM96_ROWS,
  createEgm96Geoid,
  decodeEgm96Grid,
  egm96UndulationMeters,
  type Egm96Geoid,
} from "./egm96";
export {
  CLIPPABLE_LAYER_TYPES,
  GLOBE_CLIPPING_TOOL_ID,
  closeGlobeClippingPanel,
  featuresBoundingSphere,
  findTilesetForLayer,
  getGlobeClippingProjectState,
  getGlobeClippingSnapshot,
  isGlobeClippingPanelVisible,
  openGlobeClippingPanel,
  reattachGlobeClipping,
  refreshGlobeClippingLayers,
  restoreGlobeClipping,
  setGlobeClippingLayer,
  squareClippingPlanes,
  subscribeGlobeClipping,
  type ClippableLayer,
  type GlobeClippingState,
} from "./globe-clipping";
export {
  DEFAULT_BAND_OPACITY,
  DEFAULT_ELEVATION_BANDS,
  ELEVATION_BANDS_MAX,
  ELEVATION_BANDS_TOOL_ID,
  addElevationBand,
  applyElevationBands,
  clearElevationBands,
  closeElevationBandsPanel,
  elevationBandLayers,
  getElevationBandsProjectState,
  getElevationBandsSnapshot,
  isElevationBandsPanelVisible,
  normalizeElevationBands,
  openElevationBandsPanel,
  reattachElevationBands,
  removeElevationBand,
  restoreElevationBands,
  setElevationBands,
  setElevationBandsAboveSeaLevel,
  setElevationBandsGeoid,
  setElevationBandsOpacity,
  subscribeElevationBands,
  updateElevationBand,
  type ElevationBand,
  type ElevationBandsState,
} from "./elevation-bands";
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
