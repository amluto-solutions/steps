import {
  DEFAULT_LANGUAGE,
  DEFAULT_TONE,
  isBlurStrength,
  isLanguage,
  isTone,
  matchLanguage,
  siteName,
  type BlurStrength,
  type LanguageCode,
  type Tone,
  keyCapName,
} from "@amluto-steps/core";
import { z } from "zod";

import type { CaptureMonitor, HotkeyAction } from "../recorder-bridge";
import { isLocked, policy } from "./policy";

/**
 * The recorder choices kept in this window's local storage (not in guides). "Record what's typed"
 * is chosen at each recording's start; these say only how its tick boxes start.
 */
/**
 * How the app's own screenshots are kept: Balanced (lossy WebP within 2560 pixels) or Original
 * (lossless, at the screen's full size). Balanced unless chosen (30/09/2026).
 */
export type ScreenshotQuality = "balanced" | "original";

export interface RecordingChoices {
  /** How long command output must stay unchanged before it is read (0.5–10 s). */
  outputSettleMs: number;
  captureMode: "window" | "monitor";
  screenshotQuality: ScreenshotQuality;
  /** "Hide the recording bar from screenshots", on unless switched off. */
  hideRecorderBar: boolean;
  targetMonitor: string;
  excludedApps: string[];
  /** The start dialog's "Record what's typed" starts ticked (off unless chosen, or set by IT). */
  typedByDefault: boolean;
  /** Its "Include command output" starts ticked (only with the first). */
  outputByDefault: boolean;
  /** Typing into something that can't be named shows its text: off unless chosen (A1). */
  showUnnamedTyping: boolean;
  /** "Add a step when you switch apps": an `Open "<app>"` step each time. On unless switched off. */
  appSwitchSteps: boolean;
}

export type Theme = "light" | "dark" | "system";

const KEYS = {
  outputSettleMs: "amluto-steps-output-settle-ms",
  captureMode: "amluto-steps-capture-mode",
  screenshotQuality: "amluto-steps-screenshot-quality",
  hideRecorderBar: "amluto-steps-hide-recorder-bar",
  targetMonitor: "amluto-steps-target-monitor",
  excludedApps: "amluto-steps-excluded-apps",
  typedByDefault: "amluto-steps-typed-by-default",
  outputByDefault: "amluto-steps-output-by-default",
  showUnnamedTyping: "amluto-steps-show-unnamed-typing",
  appSwitchSteps: "amluto-steps-app-switch-steps",
  theme: "amluto-steps-theme",
} as const;

export const EXCLUDED_APPS_KEY = KEYS.excludedApps;

/** A program's file name as the exclusion list holds it, e.g. `KeePass.exe`. */
export const exeName = /^[\w.-]{1,124}\.exe$/i;

/** Linux: a program's file name, e.g. `keepassxc` (no extension). */
export const linuxProgramName = /^[\w.+-]{1,124}$/;

/** Either kind: a list can come from a settings file made on the other platform. */
export const programName = (value: string) => exeName.test(value) || linuxProgramName.test(value);

/** Settings → Recording, "Wait for command output": its range and default, in milliseconds. */
export const OUTPUT_SETTLE = { min: 500, max: 10_000, step: 500, default: 1_500 } as const;

export const fitSettleMs = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(
        OUTPUT_SETTLE.max,
        Math.max(OUTPUT_SETTLE.min, Math.round(value / OUTPUT_SETTLE.step) * OUTPUT_SETTLE.step),
      )
    : OUTPUT_SETTLE.default;

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice still applies until the app closes.
  }
};

/**
 * Settings → Recording, "Language tone" (01/10/2026): how new recordings' steps are worded.
 * Casual (Steps' own short style) unless chosen.
 */
const STEP_TONE_KEY = "amluto-steps-step-tone";

/**
 * What IT set, as the main window last read it: the recording bar and the shortcut popup can't read
 * policy themselves, so the main window leaves it here for them (`rememberPolicy`).
 */
const POLICY_TONE_KEY = "amluto-steps-policy-tone";
const POLICY_LANGUAGE_KEY = "amluto-steps-policy-language";

/** The tone IT set, from policy or as the main window left it; null when it's the person's. */
export function policyTone(): Tone | null {
  const set = policy().languageTone ?? read(POLICY_TONE_KEY);
  return isTone(set) ? set : null;
}

/** Settings > Privacy, "Blur suggestions": how much they look for (IT's choice if set). */
const BLUR_STRENGTH_KEY = "amluto-steps-blur-strength";

const SAFE_TERMS_KEY = "amluto-steps-safe-terms";

/** Settings > Privacy > Never suggest: words that are fine to show, never suggested for blurring. */
export function readSafeTerms(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(SAFE_TERMS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string").slice(0, 200)
      : [];
  } catch {
    return [];
  }
}

