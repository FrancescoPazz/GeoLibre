/**
 * Open/closed state of the feature query panel (Controls → Query data),
 * kept outside React like the other tool panels so the toolbar menu and the
 * panel read one flag through `useSyncExternalStore`. The layer to query is
 * part of the state so a caller can open the panel on a given layer.
 */

let open = false;
let layerId: string | null = null;
const listeners = new Set<() => void>();

export function subscribeQueryPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isQueryPanelVisible(): boolean {
  return open;
}

/** The layer the panel opened on, or null to let it pick the first queryable one. */
export function queryPanelLayerId(): string | null {
  return layerId;
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function openQueryPanel(forLayerId: string | null = null): void {
  const changed = !open || layerId !== forLayerId;
  open = true;
  layerId = forLayerId;
  if (changed) notify();
}

export function closeQueryPanel(): void {
  if (!open) return;
  open = false;
  notify();
}

export function setQueryPanelLayer(nextLayerId: string | null): void {
  if (layerId === nextLayerId) return;
  layerId = nextLayerId;
  notify();
}
