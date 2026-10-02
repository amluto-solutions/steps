import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useLatest } from "./useLatest";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type ModalDialogProps = {
  role?: "dialog" | "alertdialog";
  labelledBy: string;
  describedBy?: string;
  /** Focused when the dialog opens; otherwise its first focusable control. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Called on Escape. Leave out when the dialog needs an explicit choice. */
  onEscape?: () => void;
  /**
   * Ctrl+Z, and Ctrl+Y or Ctrl+Shift+Z, for a dialog that changes the guide (the export review
   * and its quick fix), as in the editor. Left out, the keys belong to the dialog's own boxes.
   */
  onUndo?: (() => void) | undefined;
  onRedo?: (() => void) | undefined;
  className?: string;
  children: ReactNode;
};

/**
 * A modal that behaves like one for keyboard and screen-reader users (WCAG 2.4.3): focus
 * moves in when it opens, can't wander to the page behind it, and returns to where it was when
 * it closes. `aria-modal` alone only tells screen readers; it doesn't move focus.
 */
export function ModalDialog({
  role = "dialog",
  labelledBy,
  describedBy,
  initialFocus,
  onEscape,
  onUndo,
  onRedo,
  className,
  children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const escapeRef = useLatest(onEscape);
  const undoRef = useLatest(onUndo);
  const redoRef = useLatest(onRedo);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    (initialFocus?.current ?? focusables()[0] ?? dialog).focus();

    let backwards = false;
    // With one dialog opened from another (a step from the export review), Escape closes only
    // the one on top: the one holding focus, or else the last opened.
    const onTop = () => {
      const active = document.activeElement;
      const holder = active instanceof Element ? active.closest('[aria-modal="true"]') : null;
      return (holder ?? [...document.querySelectorAll('[aria-modal="true"]')].at(-1)) === dialog;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      backwards = event.key === "Tab" && event.shiftKey;
      if (event.key === "Escape" && escapeRef.current && onTop()) {
        event.preventDefault();
        escapeRef.current();
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const undoKey = key === "z" && !event.shiftKey;
      const redoKey = key === "y" || (key === "z" && event.shiftKey);
      const action = undoKey ? undoRef.current : redoKey ? redoRef.current : undefined;
      if (action && onTop()) {
        event.preventDefault();
        action();
      }
    };
    // Pull focus back whenever it leaves: covers Tab, Shift+Tab and radio groups alike.
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.contains(event.target)) {
        const items = focusables();
        (backwards ? items.at(-1) : items[0])?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      if (previous?.isConnected) previous.focus();
    };
  }, [initialFocus, escapeRef, undoRef, redoRef]);

  return (
    <section
      ref={dialogRef}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      tabIndex={-1}
      className={className}
    >
      {children}
    </section>
  );
}
