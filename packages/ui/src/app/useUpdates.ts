import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ToastMessage } from "../components/Toast";
import { errorCode, errorMessage } from "../errors";
import type { UpdateChannel, UpdateInfo, Updates as UpdateSource } from "../bridge/updates";
import { readAutoUpdates, saveAutoUpdates } from "../settings/preferences";
import { useLatest } from "../useLatest";

/** The first look is a little after the app opens, so it never slows the start. */
const FIRST_CHECK_MS = 15_000;
/** At most about once a day, even for an app that lives in the tray for weeks. */
const CHECK_EVERY_MS = 20 * 60 * 60 * 1000;
const DUE_TICK_MS = 60 * 60 * 1000;
/** When the last check found this was the newest version (this window's local storage). */
const LAST_CHECK_KEY = "amluto-steps-update-checked";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "newest"; at: number }
  | { kind: "downloading"; info: UpdateInfo }
  /** Downloaded: installs at the next start, or now with Restart now. */
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "installing"; info: UpdateInfo };

export interface Updates {
  /** null until the app has said; "none" if it can't say. */
  channel: UpdateChannel | null;
  status: UpdateStatus;
  check: () => Promise<void>;
  /** Restart now. */
  install: () => Promise<void>;
  /** "Update automatically": the daily look and background download. Off, nothing is asked. */
  automatic: boolean;
  setAutomatic: (on: boolean) => void;
}

const readLastCheck = (): number => {
  try {
    return Number(window.localStorage.getItem(LAST_CHECK_KEY)) || 0;
  } catch {
    return 0;
  }
};

const saveLastCheck = (at: number) => {
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(at));
  } catch {
    // Without storage it just checks again the next time the app opens.
  }
};

const settled = (): UpdateStatus => {
  const at = readLastCheck();
  return at ? { kind: "newest", at } : { kind: "idle" };
};

/** The copies that update themselves: the setup's, and the portable program. */
const updatesItself = (channel: UpdateChannel | null) =>
  channel === "checks" || channel === "portable";

/**
 * Updates for the downloadable `.exe` (docs/spec/10-distribution.md#updates-for-the-exe) and the
 * portable program. Only those copies ever ask: 15 seconds after opening, then whenever a day has
 * passed (with "Update automatically" on, which starts off for the portable program), and when
 * someone presses Check for updates. A new version is downloaded in the background and installs
 * the next time the app opens; it is announced once, with a way to Settings > About, where
 * Restart now installs it straight away.
 */
export function useUpdates(
  recorder: UpdateSource | undefined,
  notify: (toast: Omit<ToastMessage, "id">) => void,
  showAbout: () => void,
): Updates {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [status, setStatus] = useState<UpdateStatus>(settled);
  const [chosen, setChosen] = useState(readAutoUpdates);
  const automatic = chosen ?? channel !== "portable";
  const setAutomatic = useCallback((on: boolean) => {
    saveAutoUpdates(on);
    setChosen(on);
  }, []);
  const statusRef = useLatest(status);
  const announced = useRef<string | null>(null);

  useEffect(() => {
    if (!recorder) return undefined;
    let cancelled = false;
    // A copy that can't say where its updates come from doesn't update.
    void (async () => {
      const answer = await recorder.updatesChannel().catch(() => null);
      if (cancelled) return;
      setChannel(answer ?? "none");
      if (!updatesItself(answer)) return;
      // A version downloaded earlier that hasn't installed yet (Restart now wasn't pressed and
      // the app hasn't restarted since).
      const waiting = await recorder.pendingUpdate().catch(() => null);
      if (!cancelled && waiting) {
        setStatus({ kind: "ready", info: { version: waiting, notes: null, published: null } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorder]);

  const run = useCallback(
    async (quiet: boolean) => {
      if (!recorder) return;
      setStatus({ kind: "checking" });
      let info: UpdateInfo | null;
      try {
        info = await recorder.checkForUpdate();
      } catch (problem) {
        setStatus(settled());
        // The daily look fails quietly (offline, a proxy); only a pressed button says so.
        if (!quiet)
          notify({ kind: "error", text: errorMessage(problem, t("updates.checkFailed")) });
        return;
      }
      if (!info) {
        const at = Date.now();
        saveLastCheck(at);
        setStatus({ kind: "newest", at });
        return;
      }
      setStatus({ kind: "downloading", info });
      try {
        await recorder.downloadUpdate();
      } catch (problem) {
        setStatus(settled());
        if (!quiet)
          notify({ kind: "error", text: errorMessage(problem, t("updates.downloadFailed")) });
        return;
      }
      setStatus({ kind: "ready", info });
      if (quiet && announced.current !== info.version) {
        announced.current = info.version;
        notify({
          text: t("updates.readyToast", { version: info.version }),
          action: { label: t("updates.see"), run: showAbout },
        });
      }
    },
    [recorder, notify, showAbout, t],
  );
  const runRef = useLatest(run);

  // Switched off, no timer is even set: the update server is only asked when someone presses
  // Check for updates.
  useEffect(() => {
    if (!updatesItself(channel) || !automatic) return undefined;
    const due = () => {
      const busy = ["checking", "downloading", "ready", "installing"].includes(
        statusRef.current.kind,
      );
      if (!busy && Date.now() - readLastCheck() >= CHECK_EVERY_MS) void runRef.current(true);
    };
    const first = window.setTimeout(due, FIRST_CHECK_MS);
    const later = window.setInterval(due, DUE_TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(later);
    };
  }, [channel, automatic, runRef, statusRef]);

  const check = useCallback(() => run(false), [run]);

  const install = useCallback(async () => {
    const current = statusRef.current;
    if (!recorder || current.kind !== "ready") return;
    setStatus({ kind: "installing", info: current.info });
    try {
      // On success the app closes and the new version opens, so this never returns.
      await recorder.installUpdate();
    } catch (problem) {
      // Refused while recording, it stays ready. Otherwise the download failed its checks and was
      // set aside: it comes again with the next look.
      setStatus(errorCode(problem) === "updateWhileRecording" ? current : settled());
      notify({ kind: "error", text: errorMessage(problem, t("updates.installFailed")) });
    }
  }, [recorder, notify, statusRef, t]);

  return { channel, status, check, install, automatic, setAutomatic };
}
