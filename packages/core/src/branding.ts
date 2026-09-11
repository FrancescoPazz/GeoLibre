import { getRuntimeEnvironment } from "./runtime-env";

/**
 * Deployment branding: the name, logo, favicon and accent colour a hosted
 * GeoLibre presents as its own — a regional geoportal is "Geoportale" with
 * the region's crest, not "GeoLibre" with a map pin. Read from the runtime
 * environment so a deployment sets it without a rebuild; absent values keep
 * the GeoLibre defaults.
 */
export interface Branding {
  /** The product name shown in the toolbar and the page title. */
  name?: string;
  /** An image for the toolbar's brand spot, in place of the map icon. */
  logoUrl?: string;
  /** Where clicking the logo goes, if anywhere. */
  logoLink?: string;
  /** The page's favicon. */
  faviconUrl?: string;
  /** The default accent colour (`#rrggbb`), applied unless the user picks a scheme. */
  accentColor?: string;
}

/** Whether `value` is an http(s) URL or a same-site path — the only places an asset may come from. */
export function isBrandAssetUrl(value: string): boolean {
  if (/^(\/|\.\/|\.\.\/)/.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * The deployment's branding from `VITE_BRAND_NAME`, `VITE_BRAND_LOGO_URL`,
 * `VITE_BRAND_LOGO_LINK`, `VITE_BRAND_FAVICON_URL` and
 * `VITE_BRAND_ACCENT_COLOR` (or the bare names). Values that are not what
 * the field wants — a `javascript:` logo, a colour that is not `#rrggbb` —
 * are dropped rather than passed through.
 */
export function getBranding(env?: Record<string, string | undefined>): Branding {
  const runtimeEnv = env ?? getRuntimeEnvironment();
  const read = (name: string) =>
    (runtimeEnv[`VITE_${name}`] ?? runtimeEnv[name])?.trim() || undefined;
  const asset = (name: string) => {
    const value = read(name);
    return value && isBrandAssetUrl(value) ? value : undefined;
  };
  const link = read("BRAND_LOGO_LINK");
  const accent = read("BRAND_ACCENT_COLOR");
  const branding: Branding = {};
  const name = read("BRAND_NAME");
  if (name) branding.name = name;
  const logoUrl = asset("BRAND_LOGO_URL");
  if (logoUrl) branding.logoUrl = logoUrl;
  if (link && /^https?:\/\//i.test(link)) branding.logoLink = link;
  const faviconUrl = asset("BRAND_FAVICON_URL");
  if (faviconUrl) branding.faviconUrl = faviconUrl;
  if (accent && isHexColor(accent)) branding.accentColor = accent.toLowerCase();
  return branding;
}