export function saveSafeTerms(terms: string[]) {
  write(SAFE_TERMS_KEY, JSON.stringify(terms));
}

export function readBlurStrength(): BlurStrength {
  const stored = read(BLUR_STRENGTH_KEY);
  return policy().blurStrength ?? (isBlurStrength(stored) ? stored : "standard");
}

export function saveBlurStrength(strength: BlurStrength) {
  write(BLUR_STRENGTH_KEY, strength);
}

export function readStepTone(): Tone {
  const stored = read(STEP_TONE_KEY);
  return policyTone() ?? (isTone(stored) ? stored : DEFAULT_TONE);
}

export function saveStepTone(tone: Tone) {
  write(STEP_TONE_KEY, tone);
}

/** Settings → General, "Language": the person's own choice, or null to follow the system. */
const LANGUAGE_KEY = "amluto-steps-language";

export function readLanguageChoice(): LanguageCode | null {
  const stored = read(LANGUAGE_KEY);
  return isLanguage(stored) ? stored : null;
}

export function saveLanguageChoice(code: LanguageCode | null) {
  if (code) write(LANGUAGE_KEY, code);
  else
    try {
      window.localStorage.removeItem(LANGUAGE_KEY);
    } catch {
      // Nothing to forget.
    }
}

/** The language IT set, from policy or as the main window left it; null when it's the person's. */
export function policyLanguage(): LanguageCode | null {
  const set = policy().language ?? read(POLICY_LANGUAGE_KEY);
  return isLanguage(set) ? set : null;
}

/** Windows' display language (the desktop's web view reports it) or the browser's, if Steps has it. */
export function systemLanguage(): LanguageCode | null {
  const tags =
    typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const tag of tags) {
    const found = matchLanguage(tag);
    if (found) return found;
  }
  return null;
}

/** The app's language: IT's, else the person's choice, else the system's, else English. */
export const appLanguage = (): LanguageCode =>
  policyLanguage() ?? readLanguageChoice() ?? systemLanguage() ?? DEFAULT_LANGUAGE;

/** The main window leaves IT's language and tone for the windows that can't read policy. */
export function rememberPolicy() {
  const forget = (key: string) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to forget.
    }
  };
  const { language, languageTone } = policy();
  if (language) write(POLICY_LANGUAGE_KEY, language);
  else forget(POLICY_LANGUAGE_KEY);
  if (languageTone) write(POLICY_TONE_KEY, languageTone);
  else forget(POLICY_TONE_KEY);
}

/** Steps for Chrome: the sites the person never records (host names, from `siteName`). */
export const EXCLUDED_SITES_KEY = "amluto-steps-excluded-sites";

export function readExcludedSites(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(EXCLUDED_SITES_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (value): value is string => typeof value === "string" && siteName(value) === value,
        )
      : [];
  } catch {
    return [];
  }
}

let excludedSitesSaved: ((sites: string[]) => void) | null = null;

/**
 * Steps for Chrome's background worker keeps its own copy of the list, for the desktop's
 * recordings, when it can't read the pages' storage
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
 */
export function onExcludedSitesSaved(listener: ((sites: string[]) => void) | null) {
  excludedSitesSaved = listener;
}

export function saveExcludedSites(sites: string[]) {
  write(EXCLUDED_SITES_KEY, JSON.stringify(sites));
  excludedSitesSaved?.(sites);
}

export function readExcludedApps(): string[] {
  try {
    const parsed: unknown = JSON.parse(read(KEYS.excludedApps) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && programName(value))
      : [];
  } catch {
    return [];
  }
}

/** Settings IT policy locks stay at their defaults (docs/spec/07-settings-and-policy.md). */
export function readChoices(): RecordingChoices {
  const settle = read(KEYS.outputSettleMs);
  return {
    outputSettleMs: settle === null ? OUTPUT_SETTLE.default : fitSettleMs(Number(settle)),
    captureMode:
      !isLocked("ScreenshotMode") && read(KEYS.captureMode) === "monitor" ? "monitor" : "window",
    screenshotQuality:
      !isLocked("ScreenshotQuality") && read(KEYS.screenshotQuality) === "original"
        ? "original"
        : "balanced",
    hideRecorderBar: read(KEYS.hideRecorderBar) !== "false",
    targetMonitor: isLocked("Monitors") ? "all" : (read(KEYS.targetMonitor) ?? "all"),
    excludedApps: readExcludedApps(),
    typedByDefault: policy().recordTypingByDefault ?? read(KEYS.typedByDefault) === "true",
    outputByDefault: policy().includeOutputByDefault ?? read(KEYS.outputByDefault) === "true",
    showUnnamedTyping: readShowUnnamedTyping(),
    appSwitchSteps: isLocked("AppSwitchSteps") || read(KEYS.appSwitchSteps) !== "false",
  };
}

