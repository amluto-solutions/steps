import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** How long the pointer rests on a button before its tooltip shows. */
const HOVER_DELAY_MS = 500;
/** The gap between the button and its tooltip, and the least room kept from the window's edge. */
const GAP = 6;

/**
 * A tooltip for a button shown as an icon alone (#84): what it's called, and its shortcut, after
 * the pointer rests on it for half a second, or at once when it's reached with the keyboard.
 * Escape, scrolling, resizing, pressing it or moving away hide it. The window's own `title`
 * tooltip didn't show in the desktop app's web view after a second's hover (10/10/2026 test, P38),
 * so it's drawn here, in a portal on top as menus are.
 *
 * The button keeps its own accessible name (`aria-label`); the tooltip repeats it on screen only,
 * so it's hidden from screen readers rather than read twice.
 */
export function Tip({
  text,
  off = false,
  children,
}: {
  text: string;
  /** Shown with its label, the button needs no tooltip. */
  off?: boolean;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  // Listened for on the wrapper itself, as the button's own events bubble to it; the button stays
  // the only thing that can be focused or pressed.
  useEffect(() => {
    const element = anchor.current;
    if (!element || off) return;
    let timer: number | undefined;
    /** A press focuses the button too; that focus isn't the keyboard's, so it shows nothing. */
    let pressed = false;
    const show = () => {
      window.clearTimeout(timer);
      setOpen(true);
    };
    const hide = () => {
      window.clearTimeout(timer);
      setOpen(false);
      setPosition(null);
    };
    const outside = (event: Event) => {
      const related = (event as PointerEvent | FocusEvent).relatedTarget;
      return !(related instanceof Node && element.contains(related));
    };
    const over = (event: Event) => {
      if (!outside(event)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(show, HOVER_DELAY_MS);
    };
    const out = (event: Event) => {
      if (outside(event)) hide();
    };
    const down = () => {
      pressed = true;
      hide();
    };
    const focusIn = () => {
      if (!pressed) show();
    };
    const focusOut = () => {
      pressed = false;
      hide();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    element.addEventListener("pointerover", over);
    element.addEventListener("pointerout", out);
    element.addEventListener("pointerdown", down);
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", focusOut);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.clearTimeout(timer);
      element.removeEventListener("pointerover", over);
      element.removeEventListener("pointerout", out);
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", focusOut);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      setOpen(false);
    };
  }, [off]);

  // Below the button, centred; above it near the bottom of the window, nudged in at the sides.
  useLayoutEffect(() => {
    if (!open) return;
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    const width = bubble.current?.offsetWidth ?? 0;
    const height = bubble.current?.offsetHeight ?? 0;
    const left = Math.min(
      Math.max(box.left + box.width / 2 - width / 2, GAP),
      Math.max(GAP, window.innerWidth - width - GAP),
    );
    const top =
      box.bottom + GAP + height > window.innerHeight ? box.top - GAP - height : box.bottom + GAP;
    setPosition({ top, left });
  }, [open]);

  return (
    <span ref={anchor} className="inline-flex shrink-0">
      {children}
      {open &&
        createPortal(
          <span
            ref={bubble}
            role="tooltip"
            aria-hidden="true"
            className="pointer-events-none fixed z-[1100] rounded-md border border-panel bg-background px-2 py-1 text-xs whitespace-nowrap text-body shadow-[0_6px_16px_var(--amluto-shadow)]"
            style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }}
          >
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}
