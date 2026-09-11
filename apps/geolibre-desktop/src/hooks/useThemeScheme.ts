import { useLayoutEffect } from "react";
import { DEFAULT_THEME_SCHEME, applyThemeScheme } from "../lib/theme-schemes";
import { useBranding } from "./useBranding";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Keeps the document's `data-theme` attribute in sync with the persisted accent
 * scheme. Pairs with `useThemeMode` (light/dark): mode toggles the `.dark` class,
 * this hook sets the accent scheme on top of it.
 *
 * A branded deployment (`BRAND_ACCENT_COLOR`) makes its colour the default:
 * it applies while the user is on the default scheme, and any preset or
 * custom colour they pick in Settings wins over it.
 */
export function useThemeScheme(): void {
  const scheme = useDesktopSettingsStore((state) => state.desktopSettings.theme.scheme);
  const customColor = useDesktopSettingsStore((state) => state.desktopSettings.theme.customColor);
  const brandAccent = useBranding().accentColor;

  useLayoutEffect(() => {
    if (scheme === DEFAULT_THEME_SCHEME && brandAccent) applyThemeScheme("custom", brandAccent);
    else applyThemeScheme(scheme, customColor);
  }, [scheme, customColor, brandAccent]);
}
