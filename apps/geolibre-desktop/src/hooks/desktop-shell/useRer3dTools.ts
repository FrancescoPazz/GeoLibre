import { useEffect, type RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import { subscribePaneCesiumEngines } from "@geolibre/map";
import { reattachRer3dTools, setElevationBandsGeoid, setMeasure3dGeoid } from "@geolibre/plugins";
import { createAppAPI } from "../usePlugins";
import { getSharedGeoid } from "../../lib/geoid";

/**
 * Wires the 3D measurement and analysis tools into the map engines:
 * - Reattaches tools when a secondary Cesium pane mounts or replaces its engine
 * - Provides the shared EGM96 geoid to Measure 3D and Elevation Bands
 */
export function useRer3dTools(mapControllerRef: RefObject<MapEngine | null>): void {
  // The 3D tools bind to a globe in any pane (the primary canvas or a grid
  // split pane). When a pane mounts or replaces its Cesium engine, the
  // tools re-bind exactly as they do when the primary engine is rebuilt.
  useEffect(
    () =>
      subscribePaneCesiumEngines(() => {
        reattachRer3dTools(createAppAPI(mapControllerRef));
      }),
    [mapControllerRef],
  );

  // The EGM96 grid the 3D tools refer heights to mean sea level with. It is
  // a static asset fetched on first use, so wiring it is a one-time hand-over
  // rather than something the renderer swap has to redo.
  useEffect(() => {
    const geoid = getSharedGeoid();
    setMeasure3dGeoid(geoid.heights);
    setElevationBandsGeoid(geoid);
    return () => {
      setMeasure3dGeoid(undefined);
      setElevationBandsGeoid(undefined);
    };
  }, []);
}
