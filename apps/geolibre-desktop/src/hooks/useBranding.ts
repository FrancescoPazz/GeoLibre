import { getBranding, type Branding } from "@geolibre/core";
import { useEffect, useState } from "react";

/**
 * The deployment's branding, re-resolved whenever the runtime environment
 * changes (`BRAND_*` at build or deployment time, `VITE_BRAND_*` in
 * Settings → Environment variables).
 */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(() => getBranding());
  useEffect(() => {
    const refresh = () => setBranding(getBranding());
    refresh();
    window.addEventListener("geolibre:runtime-env-change", refresh);
    return () => window.removeEventListener("geolibre:runtime-env-change", refresh);
  }, []);
  return branding;
}

/** The MIME type a favicon `<link>` should declare for `url`, or null to leave it unset. */
export function faviconMimeType(url: string): string | null {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".ico")) return "image/x-icon";
  return null;
}

/**
 * Put the branding on the document: the page title and the favicon. Both
 * come back to what index.html shipped when the branding is cleared.
 */
export function useDocumentBranding(): Branding {
  const branding = useBranding();
  const { name, faviconUrl } = branding;
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previousTitle = document.title;
    if (name) document.title = name;
    const icons = Array.from(
      document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]'),
    );
    const previous = icons.map((link) => ({
      href: link.getAttribute("href"),
      type: link.getAttribute("type"),
      sizes: link.getAttribute("sizes"),
    }));
    if (faviconUrl) {
      const type = faviconMimeType(faviconUrl);
      for (const link of icons) {
        link.setAttribute("href", faviconUrl);
        if (type) link.setAttribute("type", type);
        else link.removeAttribute("type");
        link.removeAttribute("sizes");
      }
    }
    return () => {
      if (name) document.title = previousTitle;
      if (faviconUrl) {
        icons.forEach((link, i) => {
          const was = previous[i];
          if (was.href) link.setAttribute("href", was.href);
          if (was.type) link.setAttribute("type", was.type);
          else link.removeAttribute("type");
          if (was.sizes) link.setAttribute("sizes", was.sizes);
        });
      }
    };
  }, [name, faviconUrl]);
  return branding;
}
