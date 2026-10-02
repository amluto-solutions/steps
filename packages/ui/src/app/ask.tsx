import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalDialog } from "../ModalDialog";

/**
 * Questions in the app's own style, never the browser's `confirm` or `prompt`: those are titled
 * "tauri.localhost says" and look like a fake (F029, 01/10/2026). `AskHost` is drawn once in the
 * app; a window without it (a test, a lone dialog) falls back to the browser's.
 */
type Request =
  | { kind: "confirm"; title: string; body: string; yes: string; done: (answer: boolean) => void }
  | {
      kind: "text";
      title: string;
      label: string;
      start: string;
      yes: string;
      done: (answer: string | null) => void;
    };

let show: ((request: Request | null) => void) | null = null;

/** Asks a yes-or-no question; true when the person chose `yes`. */
export const askConfirm = (title: string, body: string, yes: string): Promise<boolean> =>
  show
    ? new Promise((done) => show?.({ kind: "confirm", title, body, yes, done }))
    : Promise.resolve(window.confirm(body));

/** Asks for a short text; null when the person cancelled. */
export const askText = (title: string, label: string, start: string, yes: string) =>
  show
    ? new Promise<string | null>((done) => show?.({ kind: "text", title, label, start, yes, done }))
    : Promise.resolve(window.prompt(label, start));

export function AskHost() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<Request | null>(null);
  const [text, setText] = useState("");
  const firstRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    show = (next) => {
      setText(next?.kind === "text" ? next.start : "");
      setRequest(next);
    };
    return () => {
      show = null;
    };
  }, []);
  if (!request) return null;
  const finish = (answered: boolean) => {
    setRequest(null);
    if (request.kind === "confirm") request.done(answered);
    else request.done(answered ? text : null);
  };
  return (
    // Above every other dialog: it's asked from inside them (the export review, the editor).
    <div className="fixed inset-0 z-[950] grid items-center justify-items-center bg-scrim/50 p-4">
      <ModalDialog
        role={request.kind === "confirm" ? "alertdialog" : "dialog"}
        labelledBy="ask-title"
        {...(request.kind === "confirm" ? { describedBy: "ask-body" } : {})}
        initialFocus={firstRef}
        onEscape={() => finish(false)}
        className="card w-full max-w-lg p-6"
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            finish(true);
          }}
        >
          <h2 id="ask-title" className="font-heading text-xl text-navy">
            {request.title}
          </h2>
          {request.kind === "confirm" ? (
            <p id="ask-body" className="mt-3 whitespace-pre-line text-secondary">
              {request.body}
            </p>
          ) : (
            <label className="mt-4 flex flex-col gap-1.5 text-sm text-navy">
              {request.label}
              <input
                ref={(element) => {
                  firstRef.current = element;
                }}
                className="field"
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
              />
            </label>
          )}
          <div className="mt-6 flex justify-end gap-3">
            <button
              ref={(element) => {
                if (request.kind === "confirm") firstRef.current = element;
              }}
              type="button"
              className="btn"
              onClick={() => finish(false)}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-dark">
              {request.yes}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
