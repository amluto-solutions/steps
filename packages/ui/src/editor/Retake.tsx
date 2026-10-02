import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import type { ToastMessage } from "../components/Toast";
import { errorMessage } from "../errors";
import type { MediaInfo } from "../library-bridge";
import { ModalDialog } from "../ModalDialog";

const DELAY_KEY = "amluto-steps-retake-delay";
/** Countdown choices, in seconds; long enough to bring a window forward, short enough to wait. */
const DELAYS = [3, 5, 10] as const;
type Delay = (typeof DELAYS)[number];

const readDelay = (): Delay => {
  try {
    const saved = Number(window.localStorage.getItem(DELAY_KEY));
    return DELAYS.find((delay) => delay === saved) ?? 5;
  } catch {
    return 5;
  }
};

const saveDelay = (delay: Delay) => {
  try {
    window.localStorage.setItem(DELAY_KEY, String(delay));
  } catch {
    // The countdown is a convenience; the default comes back next time.
  }
};

/**
 * Retake (docs/spec/04-editor.md#editing-steps): the button at the end of the screenshot tools,
 * and the short explanation before Steps gets out of the way. The capture itself happens in
 * the store (Rust), which minimises the window, counts down and captures the window in front.
 */
export function Retake({
  retake,
  onRetaken,
  notify,
  disabled,
}: {
  retake: (delayMs: number) => Promise<MediaInfo>;
  onRetaken: (media: MediaInfo) => void;
  notify: (message: Omit<ToastMessage, "id">) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [delay, setDelay] = useState<Delay>(readDelay);
  const [busy, setBusy] = useState(false);

  const start = () => {
    setOpen(false);
    saveDelay(delay);
    setBusy(true);
    retake(delay * 1000)
      .then(onRetaken)
      .catch((problem: unknown) =>
        notify({ kind: "error", text: errorMessage(problem, t("editor.retake.failed")) }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <>
      <button
        type="button"
        disabled={disabled || busy}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-secondary hover:bg-subtle disabled:opacity-40"
        onClick={() => setOpen(true)}
      >
        <Icon name="restart" size={15} />
        {busy ? t("editor.retake.working") : t("editor.retake.button")}
      </button>
      {open && (
        <div className="fixed inset-0 z-[800] grid place-items-center bg-scrim/50 p-4">
          <ModalDialog
            labelledBy="retake-title"
            describedBy="retake-body"
            onEscape={() => setOpen(false)}
            className="card w-full max-w-md p-6"
          >
            <h2 id="retake-title" className="font-heading text-xl text-navy">
              {t("editor.retake.title")}
            </h2>
            <p id="retake-body" className="mt-3 text-secondary">
              {t("editor.retake.body")}
            </p>
            <label className="mt-5 flex items-center justify-between gap-3 text-sm font-semibold text-navy">
              {t("editor.retake.countdown")}
              <select
                className="field font-normal"
                value={delay}
                onChange={(event) => setDelay(Number(event.currentTarget.value) as Delay)}
              >
                {DELAYS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {t("editor.retake.seconds", { count: seconds })}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-4 flex gap-2 text-[13px] text-secondary">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-blue" />
              {t("editor.retake.keepsMarks")}
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" onClick={start}>
                <Icon name="restart" size={16} />
                {t("editor.retake.start")}
              </button>
            </div>
          </ModalDialog>
        </div>
      )}
    </>
  );
}
