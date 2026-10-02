import { describe, expect, it } from "vitest";

import { initI18n } from "../i18n";
import { settingsFileName } from "./useSettingsTransfer";

initI18n();

describe("settingsFileName", () => {
  it("names the file after the person and the ISO date (30/09/2026)", () => {
    const day = new Date(2026, 8, 30, 14, 5);
    expect(settingsFileName("Sam Jones", day)).toBe("Sam Jones Steps settings 2026-09-30");
    expect(settingsFileName("  ", day)).toBe("Steps settings 2026-09-30");
    expect(settingsFileName("A/B: Ltd", day)).toBe("A B Ltd Steps settings 2026-09-30");
  });
});
