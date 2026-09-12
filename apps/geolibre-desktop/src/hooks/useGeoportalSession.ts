import {
  getGeoportalLoginConfig,
  getGeoportalSession,
  getRuntimeEnvironment,
  subscribeGeoportalSession,
  type GeoportalLoginConfig,
  type GeoportalSession,
} from "@geolibre/core";
import { useEffect, useState, useSyncExternalStore } from "react";

/** The geoportal sign-in session (memory only; a reload signs the user out). */
export function useGeoportalSession(): GeoportalSession {
  return useSyncExternalStore(subscribeGeoportalSession, getGeoportalSession, getGeoportalSession);
}

/**
 * The deployment's sign-in service, re-resolved whenever the runtime
 * environment changes (`LOGIN_SERVICE_URL` at build or deployment time,
 * `VITE_LOGIN_SERVICE_URL` in Settings → Environment variables). Null when
 * the deployment has none: the sign-in entry then stays out of the toolbar.
 */
export function useGeoportalLoginConfig(): GeoportalLoginConfig | null {
  const [config, setConfig] = useState<GeoportalLoginConfig | null>(
    () => getGeoportalLoginConfig(getRuntimeEnvironment()) ?? null,
  );
  useEffect(() => {
    const refresh = () => setConfig(getGeoportalLoginConfig(getRuntimeEnvironment()) ?? null);
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return config;
}
