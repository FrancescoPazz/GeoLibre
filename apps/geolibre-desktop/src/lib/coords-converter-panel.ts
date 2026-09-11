/**
 * Open/closed state of the coordinate converter panel (Controls →
 * Coordinate converter), kept outside React like the plugin panels so the
 * toolbar menu and the panel read one flag through `useSyncExternalStore`.
 */

let open = false;
const listeners = new Set<() => void>();

export function subscribeCoordsConverterPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isCoordsConverterPanelVisible(): boolean {
  return open;
}

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openCoordsConverterPanel(): void {
  set(true);
}

export function closeCoordsConverterPanel(): void {
  set(false);
}
