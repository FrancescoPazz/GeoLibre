import {
  excludeHiddenFieldsFromGeojson,
  resolveLayerCapabilities,
  useAppStore,
  type FieldVisibility,
} from "@geolibre/core";
import type { IdentifyPopupExtras } from "@geolibre/map";
import type { Feature, FeatureCollection } from "geojson";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSharedGeoid } from "../lib/geoid";
import {
  exportVectorLayer,
  featureExportFileStem,
  sanitizeExportFileName,
} from "../lib/vector-export";
import { useSeaLevelHeightsWanted } from "./useSeaLevelElevation";

/**
 * What the identify popup's footer needs from the app: the translated
 * labels, the sea-level shift for the click's height (when the deployment
 * wants heights above mean sea level and the globe is up), and the download
 * of the one identified feature as GeoJSON — named after the layer and the
 * feature, without piling a suffix on a name that already carries it.
 *
 * Memoized on what it reads so the map's identify effect, which lists it as
 * a dependency, is not re-armed on every render.
 */
export function useIdentifyPopupExtras(): IdentifyPopupExtras {
  const { t } = useTranslation();
  const seaLevel = useSeaLevelHeightsWanted();
  const [geoidLoaded, setGeoidLoaded] = useState(false);
  useEffect(() => {
    if (!seaLevel || geoidLoaded) return;
    let cancelled = false;
    void getSharedGeoid()
      .load()
      .then(() => {
        if (!cancelled) setGeoidLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [seaLevel, geoidLoaded]);

  return useMemo<IdentifyPopupExtras>(
    () => ({
      labels: {
        copyCoordinates: t("map.identifyPopup.copyCoordinates"),
        copied: t("map.identifyPopup.copied"),
        download: t("map.identifyPopup.download"),
        height: t("map.identifyPopup.height"),
        heightSeaLevel: t("map.identifyPopup.heightSeaLevel"),
      },
      adjustHeight: (lng, lat, alt) => {
        if (!seaLevel) return { alt, seaLevel: false };
        // Hidden rather than shown ellipsoidal until the grid is in memory,
        // so the number never jumps once it is.
        const undulation = geoidLoaded ? getSharedGeoid().heightSync(lng, lat) : null;
        return undulation === null ? null : { alt: alt - undulation, seaLevel: true };
      },
      downloadFeature: (layerId, feature, featureId) => {
        const layer = useAppStore.getState().layers.find((l) => l.id === layerId);
        if (!layer || !resolveLayerCapabilities(layer).export) return false;
        void downloadFeature(layer.name, layer.fieldVisibility, feature, featureId);
        return true;
      },
    }),
    [t, seaLevel, geoidLoaded],
  );
}

async function downloadFeature(
  layerName: string,
  fieldVisibility: Record<string, FieldVisibility> | undefined,
  feature: Feature,
  featureId: string | number | undefined,
): Promise<void> {
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: [{ ...feature, id: feature.id ?? featureId }],
  };
  const egress = fieldVisibility
    ? excludeHiddenFieldsFromGeojson(collection, fieldVisibility)
    : collection;
  const stem = featureExportFileStem(sanitizeExportFileName(layerName), featureId);
  try {
    await exportVectorLayer(egress, "geojson", stem, layerName);
  } catch (error) {
    console.warn("[GeoLibre] could not export the identified feature", error);
  }
}
