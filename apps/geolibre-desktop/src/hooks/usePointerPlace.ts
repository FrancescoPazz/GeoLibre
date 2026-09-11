import {
  createWhereAmIResolver,
  getWhereAmIConfig,
  useAppStore,
  type WhereAmIPlace,
} from "@geolibre/core";
import { useEffect, useState } from "react";

/**
 * The place under the pointer, for the status bar, when the deployment
 * names a place-name service (`WHERE_AM_I_URL` / `WHERE_AM_I_FIELD`).
 * Engine-agnostic: both the 2D map and the globe publish `pointerCoords`
 * to the store, and the resolver debounces and caches the lookups behind
 * them. Null when nothing is configured, the pointer is off the map, or
 * the service knows nothing about the spot.
 */
export function usePointerPlace(): WhereAmIPlace | null {
  const [place, setPlace] = useState<WhereAmIPlace | null>(null);
  useEffect(() => {
    const config = getWhereAmIConfig();
    if (!config) return;
    const resolver = createWhereAmIResolver({ config, emit: setPlace });
    resolver.update(useAppStore.getState().pointerCoords);
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.pointerCoords !== previous.pointerCoords) resolver.update(state.pointerCoords);
    });
    return () => {
      unsubscribe();
      resolver.dispose();
      setPlace(null);
    };
  }, []);
  return place;
}
