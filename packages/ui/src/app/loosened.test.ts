// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { initI18n } from "../i18n";
import { readChoices, saveChoices } from "../settings/preferences";
import { loosenedBy } from "./useSettingsTransfer";

const i18n = initI18n();

describe("a settings file that would loosen privacy", () => {
  it("names each thing it would loosen, and nothing when it wouldn't", () => {
    saveChoices({ ...readChoices(), excludedApps: ["KeePass.exe", "Outlook.exe"] });
    const recording = {
      captureMode: "window" as const,
      excludedApps: ["outlook.exe"],
      typedByDefault: true,
      showUnnamedTyping: false,
    };
    expect(loosenedBy(recording, i18n.t)).toEqual([
      "• Start recording apps you keep out: KeePass.exe",
      "• Start recordings with “Record what’s typed” ticked",
    ]);
    expect(
      loosenedBy(
        { captureMode: "window", excludedApps: ["KeePass.exe", "Outlook.exe", "x.exe"] },
        i18n.t,
      ),
    ).toEqual([]);
  });
});
