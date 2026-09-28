import {
  getElevationBandsSnapshot,
  getLineOfSightSnapshot,
  getMeasure3dSnapshot,
  getPlayPathSnapshot,
  getViewshedAreaSnapshot,
  subscribeElevationBands,
  subscribeLineOfSight,
  subscribeMeasure3d,
  subscribePlayPath,
  subscribeViewshedArea,
} from "@geolibre/plugins";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  isCoordsConverterPanelVisible,
  subscribeCoordsConverterPanel,
} from "../../lib/coords-converter-panel";
import {
  isMicrozonationPanelVisible,
  subscribeMicrozonationPanel,
} from "../../lib/microzonation-panel";
import {
  FLOATING_MAP_PANEL_EDGE_MARGIN,
  layoutFloatingMapPanels,
  openFloatingMapPanels,
  type FloatingMapLayoutBounds,
  type FloatingMapPanelId,
  type FloatingMapPanelOpenSet,
} from "../../hooks/floating-map-panel-layout";

function snapshotOpenSet(): FloatingMapPanelOpenSet {
  return {
    measure3d: getMeasure3dSnapshot().open,
    "play-path": getPlayPathSnapshot().open,
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
    "elevation-bands": getElevationBandsSnapshot().open,
    "coords-converter": isCoordsConverterPanelVisible(),
    microzonation: isMicrozonationPanelVisible(),
  };
}

function subscribeAllFloatingMapPanels(listener: () => void): () => void {
  const offs = [
    subscribeMeasure3d(listener),
    subscribePlayPath(listener),
    subscribeLineOfSight(listener),
    subscribeViewshedArea(listener),
    subscribeElevationBands(listener),
    subscribeCoordsConverterPanel(listener),
    subscribeMicrozonationPanel(listener),
  ];
  return () => {
    for (const off of offs) off();
  };
}

function getOpenPanelsKey(): string {
  return openFloatingMapPanels(snapshotOpenSet()).join(",");
}

interface FloatingMapPanelLayoutContextValue {
  bounds: FloatingMapLayoutBounds;
  getPosition: (id: FloatingMapPanelId) => { x: number; y: number };
  reportPanelHeight: (id: FloatingMapPanelId, height: number) => void;
  layoutVersion: string;
}

const FloatingMapPanelLayoutContext = createContext<FloatingMapPanelLayoutContextValue | null>(
  null,
);

export function FloatingMapPanelLayoutProvider({ children }: { children: ReactNode }) {
  const [bounds, setBounds] = useState<FloatingMapLayoutBounds>({
    width: typeof window !== "undefined" ? window.innerWidth : 1920,
    height: typeof window !== "undefined" ? window.innerHeight : 1080,
  });
  const [measuredHeights, setMeasuredHeights] = useState<
    Partial<Record<FloatingMapPanelId, number>>
  >({});

  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setBounds({ width, height });
      }
    });
    observer.observe(node);
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setBounds({ width: rect.width, height: rect.height });
    }
    return () => observer.disconnect();
  }, []);

  const openKey = useSyncExternalStore(
    subscribeAllFloatingMapPanels,
    getOpenPanelsKey,
    getOpenPanelsKey,
  );

  const reportPanelHeight = useCallback((id: FloatingMapPanelId, height: number) => {
    if (height <= 0) return;
    setMeasuredHeights((prev) => {
      if (prev[id] === height) return prev;
      return { ...prev, [id]: height };
    });
  }, []);

  const positions = useMemo(
    () => layoutFloatingMapPanels(snapshotOpenSet(), bounds, { heights: measuredHeights }),
    [openKey, bounds, measuredHeights],
  );

  const layoutVersion = `${openKey}|${bounds.width}x${bounds.height}|${JSON.stringify(measuredHeights)}`;

  const getPosition = useCallback(
    (id: FloatingMapPanelId) =>
      positions[id] ?? { x: FLOATING_MAP_PANEL_EDGE_MARGIN, y: FLOATING_MAP_PANEL_EDGE_MARGIN },
    [positions],
  );

  const value = useMemo(
    () => ({ bounds, getPosition, reportPanelHeight, layoutVersion }),
    [bounds, getPosition, reportPanelHeight, layoutVersion],
  );

  return (
    <FloatingMapPanelLayoutContext.Provider value={value}>
      <div ref={containerRef} className="pointer-events-none absolute inset-0">
        {children}
      </div>
    </FloatingMapPanelLayoutContext.Provider>
  );
}

export function useFloatingMapPanelLayoutContext(): FloatingMapPanelLayoutContextValue {
  const ctx = useContext(FloatingMapPanelLayoutContext);
  if (!ctx) {
    throw new Error("useFloatingMapPanelLayoutContext requires FloatingMapPanelLayoutProvider");
  }
  return ctx;
}

/** Optional context for panels that may render outside the provider (tests). */
export function useOptionalFloatingMapPanelLayoutContext(): FloatingMapPanelLayoutContextValue | null {
  return useContext(FloatingMapPanelLayoutContext);
}
