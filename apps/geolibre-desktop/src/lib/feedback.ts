import { getFeedbackTarget } from "@geolibre/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openExternalLink } from "./open-external";
import { isTauri } from "./tauri-io";

/** The project's default feedback channel: the GitHub issue tracker. */
export const DEFAULT_FEEDBACK_URL = "https://github.com/opengeos/GeoLibre/issues";

/**
 * Open Help → Give feedback. A deployment can point it at its own page or at
 * a pre-addressed e-mail (`FEEDBACK_URL`, `FEEDBACK_SUBJECT`); with nothing
 * configured it opens the issue tracker. E-mail goes through the mail
 * client: the opener plugin in the desktop shell, a same-window navigation
 * to the `mailto:` on the web, where the browser hands it to the mail app
 * without leaving the page.
 */
export async function openFeedback(): Promise<void> {
  const target = getFeedbackTarget();
  if (!target) {
    await openExternalLink(DEFAULT_FEEDBACK_URL);
    return;
  }
  if (target.kind === "web") {
    await openExternalLink(target.href);
    return;
  }
  if (isTauri()) {
    try {
      await openUrl(target.href);
    } catch (error) {
      console.warn("[GeoLibre] failed to open the feedback e-mail", error);
    }
    return;
  }
  window.location.assign(target.href);
}
