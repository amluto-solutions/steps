import {
  isBlurStrength,
  isTone,
  matchLanguage,
  type BlurStrength,
  type LanguageCode,
  type Tone,
} from "@amluto-steps/core";
import { z } from "zod";

/**
 * IT policy from the registry (docs/spec/07-settings-and-policy.md#registry-policy-desktop-windows),
 * read once before the first render: Group Policy and Intune apply at sign-in, so it doesn't
 * change while the app runs. The preference readers apply it, so every screen sees the same thing.
 */
export type LockableSetting =
  | "Monitors"
  | "ScreenshotMode"
  | "ScreenshotQuality"
  | "AppSwitchSteps"
  | "IncludeOriginals"
  | "ExportFolder"
  | "AskWhereToSave";

export interface Policy {
  libraries: { name: string; path: string }[];
  defaultLibrary: string | null;
  brandProfiles: string[];
  defaultPdfBrand: string | null;
  appColoursBrand: string | null;
  excludedApps: string[];
  blurTerms: string[];
  sensitiveFieldPatterns: string[];
  /** true: on and locked; false: off and locked; null: the user's choice. */
  autoStart: boolean | null;
  locked: LockableSetting[];
  disableUpdateCheck: boolean;
  /** "Record what's typed" can't be ticked. */
  disableKeystrokeRecording: boolean;
  /**
   * Whether the start dialog's "Record what's typed" starts ticked (30/09/2026). It's only
   * where the tick box starts: the person can still untick it for a recording. null: their choice.
   */
  recordTypingByDefault: boolean | null;
  /** The same for "Include command output". */
  includeOutputByDefault: boolean | null;
  /** Typing into something unnamed shows its text: IT's choice; null: the person's. */
  showUnnamedTyping: boolean | null;
  /** The app's language, set by IT; null: the person's choice (docs/spec/07-settings-and-policy.md). */
  language: LanguageCode | null;
  /** The tone new recordings are worded in, set by IT; null: the person's choice. */
  languageTone: Tone | null;
  /** How much blur suggestions look for, set by IT; null: the person's choice. */
  blurStrength: BlurStrength | null;
  /** Lock… is hidden; guides already locked stay locked (04/10/2026). */
  disableGuideLocks: boolean;
  /** A hash (`pbkdf2-sha256$…`) of a password that unlocks any locked guide; null: none. */
  guideLockRecoveryPassword: string | null;
  /** Guides record this PC's name and login: IT's choice; null: the person's. */
  recordPcAndLogin: boolean | null;
}

export const NO_POLICY: Policy = {
  libraries: [],
  defaultLibrary: null,
  brandProfiles: [],
  defaultPdfBrand: null,
  appColoursBrand: null,
  excludedApps: [],
  blurTerms: [],
  sensitiveFieldPatterns: [],
  autoStart: null,
  locked: [],
  disableUpdateCheck: false,
  disableKeystrokeRecording: false,
  recordTypingByDefault: null,
  includeOutputByDefault: null,
  showUnnamedTyping: null,
  language: null,
  languageTone: null,
  blurStrength: null,
  disableGuideLocks: false,
  guideLockRecoveryPassword: null,
  recordPcAndLogin: null,
};

const LOCKABLE: readonly LockableSetting[] = [
  "Monitors",
  "ScreenshotMode",
  "ScreenshotQuality",
  "AppSwitchSteps",
  "IncludeOriginals",
  "ExportFolder",
  "AskWhereToSave",
];

const text = z.string().max(4096);
const texts = z.array(text).max(1000);

/**
 * The policy as the recorder reports it, checked field by field (docs/engineering.md: Zod on
 * everything that crosses into the UI). A field that doesn't fit falls back to "not set" on its
 * own, so one odd value can't take every lock away with it; unknown lock names are left out.
 */
const policySchema = z
  .object({
    libraries: z
      .array(z.object({ name: text, path: text }).strip())
      .max(100)
      .catch(NO_POLICY.libraries),
    defaultLibrary: text.nullable().catch(null),
    brandProfiles: texts.catch([]),
    defaultPdfBrand: text.nullable().catch(null),
    appColoursBrand: text.nullable().catch(null),
    excludedApps: texts.catch([]),
    blurTerms: texts.catch([]),
    sensitiveFieldPatterns: texts.catch([]),
    autoStart: z.boolean().nullable().catch(null),
    locked: z
      .array(z.string())
      .catch([])
      .transform((names) =>
        names.filter((name): name is LockableSetting =>
          (LOCKABLE as readonly string[]).includes(name),
        ),
      ),
    disableUpdateCheck: z.boolean().catch(false),
    disableKeystrokeRecording: z.boolean().catch(false),
    recordTypingByDefault: z.boolean().nullable().catch(null),
    includeOutputByDefault: z.boolean().nullable().catch(null),
    showUnnamedTyping: z.boolean().nullable().catch(null),
    // One Steps doesn't have is left unset, so the person chooses.
    language: z
      .string()
      .nullable()
      .catch(null)
      .transform((code) => matchLanguage(code)),
    languageTone: z
      .string()
      .nullable()
      .catch(null)
      .transform((tone) => (isTone(tone) ? tone : null)),
    blurStrength: z
      .string()
      .nullable()
      .catch(null)
      .transform((strength) => (isBlurStrength(strength) ? strength : null)),
    disableGuideLocks: z.boolean().catch(false),
    guideLockRecoveryPassword: z.string().max(400).nullable().catch(null),
    recordPcAndLogin: z.boolean().nullable().catch(null),
  })
  .strip();

/** Reads the recorder's policy; anything that isn't one is no policy. */
export function parsePolicy(value: unknown): Policy {
  const result = policySchema.safeParse(value);
  return result.success ? result.data : NO_POLICY;
}

let current: Policy = NO_POLICY;

export const setPolicy = (policy: Policy) => {
  current = { ...NO_POLICY, ...policy };
};

export const policy = (): Policy => current;

export const isLocked = (setting: LockableSetting) => current.locked.includes(setting);

/** Whether the organisation sets anything at all (the settings file import is then switched off). */
export const isManaged = () =>
  current.libraries.length > 0 ||
  current.defaultLibrary !== null ||
  current.brandProfiles.length > 0 ||
  current.defaultPdfBrand !== null ||
  current.appColoursBrand !== null ||
  current.excludedApps.length > 0 ||
  current.blurTerms.length > 0 ||
  current.sensitiveFieldPatterns.length > 0 ||
  current.autoStart !== null ||
  current.locked.length > 0 ||
  current.disableUpdateCheck ||
  current.disableKeystrokeRecording ||
  current.recordTypingByDefault !== null ||
  current.includeOutputByDefault !== null ||
  current.showUnnamedTyping !== null ||
  current.language !== null ||
  current.languageTone !== null ||
  current.blurStrength !== null ||
  current.disableGuideLocks ||
  current.guideLockRecoveryPassword !== null ||
  current.recordPcAndLogin !== null;
