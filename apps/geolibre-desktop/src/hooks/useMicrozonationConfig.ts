import { getRuntimeEnvironment } from "@geolibre/core";
import { getMicrozonationConfig, type MicrozonationConfig } from "@geolibre/plugins";
import { useEffect, useState } from "react";

/** The deployment's microzonation service, re-read when the runtime environment changes. */
export function useMicrozonationConfig(): MicrozonationConfig | undefined {
  const [config, setConfig] = useState(() => getMicrozonationConfig(getRuntimeEnvironment()));
  useEffect(() => {
    const refresh = () => setConfig(getMicrozonationConfig(getRuntimeEnvironment()));
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return config;
}
