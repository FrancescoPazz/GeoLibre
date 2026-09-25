import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { MapEngine } from "@geolibre/map";
import { SectionErrorBoundary } from "../common/error-boundaries";
import { Measure3dPanel } from "./Measure3dPanel";
import { PlayPathPanel } from "./PlayPathPanel";
import { LineOfSightPanel } from "./LineOfSightPanel";
import { ViewshedAreaPanel } from "./ViewshedAreaPanel";
import { GlobeClippingPanel } from "./GlobeClippingPanel";
import { ElevationBandsPanel } from "./ElevationBandsPanel";
import { CoordsConverterPanel } from "./CoordsConverterPanel";
import { QueryPanel } from "./QueryPanel";
import { MicrozonationPanel } from "./MicrozonationPanel";

interface Rer3dToolPanelsProps {
  mapControllerRef: RefObject<MapEngine | null>;
}

/**
 * Mounts the ported 3D and regional analysis tool panels within the DesktopShell:
 * - 3D Measure, Play Path, Line of Sight, Viewshed Area
 * - Globe Clipping, Elevation Bands
 * - Coordinate Converter, Query Data, Seismic Microzonation
 */
export function Rer3dToolPanels({ mapControllerRef }: Rer3dToolPanelsProps) {
  const { t } = useTranslation();

  return (
    <>
      <SectionErrorBoundary
        label="Measure 3d panel"
        displayName={t("shell.section.measure3dPanel")}
      >
        <Measure3dPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Play path panel" displayName={t("shell.section.playPathPanel")}>
        <PlayPathPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Line of sight panel"
        displayName={t("shell.section.lineOfSightPanel")}
      >
        <LineOfSightPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Viewshed area panel"
        displayName={t("shell.section.viewshedAreaPanel")}
      >
        <ViewshedAreaPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Globe clipping panel"
        displayName={t("shell.section.globeClippingPanel")}
      >
        <GlobeClippingPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Elevation bands panel"
        displayName={t("shell.section.elevationBandsPanel")}
      >
        <ElevationBandsPanel />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Coordinate converter panel"
        displayName={t("shell.section.coordsConverterPanel")}
      >
        <CoordsConverterPanel mapControllerRef={mapControllerRef} />
      </SectionErrorBoundary>
      <SectionErrorBoundary label="Query data panel" displayName={t("shell.section.queryPanel")}>
        <QueryPanel mapControllerRef={mapControllerRef} />
      </SectionErrorBoundary>
      <SectionErrorBoundary
        label="Microzonation panel"
        displayName={t("shell.section.microzonationPanel")}
      >
        <MicrozonationPanel mapControllerRef={mapControllerRef} />
      </SectionErrorBoundary>
    </>
  );
}
