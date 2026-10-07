import type { RecorderPreferences } from "@amluto-steps/core";

import type { Policy } from "../settings/policy";

/**
 * What the app keeps and asks of the computer it runs on, part of the recorder bridge: the
 * preferences kept outside the page (the person's name, the library folder), IT policy, starting
 * with the computer (the `autoStart` capability), and who and where this is.
 */
export interface Host {
  getPreferences(): Promise<RecorderPreferences>;
  setPreferences(preferences: RecorderPreferences): Promise<RecorderPreferences>;
  /** IT policy (read once; it doesn't change while the app runs). */
  getPolicy(): Promise<Policy>;
  isAutoStartEnabled(): Promise<boolean>;
  setAutoStartEnabled(enabled: boolean): Promise<void>;
  /**
   * The person's own account names, for blur suggestions; they stay on the PC. None where the
   * edition can't tell (a browser).
   */
  identityNames(): Promise<string[]>;
  /**
   * This PC's name and login, kept with a guide's saves and lock when Settings > Privacy allows.
   * The browser can't tell them, so Steps for Chrome names itself, with no login.
   */
  machineIdentity(): Promise<{ pc: string; login: string }>;
}
