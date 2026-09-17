import { useAppStore } from "@geolibre/core";
import { isQueryableLayer } from "@geolibre/plugins";

/** Whether the map holds a layer the query panel can work on. */
export function useHasQueryableLayer(): boolean {
  return useAppStore((s) => s.layers.some(isQueryableLayer));
}
