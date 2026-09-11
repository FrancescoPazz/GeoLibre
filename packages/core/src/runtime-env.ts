/**
 * Resolves runtime environment variables shared by the external-service clients
 * (geocoding, routing). Allowlisted build-time vars (`__GEOLIBRE_BUILD_ENV__`,
 * injected by `vite.config.ts`) are overlaid
 * with project-supplied runtime vars (`window.__GEOLIBRE_RUNTIME_ENV__`, set
 * from project preferences) so a self-hosted endpoint can be configured without
 * a rebuild. Carries no React/MapLibre dependency so callers stay unit-testable.
 */

import { parseCesiumIonAssetId } from "./cesium-ion";

// Injected by `vite.config.ts`'s `define` from an explicit allowlist
// (BUILD_ENV_KEYS), with credential-bearing names withheld from redistributable
// builds such as the Jupyter wheel.
//
// This deliberately does NOT read `import.meta.env`. That read is a whole-object
// one — nothing here names a static key — so Vite could not replace it per-key
// and instead inlined the entire env record into every chunk importing this
// module. Combined with the bare-to-prefixed shell bridge in `vite.config.ts`,
// every chunk importing this module would carry whatever the build machine had
// set. Keep this indirection: reverting to `import.meta.env` silently restores
// that behaviour, and no test would catch it.
declare const __GEOLIBRE_BUILD_ENV__: Record<string, string> | undefined;

const buildEnv: Record<string, string | undefined> =
  typeof __GEOLIBRE_BUILD_ENV__ === "undefined" ? {} : __GEOLIBRE_BUILD_ENV__;

/**
 * The allowlisted build-time environment, with no runtime overlay.
 *
 * For settings that must be fixed by the build and NOT overridable by a
 * `.geolibre.json` a user opened — the auth gate, the deployment profile, the
 * embed origin allowlist. Routing those through {@link getRuntimeEnvironment}
 * would let project-supplied `__GEOLIBRE_RUNTIME_ENV__` values relax them.
 *
 * Callers should prefer this over reading `import.meta.env` directly: a
 * whole-object read defeats Vite's per-key replacement and inlines every
 * `VITE_` var on the build machine into the chunk.
 *
 * @returns The build-time environment record.
 */
export function getBuildEnvironment(): Record<string, string | undefined> {
  return buildEnv;
}

/**
 * Merges build-time env with project runtime env (the latter wins). Falls back
 * to build-time env alone outside a browser (e.g. in tests).
 *
 * @returns The resolved environment variables.
 */
export function getRuntimeEnvironment(): Record<string, string | undefined> {
  if (typeof window === "undefined") return buildEnv;

  // __GEOLIBRE_RUNTIME_ENV__ is declared globally in ./types.
  return {
    ...buildEnv,
    ...(window.__GEOLIBRE_RUNTIME_ENV__ ?? {}),
  };
}

/**
 * Resolves a local DuckDB spatial extension path from the runtime environment.
 *
 * When `VITE_DUCKDB_SPATIAL_EXTENSION_PATH` is set, DuckDB consumers (the
 * desktop app's own loader and the Add Vector panel's maplibre-gl-vector
 * control) load the spatial extension from this path with `LOAD '<path>'`
 * instead of installing it from the remote repository, which hangs in
 * sandboxed or firewalled environments. Lives in `@geolibre/core` so every
 * consumer shares one implementation.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed extension path, or undefined when unset.
 */
export function getSpatialExtensionPath(
  env?: Record<string, string | undefined>,
): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_DUCKDB_SPATIAL_EXTENSION_PATH?.trim();
  return trimmed || undefined;
}

/**
 * Resolves the Protomaps API key from the runtime environment.
 *
 * Protomaps' hosted styles require an API key embedded in the style URL. The
 * key is supplied via `VITE_PROTOMAPS_API_KEY` (baked in at build time for the
 * web demo; see the deploy workflow). When unset, the Protomaps basemaps are
 * unavailable and should be hidden from the UI.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed API key, or undefined when unset.
 */
export function getProtomapsApiKey(env?: Record<string, string | undefined>): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_PROTOMAPS_API_KEY?.trim();
  return trimmed || undefined;
}

