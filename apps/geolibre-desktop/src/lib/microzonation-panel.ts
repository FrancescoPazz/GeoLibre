/**
 * Open/closed state of the seismic microzonation panel (Controls →
 * Seismic microzonation), kept outside React like the other tool panels so
 * the toolbar menu and the panel read one flag through `useSyncExternalStore`.
 */

let open = false;
const listeners = new Set<() => void>();

export function subscribeMicrozonationPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isMicrozonationPanelVisible(): boolean {
  return open;
}

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function openMicrozonationPanel(): void {
  set(true);
}

export function closeMicrozonationPanel(): void {
  set(false);
}
