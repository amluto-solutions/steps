// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { initI18n } from "../i18n";
import { saveStepTone } from "../settings/preferences";
import { useStepWording } from "./ShortcutPopup";

initI18n();
afterEach(cleanup);

describe("the wording of new steps", () => {
  it("takes the tone Settings has now, not the one it had when the window drew (F063)", () => {
    saveStepTone("casual");
    const seen: (() => { tone: string })[] = [];
    function Probe() {
      seen.push(useStepWording());
      return null;
    }
    render(<Probe />);
    saveStepTone("formal");
    expect(seen.at(-1)?.().tone).toBe("formal");
    saveStepTone("casual");
  });
});
