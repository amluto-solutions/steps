import { mergeAttributes, Node } from "@tiptap/react";
import { CALLOUT_KINDS, type CalloutKind } from "@amluto-steps/core";

declare module "@tiptap/react" {
  interface Commands<ReturnType> {
    callout: {
      /** Puts the selection in a box of this kind, or changes the kind of the box it's in. */
      setCallout: (kind: CalloutKind) => ReturnType;
      /** Takes the selection out of its box. */
      unsetCallout: () => ReturnType;
    };
  }
}

const kindOf = (value: string | null | undefined): CalloutKind =>
  (CALLOUT_KINDS as readonly string[]).includes(value ?? "") ? (value as CalloutKind) : "note";

/**
 * A coloured box in notes (docs/spec/04-editor.md#editing-steps): paragraphs and lists in a note,
 * tip, warning or important box. Its label comes from `labels`, in the app's words, and is shown
 * by the stylesheet, so it isn't part of the text.
 */
export const Callout = Node.create<{ labels: Record<CalloutKind, string> }>({
  name: "callout",
  group: "block",
  content: "(paragraph | bulletList | orderedList)+",
  defining: true,

  addOptions() {
    return { labels: { note: "Note", tip: "Tip", warning: "Warning", important: "Important" } };
  },

  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (element) => kindOf(element.getAttribute("data-callout")),
        renderHTML: (attributes) => ({ "data-callout": kindOf(attributes.kind as string) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-callout]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const kind = kindOf(node.attrs.kind as string);
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        class: `callout callout-${kind}`,
        "data-label": this.options.labels[kind],
      }),
      0,
    ];
  },

  addCommands() {
    return {
      setCallout:
        (kind) =>
        ({ commands, editor }) =>
          editor.isActive(this.name)
            ? commands.updateAttributes(this.name, { kind })
            : commands.wrapIn(this.name, { kind }),
      unsetCallout:
        () =>
        ({ commands }) =>
          commands.lift(this.name),
    };
  },
});
