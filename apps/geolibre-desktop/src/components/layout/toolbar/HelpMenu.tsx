import { getRelatedMaps } from "@geolibre/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import {
  BookOpen,
  Bug,
  CircleHelp,
  FolderGit2,
  Globe,
  Info,
  Keyboard,
  Map as MapIcon,
  MessageSquare,
  RefreshCw,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../../hooks/useDesktopSettings";
import { IS_STORE_BUILD } from "../../../lib/updates";
import { isMenuItemVisible } from "../../../lib/ui-profile";
import {
  GITHUB_URL,
  openExternalLink,
  openFeedback,
  type ToolbarChrome,
  WEBSITE_URL,
} from "./constants";

interface HelpMenuProps {
  chrome: ToolbarChrome;
  /**
   * The read-only viewer preset. Hides the command palette and keyboard
   * shortcut entries, which reach the authoring commands whose own menus the
   * preset already hides (the toolbar switches the palette and the global
   * shortcuts off entirely in this mode).
   */
  viewer?: boolean;
  diagnosticsErrorCount: number;
  onOpenCommandPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenGuides: () => void;
  onOpenDiagnostics: () => void;
  onCheckForUpdates: () => void;
  onAbout: () => void;
}

/** The Help menu: command palette, shortcuts, diagnostics, feedback, updates, about. */
export function HelpMenu({
  chrome,
  viewer = false,
  diagnosticsErrorCount,
  onOpenCommandPalette,
  onOpenShortcuts,
  onOpenGuides,
  onOpenDiagnostics,
  onCheckForUpdates,
  onAbout,
}: HelpMenuProps) {
  const { t } = useTranslation();
  const uiProfile = useDesktopSettingsStore((s) => s.desktopSettings.uiProfile);
  // The Microsoft Store build strips the "Check for updates" item entirely so the
  // app only updates through the Store (policy 10.2.5); other builds keep it.
  const show = (id: string) => {
    if (id === "help.checkForUpdates" && IS_STORE_BUILD) return false;
    if (viewer && (id === "help.commandPalette" || id === "help.keyboardShortcuts")) return false;
    return isMenuItemVisible(uiProfile, id);
  };
  // Read once per render: the env does not change while the menu is open.
  const relatedMaps = getRelatedMaps();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          className={chrome.buttonClass}
          variant="ghost"
          size={chrome.buttonSize}
          aria-label={t("toolbar.menu.help")}
        >
          <CircleHelp className={chrome.iconClassName} />
          {chrome.renderLabel(t("toolbar.menu.help"))}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{t("toolbar.menu.help")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {show("help.commandPalette") && (
          <DropdownMenuItem onSelect={onOpenCommandPalette}>
            <Search className="me-2 h-3.5 w-3.5" />
            {t("toolbar.item.commandPalette")}
          </DropdownMenuItem>
        )}
        {show("help.keyboardShortcuts") && (
          <DropdownMenuItem onSelect={onOpenShortcuts}>
            <Keyboard className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.keyboardShortcuts")}
          </DropdownMenuItem>
        )}
        {show("help.guides") && (
          <DropdownMenuItem onSelect={onOpenGuides}>
            <BookOpen className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.guides")}
          </DropdownMenuItem>
        )}
        {(show("help.commandPalette") || show("help.keyboardShortcuts") || show("help.guides")) && (
          <DropdownMenuSeparator />
        )}
        {show("help.website") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(WEBSITE_URL)}>
            <Globe className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.website")}
          </DropdownMenuItem>
        )}
        {show("help.github") && (
          <DropdownMenuItem onSelect={() => void openExternalLink(GITHUB_URL)}>
            <FolderGit2 className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.githubRepository")}
          </DropdownMenuItem>
        )}
        {/* The deployment's sister portals (RELATED_MAPS), each opening in a
            new tab — the geoportal's "mappe correlate" list. */}
        {show("help.relatedMaps") && relatedMaps.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <MapIcon className="h-3.5 w-3.5" />
              {t("toolbar.command.relatedMaps")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-xs">
              {relatedMaps.map((map) => (
                <DropdownMenuItem
                  key={map.url}
                  title={map.description ?? map.url}
                  onSelect={() => void openExternalLink(map.url)}
                  className="flex-col items-start gap-0.5"
                >
                  <span>{map.title}</span>
                  {map.description ? (
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {map.description}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {(show("help.website") || show("help.github") || relatedMaps.length > 0) &&
          (show("help.diagnostics") ||
            show("help.feedback") ||
            show("help.checkForUpdates") ||
            show("help.about")) && <DropdownMenuSeparator />}
        {show("help.diagnostics") && (
          <DropdownMenuItem onSelect={onOpenDiagnostics}>
            <Bug className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.diagnostics")}
            {diagnosticsErrorCount > 0 ? (
              <span className="ms-2 rounded bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground">
                {diagnosticsErrorCount}
              </span>
            ) : null}
          </DropdownMenuItem>
        )}
        {show("help.feedback") && (
          <DropdownMenuItem onSelect={() => void openFeedback()}>
            <MessageSquare className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.giveFeedback")}
          </DropdownMenuItem>
        )}
        {show("help.checkForUpdates") && (
          <DropdownMenuItem onSelect={onCheckForUpdates}>
            <RefreshCw className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.checkForUpdates")}
          </DropdownMenuItem>
        )}
        {show("help.about") && (
          <DropdownMenuItem onSelect={onAbout}>
            <Info className="me-2 h-3.5 w-3.5" />
            {t("toolbar.command.about")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