/**
 * Resolves the Google Maps API key from the runtime environment.
 *
 * GeoLibre's browser-facing builds normally use `VITE_GOOGLE_MAPS_API_KEY`.
 * The bare `GOOGLE_MAPS_API_KEY` fallback is reached two ways: (1) the desktop
 * Vite config copies it to `VITE_GOOGLE_MAPS_API_KEY` at build time for local
 * shell testing (`vite.config.ts`'s `envPrefix` does not include the bare
 * name), and (2) a project's own runtime environment variables
 * (`window.__GEOLIBRE_RUNTIME_ENV__`), which are not subject to Vite's
 * envPrefix allowlist at all.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed API key, or undefined when unset.
 */
export function getGoogleMapsApiKey(env?: Record<string, string | undefined>): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed =
    runtimeEnv.VITE_GOOGLE_MAPS_API_KEY?.trim() || runtimeEnv.GOOGLE_MAPS_API_KEY?.trim();
  return trimmed || undefined;
}

/**
 * Resolves the Mapbox access token from the runtime environment.
 *
 * The basemap control's Mapbox styles authenticate with the user's own token.
 * It is supplied via `VITE_MAPBOX_ACCESS_TOKEN` (baked in at build time from the
 * bare `MAPBOX_TOKEN` env var, which `vite.config.ts` copies into the prefixed
 * name — the spelling Mapbox's own tooling uses) or set at runtime through
 * Settings → Environment variables (`window.__GEOLIBRE_RUNTIME_ENV__`, which
 * bypasses Vite's envPrefix allowlist, so a bare `MAPBOX_TOKEN` entry works
 * there too). When unset, the Mapbox basemaps prompt for a token in the basemap
 * panel's API keys view instead.
 *
 * Note the precedence, shared with {@link getGoogleMapsApiKey} and
 * {@link getCesiumIonToken}: the prefixed name always wins over the bare one,
 * and `getRuntimeEnvironment` merges build-time and runtime vars into one
 * record. So a build that baked in `VITE_MAPBOX_ACCESS_TOKEN` is overridden at
 * runtime by a Settings entry under that *same* prefixed name; a bare
 * `MAPBOX_TOKEN` entry is a fallback for when nothing was baked in, not a way
 * to override a baked token.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed token, or undefined when unset.
 */
export function getMapboxAccessToken(env?: Record<string, string | undefined>): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_MAPBOX_ACCESS_TOKEN?.trim() || runtimeEnv.MAPBOX_TOKEN?.trim();
  return trimmed || undefined;
}

/**
 * Resolves the Cesium Ion access token from the runtime environment.
 *
 * Cesium World Terrain and Ion World Imagery need a Cesium Ion token. It is
 * supplied via `VITE_CESIUM_TOKEN` (baked in at build time from the bare
 * `CESIUM_TOKEN` env var, which `vite.config.ts` copies into the prefixed name)
 * or set at runtime through Settings → Environment variables
 * (`window.__GEOLIBRE_RUNTIME_ENV__`, which bypasses Vite's envPrefix allowlist,
 * so a bare `CESIUM_TOKEN` entry works there too).
 *
 * The 3D-globe view itself does **not** need one: it draws the project basemap
 * as its base imagery whenever that basemap has a raster form (see
 * {@link basemapToCesiumImagery}), and falls back to Ion World Imagery — or, with
 * no token, to OpenStreetMap — for the ones that do not. So an absent token
 * costs terrain and the quality of that fallback, not the view.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The trimmed token, or undefined when unset.
 */
export function getCesiumIonToken(env?: Record<string, string | undefined>): string | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const trimmed = runtimeEnv.VITE_CESIUM_TOKEN?.trim() || runtimeEnv.CESIUM_TOKEN?.trim();
  return trimmed || undefined;
}

/**
 * The Cesium Ion asset id of the terrain the globe should load in place of
 * Cesium World Terrain (Ion asset 1). A deployment that has uploaded its own
 * DTM to Ion — a regional model at a finer resolution than World Terrain, say —
 * sets `CESIUM_TERRAIN_ASSET_ID` (or the prefixed `VITE_CESIUM_TERRAIN_ASSET_ID`)
 * next to its Ion token, and the globe samples and drapes against that asset.
 *
 * The asset is private to the token that owns it, so the id is meaningless
 * without a token: the globe engine only consults it when Ion credentials
 * are present, and otherwise stays on the keyless Terrarium path. It is read
 * the same way as the token — build-time value overridden by a runtime one —
 * so a web deployment can repoint terrain from Settings with no rebuild.
 *
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The asset id as a positive integer, or undefined when unset or not a
 *   valid id (blank, non-numeric, zero, negative, or fractional).
 */
