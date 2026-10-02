// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/react";
import type { RichText } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import { ReadOnlyContext } from "./readOnly";
import { RichTextEditor } from "./RichTextEditor";

initI18n();
afterEach(cleanup);

const boldNote: RichText = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", marks: [{ type: "bold" }], text: "hello" }],
    },
  ],
};

/** The parent keeps the value and passes it back, as the editor's step panel does. */
function Harness({ seen }: { seen?: (value: RichText | null) => void }) {
  const [value, setValue] = useState<RichText | null>(boldNote);
  return (
    <RichTextEditor
      label="Notes"
      placeholder=""
      value={value}
      onChange={(next) => {
        seen?.(next);
        setValue(next);
      }}
    />
  );
}

const editorOf = (container: HTMLElement) =>
  (container.querySelector(".ProseMirror") as HTMLElement & { editor?: Editor }).editor;

/** A note written elsewhere (another edition, a file): its marks in another order, a list last. */
const writtenElsewhere: RichText = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "supplier list",
          marks: [{ type: "italic" }, { type: "link", attrs: { href: "https://example.com" } }],
        },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Check the total." }] }],
        },
      ],
    },
  ],
};

describe("notes", () => {
  it("are only saved when someone changes them, not when shown or made read-only", async () => {
    const changes: (RichText | null)[] = [];
    const { container, rerender } = render(
      <RichTextEditor
        label="Notes"
        placeholder=""
        value={writtenElsewhere}
        onChange={(next) => changes.push(next)}
      />,
    );
    await waitFor(() => expect(editorOf(container)).toBeDefined());
    await act(async () => {
      await Promise.resolve();
    });
    rerender(
      <ReadOnlyContext.Provider value={true}>
        <RichTextEditor
          label="Notes"
          placeholder=""
          value={writtenElsewhere}
          onChange={(next) => changes.push(next)}
        />
      </ReadOnlyContext.Provider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Showing a note never writes it: in a shared library that would change a guide nobody edited.
    expect(changes).toEqual([]);
  });

  it("keep the cursor where it is while typing inside formatted text", async () => {
    const { container } = render(<Harness />);
    await waitFor(() => expect(editorOf(container)).toBeDefined());
    const editor = editorOf(container) as Editor;

    // Type "X" after "he", inside the bold word.
    act(() => {
      editor.chain().setTextSelection(3).insertContent("X").run();
    });
    expect(editor.getText()).toBe("heXllo");
    // After the value has gone round the parent and come back, the cursor is still after "X",
    // not thrown to the end of the note.
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor.state.selection.from).toBe(4);
    act(() => {
      editor.chain().insertContent("Y").run();
    });
    expect(editor.getText()).toBe("heXYllo");
  });

  it("put a paragraph in a coloured box, change its kind, and take it out again", async () => {
    let last: RichText | null = null;
    const { container } = render(<Harness seen={(value) => (last = value)} />);
    await waitFor(() => expect(editorOf(container)).toBeDefined());
    act(() => {
      editorOf(container)?.commands.setTextSelection(2);
    });
    const pick = (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Coloured box" }));
      fireEvent.click(screen.getByRole("menuitem", { name }));
    };
    pick("Warning");
    // The box (TipTap keeps an empty line after it, to go on typing below).
    const first = () => (last as RichText | null)?.content?.[0];
    expect(first()).toMatchObject({
      type: "callout",
      attrs: { kind: "warning" },
      content: [{ type: "paragraph", content: [{ text: "hello" }] }],
    });
    // Its kind is shown in words, from the app's wording.
    expect(container.querySelector(".callout-warning")?.getAttribute("data-label")).toBe("Warning");
    pick("Tip");
    expect(first()).toMatchObject({ type: "callout", attrs: { kind: "tip" } });
    pick("Take out of the box");
    expect(first()).toMatchObject({ type: "paragraph", content: [{ text: "hello" }] });
  });
});
