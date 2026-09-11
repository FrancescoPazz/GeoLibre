import { getElevationMeanSeaLevelDefault, useAppStore } from "@geolibre/core";
import { useEffect, useState } from "react";
import { getSharedGeoid } from "../lib/geoid";

/**
 * Whether heights read off the globe should be shown above mean sea level.
 * The globe's terrain heights are ellipsoidal (WGS84); the 2D map's come
 * from sea-level DEM tiles and the Open-Meteo service and need no shift.
 */
export function useSeaLevelHeightsWanted(): boolean {
  const cesiumPrimary = useAppStore((s) => s.primaryRenderer === "cesium");
  const [wanted, setWanted] = useState(() => getElevationMeanSeaLevelDefault());
  useEffect(() => {
    const refresh = () => setWanted(getElevationMeanSeaLevelDefault());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return cesiumPrimary && wanted;
}

/**
 * `elevation` referred to mean sea level when that is wanted: the EGM96
 * undulation at `coords` is subtracted once the grid is in memory (it is
 * fetched on first need, and the readout stays hidden rather than show an
 * ellipsoidal value that would then jump). Otherwise `elevation` as given.
 */
export function useSeaLevelElevation(
  elevation: number | null,
  coords: [number, number] | null,
): { elevation: number | null; seaLevel: boolean } {
  const wanted = useSeaLevelHeightsWanted();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!wanted || loaded) return;
    let cancelled = false;
    void getSharedGeoid()
      .load()
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wanted, loaded]);
  if (!wanted || elevation === null) return { elevation, seaLevel: false };
  if (!coords) return { elevation: null, seaLevel: true };
  const undulation = loaded ? getSharedGeoid().heightSync(coords[0], coords[1]) : null;
  if (undulation === null) return { elevation: null, seaLevel: true };
  return { elevation: elevation - undulation, seaLevel: true };
}