export function getCesiumTerrainAssetId(
  env?: Record<string, string | undefined>,
): number | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw =
    runtimeEnv.VITE_CESIUM_TERRAIN_ASSET_ID?.trim() || runtimeEnv.CESIUM_TERRAIN_ASSET_ID?.trim();
  return parseCesiumIonAssetId(raw) ?? undefined;
}

/**
 * Whether elevations should be reported above mean sea level (EGM96) rather
 * than above the WGS84 ellipsoid, as a deployment default. Terrain heights
 * are ellipsoidal; a geoportal whose users read heights off official
 * cartography wants them referred to sea level, which in Italy differs from
 * the ellipsoid by some 40–50 m. Set `VITE_ELEVATION_MEAN_SEA_LEVEL` (or the
 * bare `ELEVATION_MEAN_SEA_LEVEL`) to `1`/`true` at build or deployment time;
 * the user can still toggle it per tool.
 */
export function getElevationMeanSeaLevelDefault(env?: Record<string, string | undefined>): boolean {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = (runtimeEnv.VITE_ELEVATION_MEAN_SEA_LEVEL ?? runtimeEnv.ELEVATION_MEAN_SEA_LEVEL)
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Where Help → Give feedback goes: a web page or a pre-addressed e-mail. */
export interface FeedbackTarget {
  kind: "web" | "mailto";
  /** The full href: an http(s) URL, or `mailto:` with the subject filled in. */
  href: string;
}

/**
 * The deployment's feedback channel, if it names one. `VITE_FEEDBACK_URL`
 * (or the bare `FEEDBACK_URL`) is either an http(s) page — an issue tracker,
 * a form — or a `mailto:` address (a bare e-mail address is accepted too);
 * for e-mail, `VITE_FEEDBACK_SUBJECT` / `FEEDBACK_SUBJECT` pre-fills the
 * subject line, the way a geoportal wants "Geoportale 3D — segnalazione"
 * on every message. Anything else, or nothing, yields undefined and the app
 * keeps its default feedback link.
 */
export function getFeedbackTarget(
  env?: Record<string, string | undefined>,
): FeedbackTarget | undefined {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const raw = (runtimeEnv.VITE_FEEDBACK_URL ?? runtimeEnv.FEEDBACK_URL)?.trim();
  if (!raw) return undefined;
  const subject = (runtimeEnv.VITE_FEEDBACK_SUBJECT ?? runtimeEnv.FEEDBACK_SUBJECT)?.trim();
  const mailto = /^mailto:/i.test(raw)
    ? raw.slice("mailto:".length)
    : /^[^s@/?#]+@[^s@/?#]+$/.test(raw)
      ? raw
      : null;
  if (mailto !== null) {
    const [address, query] = mailto.split("?", 2);
    if (!address) return undefined;
    const params = new URLSearchParams(query ?? "");
    if (subject && !params.has("subject")) params.set("subject", subject);
    const search = params.toString();
    return { kind: "mailto", href: `mailto:${address}${search ? `?${search}` : ""}` };
  }
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:")
      return { kind: "web", href: url.href };
  } catch {
    // not a URL: fall through
  }
  return undefined;
}

/**
 * Builds a full Protomaps v5 style URL for a flavor, injecting the API key.
 *
 * @param flavor - The Protomaps flavor name (e.g. `light`, `dark`, `white`,
 *   `grayscale`, `black`).
 * @param env - Environment record (defaults to the runtime environment);
 *   injectable for testing.
 * @returns The resolved style URL, or undefined when no API key is configured.
 */
export function getProtomapsStyleUrl(
  flavor: string,
  env?: Record<string, string | undefined>,
): string | undefined {
  const key = getProtomapsApiKey(env);
  if (!key) return undefined;
  return `https://api.protomaps.com/styles/v5/${encodeURIComponent(
    flavor,
  )}/en.json?key=${encodeURIComponent(key)}`;
}
