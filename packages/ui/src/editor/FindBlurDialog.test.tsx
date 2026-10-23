// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GuideStep, OcrLine } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import type { ScreenWords } from "../screen-words";
import { blankStep } from "./edits";
import { FindBlurDialog } from "./FindBlurDialog";

initI18n();
afterEach(cleanup);

const pictured = (id: string): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  media: { id: `m-${id}`, width: 100, height: 100, scale: 1, captureRect: null },
});

const word = (text: string, y: number) => ({ words: [{ text, x: 10, y, w: 12, h: 2 }] });

/** Two screenshots showing Explorer's Downloads folder, one of them twice, and a client's name. */
const lines: Record<string, OcrLine[]> = {
  "m-a": [word("Downloads", 10), word("Downloads", 40), word("Contoso", 70)],
  "m-b": [word("Downloads", 20)],
};
const words: ScreenWords = {
  wordsOf: async (step) => lines[step.media?.id ?? ""] ?? [],
};

const open = (terms: string[]) => {
  const steps = [pictured("a"), pictured("b")];
  render(
    <FindBlurDialog
      steps={steps}
      numbers={
        new Map([
          ["a", 1],
          ["b", 2],
        ])
      }
      terms={terms}
      words={words}
      onBlur={vi.fn()}
      textMatches={() => []}
      onReplace={vi.fn()}
      onClose={vi.fn()}
    />,
  );
};

const search = async (term: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Word or phrase" }), {
    target: { value: term },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await waitFor(() => expect(screen.getByRole("list")).toBeTruthy());
  return within(screen.getByRole("list"))
    .getAllByRole("listitem")
    .map((row) => [...row.children].map((part) => part.textContent).join(": "));
};

describe("Find & Blur", () => {
  it("labels what a search finds as matches, not always-blur words (#84)", async () => {
    open(["Contoso"]);
    expect(await search("Downloads")).toEqual(["Step 1: 2 matches", "Step 2: 1 match"]);
  });

  it("still names always-blur words found with the box left empty", async () => {
    open(["Contoso"]);
    expect(await search("")).toEqual(["Step 1: always-blur word"]);
  });
});
