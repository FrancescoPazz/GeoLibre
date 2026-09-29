import {
  getElevationBandsSnapshot,
  getGlobeClippingSnapshot,
  getLineOfSightSnapshot,
  getMeasure3dSnapshot,
  getPlayPathSnapshot,
  getViewshedAreaSnapshot,
  subscribeElevationBands,
  subscribeGlobeClipping,
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
  FLOATING_MAP_PANEL_ORDER,
  layoutFloatingMapPanels,
  openFloatingMapPanels,
  type FloatingMapLayoutBounds,
  type FloatingMapPanelId,
  type FloatingMapPanelMinimizedSet,
  type FloatingMapPanelOpenSet,
} from "../../hooks/floating-map-panel-layout";
import { FloatingMapPanelMinimizedDock } from "./FloatingMapPanelMinimizedDock";

function snapshotOpenSet(): FloatingMapPanelOpenSet {
  return {
    measure3d: getMeasure3dSnapshot().open,
    "play-path": getPlayPathSnapshot().open,
    "line-of-sight": getLineOfSightSnapshot().open,
    "viewshed-area": getViewshedAreaSnapshot().open,
    "globe-clipping": getGlobeClippingSnapshot().open,
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
    subscribeGlobeClipping(listener),
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
  minimized: FloatingMapPanelMinimizedSet;
  isMinimized: (id: FloatingMapPanelId) => boolean;
  setMinimized: (id: FloatingMapPanelId, minimized: boolean) => void;
  toggleMinimized: (id: FloatingMapPanelId) => void;
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
  const [minimized, setMinimizedState] = useState<FloatingMapPanelMinimizedSet>({});

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

  useEffect(() => {
    const open = snapshotOpenSet();
    setMinimizedState((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const id of FLOATING_MAP_PANEL_ORDER) {
        if (!open[id] && next[id]) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [openKey]);

  const reportPanelHeight = useCallback((id: FloatingMapPanelId, height: number) => {
    if (height <= 0) return;
    setMeasuredHeights((prev) => {
      if (prev[id] === height) return prev;
      return { ...prev, [id]: height };
    });
  }, []);

  const positions = useMemo(
    () =>
      layoutFloatingMapPanels(snapshotOpenSet(), bounds, { heights: measuredHeights }, minimized),
    [openKey, bounds, measuredHeights, minimized],
  );

  const layoutVersion = `${openKey}|${bounds.width}x${bounds.height}|${JSON.stringify(measuredHeights)}|${JSON.stringify(minimized)}`;

  const getPosition = useCallback(
    (id: FloatingMapPanelId) =>
      positions[id] ?? { x: FLOATING_MAP_PANEL_EDGE_MARGIN, y: FLOATING_MAP_PANEL_EDGE_MARGIN },
    [positions],
  );

  const isMinimized = useCallback((id: FloatingMapPanelId) => minimized[id] === true, [minimized]);

  const setMinimized = useCallback((id: FloatingMapPanelId, value: boolean) => {
    setMinimizedState((prev) => {
      if (value) {
        if (prev[id]) return prev;
        return { ...prev, [id]: true };
      }
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const toggleMinimized = useCallback(
    (id: FloatingMapPanelId) => {
      setMinimized(id, !minimized[id]);
    },
    [minimized, setMinimized],
  );

  const value = useMemo(
    () => ({
      bounds,
      getPosition,
      reportPanelHeight,
      layoutVersion,
      minimized,
      isMinimized,
      setMinimized,
      toggleMinimized,
    }),
    [
      bounds,
      getPosition,
      reportPanelHeight,
      layoutVersion,
      minimized,
      isMinimized,
      setMinimized,
      toggleMinimized,
    ],
  );

  return (
    <FloatingMapPanelLayoutContext.Provider value={value}>
      <div ref={containerRef} className="pointer-events-none absolute inset-0">
        {children}
        <FloatingMapPanelMinimizedDock />
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
