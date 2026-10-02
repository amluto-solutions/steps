import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "./icons";

export interface ToastMessage {
  id: number;
  text: string;
  /** e.g. Undo. The toast closes after it runs. */
  action?: { label: string; run: () => void };
  /** A second one beside it, e.g. "Open file location" after "Open". */
  secondAction?: { label: string; run: () => void };
  /**
   * Something went wrong: it stays until closed, as the message can't be read again anywhere
   * else (WCAG 2.2.1).
   */
  kind?: "error";
}

/**
 * A short message at the bottom of the window, used for undo after deletes (undo rather than
 * "are you sure?" for anything that can be brought back). It stays 8 seconds, longer than the
 * WCAG 2.2.1 minimum for reading and reaching the button, and pauses while hovered or focused.
 * An error stays until it's closed.
 */
export function Toast({ toast, onClose }: { toast: ToastMessage | null; onClose: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-6 z-[900] flex justify-center"
    >
      {toast && <ToastBox toast={toast} onClose={onClose} />}
    </div>
  );
}

/** The message itself. It is new each time a toast opens, so it always starts unpaused. */
function ToastBox({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  // Hover and focus are tracked separately: leaving with the mouse mustn't restart the timer
  // while the keyboard is still on the Undo button.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;

  useEffect(() => {
    if (paused || toast.kind === "error") return;
    // A fresh 8 seconds after each pause, so there is always time to reach the button.
    const timer = window.setTimeout(onClose, 8000);
    return () => window.clearTimeout(timer);
  }, [toast, onClose, paused]);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const enter = () => setHovered(true);
    const leave = () => setHovered(false);
    const focusIn = () => setFocused(true);
    const focusOut = (event: FocusEvent) => {
      if (!element.contains(event.relatedTarget as Node | null)) setFocused(false);
    };
    element.addEventListener("mouseenter", enter);
    element.addEventListener("mouseleave", leave);
    element.addEventListener("focusin", focusIn);
    element.addEventListener("focusout", focusOut);
    return () => {
      element.removeEventListener("mouseenter", enter);
      element.removeEventListener("mouseleave", leave);
      element.removeEventListener("focusin", focusIn);
      element.removeEventListener("focusout", focusOut);
    };
  }, []);

  return (
    <div
      ref={box}
      className="pointer-events-auto flex items-center gap-3 rounded-xl bg-brand-navy py-2 pr-2 pl-4 text-sm text-white shadow-[0_10px_28px_var(--amluto-shadow)]"
    >
      <span>{toast.text}</span>
      {toast.action && (
        <button
          type="button"
          className="h-8 rounded-lg bg-white/15 px-3 font-bold hover:bg-white/25"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
        >
          {toast.action.label}
        </button>
      )}
      {toast.secondAction && (
        <button
          type="button"
          className="h-8 rounded-lg bg-white/15 px-3 font-bold hover:bg-white/25"
          onClick={() => {
            toast.secondAction?.run();
            onClose();
          }}
        >
          {toast.secondAction.label}
        </button>
      )}
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-white/15"
        aria-label={t("common.dismiss")}
        onClick={onClose}
      >
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}
