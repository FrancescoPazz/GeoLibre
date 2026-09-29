import { Button } from "@geolibre/ui";
import { ChevronUp, X, type LucideIcon } from "lucide-react";
import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import type { FloatingMapPanelId } from "../../hooks/floating-map-panel-layout";
import { clamp } from "../../lib/clamp";
import { useOptionalFloatingMapPanelLayoutContext } from "./FloatingMapPanelLayoutContext";

const EDGE_MARGIN = 12;

export interface FloatingMapToolPanelShellProps {
  id: FloatingMapPanelId;
  title: string;
  icon: LucideIcon;
  iconClassName: string;
  width: number;
  cardRef: RefObject<HTMLDivElement | null>;
  position: { x: number; y: number };
  setPosition: (next: { x: number; y: number }) => void;
  onClose: () => void;
  closeAriaLabel: string;
  testId: string;
  headerActions?: ReactNode;
  dragIgnoreSelector?: string;
  onMinimizedChange?: (minimized: boolean) => void;
  cardClassName?: string;
  children: ReactNode;
}

/**
 * Shared chrome for map floating tool cards: drag header, minimize-to-dock, close.
 */
export function FloatingMapToolPanelShell({
  id,
  title,
  icon: Icon,
  iconClassName,
  width,
  cardRef,
  position,
  setPosition,
  onClose,
  closeAriaLabel,
  testId,
  headerActions,
  dragIgnoreSelector = "button,input,select,label,[role=slider]",
  onMinimizedChange,
  cardClassName,
  children,
}: FloatingMapToolPanelShellProps) {
  const { t } = useTranslation();
  const layout = useOptionalFloatingMapPanelLayoutContext();
  const minimized = layout?.isMinimized(id) ?? false;

  useEffect(() => {
    onMinimizedChange?.(minimized);
  }, [minimized, onMinimizedChange]);

  if (minimized) return null;

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest(dragIgnoreSelector)) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = position;
    const handleMove = (move: PointerEvent) => {
      const card = handle.parentElement;
      const bounds = card?.parentElement?.getBoundingClientRect();
      const cardHeight = card?.getBoundingClientRect().height ?? 80;
      const maxX = Math.max(
        EDGE_MARGIN,
        (bounds?.width ?? window.innerWidth) - width - EDGE_MARGIN,
      );
      const maxY = Math.max(
        EDGE_MARGIN,
        (bounds?.height ?? window.innerHeight) - cardHeight - EDGE_MARGIN,
      );
      setPosition({
        x: clamp(origin.x + (move.clientX - startX), EDGE_MARGIN, maxX),
        y: clamp(origin.y + (move.clientY - startY), EDGE_MARGIN, maxY),
      });
    };
    const handleUp = () => {
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", handleMove);
      handle.removeEventListener("pointerup", handleUp);
      handle.removeEventListener("pointercancel", handleUp);
    };
    handle.addEventListener("pointermove", handleMove);
    handle.addEventListener("pointerup", handleUp);
    handle.addEventListener("pointercancel", handleUp);
  };

  return (
    <div
      ref={cardRef}
      className={`pointer-events-auto absolute z-30 rounded-lg border border-border map-glass shadow-lg${cardClassName ? ` ${cardClassName}` : ""}`}
      style={{ left: position.x, top: position.y, width }}
      role="dialog"
      aria-label={title}
      data-testid={testId}
    >
      <div
        className="flex cursor-grab items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2 active:cursor-grabbing"
        onPointerDown={handleDragStart}
      >
        <Icon className={iconClassName} />
        <span className="text-sm font-medium">{title}</span>
        {headerActions}
        <Button
          variant="ghost"
          size="icon"
          className={`h-6 w-6 ${headerActions ? "" : "ms-auto"}`}
          aria-label={t("toolbar.mapToolPanel.minimize")}
          title={t("toolbar.mapToolPanel.minimize")}
          disabled={!layout}
          onClick={() => layout?.setMinimized(id, true)}
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label={closeAriaLabel}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {children}
    </div>
  );
}
