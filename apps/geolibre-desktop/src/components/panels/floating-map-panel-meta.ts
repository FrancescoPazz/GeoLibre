import type { LucideIcon } from "lucide-react";
import { Activity, Mountain, Move3d, Eye, Radar, Route, Ruler, Scissors } from "lucide-react";
import type { FloatingMapPanelId } from "../../hooks/floating-map-panel-layout";

/** i18n key under `toolbar.*.title` for each floating map tool panel. */
export const FLOATING_MAP_PANEL_TITLE_KEY: Record<FloatingMapPanelId, string> = {
  measure3d: "toolbar.measure3d.title",
  "play-path": "toolbar.playPath.title",
  "line-of-sight": "toolbar.lineOfSight.title",
  "viewshed-area": "toolbar.viewshedArea.title",
  "globe-clipping": "toolbar.globeClipping.title",
  "elevation-bands": "toolbar.elevationBands.title",
  "coords-converter": "toolbar.coordsConverter.title",
  microzonation: "toolbar.microzonation.title",
};

export const FLOATING_MAP_PANEL_TEST_ID: Record<FloatingMapPanelId, string> = {
  measure3d: "measure-3d-panel",
  "play-path": "play-path-panel",
  "line-of-sight": "line-of-sight-panel",
  "viewshed-area": "viewshed-area-panel",
  "globe-clipping": "globe-clipping-panel",
  "elevation-bands": "elevation-bands-panel",
  "coords-converter": "coords-converter-panel",
  microzonation: "microzonation-panel",
};

export const FLOATING_MAP_PANEL_ICON: Record<
  FloatingMapPanelId,
  { Icon: LucideIcon; className: string }
> = {
  measure3d: { Icon: Ruler, className: "h-4 w-4 text-sky-500" },
  "play-path": { Icon: Route, className: "h-4 w-4 text-violet-500" },
  "line-of-sight": { Icon: Eye, className: "h-4 w-4 text-emerald-500" },
  "viewshed-area": { Icon: Radar, className: "h-4 w-4 text-emerald-500" },
  "globe-clipping": { Icon: Scissors, className: "h-4 w-4 text-orange-500" },
  "elevation-bands": { Icon: Mountain, className: "h-4 w-4 text-lime-600" },
  "coords-converter": { Icon: Move3d, className: "h-4 w-4 text-sky-500" },
  microzonation: { Icon: Activity, className: "h-4 w-4 text-sky-500" },
};
