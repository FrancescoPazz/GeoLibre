import { createEgm96Geoid, type Egm96Geoid } from "@geolibre/plugins";

/**
 * The EGM96 geoid the app refers heights to mean sea level with — one
 * instance, created on first use, shared by the 3D tools and the status
 * bar so the 2 MB grid is fetched once.
 */
let shared: Egm96Geoid | null = null;

export function getSharedGeoid(): Egm96Geoid {
  if (!shared) {
    const url = new URL(`${import.meta.env.BASE_URL}geoid/WW15MGH.DAC`, document.baseURI).href;
    shared = createEgm96Geoid(url);
  }
  return shared;
}
