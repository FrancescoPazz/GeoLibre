import { useAppStore } from "@geolibre/core";
import { useEffect } from "react";
import {
  deploymentGeocodingPreference,
  isDefaultGeocodingPreference,
} from "../lib/deployment-geocoder";

/**
 * Make the deployment's geocoder the project's default. Whenever the
 * project's geocoding preference is the untouched default — a new project,
 * or one saved without a choice — it is replaced by what the deployment
 * names; a project that carries its own choice keeps it. Written straight
 * to the store so it does not count as an unsaved change.
 */
export function useDeploymentGeocoderDefault(): void {
  useEffect(() => {
    const apply = () => {
      const state = useAppStore.getState();
      if (!isDefaultGeocodingPreference(state.preferences.geocoding)) return;
      const preferred = deploymentGeocodingPreference();
      if (!preferred) return;
      useAppStore.setState({
        preferences: { ...state.preferences, geocoding: preferred },
      });
    };
    apply();
    return useAppStore.subscribe((state, previous) => {
      if (state.preferences.geocoding !== previous.preferences.geocoding) apply();
    });
  }, []);
}
