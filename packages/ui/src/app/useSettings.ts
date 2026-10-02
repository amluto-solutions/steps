import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecorderPreferences } from "@amluto-steps/core";

import type { ToastMessage } from "../components/Toast";
import { readBlurTerms, saveBlurTerms } from "../editor/suggestions";
import { errorMessage } from "../errors";
import type { RecorderBridge } from "../recorder-bridge";
import { isLocked, policy } from "../settings/policy";
import {
  applyTheme,
  EXCLUDED_APPS_KEY,
  readChoices,
  readExcludedApps,
  readTheme,
  saveChoices,
  type RecordingChoices,
  type SettingsFile,
  type Theme,
} from "../settings/preferences";

/**
 * The person's own settings (docs/spec/07-settings-and-policy.md): name and library folder,
 * recording choices, theme, Start with Windows and always-blur words, and the settings file's
 * contents built from them or applied to them.
 */
export function useSettings(
  recorder: RecorderBridge | undefined,
  notify: (message: Omit<ToastMessage, "id">) => void,
) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<RecorderPreferences | null>(null);
  const [autoStart, setAutoStart] = useState(false);
  const [choices, setChoices] = useState<RecordingChoices>(readChoices);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [blurTerms, setBlurTerms] = useState<string[]>(readBlurTerms);
  /** The organisation's always-blur words (IT policy) as well as the user's own. */
  const allBlurTerms = useMemo(() => [...policy().blurTerms, ...blurTerms], [blurTerms]);
  const author = preferences?.displayName ?? "";

  useEffect(() => applyTheme(theme), [theme]);

  // The recorder bar's "Never record this app" saves to the same storage from its own window;
  // take it up here, or the next recording (which saves these choices) would write it away.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === EXCLUDED_APPS_KEY || event.key === null)
        setChoices((current) => ({ ...current, excludedApps: readExcludedApps() }));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const updateChoices = (next: RecordingChoices) => {
    const removed = choices.excludedApps.filter((app) => !next.excludedApps.includes(app));
    setChoices(next);
    saveChoices(next);
    removed.forEach((app) => void recorder?.includeApp(app).catch(() => undefined));
    if (next.captureMode !== choices.captureMode)
      void recorder?.setCaptureMode(next.captureMode).catch(() => undefined);
    if (next.hideRecorderBar !== choices.hideRecorderBar)
      void recorder?.setBarHidden(next.hideRecorderBar).catch(() => undefined);
  };

  const updateBlurTerms = useCallback((terms: string[]) => {
    setBlurTerms(terms);
    saveBlurTerms(terms);
  }, []);

  const saveName = async (displayName: string) => {
    if (!recorder || !preferences) return;
    try {
      setPreferences(await recorder.setPreferences({ ...preferences, displayName }));
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("recorder.preferencesFailed")) });
    }
  };

  /** Start with Windows, put back if Windows refuses. */
  const changeAutoStart = (enabled: boolean) => {
    setAutoStart(enabled);
    void recorder?.setAutoStartEnabled(enabled).catch((problem: unknown) => {
      setAutoStart(!enabled);
      notify({ kind: "error", text: errorMessage(problem, t("recorder.errorTitle")) });
    });
  };

  /** A settings file's contents on this PC; returns what couldn't be applied. */
  const applySettingsFile = async (file: SettingsFile): Promise<string[]> => {
    if (!recorder) return [];
    if (file.displayName && preferences)
      setPreferences(
        await recorder.setPreferences({ ...preferences, displayName: file.displayName }),
      );
    const {
      outputSettleMs,
      hideRecorderBar,
      typedByDefault,
      outputByDefault,
      showUnnamedTyping,
      appSwitchSteps,
      screenshotQuality,
      ...recording
    } = file.recording;
    updateChoices({
      ...choices,
      ...recording,
      outputSettleMs: outputSettleMs ?? choices.outputSettleMs,
      hideRecorderBar: hideRecorderBar ?? choices.hideRecorderBar,
      typedByDefault: typedByDefault ?? choices.typedByDefault,
      outputByDefault: outputByDefault ?? choices.outputByDefault,
      showUnnamedTyping: showUnnamedTyping ?? choices.showUnnamedTyping,
      // A lock keeps it on, whatever the file says.
      appSwitchSteps: isLocked("AppSwitchSteps") || (appSwitchSteps ?? choices.appSwitchSteps),
      screenshotQuality: isLocked("ScreenshotQuality")
        ? "balanced"
        : (screenshotQuality ?? choices.screenshotQuality),
    });
    if (file.theme) setTheme(file.theme);
    const problems: string[] = [];
    // A shortcut already set the same is left alone: setting it again failed while another copy
    // of Steps held it, and restore reported it as a problem (F057).
    const current = await recorder.getHotkeys().catch(() => []);
    for (const [action, keys] of Object.entries(file.shortcuts ?? {})) {
      if (current.some((binding) => binding.action === action && binding.keys === (keys ?? null)))
        continue;
      try {
        await recorder.setHotkey(
          action as Parameters<RecorderBridge["setHotkey"]>[0],
          keys ?? null,
        );
      } catch {
        problems.push(
          t("backup.problemShortcut", { name: t(`settings.shortcuts.actions.${action}`) }),
        );
      }
    }
    return problems;
  };

  /** The settings file's contents as they are now (for Export settings and Back up all). */
  const currentSettingsFile = async (): Promise<SettingsFile> => {
    const bindings = (await recorder?.getHotkeys().catch(() => [])) ?? [];
    return {
      kind: "amluto-steps-settings",
      formatVersion: 1,
      displayName: author,
      recording: {
        outputSettleMs: choices.outputSettleMs,
        captureMode: choices.captureMode,
        screenshotQuality: choices.screenshotQuality,
        hideRecorderBar: choices.hideRecorderBar,
        excludedApps: choices.excludedApps,
        typedByDefault: choices.typedByDefault,
        outputByDefault: choices.outputByDefault,
        showUnnamedTyping: choices.showUnnamedTyping,
        appSwitchSteps: choices.appSwitchSteps,
      },
      shortcuts: Object.fromEntries(
        bindings.map((binding) => [binding.action, binding.keys]),
      ) as SettingsFile["shortcuts"],
      theme,
    };
  };

  return {
    preferences,
    setPreferences,
    author,
    autoStart,
    setAutoStart,
    changeAutoStart,
    choices,
    updateChoices,
    theme,
    setTheme,
    blurTerms,
    allBlurTerms,
    updateBlurTerms,
    saveName,
    applySettingsFile,
    currentSettingsFile,
  };
}

export type Settings = ReturnType<typeof useSettings>;
