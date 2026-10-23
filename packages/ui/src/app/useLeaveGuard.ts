import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppWindows } from "../bridge/app-windows";
import type { SaveState } from "../editor/useGuideEditor";
import { askConfirm } from "./ask";

/** Whether to go with the latest changes unsaved: `yes` goes, Stay (where focus starts) stays. */
const askLeave = (t: TFunction, yes: string) =>
  askConfirm(t("editor.leave.title"), t("editor.leave.body"), yes, t("editor.leave.stay"));

/**
 * Leaving the editor while a save is failing asks first (docs/spec/04-editor.md#leaving-the-editor):
 * the changes not saved yet would go with it, and nobody should lose edits without being told.
 * That's any way out of the editor, closing the window and the tray's Quit (#95), which the
 * edition holds for the page meanwhile. While saves work, nothing asks.
 */
export function useLeaveGuard(
  windows: Pick<
    AppWindows,
    "askBeforeClose" | "onCloseAsked" | "closeMain" | "onQuitAsked" | "quitApp"
  >,
) {
  const { t } = useTranslation();
  // Set the moment the editor says, not after a render: a way out taken straight after must see it.
  const failing = useRef(false);
  const [holdClose, setHoldClose] = useState(false);

  /** Runs `leave` at once while saves work, or once the person chooses to leave anyway. */
  const leaveEditor = async (leave: () => unknown) => {
    if (failing.current && !(await askLeave(t, t("editor.leave.leave")))) return;
    await leave();
  };

  /** The open editor's save status (GuideEditor's `onSaveState`). */
  const onSaveState = (state: SaveState) => {
    failing.current = state === "error";
    setHoldClose(failing.current);
  };

  // Told at start too: a page that reloaded while closing was held lets it go.
  useEffect(() => {
    void windows.askBeforeClose(holdClose).catch(() => undefined);
  }, [windows, holdClose]);

  useEffect(() => {
    const stop = windows.onCloseAsked(() => {
      void (async () => {
        // The save may have gone through since closing was held.
        if (failing.current && !(await askLeave(t, t("editor.leave.close")))) return;
        await windows.closeMain().catch(() => undefined);
      })();
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [windows, t]);

  useEffect(() => {
    const stop = windows.onQuitAsked(() => {
      void (async () => {
        if (failing.current && !(await askLeave(t, t("editor.leave.quit")))) return;
        await windows.quitApp().catch(() => undefined);
      })();
    });
    return () => void stop.then((unlisten) => unlisten());
  }, [windows, t]);

  return {
    leaveEditor,
    /** Asks whether to go on without the changes that couldn't be saved; false to stay. */
    askLeave: () => askLeave(t, t("editor.leave.leave")),
    onSaveState,
  };
}
