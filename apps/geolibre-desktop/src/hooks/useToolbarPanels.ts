import { useAppStore } from "@geolibre/core";
import {
  closeBookmarkPanel,
  closeColorbarPanel,
  closeHtmlPanel,
  closeMeasurePanel,
  closeMinimapPanel,
  closePrintPanel,
  closeSearchPlacesPanel,
  closeFlightSimulatorPanel,
  closeLineOfSightPanel,
  closeMeasure3dPanel,
  closePlayPathPanel,
  closeElevationBandsPanel,
  closeGlobeClippingPanel,
  closeRouteAnimationPanel,
  closeSpinGlobePanel,
  closeSunPanel,
  closeViewStatePanel,
  isBookmarkPanelVisible,
  isColorbarPanelVisible,
  isEarthEnginePanelVisible,
  isHtmlPanelVisible,
  isMeasurePanelVisible,
  isMinimapPanelVisible,
  isPrintPanelVisible,
  isSearchPlacesPanelVisible,
  isFlightSimulatorPanelVisible,
  isLineOfSightPanelVisible,
  isMeasure3dPanelVisible,
  isPlayPathPanelVisible,
  isElevationBandsPanelVisible,
  isGlobeClippingPanelVisible,
  isRouteAnimationPanelVisible,
  isSpinGlobePanelVisible,
  isSunPanelVisible,
  isViewStatePanelVisible,
  openBookmarkPanel,
  openColorbarPanel,
  openHtmlPanel,
  openMeasurePanel,
  openMinimapPanel,
  openPrintPanel,
  openSearchPlacesPanel,
  openFlightSimulatorPanel,
  openLineOfSightPanel,
  openMeasure3dPanel,
  openPlayPathPanel,
  openElevationBandsPanel,
  openGlobeClippingPanel,
  openRouteAnimationPanel,
  openSpinGlobePanel,
  openSunPanel,
  openViewStatePanel,
  subscribeBookmarkPanel,
  subscribeColorbarPanel,
  subscribeEarthEnginePanel,
  subscribeHtmlPanel,
  subscribeMeasurePanel,
  subscribeMinimapPanel,
  subscribePrintPanel,
  subscribeSearchPlacesPanel,
  subscribeFlightSimulatorPanel,
  subscribeLineOfSight,
  subscribeMeasure3d,
  subscribePlayPath,
  subscribeElevationBands,
  subscribeGlobeClipping,
  subscribeRouteAnimationPanel,
  subscribeSpinGlobePanel,
  subscribeSunPanel,
  subscribeViewStatePanel,
  toggleEarthEnginePanel,
} from "@geolibre/plugins";
import { useSyncExternalStore } from "react";
import {
  closeCoordsConverterPanel,
  isCoordsConverterPanelVisible,
  openCoordsConverterPanel,
  subscribeCoordsConverterPanel,
} from "../lib/coords-converter-panel";
import {
  closeQueryPanel,
  isQueryPanelVisible,
  openQueryPanel,
  subscribeQueryPanel,
} from "../lib/query-panel";
import {
  closeMicrozonationPanel,
  isMicrozonationPanelVisible,
  openMicrozonationPanel,
  subscribeMicrozonationPanel,
} from "../lib/microzonation-panel";
import type { AppApi } from "../components/layout/toolbar/constants";

/** Visibility flag plus a toggle handler for a single toolbar panel. */
export interface ToolbarPanel {
  visible: boolean;
  toggle: () => void;
}

/** Visibility + toggle state for every panel surfaced in the toolbar menus. */
export interface ToolbarPanels {
  searchPlaces: ToolbarPanel;
  spinGlobe: ToolbarPanel;
  sun: ToolbarPanel;
  routeAnimation: ToolbarPanel;
  flightSimulator: ToolbarPanel;
  lineOfSight: ToolbarPanel;
  measure3d: ToolbarPanel;
  playPath: ToolbarPanel;
  globeClipping: ToolbarPanel;
  elevationBands: ToolbarPanel;
  coordsConverter: ToolbarPanel;
  queryData: ToolbarPanel;
  microzonation: ToolbarPanel;
  print: ToolbarPanel;
  colorbar: ToolbarPanel;
  legend: ToolbarPanel;
  html: ToolbarPanel;
  measure: ToolbarPanel;
  bookmark: ToolbarPanel;
  minimap: ToolbarPanel;
  viewState: ToolbarPanel;
  earthEngine: ToolbarPanel;
}

