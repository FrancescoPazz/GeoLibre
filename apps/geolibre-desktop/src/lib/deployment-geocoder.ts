import {
  DEFAULT_GEOCODING_PROVIDER_ID,
  normalizeGeocodingProviderId,
  type GeocodingPreferences,
} from "@geolibre/core";
import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

/**
 * The geocoder a deployment names for its users — `VITE_GEOCODER_PROVIDER`
 * with its key, endpoints and contact email, set at build time or by the
 * Docker entrypoint. A regional geoportal wants its own address service in
 * the search box, not Nominatim, without every visitor picking it in
 * Settings.
 */

/** Whether `geocoding` is the untouched default: Nominatim, no key, no overrides. */
export function isDefaultGeocodingPreference(geocoding: GeocodingPreferences): boolean {
  return (
    normalizeGeocodingProviderId(geocoding.providerId) === DEFAULT_GEOCODING_PROVIDER_ID &&
    Object.values(geocoding.apiKeys ?? {}).every((key) => !key?.trim()) &&
    !geocoding.forwardEndpoint?.trim() &&
    !geocoding.reverseEndpoint?.trim() &&
    !geocoding.email?.trim()
  );
}

/**
 * The deployment's geocoding preference, or null when it names no provider.
 * The key lands under the provider's id, where Settings → Geocoding keeps it.
 */
export function deploymentGeocodingPreference(
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): GeocodingPreferences | null {
  const read = (key: string) => readDeploymentEnvValue(key, deploymentEnv, buildEnv)?.trim();
  const provider = read("VITE_GEOCODER_PROVIDER");
  if (!provider) return null;
  const providerId = normalizeGeocodingProviderId(provider);
  const apiKey = read("VITE_GEOCODER_API_KEY");
  return {
    providerId,
    apiKeys: apiKey ? { [providerId]: apiKey } : {},
    forwardEndpoint: read("VITE_GEOCODER_ENDPOINT") || undefined,
    reverseEndpoint: read("VITE_GEOCODER_REVERSE_ENDPOINT") || undefined,
    email: read("VITE_GEOCODER_EMAIL") || undefined,
  };
}