/**
 * Whether typing into something the recording couldn't name (a document, a dialog's unlabelled
 * box) shows its text in the step. Off unless the person or IT turns it on: an unnamed box may
 * have been a password box that didn't say so (F021, 01/10/2026).
 */
const RECORD_PC_KEY = "amluto-steps-record-pc-and-login";

/**
 * Settings > Privacy, "Record this PC's name and my Windows login in guides" (04/10/2026): kept
 * with a guide's saves and password lock, shown in its Properties. On unless switched off; IT
 * can set it either way.
 */
export function readRecordPcAndLogin(): boolean {
  return policy().recordPcAndLogin ?? read(RECORD_PC_KEY) !== "false";
}

export function saveRecordPcAndLogin(on: boolean) {
  write(RECORD_PC_KEY, String(on));
}

export function readShowUnnamedTyping(): boolean {
  return policy().showUnnamedTyping ?? read(KEYS.showUnnamedTyping) === "true";
}

export function saveChoices(choices: RecordingChoices) {
  write(KEYS.outputSettleMs, String(fitSettleMs(choices.outputSettleMs)));
  write(KEYS.captureMode, choices.captureMode);
  write(KEYS.screenshotQuality, choices.screenshotQuality);
  write(KEYS.hideRecorderBar, String(choices.hideRecorderBar));
  write(KEYS.targetMonitor, choices.targetMonitor);
  write(KEYS.excludedApps, JSON.stringify(choices.excludedApps));
  write(KEYS.typedByDefault, String(choices.typedByDefault));
  write(KEYS.outputByDefault, String(choices.outputByDefault));
  write(KEYS.showUnnamedTyping, String(choices.showUnnamedTyping));
  write(KEYS.appSwitchSteps, String(choices.appSwitchSteps));
}

const AUTO_UPDATES_KEY = "amluto-steps-auto-updates";

/**
 * Settings > About, "Update automatically" (30/09/2026), as chosen, or null when it never
 * was: then it's on for the setup's copy and off for the portable program. Off, Steps never
 * contacts the update server unless someone presses Check for updates. IT switches every check
 * off with `DisableUpdateCheck`.
 */
export const readAutoUpdates = (): boolean | null => {
  const stored = read(AUTO_UPDATES_KEY);
  return stored === "true" ? true : stored === "false" ? false : null;
};
export const saveAutoUpdates = (on: boolean) => write(AUTO_UPDATES_KEY, String(on));

const BROWSER_LINK_KEY = "amluto-steps-browser-link";

/**
 * Settings > Recording, "Work with Steps for Chrome and Edge" (the desktop), as chosen, or null
 * when it never was: then the app's default applies (on, except in the portable program).
 */
export const readBrowserLink = (): boolean | null => {
  const stored = read(BROWSER_LINK_KEY);
  return stored === "true" ? true : stored === "false" ? false : null;
};
export const saveBrowserLink = (on: boolean) => write(BROWSER_LINK_KEY, String(on));

const STORAGE_WARN_KEY = "amluto-steps-storage-warn-gb";
/** Steps for Chrome: the library size, in GB, past which "Export and remove" is offered. */
export const STORAGE_WARN = { min: 0.25, max: 100, default: 1 } as const;

export const fitStorageWarnGb = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(STORAGE_WARN.max, Math.max(STORAGE_WARN.min, Math.round(value * 4) / 4))
    : STORAGE_WARN.default;

export const readStorageWarnGb = (): number => {
  const stored = read(STORAGE_WARN_KEY);
  return stored === null ? STORAGE_WARN.default : fitStorageWarnGb(Number(stored));
};
export const saveStorageWarnGb = (gb: number) =>
  write(STORAGE_WARN_KEY, String(fitStorageWarnGb(gb)));

const MADE_WITH_KEY = "amluto-steps-made-with";

/** Settings → General, "Made with Steps on exports": on unless switched off. */
export const readMadeWith = (): boolean => read(MADE_WITH_KEY) !== "false";
export const saveMadeWith = (on: boolean) => write(MADE_WITH_KEY, String(on));

/** Settings → Export: where exports go, and whether to ask each time (docs/spec/05-export.md#saving). */
export interface ExportPreferences {
  /** null: the Downloads folder. */
  folder: string | null;
  askEveryTime: boolean;
  /**
   * Web pages with pictures at most 1920 pixels wide, about half the size. On unless turned off
   * (30/09/2026: a setting, not a box to tick on every export).
   */
  optimiseForSharing: boolean;
}

/**
 * Whether a folder is on one of this PC's drives (a mapped drive letter counts). Exports go to
 * the export folder without a dialog, so it can't be a network share (docs/spec/05-export.md#saving).
 */
export const isLocalFolder = (path: string) => /^(?:[\\/]{2}\?[\\/])?[A-Za-z]:[\\/]/.test(path);

