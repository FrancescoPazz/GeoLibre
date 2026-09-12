import type { CesiumEngine } from "./cesium-engine";

/**
 * The globes living in grid panes, by pane id, in mount order.
 *
 * The primary map area publishes its engine through `CesiumCanvas`'s
 * `engineRef`; a pane's globe never did, so a plugin that draws on a globe
 * had nothing to bind to while the 2D map stayed primary — which is the
 * arrangement a geoportal wants: the flat map for everyday work, the globe
 * in a pane for the 3D tools. Each pane's `CesiumCanvas` registers its
 * engine here once ready and withdraws it on unmount; the host hands the
 * list to plugins (`getCesiumScenes`) and re-binds them when it changes.
 */

const engines = new Map<string, CesiumEngine>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function registerPaneCesiumEngine(viewId: string, engine: CesiumEngine): void {
  if (engines.get(viewId) === engine) return;
  engines.set(viewId, engine);
  notify();
}

/** Withdraw `engine` for `viewId`; a different engine already there (a remount) is left alone. */
export function unregisterPaneCesiumEngine(viewId: string, engine: CesiumEngine): void {
  if (engines.get(viewId) !== engine) return;
  engines.delete(viewId);
  notify();
}

/** The pane globes' engines, in mount order. */
export function getPaneCesiumEngines(): CesiumEngine[] {
  return [...engines.values()];
}

/** Be told when a pane globe mounts or unmounts. */
export function subscribePaneCesiumEngines(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
