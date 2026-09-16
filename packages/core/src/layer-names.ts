/**
 * Layer display names that stay distinct when the same file is added twice
 * or a layer is duplicated: `Roads`, then `Roads (2)`, `Roads (3)`, … — the
 * suffix the desktop gives a second copy of a file, so a second drop of the
 * same dataset is telling apart in the Layers panel instead of two identical
 * rows.
 *
 * The counter starts at 2 and always picks the lowest free number, so
 * removing `Roads (2)` and adding the file again fills the gap rather than
 * marching on to `(4)`. A name that already carries a suffix is treated as
 * its base: duplicating `Roads (2)` yields `Roads (3)`, not `Roads (2) (2)`.
 */

const UNIQUE_SUFFIX = /^(.*?) \((\d+)\)$/;

/** `Roads (2)` → `Roads`; a name with no counter is returned unchanged. */
export function baseLayerName(name: string): string {
  const match = UNIQUE_SUFFIX.exec(name);
  return match ? match[1] : name;
}

/**
 * `name` when nothing in `taken` uses it, else the lowest `name (N)` (N ≥ 2)
 * that nothing uses. `taken` is any iterable of names — typically
 * `layers.map((l) => l.name)`.
 */
export function uniqueLayerName(name: string, taken: Iterable<string>): string {
  const existing = taken instanceof Set ? taken : new Set(taken);
  if (!existing.has(name)) return name;
  const base = baseLayerName(name);
  let n = 2;
  while (existing.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/**
 * Whether two names refer to the same dataset once the copy counter is set
 * aside — what a multi-layer file's reload uses to find the entry a layer was
 * built from after the layer was renamed `Roads (2)` by {@link uniqueLayerName}.
 */
export function sameBaseLayerName(a: string, b: string): boolean {
  return a === b || baseLayerName(a) === baseLayerName(b);
}