export function readExportPreferences(): ExportPreferences {
  return {
    folder: isLocked("ExportFolder") ? null : read("amluto-steps-export-folder"),
    askEveryTime: !isLocked("AskWhereToSave") && read("amluto-steps-export-ask") === "true",
    optimiseForSharing: read("amluto-steps-export-optimise") !== "false",
  };
}

export function saveExportPreferences(preferences: ExportPreferences) {
  if (preferences.folder) write("amluto-steps-export-folder", preferences.folder);
  else {
    try {
      window.localStorage.removeItem("amluto-steps-export-folder");
    } catch {
      // Nothing stored.
    }
  }
  write("amluto-steps-export-ask", String(preferences.askEveryTime));
  write("amluto-steps-export-optimise", String(preferences.optimiseForSharing));
}

export const readTheme = (): Theme => {
  const value = read(KEYS.theme);
  return value === "light" || value === "dark" ? value : "system";
};

export function applyTheme(theme: Theme) {
  write(KEYS.theme, theme);
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

/**
 * A screen as people know it: "Screen 1, main: DELL U2720Q (1920 × 1080)". Windows' device name
 * ("\\.\DISPLAY2") meant nothing to anyone. The list comes main first, then left to right.
 */
export const screenLabel = (
  t: (key: string, options: Record<string, unknown>) => string,
  monitor: CaptureMonitor,
  index: number,
): string => {
  const { left, top, right, bottom } = monitor.bounds;
  const values = {
    number: index + 1,
    name: monitor.name,
    width: right - left,
    height: bottom - top,
  };
  if (monitor.primary)
    return monitor.name
      ? t("settings.recording.screenMainNamed", values)
      : t("settings.recording.screenMain", values);
  return monitor.name
    ? t("settings.recording.screenNamed", values)
    : t("settings.recording.screen", values);
};

export const monitorKey = (bounds: CaptureMonitor["bounds"]): string =>
  `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}`;

/**
 * The combination a key press makes, in the `ctrl+alt+shift+k` form the shortcut settings use.
 * "modifier" while only Ctrl/Alt/Shift are held; null when it isn't allowed (it must use Ctrl or
 * Alt, and one letter, digit or F-key), so ordinary typing is never taken.
 */
export function keysFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey">,
): string | "modifier" | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(event.key)) return "modifier";
  const letterOrDigit = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code);
  const fKey = /^F([1-9]|1[0-9]|2[0-4])$/.exec(event.key);
  const key = letterOrDigit
    ? (letterOrDigit[1] ?? letterOrDigit[2] ?? "").toLowerCase()
    : fKey
      ? event.key.toLowerCase()
      : null;
  if (!key || (!event.ctrlKey && !event.altKey)) return null;
  return [
    event.ctrlKey ? "ctrl" : null,
    event.altKey ? "alt" : null,
    event.shiftKey ? "shift" : null,
    key,
  ]
    .filter((part): part is string => part !== null)
    .join("+");
}

/** `ctrl+alt+shift+k` → ["Ctrl", "Alt", "Shift", "K"] for the key caps. */
export const displayKeys = (keys: string, language = "en"): string[] =>
  keys.split("+").map((part) =>
    // The key caps say what the keyboard says ("Strg" in German).
    keyCapName(
      part === "ctrl"
        ? "Ctrl"
        : part === "alt"
          ? "Alt"
          : part === "shift"
            ? "Shift"
            : part.toUpperCase(),
      language,
    ),
  );

const hotkeyActions = [
  "startRecording",
  "togglePause",
  "stop",
  "captureNow",
  "addShortcut",
] as const satisfies readonly HotkeyAction[];

/**
 * A `.amlsettings` file: one person's setup, to move to another PC or share with a team. It holds
 * no guides and nothing personal beyond the display name (docs/spec/07-settings-and-policy.md).
 */
export const settingsFileSchema = z
  .object({
    kind: z.literal("amluto-steps-settings"),
    formatVersion: z.literal(1),
    displayName: z.string().max(120).optional(),
    recording: z
      .object({
        outputSettleMs: z.number().min(OUTPUT_SETTLE.min).max(OUTPUT_SETTLE.max).optional(),
        captureMode: z.enum(["window", "monitor"]),
        screenshotQuality: z.enum(["balanced", "original"]).optional(),
        hideRecorderBar: z.boolean().optional(),
        excludedApps: z.array(z.string().refine(programName)).max(200),
        typedByDefault: z.boolean().optional(),
        outputByDefault: z.boolean().optional(),
        showUnnamedTyping: z.boolean().optional(),
        appSwitchSteps: z.boolean().optional(),
      })
      .strip(),
    shortcuts: z.partialRecord(z.enum(hotkeyActions), z.string().max(40).nullable()).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .strip();

export type SettingsFile = z.infer<typeof settingsFileSchema>;
