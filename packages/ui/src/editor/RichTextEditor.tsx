import { useContext, useEffect } from "react";
import { useLatest } from "../useLatest";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extensions";
import { CALLOUT_KINDS, richTextSchema, type RichText } from "@amluto-steps/core";

import { Icon, type IconName } from "../components/icons";
import { Menu } from "../components/Menu";
import { Callout } from "./callout";
import { askText } from "../app/ask";
import { ReadOnlyContext } from "./readOnly";

interface RichTextEditorProps {
  value: RichText | null;
  onChange: (value: RichText | null) => void;
  label: string;
  placeholder: string;
  /** Headings are offered in intro/outro and blocks, not in step notes. */
  headings?: boolean;
  /** Puts the cursor in the box as it appears (one just added). */
  focusOnOpen?: boolean;
}

/** Each box's colour, as a dot beside its name in the menu. */
const CALLOUT_DOT = {
  note: "bg-callout-note",
  tip: "bg-callout-tip",
  warning: "bg-callout-warning",
  important: "bg-callout-important",
} as const;

const isEmpty = (value: RichText) =>
  !value.content?.some((node) => node.type !== "paragraph" || (node.content?.length ?? 0) > 0);

/**
 * Notes, intro, outro and block text. Only the allow-listed nodes and marks exist in the editor
 * (bold, italic, lists, links, small headings), and what it produces is checked against the same
 * schema as files on disk before it is kept (docs/spec/08-privacy-and-security.md#app-hardening).
 * Its own undo is off: Ctrl+Z goes to the guide's undo, which covers notes too.
 */
export function RichTextEditor({
  value,
  onChange,
  label,
  placeholder,
  headings,
  focusOnOpen = false,
}: RichTextEditorProps) {
  const { t } = useTranslation();
  const onChangeRef = useLatest(onChange);
  const valueRef = useLatest(value);
  const readOnly = useContext(ReadOnlyContext);

  const editor = useEditor({
    // The app's content security policy refuses inline <style>; styles.css has what's needed.
    injectCSS: false,
    autofocus: focusOnOpen ? "end" : false,
    extensions: [
      StarterKit.configure({
        undoRedo: false,
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        heading: headings ? { levels: [2, 3] } : false,
        link: {
          openOnClick: false,
          autolink: true,
          protocols: ["http", "https", "mailto"],
          isAllowedUri: (url) => /^(https?:|mailto:)/i.test(url),
        },
      }),
      Placeholder.configure({ placeholder }),
      Callout.configure({
        labels: {
          note: t("editor.callout.note"),
          tip: t("editor.callout.tip"),
          warning: t("editor.callout.warning"),
          important: t("editor.callout.important"),
        },
      }),
    ],
    content: value ?? "",
    editable: !readOnly,
    editorProps: {
      attributes: {
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
        class: "px-3 py-2 text-sm leading-relaxed",
      },
    },
    onUpdate: ({ editor: current }) => {
      const parsed = richTextSchema.safeParse(current.getJSON());
      if (!parsed.success) return;
      const next = isEmpty(parsed.data) ? null : parsed.data;
      // Nothing changed: not an edit, so nothing to save.
      if (JSON.stringify(next) === JSON.stringify(valueRef.current)) return;
      onChangeRef.current(next);
    },
  });

  // Undo, redo or switching steps change the value from outside; show it without echoing back.
  // The editor's own JSON is compared after the same schema check the saved value went through:
  // the schema orders keys its own way and drops attributes it doesn't allow, so comparing raw
  // JSON saw every keystroke in a formatted note as an outside change and replaced the note,
  // throwing the cursor to the end.
  // Without `false`, TipTap reports this as an edit: the note, as its schema orders it, was then
  // saved each time it was shown or its guide went read-only, changing a step nobody edited (and,
  // in a shared library, turning a guide someone else is editing into a draft; 30/09/2026).
  useEffect(() => {
    editor?.setEditable(!readOnly, false);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    const own = richTextSchema.safeParse(editor.getJSON());
    if (value === null && own.success && isEmpty(own.data)) return;
    const current = JSON.stringify(own.success ? own.data : editor.getJSON());
    const next = value ?? { type: "doc", content: [{ type: "paragraph" }] };
    if (current !== JSON.stringify(next)) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [editor, value]);

  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      bullet: current?.isActive("bulletList") ?? false,
      ordered: current?.isActive("orderedList") ?? false,
      link: current?.isActive("link") ?? false,
      heading: current?.isActive("heading", { level: 2 }) ?? false,
      callout: current?.isActive("callout") ?? false,
    }),
  });

  const tool = (name: IconName, text: string, pressed: boolean, run: () => void) => (
    <button
      type="button"
      // Pressed shows as a bar under the button too, not only its colour (WCAG 1.4.1).
      className={`icon-btn size-8 ${pressed ? "bg-selected text-link shadow-[inset_0_-2px_0_var(--amluto-focus)]" : ""}`}
      aria-label={text}
      aria-pressed={pressed}
      title={text}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      <Icon name={name} size={16} />
    </button>
  );

  const setLink = async () => {
    if (!editor) return;
    if (editor.isActive("link")) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    const href = await askText(
      t("editor.linkTitle"),
      t("editor.linkPrompt"),
      "https://",
      t("editor.linkYes"),
    );
    if (href && /^(https?:|mailto:)/i.test(href.trim())) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
    }
  };

  return (
    <div className="rounded-lg border border-control-line bg-background focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus">
      <div
        role="toolbar"
        aria-label={t("editor.formatting")}
        className="flex gap-0.5 border-b border-panel p-1"
      >
        {tool("bold", t("editor.bold"), active?.bold ?? false, () =>
          editor?.chain().focus().toggleBold().run(),
        )}
        {tool("italic", t("editor.italic"), active?.italic ?? false, () =>
          editor?.chain().focus().toggleItalic().run(),
        )}
        {tool("bulletList", t("editor.bullets"), active?.bullet ?? false, () =>
          editor?.chain().focus().toggleBulletList().run(),
        )}
        {tool("numberList", t("editor.numbers"), active?.ordered ?? false, () =>
          editor?.chain().focus().toggleOrderedList().run(),
        )}
        {headings &&
          tool("text", t("editor.heading"), active?.heading ?? false, () =>
            editor?.chain().focus().toggleHeading({ level: 2 }).run(),
          )}
        {tool("link", t("editor.link"), active?.link ?? false, setLink)}
        <Menu
          label={t("editor.callout.menu")}
          align="start"
          width={220}
          entries={[
            ...CALLOUT_KINDS.map((kind) => ({
              label: t(`editor.callout.${kind}`),
              leading: (
                <span aria-hidden="true" className={`size-3 rounded-full ${CALLOUT_DOT[kind]}`} />
              ),
              onSelect: () => editor?.chain().focus().setCallout(kind).run(),
            })),
            ...(active?.callout
              ? [
                  "divider" as const,
                  {
                    label: t("editor.callout.remove"),
                    onSelect: () => editor?.chain().focus().unsetCallout().run(),
                  },
                ]
              : []),
          ]}
          trigger={(trigger) => (
            <button
              type="button"
              {...trigger}
              className={`icon-btn size-8 ${active?.callout ? "bg-selected text-link" : ""}`}
              aria-label={t("editor.callout.menu")}
              title={t("editor.callout.menu")}
              onMouseDown={(event) => event.preventDefault()}
            >
              <Icon name="info" size={16} />
            </button>
          )}
        />
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
