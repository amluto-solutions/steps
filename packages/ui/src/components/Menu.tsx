import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "./icons";

export interface MenuItem {
  label: string;
  /** A second, quieter line under the label. */
  note?: string;
  icon?: IconName;
  /** Shown at the right, e.g. a shortcut or a file-type badge. */
  trailing?: ReactNode;
  leading?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | "divider" | { heading: string };

interface MenuProps {
  /** The button that opens the menu; it gets aria-haspopup/aria-expanded. */
  trigger: (props: {
    ref: RefObject<HTMLButtonElement | null>;
    onClick: () => void;
    "aria-haspopup": "menu";
    "aria-expanded": boolean;
    "aria-controls": string;
  }) => ReactNode;
  entries: MenuEntry[];
  label: string;
  align?: "start" | "end";
  width?: number;
}

/**
 * A pop-up menu drawn in a portal on document.body with fixed positioning, so it always sits on
 * top of everything else and is never clipped by a scrolling list or card (25/09/2026). Arrow keys move, Enter picks, Escape closes and returns focus.
 */
export function Menu({ trigger, entries, label, align = "end", width = 280 }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const id = useId();

  const items = entries.filter(
    (entry): entry is MenuItem => typeof entry === "object" && "onSelect" in entry,
  );

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      const height = menu.current?.offsetHeight ?? 0;
      const below = box.bottom + 6;
      const above = box.top - height - 6;
      // Below if it fits, else above; if neither (a card low in a small window), as low as it
      // fits, scrolling when taller than the window. Cut off below, Move to Bin couldn't be reached.
      const top =
        below + height <= window.innerHeight - 8
          ? below
          : above > 8
            ? above
            : Math.max(8, window.innerHeight - height - 8);
      const left =
        align === "end"
          ? Math.max(8, Math.min(box.right - width, window.innerWidth - width - 8))
          : Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (item: MenuItem) => {
    setOpen(false);
    anchor.current?.focus();
    item.onSelect();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const buttons = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ??
        []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      anchor.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(index + 1) % buttons.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons.at(-1)?.focus();
    } else if (event.key === "Tab") {
      // The menu is drawn at the end of the page; back on its button first, Tab moves on from
      // there instead of jumping to the end.
      setOpen(false);
      anchor.current?.focus();
    }
  };

  return (
    <>
      {trigger({
        ref: anchor,
        onClick: () => setOpen((current) => !current),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": id,
      })}
      {open &&
        items.length > 0 &&
        createPortal(
          <div
            ref={menu}
            id={id}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="fixed z-[1000] flex flex-col rounded-xl border border-panel bg-background p-1.5 text-body shadow-[0_12px_32px_var(--amluto-shadow)]"
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              width,
              maxHeight: "calc(100vh - 16px)",
              overflowY: "auto",
            }}
          >
            {entries.map((entry, index) => {
              if (entry === "divider") {
                return (
                  <div
                    key={`divider-${index}`}
                    role="separator"
                    className="mx-1.5 my-1 h-px bg-panel"
                  />
                );
              }
              if ("heading" in entry) {
                return (
                  <div
                    key={`heading-${entry.heading}`}
                    className="px-2.5 pt-1.5 pb-1 text-xs font-bold text-secondary"
                  >
                    {entry.heading}
                  </div>
                );
              }
              return (
                <button
                  key={entry.label}
                  type="button"
                  role="menuitem"
                  disabled={entry.disabled}
                  onClick={() => choose(entry)}
                  className={`flex min-h-10 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-subtle focus:bg-subtle disabled:cursor-not-allowed disabled:opacity-50 ${entry.danger ? "text-recording" : "text-body"}`}
                >
                  {entry.leading}
                  {entry.icon && <Icon name={entry.icon} className="shrink-0" />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium">{entry.label}</span>
                    {entry.note && <span className="text-xs text-secondary">{entry.note}</span>}
                  </span>
                  {entry.trailing && (
                    <span className="shrink-0 text-xs text-secondary">{entry.trailing}</span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