/**
 * Subscribe to the external panel stores and expose a `{ visible, toggle }`
 * pair per panel. This collapses the toolbar's many repetitive
 * `useSyncExternalStore` + handler blocks into one hook.
 *
 * @param appApi - The live app API used to open/close panels.
 * @returns Visibility flags and toggle handlers for each toolbar panel.
 */
export function useToolbarPanels(appApi: AppApi): ToolbarPanels {
  const searchPlacesVisible = useSyncExternalStore(
    subscribeSearchPlacesPanel,
    isSearchPlacesPanelVisible,
    isSearchPlacesPanelVisible,
  );
  const spinGlobeVisible = useSyncExternalStore(
    subscribeSpinGlobePanel,
    isSpinGlobePanelVisible,
    isSpinGlobePanelVisible,
  );
  const sunVisible = useSyncExternalStore(subscribeSunPanel, isSunPanelVisible, isSunPanelVisible);
  const routeAnimationVisible = useSyncExternalStore(
    subscribeRouteAnimationPanel,
    isRouteAnimationPanelVisible,
    isRouteAnimationPanelVisible,
  );
  const flightSimulatorVisible = useSyncExternalStore(
    subscribeFlightSimulatorPanel,
    isFlightSimulatorPanelVisible,
    isFlightSimulatorPanelVisible,
  );
  const lineOfSightVisible = useSyncExternalStore(
    subscribeLineOfSight,
    isLineOfSightPanelVisible,
    isLineOfSightPanelVisible,
  );
  const measure3dVisible = useSyncExternalStore(
    subscribeMeasure3d,
    isMeasure3dPanelVisible,
    isMeasure3dPanelVisible,
  );
  const playPathVisible = useSyncExternalStore(
    subscribePlayPath,
    isPlayPathPanelVisible,
    isPlayPathPanelVisible,
  );
  const globeClippingVisible = useSyncExternalStore(
    subscribeGlobeClipping,
    isGlobeClippingPanelVisible,
    isGlobeClippingPanelVisible,
  );
  const elevationBandsVisible = useSyncExternalStore(
    subscribeElevationBands,
    isElevationBandsPanelVisible,
    isElevationBandsPanelVisible,
  );
  const coordsConverterVisible = useSyncExternalStore(
    subscribeCoordsConverterPanel,
    isCoordsConverterPanelVisible,
    isCoordsConverterPanelVisible,
  );
  const queryDataVisible = useSyncExternalStore(
    subscribeQueryPanel,
    isQueryPanelVisible,
    isQueryPanelVisible,
  );
  const microzonationVisible = useSyncExternalStore(
    subscribeMicrozonationPanel,
    isMicrozonationPanelVisible,
    isMicrozonationPanelVisible,
  );
  const printVisible = useSyncExternalStore(
    subscribePrintPanel,
    isPrintPanelVisible,
    isPrintPanelVisible,
  );
  const colorbarVisible = useSyncExternalStore(
    subscribeColorbarPanel,
    isColorbarPanelVisible,
    isColorbarPanelVisible,
  );
  // The Legend panel is React-rendered from store state (MapLegendPanel), not
  // a maplibre-gl-components control like the rest.
  const legendConfig = useAppStore((state) => state.legend);
  const setLegend = useAppStore((state) => state.setLegend);
  const legendVisible = legendConfig.panelVisible === true;
  const htmlVisible = useSyncExternalStore(
    subscribeHtmlPanel,
    isHtmlPanelVisible,
    isHtmlPanelVisible,
  );
  const measureVisible = useSyncExternalStore(
    subscribeMeasurePanel,
    isMeasurePanelVisible,
    isMeasurePanelVisible,
  );
  const bookmarkVisible = useSyncExternalStore(
    subscribeBookmarkPanel,
    isBookmarkPanelVisible,
    isBookmarkPanelVisible,
  );
  const minimapVisible = useSyncExternalStore(
    subscribeMinimapPanel,
    isMinimapPanelVisible,
    isMinimapPanelVisible,
  );
  const viewStateVisible = useSyncExternalStore(
    subscribeViewStatePanel,
    isViewStatePanelVisible,
    isViewStatePanelVisible,
  );
  const earthEngineVisible = useSyncExternalStore(
    subscribeEarthEnginePanel,
    isEarthEnginePanelVisible,
    isEarthEnginePanelVisible,
  );

  return {
    searchPlaces: {
      visible: searchPlacesVisible,
      toggle: () => {
        if (searchPlacesVisible) {
          closeSearchPlacesPanel();
          return;
        }
        openSearchPlacesPanel(appApi);
      },
    },
    spinGlobe: {
      visible: spinGlobeVisible,
      toggle: () => {
        if (spinGlobeVisible) {
          closeSpinGlobePanel(appApi);
          return;
        }
        openSpinGlobePanel(appApi);
      },
    },
    sun: {
      visible: sunVisible,
      toggle: () => {
        if (sunVisible) {
          closeSunPanel(appApi);
          return;
        }
        openSunPanel(appApi);
      },
    },
    routeAnimation: {
      visible: routeAnimationVisible,
      toggle: () => {
        if (routeAnimationVisible) {
          closeRouteAnimationPanel(appApi);
          return;
        }
        openRouteAnimationPanel(appApi);
      },
    },
    flightSimulator: {
      visible: flightSimulatorVisible,
      toggle: () => {
        if (flightSimulatorVisible) {
          closeFlightSimulatorPanel(appApi);
          return;
        }
        openFlightSimulatorPanel(appApi);
      },
    },
    lineOfSight: {
      visible: lineOfSightVisible,
      toggle: () => {
        if (lineOfSightVisible) {
          closeLineOfSightPanel(appApi);
          return;
        }
        openLineOfSightPanel(appApi);
      },
    },
    measure3d: {
      visible: measure3dVisible,
      toggle: () => {
        if (measure3dVisible) {
          closeMeasure3dPanel(appApi);
          return;
        }
        openMeasure3dPanel(appApi);
      },
    },
    playPath: {
      visible: playPathVisible,
      toggle: () => {
        if (playPathVisible) {
          closePlayPathPanel(appApi);
          return;
        }
        openPlayPathPanel(appApi);
      },
    },
    globeClipping: {
      visible: globeClippingVisible,
      toggle: () => {
        if (globeClippingVisible) {
          closeGlobeClippingPanel(appApi);
          return;
        }
        openGlobeClippingPanel(appApi);
      },
    },
    elevationBands: {
      visible: elevationBandsVisible,
      toggle: () => {
        if (elevationBandsVisible) {
          closeElevationBandsPanel(appApi);
          return;
        }
        openElevationBandsPanel(appApi);
      },
    },
    coordsConverter: {
      visible: coordsConverterVisible,
      toggle: () => {
        if (coordsConverterVisible) {
          closeCoordsConverterPanel();
          return;
        }
        openCoordsConverterPanel();
      },
    },
    queryData: {
      visible: queryDataVisible,
      toggle: () => {
        if (queryDataVisible) {
          closeQueryPanel();
          return;
        }
        openQueryPanel();
      },
    },
    microzonation: {
      visible: microzonationVisible,
      toggle: () => {
        if (microzonationVisible) {
          closeMicrozonationPanel();
          return;
        }
        openMicrozonationPanel();
      },
    },
    print: {
      visible: printVisible,
      toggle: () => {
        if (printVisible) {
          closePrintPanel();
          return;
        }
        openPrintPanel(appApi);
      },
    },
    colorbar: {
      visible: colorbarVisible,
      toggle: () => {
        if (colorbarVisible) {
          closeColorbarPanel(appApi);
          return;
        }
        openColorbarPanel(appApi);
      },
    },
    legend: {
      visible: legendVisible,
      toggle: () => setLegend({ ...legendConfig, panelVisible: !legendVisible }),
    },
    html: {
      visible: htmlVisible,
      toggle: () => {
        if (htmlVisible) {
          closeHtmlPanel(appApi);
          return;
        }
        openHtmlPanel(appApi);
      },
    },
    measure: {
      visible: measureVisible,
      toggle: () => {
        if (measureVisible) {
          closeMeasurePanel(appApi);
          return;
        }
        openMeasurePanel(appApi);
      },
    },
    bookmark: {
      visible: bookmarkVisible,
      toggle: () => {
        if (bookmarkVisible) {
          closeBookmarkPanel(appApi);
          return;
        }
        openBookmarkPanel(appApi);
      },
    },
    minimap: {
      visible: minimapVisible,
      toggle: () => {
        if (minimapVisible) {
          closeMinimapPanel(appApi);
          return;
        }
        openMinimapPanel(appApi);
      },
    },
    viewState: {
      visible: viewStateVisible,
      toggle: () => {
        if (viewStateVisible) {
          closeViewStatePanel(appApi);
          return;
        }
        openViewStatePanel(appApi);
      },
    },
    earthEngine: {
      visible: earthEngineVisible,
      toggle: () => toggleEarthEnginePanel(appApi),
    },
  };
}
