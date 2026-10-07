// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { StepWording } from "@amluto-steps/core";
import { afterEach, describe, expect, it } from "vitest";

import { initI18n } from "../i18n";
import { NO_POLICY, setPolicy } from "../settings/policy";
import { readWording, saveStepTone } from "../settings/preferences";
import { useStepWording } from "./ShortcutPopup";

initI18n();
afterEach(() => {
  cleanup();
  saveStepTone("casual");
  setPolicy(NO_POLICY);
});

describe("the wording of new steps", () => {
  it("is the app's language and the tone Settings chose, or IT's tone when policy sets one", () => {
    saveStepTone("formal");
    expect(readWording("de-AT")).toEqual({ language: "de", tone: "formal" });
    expect(readWording("xx")).toEqual({ language: "en", tone: "formal" });
    setPolicy({ ...NO_POLICY, languageTone: "plain" });
    expect(readWording("fr")).toEqual({ language: "fr", tone: "plain" });
  });

  it("keeps the tone a recording started with; a change applies from the next recording", () => {
    saveStepTone("casual");
    const seen: ((sessionId: string) => StepWording)[] = [];
    function Probe() {
      seen.push(useStepWording());
      return null;
    }
    const view = render(<Probe />);
    const wording = seen.at(-1);
    expect(wording?.("first").tone).toBe("casual");
    // Changed in Settings partway through: the live steps and the draft must still agree.
    saveStepTone("formal");
    expect(wording?.("first").tone).toBe("casual");
    // The window drawn again keeps it too, and the next recording takes the new tone, so it
    // isn't a value kept from the first render (F063).
    view.rerender(<Probe />);
    expect(seen.at(-1)?.("first").tone).toBe("casual");
    expect(seen.at(-1)?.("second").tone).toBe("formal");
  });
});
