import { describe, expect, it } from "vitest";

import { wordStepIn, type PhraseFacts } from "./reword.ts";

/** A click step as the recorder stores it, with the verb it was recorded with. */
const stored = (verb: string, patch: Partial<PhraseFacts> = {}): PhraseFacts => ({
  kind: "interaction",
  action: "click",
  actionText: 'Click "Sheet1"',
  textParts: { verb, target: "Sheet1", kind: "tabitem" },
  showValue: false,
  context: { windowTitle: "Book1 - Excel" },
  target: { labelText: "Sheet1" },
  naming: { name: "Sheet1", kind: "tab", source: "element", needsReview: false },
  ...patch,
});

describe("double-clicks (12/10/2026, #55)", () => {
  it("say so in each tone, worked out again from the stored verb", () => {
    expect(wordStepIn(stored("doubleClick"), "en", "casual")).toBe('Double-click "Sheet1"');
    expect(wordStepIn(stored("doubleClick"), "en", "plain")).toBe('Double-click "Sheet1"');
    expect(wordStepIn(stored("doubleClick"), "en", "formal")).toBe('Double-click "Sheet1".');
    // A single click is worded as it always was.
    expect(wordStepIn(stored("click"), "en", "plain")).toBe('Select the "Sheet1" tab');
  });

  it("say so in a window, or where nothing named what was double-clicked", () => {
    const inWindow = stored("doubleClick", {
      naming: { name: "Book1 - Excel", kind: "other", source: "window", needsReview: true },
    });
    expect(wordStepIn(inWindow, "en", "casual")).toBe('Double-click in "Book1 - Excel"');
    expect(wordStepIn(inWindow, "en", "plain")).toBe(
      'Double-click inside the "Book1 - Excel" window',
    );
    const bare = stored("doubleClick", {
      naming: { name: "", kind: "other", source: "window", needsReview: true },
    });
    expect(wordStepIn(bare, "en", "casual")).toBe("Double-click");
    expect(wordStepIn(bare, "en", "formal")).toBe("Double-click.");
  });

  it("are worded in another language from the stored verb", () => {
    expect(wordStepIn(stored("doubleClick"), "de", "casual")).toMatch(/doppel/i);
    expect(wordStepIn(stored("doubleClick"), "de", "casual")).not.toBe(
      wordStepIn(stored("click"), "de", "casual"),
    );
  });

  it("leave a window's own title-bar button worded by what it does (#48)", () => {
    const maximise = stored("doubleClick", {
      textParts: { verb: "doubleClick", target: "Book1 - Excel", kind: "maximiseButton" },
      naming: {
        name: "Book1 - Excel",
        kind: "maximiseButton",
        source: "titleBar",
        needsReview: false,
      },
    });
    expect(wordStepIn(maximise, "en", "casual")).toBe('Maximise "Book1 - Excel"');
  });

  it("name a taskbar button's app", () => {
    const taskbar = stored("doubleClick", {
      naming: { name: "Excel", kind: "button", source: "taskbar", needsReview: false },
    });
    expect(wordStepIn(taskbar, "en", "casual")).toBe('Double-click "Excel"');
  });
});
