import { describe, expect, it } from "vitest";

import { asRightClick, renderPhrase } from "./phrase.ts";
import { phraseOfStep } from "./reword.ts";

describe("right-clicks (04/10/2026)", () => {
  it("say so in each tone, and are worked out again from a stored step", () => {
    const named = asRightClick({ key: "click", kind: "other", name: "D52" });
    expect(renderPhrase(named, "en", "casual")).toBe('Right-click "D52"');
    expect(renderPhrase(named, "en", "formal")).toBe('Right-click "D52".');
    expect(renderPhrase(asRightClick({ key: "clickBare" }), "en", "plain")).toBe(
      "Right-click here",
    );
    expect(renderPhrase(asRightClick({ key: "clickIn", title: "Book1" }), "en", "casual")).toBe(
      'Right-click in "Book1"',
    );
    const stored = {
      kind: "interaction",
      action: "click",
      actionText: 'Right-click "D52"',
      textParts: { verb: "rightClick", target: "D52", kind: "dataitem" },
      showValue: false,
      context: { windowTitle: "Book1 - Excel" },
      target: { labelText: "D52" },
    };
    const phrase = phraseOfStep(stored);
    expect(phrase && renderPhrase(phrase, "de", "casual")).toMatch(/rechten Maustaste/);
  });
});
