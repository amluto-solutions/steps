import type { RecorderPreferences } from "@amluto-steps/core";

import { NO_POLICY, type Policy } from "../settings/policy";
import type { Host } from "./host";

/**
 * Preferences, policy and this computer for tests and the preview, kept in memory. Starting with
 * the computer can be switched on unless `autoStart` is false (an edition without it).
 */
export function fakeHost(
  options: {
    preferences?: RecorderPreferences;
    policy?: Policy;
    autoStart?: boolean;
    machine?: { pc: string; login: string };
    identityNames?: string[];
  } = {},
): Host {
  let preferences: RecorderPreferences = options.preferences ?? {
    displayName: "Robin",
    libraryFolder: "C:\\Guides",
  };
  let autoStart = false;
  return {
    getPreferences: () => Promise.resolve({ ...preferences }),
    setPreferences(changed) {
      preferences = { ...changed };
      return Promise.resolve({ ...preferences });
    },
    getPolicy: () => Promise.resolve(options.policy ?? NO_POLICY),
    isAutoStartEnabled: () => Promise.resolve(autoStart),
    setAutoStartEnabled(enabled) {
      autoStart = enabled && options.autoStart !== false;
      return Promise.resolve();
    },
    identityNames: () => Promise.resolve([...(options.identityNames ?? [])]),
    machineIdentity: () => Promise.resolve(options.machine ?? { pc: "EXAMPLE-PC", login: "robin" }),
  };
}
