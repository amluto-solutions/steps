import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { askConfirm } from "../app/ask";
import { useTranslation } from "react-i18next";
import type { Block, Finding, GuideStep, OcrLine } from "@amluto-steps/core";
import {
  BLOCK_TYPES,
  LANGUAGES,
  calloutOfBlock,
  docIn,
  languageName,
  mainLanguage,
  toneOf,
  typedValueInText,
  type MissingText,
} from "@amluto-steps/core";

import { Spinner } from "../components/Spinner";
import { DateField } from "../components/DateField";
import { Icon, type IconName } from "../components/icons";
import { useLatest } from "../useLatest";
import { Menu, type MenuEntry } from "../components/Menu";
import type { ToastMessage } from "../components/Toast";
import type { EditorDoc } from "./document";
import {
  blankStep,
  blockStep,
  deleteSteps,
  duplicateStep,
  insertStepAt,
  mergeWithNext,
  moveStep,
  removeStepOutput,
  removeTypedValue,
  setTypedValue,
  setAllValues,
  rebuildsWording,
  setShowValue,
  markChecked,
  reviewReason,
  setStepCode,
  splitStep,
  updateGuide,
  updateStep,
  replaceText,
  stepsWithText,
} from "./edits";
import { CodePanel } from "./CodePanel";
import { ImageEditor, type ImageTool } from "./ImageEditor";
import { RichTextEditor } from "./RichTextEditor";
import { ReadOnlyContext } from "./readOnly";
import { SuggestedBlurs } from "./SuggestedBlurs";
import { StepRail, type Selection } from "./StepRail";
import { applySuggestions, tidySuggestions, type TidySuggestion } from "./tidy";
import { AltTextField } from "./AltTextField";
import { TypedValueField } from "./TypedValueField";
import {
  changeLanguageAndTone,
  setAltTextIn,
  setBlockIn,
  setStepNotesIn,
  setStepTextIn,
  updateGuideIn,
} from "./languages";
import { LanguageToneDialog } from "./LanguageToneDialog";
import { FindBlurDialog } from "./FindBlurDialog";
import { applySmartZoom } from "./zoom";
import { Retake } from "./Retake";
import {
  blurFoundEdit,
  dataUrlBytes,
  findOpenInGuide,
  notPersonalEdit,
  openFindings,
} from "./suggestions";
import { useGuideEditor, type EditorHooks, type GuideStore } from "./useGuideEditor";
import { ModalDialog } from "../ModalDialog";

/** What a side panel (review comments) sees of the editor. */
export interface EditorView {
  steps: GuideStep[];
  /** Each interaction step's number. */
  numbers: Map<string, number>;
  /** The step on screen, if a step is. */
  selectedStepId: string | null;
  showStep: (id: string) => void;
}

export interface GuideEditorProps {
  initial: EditorDoc;
  store: GuideStore;
  author: string;
  /** A stopped recording not yet in a library shows Save and Discard. */
  mode: "draft" | "saved";
  busy: boolean;
  onBack: () => void;
  onSave?: ((flush: () => Promise<void>, doc: EditorDoc) => void) | undefined;
  /** Saves a version of a saved guide first, as Language and tone does before rewording. */
  saveVersion?: ((note: string) => Promise<void>) | undefined;
  /**
   * Save as: the libraries a recording can go to instead of the default, from an arrow beside
   * Save (01/10/2026). A one-off: the default library stays as it is.
   */
  saveTargets?: { id: string; name: string; isDefault: boolean }[] | undefined;
  onSaveTo?: ((flush: () => Promise<void>, doc: EditorDoc, libraryId: string) => void) | undefined;
  onDiscard?: (() => void) | undefined;
  /** The Export menu (built by the app, which knows the formats and where files go). */
  exportMenu: (doc: EditorDoc, flush: () => Promise<void>, editor: EditorHooks) => MenuEntry[];
  /** Guide-level actions for a saved guide (duplicate, versions, move…). */
  guideMenu?: ((doc: EditorDoc, flush: () => Promise<void>) => MenuEntry[]) | undefined;
  notify: (toast: Omit<ToastMessage, "id">) => void;
  /** Windows OCR, for suggested blurs and Find & Blur; absent where it isn't available. */
  /**
   * The guide is in a synced or organisation-managed library, so blur only hides text in exports:
   * people with access can still open the original screenshots.
   */
  sharedLibrary?: boolean | undefined;
  readText?:
    | ((
        image: Uint8Array,
        blurred?: { x: number; y: number; w: number; h: number }[],
      ) => Promise<OcrLine[]>)
    | undefined;
  /** Settings → Privacy: always-blur terms. */
  blurTerms: string[];
  /** Someone else holds the edit lock (shared libraries): nothing can change here. */
  readOnly?: boolean | undefined;
  /** Shown above the editor: who is editing, unsynced drafts. */
  banner?: ReactNode;
  /** An edit was refused because the guide is read-only. */
  onRefused?: (() => void) | undefined;
  /** Someone took over while this editor had the lock; `doc` is its unsaved state. */
  onLockLost?: ((doc: EditorDoc) => void) | undefined;
  /** In the header, after the save status (the Comments button). */
  headerActions?: ReactNode;
  /** On the right of the editor, when given (review comments). */
  sidePanel?: ((view: EditorView) => ReactNode) | undefined;
}

let idCounter = 0;
const newId = (prefix: string) => {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}${idCounter.toString(36)}`;
};

const TOOLS: { tool: ImageTool; icon: IconName }[] = [
  { tool: "select", icon: "pointer" },
  { tool: "arrow", icon: "arrow" },
  { tool: "box", icon: "box" },
  { tool: "text", icon: "text" },
  { tool: "blur", icon: "blur" },
  { tool: "crop", icon: "crop" },
];

/** The pictures Steps takes as a step's screenshot. */
const isTakenImage = (file: File) => /^image\/(png|jpeg|webp)$/.test(file.type);

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The guide editor (docs/spec/04-editor.md), laid out as on the Phase 3 design canvas: the steps
 * list on the left, the selected step on the right. Every change goes through the undo layer and
 * is saved file by file straight away.
 */
/** Read text is kept per screenshot and the blur it was read with. */
const textKey = (mediaId: string, blur: string) => `${mediaId}|${blur}`;

/**
 * Full screenshots are large data URLs (a long guide's would be hundreds of megabytes), so only
 * the most recently used are kept; thumbnails are small and more are kept.
 */
const MAX_CACHED = { full: 24, thumbnail: 400 };

function trimImageCache(cache: Map<string, string>) {
  for (const [kind, suffix] of [
    ["full", ":f"],
    ["thumbnail", ":t"],
  ] as const) {
    const keys = [...cache.keys()].filter((key) => key.endsWith(suffix));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHED[kind]))) cache.delete(key);
  }
}

export function GuideEditor(props: GuideEditorProps) {
  const { t } = useTranslation();
  const onLockLostRef = useLatest(props.onLockLost);
  const editorDocRef = useRef(props.initial);
  const editor = useGuideEditor(props.initial, props.store, props.author, {
    readOnly: props.readOnly === true,
    onRefused: props.onRefused,
    onLockLost: () => onLockLostRef.current?.(editorDocRef.current),
  });
  const { doc, apply } = editor;
  useEffect(() => {
    editorDocRef.current = doc;
  }, [doc]);

  // ----- The language shown (docs/spec/04-editor.md#languages) -----
  const main = mainLanguage(doc.guide);
  const [showingChoice, setShowingChoice] = useState<string | null>(null);
  /** The language the editor shows and edits in: the guide's main one unless another is chosen. */
  const language = showingChoice ?? main;
  const shown = useMemo(
    () => (language === main ? { doc, missing: [] as MissingText[] } : docIn(doc, language)),
    [doc, language, main],
  );
  const view = shown.doc;
  const missing = useMemo(
    () => new Set(shown.missing.map((item) => `${item.stepId ?? ""}:${item.field}`)),
    [shown.missing],
  );
  const notWritten = (stepId: string | null, field: string) =>
    missing.has(`${stepId ?? ""}:${field}`);
  const [languageTone, setLanguageTone] = useState(false);
  const [chosen, setSelection] = useState<Selection>(() => {
    const first = props.initial.steps[0];
    return first ? { kind: "step", id: first.id } : { kind: "details" };
  });
  const [tool, setTool] = useState<ImageTool>("select");
  const [notesOpen, setNotesOpen] = useState(false);
  const [textLines, setTextLines] = useState<Map<string, OcrLine[]>>(new Map());
  /** The suggested blur pointed at in the list, and the one last asked to be shown. */
  const [pointed, setPointed] = useState<{ stepId: string; index: number } | null>(null);
  const [revealed, setRevealed] = useState<{ stepId: string; area: Finding["rect"] } | null>(null);
  const [findBlurOpen, setFindBlurOpen] = useState(false);
  const [tidy, setTidy] = useState<{ suggestions: TidySuggestion[]; chosen: Set<string> } | null>(
    null,
  );
  const imageCache = useRef(new Map<string, string>());

  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    let next = 1;
    for (const step of doc.steps) if (step.kind === "interaction") map.set(step.id, next++);
    return map;
  }, [doc.steps]);

  // A step that disappears (undo of an insert, say) falls back to the first step.
  const chosenIndex =
    chosen.kind === "step" ? doc.steps.findIndex((step) => step.id === chosen.id) : -1;
  const firstStep = doc.steps[0];
  const selection: Selection =
    chosen.kind === "step" && chosenIndex < 0
      ? firstStep
        ? { kind: "step", id: firstStep.id }
        : { kind: "details" }
      : chosen;
  const selectedIndex =
    selection.kind === "step" ? doc.steps.findIndex((step) => step.id === selection.id) : -1;
  const selected = selectedIndex >= 0 ? doc.steps[selectedIndex] : undefined;
  /** The selected step's words in the language shown. */
  const selectedText = selected && (view.steps[selectedIndex] ?? selected);

  const loadImage = useCallback(
    async (mediaId: string, thumbnail: boolean) => {
      const key = `${mediaId}:${thumbnail ? "t" : "f"}`;
      const cache = imageCache.current;
      const cached = cache.get(key);
      if (cached) {
        // Most recently used last, so the oldest go first when the cache is trimmed.
        cache.delete(key);
        cache.set(key, cached);
        return cached;
      }
      const data = await props.store.loadImage(mediaId, thumbnail);
      cache.set(key, data);
      trimImageCache(cache);
      return data;
    },
    [props.store],
  );
  const loadThumbnail = useCallback((mediaId: string) => loadImage(mediaId, true), [loadImage]);

  const [imageUrl, setImageUrl] = useState<{ id: string; url: string } | null>(null);
  const mediaId = selected?.media?.id ?? null;
  useEffect(() => {
    if (!mediaId) return;
    let cancelled = false;
    loadImage(mediaId, false)
      .then((url) => {
        if (!cancelled) setImageUrl({ id: mediaId, url });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mediaId, loadImage]);

  // Words in each screenshot as a step blurs it, read by OCR and kept for this session. Kept per
  // screenshot *and* blur: two steps can share a screenshot with different blur, and words
  // under one step's blur must still count for the other.
  const readText = props.readText;
  const linesFor = useCallback(
    async (step: GuideStep): Promise<OcrLine[]> => {
      const id = step.media?.id;
      if (!id || !readText) return [];
      const key = textKey(id, JSON.stringify(step.redactions));
      const known = textLines.get(key);
      if (known) return known;
      const lines = await readText(dataUrlBytes(await loadImage(id, false)), step.redactions);
      setTextLines((current) => new Map(current).set(key, lines));
      return lines;
    },
    [readText, textLines, loadImage],
  );

  const selectedMedia = selected?.kind === "interaction" ? (selected.media?.id ?? null) : null;
  // The blur on screen, as a value that changes only when the blur does.
  const selectedBlur = JSON.stringify(selected?.redactions ?? []);
  // Read the text in the screenshot on screen, for its suggested blurs; again whenever its blur
  // changes, which also takes blurred words out of the cache (OCR itself is cached, so it's cheap).
  useEffect(() => {
    if (!selectedMedia || !readText) return;
    let cancelled = false;
    void (async () => {
      try {
        const blurred = JSON.parse(selectedBlur) as {
          x: number;
          y: number;
          w: number;
          h: number;
        }[];
        const lines = await readText(dataUrlBytes(await loadImage(selectedMedia, false)), blurred);
        if (!cancelled)
          setTextLines((current) =>
            new Map(current).set(textKey(selectedMedia, selectedBlur), lines),
          );
      } catch {
        // No OCR (or no language for it): no suggestions, and the export review still shows everything.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedMedia, selectedBlur, readText, loadImage]);

  const findings: Finding[] =
    selected && selectedMedia
      ? openFindings(
          selected,
          textLines.get(textKey(selectedMedia, selectedBlur)) ?? [],
          props.blurTerms,
        )
      : [];

  /** Adds blur areas to several steps as one undo step (Find & Blur, Blur all). */
  const blurFound = (found: { stepId: string; findings: Finding[] }[]) =>
    apply(blurFoundEdit(found, t("editor.undo.blur")));

  /** Blur all: every possible personal detail in every screenshot, blurred in one go (one undo). */
  const [blurring, setBlurring] = useState<{ done: number; total: number } | null>(null);
  const blurAll = async () => {
    setBlurring({ done: 0, total: 0 });
    try {
      const { found, unread } = await findOpenInGuide(
        doc.steps,
        linesFor,
        props.blurTerms,
        (done, total) => setBlurring({ done, total }),
      );
      const count = found.reduce((sum, item) => sum + item.findings.length, 0);
      const made = count > 0 ? blurFound(found) : null;
      props.notify({
        text: [
          made
            ? t("suggest.blurAllDone", { count, steps: found.length })
            : t("suggest.blurAllNothing"),
          unread ? t("findBlur.unread", { count: unread }) : "",
        ]
          .filter(Boolean)
          .join(" "),
        ...(made ? { action: { label: t("common.undo"), run: () => editor.undo() } } : {}),
      });
    } finally {
      setBlurring(null);
    }
  };

  const remove = useCallback(
    (ids: string[]) => {
      // Deleting the step on screen moves to its neighbour, not back to the top.
      if (selection.kind === "step" && ids.includes(selection.id)) {
        const remaining = doc.steps.filter((step) => !ids.includes(step.id));
        const neighbour = remaining[Math.min(selectedIndex, remaining.length - 1)];
        setSelection(neighbour ? { kind: "step", id: neighbour.id } : { kind: "details" });
        // Deleting from the steps list removes the focused row: focus its neighbour instead of
        // leaving it on nothing.
        window.requestAnimationFrame(() => {
          if (document.activeElement && document.activeElement !== document.body) return;
          const target = [...document.querySelectorAll<HTMLElement>("[data-step-button]")].find(
            (button) => button.dataset.stepButton === neighbour?.id,
          );
          target?.focus();
        });
      }
      const edit = apply((current, stamp) => deleteSteps(current, ids, stamp));
      if (!edit) return;
      props.notify({
        text: t("editor.deleted", { count: ids.length }),
        action: { label: t("common.undo"), run: () => editor.undo() },
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor.undo is stable
    [apply, props.notify, t, selection, selectedIndex, doc.steps],
  );

  const insertAfter = useCallback(
    (step: GuideStep, index: number, label: string) => {
      apply((current, stamp) => insertStepAt(current, step, index + 1, label, stamp));
      setSelection({ kind: "step", id: step.id });
    },
    [apply],
  );

  const addImages = useCallback(
    async (files: File[]) => {
      const importImage = props.store.importImage;
      if (!importImage) {
        props.notify({ text: t("editor.saveFirstForImages") });
        return;
      }
      let index = selectedIndex >= 0 ? selectedIndex : doc.steps.length - 1;
      for (const file of files) {
        try {
          if (!isTakenImage(file)) throw new Error("not a PNG, JPEG or WebP");
          const media = await importImage(new Uint8Array(await file.arrayBuffer()));
          const at = Date.now();
          const step: GuideStep = {
            ...blankStep(newId("manual"), { at, by: props.author }),
            media: {
              id: media.id,
              width: media.width,
              height: media.height,
              scale: 1,
              captureRect: null,
            },
          };
          insertAfter(step, index, t("editor.undo.addImage"));
          index += 1;
        } catch {
          props.notify({ kind: "error", text: t("editor.imageFailed") });
        }
      }
    },
    [props, selectedIndex, doc.steps.length, insertAfter, t],
  );

  // Undo/redo for the whole editor (typing included), Ctrl+V for pasted screenshots.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Inside a dialog (Find & Blur, Tidy…) the keys belong to it: undoing the guide behind it
      // would silently take back what the dialog just did.
      if (event.target instanceof Element && event.target.closest("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        editor.undo();
      } else if (key === "y" || (key === "z" && event.shiftKey)) {
        event.preventDefault();
        editor.redo();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      if (isTextField(event.target)) return;
      const files = [...(event.clipboardData?.files ?? [])].filter(isTakenImage);
      if (files.length === 0) return;
      event.preventDefault();
      void addImages(files);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("paste", onPaste);
    };
  }, [editor, addImages]);

  const stepMenu = (step: GuideStep, index: number): MenuEntry[] => [
    {
      label: t("editor.menu.duplicate"),
      icon: "copy",
      onSelect: () =>
        apply((current, stamp) => duplicateStep(current, step.id, newId("step"), stamp)),
    },
    ...(step.kind === "interaction"
      ? [
          {
            label: t("editor.menu.split"),
            icon: "split" as const,
            note: t("editor.menu.splitNote"),
            onSelect: () =>
              apply((current, stamp) => splitStep(current, step.id, newId("step"), stamp)),
          },
          {
            label: t("editor.menu.merge"),
            icon: "merge" as const,
            disabled: doc.steps[index + 1]?.kind !== "interaction",
            onSelect: () => apply((current, stamp) => mergeWithNext(current, step.id, stamp)),
          },
        ]
      : []),
    "divider",
    {
      label: t("editor.menu.moveUp"),
      icon: "up",
      disabled: index === 0,
      onSelect: () => apply((current, stamp) => moveStep(current, step.id, index - 1, stamp)),
    },
    {
      label: t("editor.menu.moveDown"),
      icon: "down",
      disabled: index === doc.steps.length - 1,
      onSelect: () => apply((current, stamp) => moveStep(current, step.id, index + 1, stamp)),
    },
    "divider",
    {
      label: t("editor.menu.addStepAfter"),
      icon: "plus",
      onSelect: () =>
        insertAfter(
          blankStep(newId("step"), { at: Date.now(), by: props.author }),
          index,
          t("editor.undo.addStep"),
        ),
    },
    {
      label: t("editor.menu.addTipAfter"),
      icon: "info",
      onSelect: () =>
        insertAfter(
          blockStep(newId("block"), "tip", { at: Date.now(), by: props.author }),
          index,
          t("editor.undo.addBlock"),
        ),
    },
    "divider",
    {
      label: t("editor.menu.delete"),
      icon: "trash",
      danger: true,
      trailing: t("editor.deleteKey"),
      onSelect: () => remove([step.id]),
    },
  ];

  // New items go after the selected step; with the guide details or intro selected they go
  // first, and only the outro sends them to the end.
  const addAt =
    selectedIndex >= 0 ? selectedIndex : selection.kind === "outro" ? doc.steps.length - 1 : -1;
  const addBlock = (type: Block["type"]) =>
    insertAfter(
      blockStep(newId("block"), type, { at: Date.now(), by: props.author }),
      addAt,
      t("editor.undo.addBlock"),
    );
  const addMenu: MenuEntry[] = [
    {
      label: t("editor.menu.blankStep"),
      icon: "plus",
      note: t("editor.menu.blankStepNote"),
      onSelect: () =>
        insertAfter(
          blankStep(newId("step"), { at: Date.now(), by: props.author }),
          addAt,
          t("editor.undo.addStep"),
        ),
    },
    {
      label: t("editor.menu.image"),
      icon: "image",
      note: props.store.importImage ? t("editor.menu.imageNote") : t("editor.saveFirstForImages"),
      disabled: !props.store.importImage,
      onSelect: () => document.getElementById("editor-image-input")?.click(),
    },
    { heading: t("editor.menu.blocks") },
    { label: t("editor.block.header"), icon: "text", onSelect: () => addBlock("header") },
    { label: t("editor.block.text"), icon: "note", onSelect: () => addBlock("text") },
    { label: t("editor.block.callout"), icon: "info", onSelect: () => addBlock("callout") },
    { label: t("editor.block.tip"), icon: "info", onSelect: () => addBlock("tip") },
    { label: t("editor.block.warning"), icon: "warning", onSelect: () => addBlock("warning") },
    { label: t("editor.block.alert"), icon: "warning", onSelect: () => addBlock("alert") },
  ];

  const hasValues = doc.steps.some((step) => step.textParts.value);
  const guideMenu: MenuEntry[] = [
    ...(readText
      ? [
          {
            label: t("findBlur.menu"),
            icon: "blur" as const,
            note: t("findBlur.menuNote"),
            onSelect: () => setFindBlurOpen(true),
          },
        ]
      : []),
    {
      label: t("zoom.menu"),
      icon: "crop",
      note: t("zoom.menuNote"),
      onSelect: () => {
        const made = apply((current, stamp) => applySmartZoom(current, stamp));
        props.notify(
          made
            ? {
                text: t("zoom.done", { count: made.changes.length }),
                action: { label: t("common.undo"), run: () => editor.undo() },
              }
            : { text: t("zoom.nothing") },
        );
      },
    },
    {
      label: t("tidy.menu"),
      icon: "check",
      note: t("tidy.menuNote"),
      onSelect: () => {
        const found = tidySuggestions(doc, { at: Date.now(), by: props.author });
        if (found.length === 0) {
          props.notify({ text: t("tidy.nothing") });
          return;
        }
        setTidy({ suggestions: found, chosen: new Set(found.map((item) => item.id)) });
      },
    },
    "divider",
    ...(hasValues
      ? [
          {
            label: t("editor.menu.hideAllValues"),
            icon: "shield" as const,
            onSelect: () => apply((current, stamp) => setAllValues(current, false, stamp)),
          },
          {
            label: t("editor.menu.showAllValues"),
            icon: "text" as const,
            onSelect: () => apply((current, stamp) => setAllValues(current, true, stamp)),
          },
          "divider" as const,
        ]
      : []),
    {
      label: t("editor.languages.menu"),
      icon: "text",
      onSelect: () => setLanguageTone(true),
    },
    "divider" as const,
    {
      label: t("editor.menu.undo"),
      icon: "undo",
      trailing: "Ctrl+Z",
      disabled: editor.history.past.length === 0,
      onSelect: () => editor.undo(),
    },
    {
      label: t("editor.menu.redo"),
      icon: "redo",
      trailing: "Ctrl+Y",
      disabled: editor.history.future.length === 0,
      onSelect: () => editor.redo(),
    },
    ...(props.guideMenu ? ["divider" as const, ...props.guideMenu(doc, editor.flush)] : []),
  ];

  const saveLabel =
    props.mode === "draft"
      ? t("editor.status.notSaved")
      : editor.saveState === "saving"
        ? t("editor.status.saving")
        : editor.saveState === "error"
          ? t("editor.status.error")
          : t("editor.status.saved");

  const describe = (suggestion: TidySuggestion) => {
    const texts = suggestion.stepIds.map((id) => {
      const step = doc.steps.find((item) => item.id === id);
      return step ? `${numbers.get(id) ?? "?"}. ${step.actionText}` : id;
    });
    return t(`tidy.kinds.${suggestion.kind}`, { steps: texts.join(" / ") });
  };

  /** The arrow beside Save, when there's more than one library to choose from. */
  const saveAs =
    props.saveTargets && props.saveTargets.length > 1 && props.onSaveTo
      ? { targets: props.saveTargets, onSaveTo: props.onSaveTo }
      : null;
  return (
    <ReadOnlyContext.Provider value={props.readOnly === true}>
      <div className="flex h-full flex-col">
        {props.banner}
        {languageTone && (
          <LanguageToneDialog
            doc={doc}
            busy={props.busy}
            onCancel={() => setLanguageTone(false)}
            onApply={(nextLanguage, tone, reword) => {
              setLanguageTone(false);
              void (async () => {
                // The old words stay easy to find after this session's Undo is gone.
                if (props.saveVersion) {
                  await editor.flush();
                  await props.saveVersion(t("editor.languages.versionNote")).catch(() => undefined);
                }
                const made = apply((current, stamp) =>
                  changeLanguageAndTone(current, nextLanguage, tone, reword, stamp),
                );
                setShowingChoice(null);
                if (made)
                  props.notify({
                    text: t("editor.languages.done", {
                      count: reword.size,
                      name: languageName(nextLanguage),
                      tone: t(`editor.languages.tones.${tone}`),
                    }),
                    action: { label: t("common.undo"), run: () => editor.undo() },
                  });
              })();
            }}
          />
        )}
        {findBlurOpen && readText && (
          <FindBlurDialog
            steps={doc.steps}
            numbers={numbers}
            terms={props.blurTerms}
            linesFor={linesFor}
            textMatches={(term) => stepsWithText(doc, term)}
            onReplace={(term, replacement) => {
              const made = apply((current, stamp) =>
                replaceText(current, term, replacement, stamp),
              );
              if (made)
                props.notify({
                  text: t("findBlur.replaced", { count: made.changes.length }),
                  action: { label: t("common.undo"), run: () => editor.undo() },
                });
            }}
            onBlur={(found) => {
              if (blurFound(found)) {
                props.notify({
                  text: t("findBlur.done", {
                    count: found.reduce((sum, item) => sum + item.findings.length, 0),
                  }),
                  action: { label: t("common.undo"), run: () => editor.undo() },
                });
              }
            }}
            onClose={() => setFindBlurOpen(false)}
          />
        )}
        {tidy && (
          <div className="fixed inset-0 z-[800] grid place-items-center bg-scrim/50 p-4">
            <ModalDialog
              labelledBy="tidy-title"
              describedBy="tidy-help"
              onEscape={() => setTidy(null)}
              className="card flex max-h-[80vh] w-full max-w-xl flex-col p-6"
            >
              <h2 id="tidy-title" className="font-heading text-xl text-navy">
                {t("tidy.title")}
              </h2>
              <p id="tidy-help" className="mt-1 text-sm text-secondary">
                {t("tidy.help")}
              </p>
              <ul className="mt-4 flex min-h-0 flex-col gap-1 overflow-y-auto">
                {tidy.suggestions.map((suggestion) => (
                  <li key={suggestion.id}>
                    <label className="flex items-start gap-3 rounded-lg px-2 py-2 text-sm hover:bg-subtle">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-blue"
                        checked={tidy.chosen.has(suggestion.id)}
                        onChange={(event) => {
                          const chosen = new Set(tidy.chosen);
                          if (event.currentTarget.checked) chosen.add(suggestion.id);
                          else chosen.delete(suggestion.id);
                          setTidy({ ...tidy, chosen });
                        }}
                      />
                      <span>{describe(suggestion)}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" className="btn" onClick={() => setTidy(null)}>
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={tidy.chosen.size === 0}
                  onClick={() => {
                    const ids = tidy.chosen;
                    setTidy(null);
                    // Worked out again from the guide as it is now: an undo or redo since the
                    // dialog opened would otherwise be overwritten by the old before/after.
                    let count = 0;
                    const made = apply((current, stamp) => {
                      const chosen = tidySuggestions(current, stamp).filter((item) =>
                        ids.has(item.id),
                      );
                      count = chosen.length;
                      return applySuggestions(chosen, stamp);
                    });
                    if (made) {
                      props.notify({
                        text: t("tidy.done", { count }),
                        action: { label: t("common.undo"), run: () => editor.undo() },
                      });
                    }
                  }}
                >
                  {t("tidy.apply", { count: tidy.chosen.size })}
                </button>
              </div>
            </ModalDialog>
          </div>
        )}
        {/* In a narrow window the buttons move to a second row together, at the right, rather than
            off the edge with Save (04/10/2026). */}
        <header className="relative z-10 flex min-h-[60px] shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-panel bg-background py-2.5 pr-4 pl-3">
          <button type="button" className="btn pl-2" onClick={props.onBack}>
            <Icon name="back" size={16} strokeWidth={2.4} />
            {t("nav.guides")}
          </button>
          {/* At 200% zoom the header is narrow: buttons below keep their names for screen readers
              but show only icons, and the title keeps room to be read. */}
          {/* The title box is the visible heading; this names the screen for screen readers. */}
          <h1 className="sr-only">{view.guide.title || t("editor.title")}</h1>
          <label className="flex min-w-32 flex-1 items-center">
            <span className="sr-only">{t("editor.title")}</span>
            <input
              value={view.guide.title}
              // A long title is cut off by the header: the whole of it shows on hover (F052).
              title={view.guide.title}
              lang={language}
              onChange={(event) => {
                const title = event.currentTarget.value;
                apply((current, stamp) =>
                  updateGuideIn(
                    current,
                    { title },
                    language,
                    t("editor.undo.title"),
                    stamp,
                    "title",
                  ),
                );
              }}
              className="h-10 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 font-heading text-[19px] font-bold text-navy hover:border-panel focus:border-line"
            />
          </label>
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2.5">
            <span
              role="status"
              className={`rounded-full px-2.5 py-1 text-xs font-bold whitespace-nowrap ${props.mode === "draft" || editor.saveState === "error" ? "bg-warning-soft text-warning" : "text-secondary max-2xl:sr-only"}`}
            >
              {saveLabel}
            </span>
            <label className="flex items-center gap-1.5 text-xs text-secondary">
              {/* Longer languages (German, Finnish) need the room for the title below 1536 px. */}
              <span className="max-2xl:sr-only">{t("editor.languages.showing")}</span>
              <select
                className="field h-8 max-w-48 text-sm"
                value={language}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setShowingChoice(next === main ? null : next);
                }}
              >
                <option value={main} lang={main}>
                  {t("editor.languages.mainOption", { name: languageName(main) })}
                </option>
                {LANGUAGES.filter((item) => item.code !== main).map((item) => (
                  <option key={item.code} value={item.code} lang={item.code}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            {shown.missing.length > 0 && (
              <button
                type="button"
                className="chip h-8 shrink-0 gap-1 bg-warning-soft text-warning"
                title={t("editor.languages.nextMissing", { name: languageName(language) })}
                onClick={() => {
                  // The next text not written yet after what's selected, round to the first.
                  const order = (item: MissingText) =>
                    item.stepId === null
                      ? item.field === "intro"
                        ? -2
                        : item.field === "outro"
                          ? doc.steps.length
                          : -3
                      : doc.steps.findIndex((step) => step.id === item.stepId);
                  const here =
                    selection.kind === "step"
                      ? selectedIndex
                      : selection.kind === "details"
                        ? -3
                        : selection.kind === "intro"
                          ? -2
                          : doc.steps.length;
                  const next = shown.missing.find((item) => order(item) > here) ?? shown.missing[0];
                  if (!next) return;
                  setSelection(
                    next.stepId !== null
                      ? { kind: "step", id: next.stepId }
                      : next.field === "intro"
                        ? { kind: "intro" }
                        : next.field === "outro"
                          ? { kind: "outro" }
                          : { kind: "details" },
                  );
                }}
              >
                {t("editor.languages.missing", {
                  count: shown.missing.length,
                  name: languageName(language),
                })}
              </button>
            )}
            {props.headerActions}
            <Menu
              label={t("editor.guideMenu")}
              entries={guideMenu}
              trigger={(trigger) => (
                <button
                  type="button"
                  {...trigger}
                  className="icon-btn"
                  aria-label={t("editor.guideMenu")}
                >
                  <Icon name="more" size={20} strokeWidth={3} />
                </button>
              )}
            />
            {readText && (
              <button
                type="button"
                className="btn"
                disabled={blurring !== null}
                title={t("suggest.blurAllHelp")}
                onClick={() => void blurAll()}
              >
                <Icon name="blur" size={16} />
                {blurring ? (
                  t("suggest.blurAllWorking", { done: blurring.done, total: blurring.total })
                ) : (
                  <span className="max-lg:sr-only">{t("suggest.blurAllGuide")}</span>
                )}
              </button>
            )}
            {props.mode === "draft" && props.onDiscard && (
              <button type="button" className="btn" disabled={props.busy} onClick={props.onDiscard}>
                {t("editor.discard")}
              </button>
            )}
            <Menu
              label={t("export.menu")}
              entries={props.exportMenu(doc, editor.flush, {
                apply: editor.apply,
                undo: editor.undo,
                redo: editor.redo,
                showStep: (id) => setSelection({ kind: "step", id }),
              })}
              width={300}
              trigger={(trigger) => (
                <button type="button" {...trigger} className="btn btn-dark">
                  <Icon name="download" size={17} />
                  <span className="max-lg:sr-only">{t("export.button")}</span>
                  <Icon name="chevronDown" size={14} strokeWidth={2.4} />
                </button>
              )}
            />
            {props.mode === "draft" && props.onSave && (
              <div className="flex">
                <button
                  type="button"
                  className={`btn btn-primary ${saveAs ? "rounded-r-none" : ""}`}
                  disabled={props.busy}
                  onClick={() => props.onSave?.(editor.flush, doc)}
                >
                  {props.busy && <Spinner />}
                  {t("editor.save")}
                </button>
                {saveAs && (
                  <Menu
                    label={t("editor.saveTo")}
                    entries={[
                      { heading: t("editor.saveTo") },
                      ...saveAs.targets.map((target) => ({
                        label: target.name,
                        icon: "folder" as const,
                        ...(target.isDefault ? { note: t("editor.defaultLibrary") } : {}),
                        onSelect: () => saveAs.onSaveTo(editor.flush, doc, target.id),
                      })),
                    ]}
                    width={280}
                    trigger={(trigger) => (
                      <button
                        type="button"
                        {...trigger}
                        className="btn btn-primary rounded-l-none border-l border-l-white/40 px-2"
                        disabled={props.busy}
                        aria-label={t("editor.saveAs")}
                      >
                        <Icon name="chevronDown" size={14} strokeWidth={2.4} />
                      </button>
                    )}
                  />
                )}
              </div>
            )}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">
          <StepRail
            steps={view.steps}
            numbers={numbers}
            selection={selection}
            onSelect={setSelection}
            onMove={(id, toIndex) =>
              apply((current, stamp) => moveStep(current, id, toIndex, stamp))
            }
            onDelete={(id) => remove([id])}
            stepMenu={stepMenu}
            addMenu={addMenu}
            loadThumbnail={loadThumbnail}
          />
          <input
            id="editor-image-input"
            aria-label={t("editor.menu.image")}
            type="file"
            // "image/*" is what the file dialog calls "Image files"; a list of types it calls
            // "Custom files" (30/09/2026). The types Steps takes are checked on the way in.
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void addImages(files);
            }}
          />

          {/* Dropping picture files here is a shortcut; "Add > Step from a picture" and Ctrl+V do the
            same from the keyboard. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <section
            aria-label={t("editor.selectedPanel")}
            className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-7 py-5"
            onDragOver={(event) => {
              if ([...event.dataTransfer.items].some((item) => item.kind === "file"))
                event.preventDefault();
            }}
            onDrop={(event) => {
              const files = [...event.dataTransfer.files].filter((file) =>
                /^image\/(png|jpeg|webp)$/.test(file.type),
              );
              if (files.length === 0) return;
              event.preventDefault();
              void addImages(files);
            }}
          >
            {selection.kind === "details" && (
              <DetailsPanel
                doc={doc}
                view={view}
                language={language}
                descriptionNotWritten={notWritten(null, "description")}
                onChange={(patch, label, key) =>
                  apply((current, stamp) => updateGuide(current, patch, label, stamp, key))
                }
                onDescription={(description) =>
                  apply((current, stamp) =>
                    updateGuideIn(
                      current,
                      { description },
                      language,
                      t("editor.undo.text"),
                      stamp,
                      "description",
                    ),
                  )
                }
                onLanguageTone={() => setLanguageTone(true)}
              />
            )}
            {(selection.kind === "intro" || selection.kind === "outro") && (
              <div className="flex flex-col gap-3">
                <h2 className="font-heading text-xl text-navy">
                  {selection.kind === "intro" ? t("editor.intro") : t("editor.outro")}
                </h2>
                <p className="text-sm text-secondary">
                  {selection.kind === "intro" ? t("editor.introHelp") : t("editor.outroHelp")}
                </p>
                {notWritten(null, selection.kind) && (
                  <NotWrittenYet language={language} main={main} />
                )}
                <RichTextEditor
                  key={`${selection.kind}:${language}`}
                  headings
                  label={selection.kind === "intro" ? t("editor.intro") : t("editor.outro")}
                  placeholder={
                    selection.kind === "intro"
                      ? t("editor.introPlaceholder")
                      : t("editor.outroPlaceholder")
                  }
                  value={selection.kind === "intro" ? view.guide.intro : view.guide.outro}
                  onChange={(value) =>
                    apply((current, stamp) =>
                      updateGuideIn(
                        current,
                        selection.kind === "intro" ? { intro: value } : { outro: value },
                        language,
                        t("editor.undo.text"),
                        stamp,
                        selection.kind,
                      ),
                    )
                  }
                />
              </div>
            )}
            {selected?.kind === "block" && selectedText?.block && (
              <BlockPanel
                step={selectedText}
                language={language}
                notWritten={
                  notWritten(selected.id, "heading") || notWritten(selected.id, "body")
                    ? main
                    : null
                }
                onChange={(block, key) =>
                  apply((current, stamp) =>
                    setBlockIn(
                      current,
                      selected.id,
                      block,
                      language,
                      t("editor.undo.text"),
                      stamp,
                      key ?? `block:${selected.id}`,
                    ),
                  )
                }
                onDelete={() => remove([selected.id])}
              />
            )}
            {selected?.kind === "interaction" && (
              <>
                <div className="flex items-center gap-2">
                  <span className="flex-1 text-[13px] text-secondary">
                    {t("editor.stepOf", {
                      number: numbers.get(selected.id) ?? 0,
                      count: numbers.size,
                    })}
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger h-8 px-3"
                    onClick={() => remove([selected.id])}
                  >
                    <Icon name="trash" size={15} />
                    {t("editor.deleteStep")}
                  </button>
                  <button
                    type="button"
                    className="icon-btn size-8 border border-line"
                    aria-label={t("editor.previous")}
                    disabled={selectedIndex <= 0}
                    onClick={() => {
                      const previous = doc.steps[selectedIndex - 1];
                      if (previous) setSelection({ kind: "step", id: previous.id });
                    }}
                  >
                    <Icon name="back" size={16} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn size-8 border border-line"
                    aria-label={t("editor.next")}
                    disabled={selectedIndex >= doc.steps.length - 1}
                    onClick={() => {
                      const next = doc.steps[selectedIndex + 1];
                      if (next) setSelection({ kind: "step", id: next.id });
                    }}
                  >
                    <Icon name="forward" size={16} />
                  </button>
                </div>
                {reviewReason(selected) && (
                  <div className="flex items-center gap-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
                    <p className="flex-1">{t(`editor.review.${reviewReason(selected)}`)}</p>
                    <button
                      type="button"
                      className="btn h-8 shrink-0 px-3"
                      onClick={() =>
                        apply((current, stamp) => markChecked(current, selected.id, stamp))
                      }
                    >
                      {t("editor.review.looksRight")}
                    </button>
                  </div>
                )}
                <label className="flex flex-col gap-1">
                  <span className="sr-only">{t("editor.stepText")}</span>
                  <textarea
                    rows={1}
                    lang={language}
                    value={selectedText?.actionText ?? selected.actionText}
                    placeholder={t("editor.stepTextPlaceholder")}
                    // A step's wording is one line: Enter finishes it (F033).
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                    }}
                    onChange={(event) => {
                      const text = event.currentTarget.value;
                      apply((current, stamp) =>
                        setStepTextIn(current, selected.id, text, language, stamp),
                      );
                    }}
                    className="field-sizing-content min-h-10 resize-none rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-[20px] leading-snug text-navy hover:border-panel focus:border-line"
                  />
                </label>
                {notWritten(selected.id, "actionText") && (
                  <NotWrittenYet language={language} main={main} />
                )}
                {selected.action === "input" && (
                  <div className="flex flex-wrap items-center gap-3 rounded-lg bg-subtle px-3 py-2 text-sm">
                    <TypedValueField
                      key={selected.id}
                      value={selected.textParts.value ?? ""}
                      onChange={(value) =>
                        apply((current, stamp) => setTypedValue(current, selected.id, value, stamp))
                      }
                    />
                    {selected.textParts.value !== undefined && (
                      <>
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.showValue}
                            onChange={async (event) => {
                              const show = event.currentTarget.checked;
                              // Hiding never asks: the value comes out of hand-edited wording too.
                              if (!show) {
                                const inWording = selected.textEdited && typedValueInText(selected);
                                // Wording written by hand that the value can't be found in may still
                                // hold it in another form: offer the standard wording (F028).
                                const standard =
                                  selected.textEdited && !inWording
                                    ? await askConfirm(
                                        t("editor.valueNotFoundTitle"),
                                        t("editor.valueNotFound", {
                                          value: selected.textParts.value ?? "",
                                        }),
                                        t("editor.useStandardWording"),
                                      )
                                    : false;
                                const edit = apply((current, stamp) =>
                                  setShowValue(current, selected.id, false, stamp, standard),
                                );
                                if (edit && inWording)
                                  props.notify({
                                    text: t("editor.valueTakenOut"),
                                    action: { label: t("common.undo"), run: () => editor.undo() },
                                  });
                                return;
                              }
                              const rebuild = await rebuildsWording(selected, show, () =>
                                askConfirm(
                                  t("editor.replaceEditedTitle"),
                                  t("editor.replaceEditedText"),
                                  t("editor.replaceEditedYes"),
                                ),
                              );
                              apply((current, stamp) =>
                                setShowValue(current, selected.id, show, stamp, rebuild),
                              );
                            }}
                          />
                          {t("editor.showValue")}
                        </label>
                        <button
                          type="button"
                          className="text-link underline"
                          onClick={() => {
                            const inWording = selected.textEdited && typedValueInText(selected);
                            const edit = apply((current, stamp) =>
                              removeTypedValue(current, selected.id, stamp),
                            );
                            if (edit && inWording)
                              props.notify({
                                text: t("editor.valueTakenOut"),
                                action: { label: t("common.undo"), run: () => editor.undo() },
                              });
                          }}
                        >
                          {t("editor.removeValue")}
                        </button>
                      </>
                    )}
                  </div>
                )}
                {selected.code && (
                  <CodePanel
                    key={selected.id}
                    stepId={selected.id}
                    code={selected.code}
                    notify={props.notify}
                    onChange={(patch, key) =>
                      apply((current, stamp) =>
                        setStepCode(current, selected.id, patch, t("editor.undo.code"), stamp, key),
                      )
                    }
                    onRemoveOutput={() =>
                      apply((current, stamp) =>
                        removeStepOutput(current, selected.id, t("editor.undo.output"), stamp),
                      )
                    }
                  />
                )}
                {notesOpen || selectedText?.notes ? (
                  <>
                    {notWritten(selected.id, "notes") && (
                      <NotWrittenYet language={language} main={main} />
                    )}
                    <RichTextEditor
                      key={`${selected.id}:${language}`}
                      label={t("editor.notes")}
                      placeholder={t("editor.notesPlaceholder")}
                      // An empty note is one just added: type straight into it (F030).
                      focusOnOpen={!selectedText?.notes}
                      value={selectedText?.notes ?? null}
                      onChange={(notes) =>
                        apply((current, stamp) =>
                          setStepNotesIn(current, selected.id, notes, language, stamp),
                        )
                      }
                    />
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-quiet self-start px-2 text-link"
                    onClick={() => setNotesOpen(true)}
                  >
                    <Icon name="plus" size={15} />
                    {t("editor.addNote")}
                  </button>
                )}
                <div className="card flex min-h-[320px] flex-auto shrink-0 flex-col overflow-hidden">
                  <div
                    role="toolbar"
                    aria-label={t("editor.imageTools")}
                    className="flex flex-wrap items-center gap-0.5 border-b border-panel p-1.5"
                  >
                    {TOOLS.map(({ tool: name, icon }) => (
                      <button
                        key={name}
                        type="button"
                        aria-pressed={tool === name}
                        disabled={!selected.media?.id}
                        onClick={() => setTool(name)}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] disabled:opacity-40 ${tool === name ? "bg-selected font-semibold text-link" : "text-secondary hover:bg-subtle"}`}
                      >
                        <Icon name={icon} size={15} />
                        {t(`editor.tools.${name}`)}
                      </button>
                    ))}
                    <span className="flex-1" />
                    {selected.highlight && (
                      <button
                        type="button"
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-secondary hover:bg-subtle"
                        onClick={() =>
                          apply((current, stamp) =>
                            updateStep(
                              current,
                              selected.id,
                              {
                                highlight: selected.highlight
                                  ? {
                                      ...selected.highlight,
                                      shape:
                                        selected.highlight.shape === "circle" ? "box" : "circle",
                                    }
                                  : null,
                              },
                              t("editor.undo.shape"),
                              stamp,
                            ),
                          )
                        }
                      >
                        {selected.highlight.shape === "circle"
                          ? t("editor.tools.makeBox")
                          : t("editor.tools.makeCircle")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!props.store.importImage}
                      title={props.store.importImage ? undefined : t("editor.saveFirstForImages")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-secondary hover:bg-subtle disabled:opacity-40"
                      onClick={() => document.getElementById("editor-replace-input")?.click()}
                    >
                      <Icon name="image" size={15} />
                      {t("editor.tools.replace")}
                    </button>
                    <input
                      id="editor-replace-input"
                      aria-label={t("editor.tools.replace")}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        const importImage = props.store.importImage;
                        if (!file || !importImage) return;
                        if (!isTakenImage(file)) {
                          props.notify({ kind: "error", text: t("editor.imageFailed") });
                          return;
                        }
                        // A different picture: blur areas, crop and highlight drawn for the old one
                        // no longer line up, so they go (Retake keeps them), and the person is told.
                        const cleared =
                          selected.redactions.length > 0 ||
                          selected.crop !== null ||
                          selected.highlight !== null;
                        void file
                          .arrayBuffer()
                          .then((buffer) => importImage(new Uint8Array(buffer)))
                          .then((media) =>
                            apply((current, stamp) =>
                              updateStep(
                                current,
                                selected.id,
                                {
                                  media: {
                                    id: media.id,
                                    width: media.width,
                                    height: media.height,
                                    scale: 1,
                                    captureRect: null,
                                  },
                                  highlight: null,
                                  crop: null,
                                  redactions: [],
                                  notPersonal: [],
                                },
                                t("editor.undo.replace"),
                                stamp,
                              ),
                            ),
                          )
                          .then((made) => {
                            if (made && cleared)
                              props.notify({
                                text: t("editor.replaceCleared"),
                                action: { label: t("common.undo"), run: () => editor.undo() },
                              });
                          })
                          .catch(() =>
                            props.notify({ kind: "error", text: t("editor.imageFailed") }),
                          );
                      }}
                    />
                    {props.store.retakeImage && (
                      <Retake
                        retake={props.store.retakeImage}
                        notify={props.notify}
                        onRetaken={(media) => {
                          // Marks, blur and crop stay: a retake is usually the same window, and
                          // dropping blur areas silently would be the riskier mistake.
                          apply((current, stamp) =>
                            updateStep(
                              current,
                              selected.id,
                              {
                                media: {
                                  id: media.id,
                                  width: media.width,
                                  height: media.height,
                                  scale: 1,
                                  captureRect: null,
                                },
                              },
                              t("editor.undo.retake"),
                              stamp,
                            ),
                          );
                          props.notify({ text: t("editor.retake.done") });
                        }}
                      />
                    )}
                  </div>
                  <SuggestedBlurs
                    findings={findings}
                    onBlur={(items) => {
                      setPointed(null);
                      blurFound([{ stepId: selected.id, findings: items }]);
                    }}
                    onDismiss={(items) => {
                      setPointed(null);
                      // Saved on the step, so they stay dismissed, in the export review too.
                      apply(notPersonalEdit(selected.id, items, t("editor.undo.notPersonal")));
                    }}
                    onShow={(finding) =>
                      setRevealed({ stepId: selected.id, area: { ...finding.rect } })
                    }
                    onPoint={(index) =>
                      setPointed(index === null ? null : { stepId: selected.id, index })
                    }
                  />
                  {props.sharedLibrary && selected.redactions.length > 0 && (
                    <p className="flex items-center gap-2 border-b border-panel px-3 py-2 text-[13px] text-secondary">
                      <Icon name="info" size={15} />
                      <span className="flex-1">{t("editor.sharedLibraryBlur")}</span>
                    </p>
                  )}
                  {/* Never squeezed by a long list of suggestions above it: the step's pane scrolls
                      instead, so the screenshot keeps its size (04/10/2026: with 15 suggestions it
                      shrank to a strip). */}
                  <div className="flex min-h-[50vh] flex-1 bg-subtle p-3">
                    <ImageEditor
                      key={selected.id}
                      step={selected}
                      imageUrl={
                        imageUrl && imageUrl.id === selected.media?.id ? imageUrl.url : null
                      }
                      tool={tool}
                      onToolChange={setTool}
                      suggestions={findings.map((finding) => finding.rect)}
                      activeSuggestion={pointed?.stepId === selected.id ? pointed.index : null}
                      reveal={revealed?.stepId === selected.id ? revealed.area : null}
                      onCommit={(geometry, label) =>
                        apply((current, stamp) =>
                          updateStep(current, selected.id, geometry, label, stamp),
                        )
                      }
                    />
                  </div>
                  {selected.media?.id && (
                    <div className="border-t border-panel px-3 py-2.5">
                      <AltTextField
                        key={language}
                        step={selectedText ?? selected}
                        onChange={(altText) =>
                          apply((current, stamp) =>
                            setAltTextIn(
                              current,
                              selected.id,
                              altText,
                              language,
                              t("editor.undo.altText"),
                              stamp,
                            ),
                          )
                        }
                      />
                      {notWritten(selected.id, "altText") && (
                        <NotWrittenYet language={language} main={main} />
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
          {props.sidePanel?.({
            steps: doc.steps,
            numbers,
            selectedStepId: selection.kind === "step" ? selection.id : null,
            showStep: (id) => setSelection({ kind: "step", id }),
          })}
        </div>
      </div>
    </ReadOnlyContext.Provider>
  );
}

/** Under a text not written in the language shown: what's showing instead, and what to do. */
function NotWrittenYet({ language, main }: { language: string; main: string }) {
  const { t } = useTranslation();
  return (
    <p className="rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
      {t("editor.languages.notWritten", {
        name: languageName(language),
        main: languageName(main),
      })}
    </p>
  );
}

function DetailsPanel({
  doc,
  view,
  language,
  descriptionNotWritten,
  onChange,
  onDescription,
  onLanguageTone,
}: {
  doc: EditorDoc;
  /** The guide in the language shown. */
  view: EditorDoc;
  language: string;
  descriptionNotWritten: boolean;
  onChange: (patch: Partial<EditorDoc["guide"]>, label: string, key?: string) => void;
  onDescription: (description: string) => void;
  onLanguageTone: () => void;
}) {
  const { t } = useTranslation();
  const [tag, setTag] = useState("");
  const addTag = () => {
    const value = tag.trim();
    setTag("");
    if (!value || doc.guide.tags.some((existing) => existing.toLowerCase() === value.toLowerCase()))
      return;
    onChange({ tags: [...doc.guide.tags, value] }, t("editor.undo.tags"));
  };
  return (
    <div className="flex max-w-[640px] flex-col gap-4">
      <h2 className="font-heading text-xl text-navy">{t("editor.details")}</h2>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle px-3 py-2 text-sm">
        <span className="min-w-0 flex-1 text-navy">
          {t("editor.languages.row", {
            language: languageName(mainLanguage(doc.guide)),
            tone: t(`editor.languages.tones.${toneOf(doc.guide)}`),
          })}
        </span>
        <button type="button" className="btn h-8" onClick={onLanguageTone}>
          {t("editor.languages.change")}
        </button>
      </div>
      <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
        {t("editor.description")}
        <textarea
          rows={3}
          lang={language}
          value={view.guide.description}
          placeholder={t("editor.descriptionPlaceholder")}
          onChange={(event) => onDescription(event.currentTarget.value)}
          className="field h-auto py-2 font-normal"
        />
      </label>
      {descriptionNotWritten && (
        <NotWrittenYet language={language} main={mainLanguage(doc.guide)} />
      )}
      <div className="flex flex-col gap-1.5">
        <span id="tags-label" className="text-sm font-semibold text-navy">
          {t("editor.tags")}
        </span>
        <div
          role="group"
          className="flex flex-wrap items-center gap-1.5"
          aria-labelledby="tags-label"
        >
          {doc.guide.tags.map((name) => (
            <span
              key={name}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-subtle pr-1 pl-3 text-sm"
            >
              {name}
              <button
                type="button"
                className="inline-flex size-6 items-center justify-center rounded-full hover:bg-panel"
                aria-label={t("editor.removeTag", { name })}
                onClick={() =>
                  onChange(
                    { tags: doc.guide.tags.filter((existing) => existing !== name) },
                    t("editor.undo.tags"),
                  )
                }
              >
                <Icon name="close" size={12} strokeWidth={2.6} />
              </button>
            </span>
          ))}
          <input
            value={tag}
            aria-label={t("editor.addTag")}
            placeholder={t("editor.addTag")}
            onChange={(event) => setTag(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            className="field h-8 w-40"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
          {t("editor.owner")}
          <input
            value={doc.guide.owner}
            onChange={(event) =>
              onChange({ owner: event.currentTarget.value }, t("editor.undo.text"), "owner")
            }
            className="field font-normal"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
          {t("editor.reviewBy")}
          <DateField
            value={doc.guide.reviewBy ?? null}
            onChange={(reviewBy) => onChange({ reviewBy }, t("editor.undo.reviewBy"))}
          />
          <span className="text-xs font-normal text-secondary">{t("editor.reviewByHelp")}</span>
        </label>
      </div>
    </div>
  );
}

/** A coloured-box block's bar and fill in the editor, as exports draw it. */
const BLOCK_LOOK = {
  note: "border-callout-note bg-callout-note-soft",
  tip: "border-callout-tip bg-callout-tip-soft",
  warning: "border-callout-warning bg-callout-warning-soft",
  important: "border-callout-important bg-callout-important-soft",
} as const;

function BlockPanel({
  step,
  language,
  notWritten,
  onChange,
  onDelete,
}: {
  /** The block in the language shown. */
  step: GuideStep;
  language: string;
  /** The main language, when the block isn't written in the one shown yet. */
  notWritten: string | null;
  onChange: (block: Block, coalesceKey?: string) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  // A block with no heading yet is one just added: type straight into it (F030).
  const headingRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headingRef.current && !headingRef.current.value) headingRef.current.focus();
  }, [step.id]);
  const block = step.block;
  if (!block) return null;
  const callout = calloutOfBlock(block.type);
  return (
    <div
      className={`flex max-w-[720px] flex-col gap-3 ${callout ? `rounded-lg border-l-[6px] p-3 ${BLOCK_LOOK[callout]}` : ""}`}
    >
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm font-semibold text-navy">
          {t("editor.blockType")}
          <select
            value={block.type}
            onChange={(event) =>
              onChange({ ...block, type: event.currentTarget.value as Block["type"] })
            }
            className="field"
          >
            {BLOCK_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`editor.block.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <button type="button" className="btn btn-danger h-8 px-3" onClick={onDelete}>
          <Icon name="trash" size={15} />
          {t("editor.deleteBlock")}
        </button>
      </div>
      {notWritten && <NotWrittenYet language={language} main={notWritten} />}
      <input
        ref={headingRef}
        value={block.heading}
        lang={language}
        aria-label={t("editor.blockHeading")}
        placeholder={t("editor.blockHeading")}
        onChange={(event) =>
          onChange({ ...block, heading: event.currentTarget.value }, `heading:${step.id}`)
        }
        className="field h-10 text-base font-semibold"
      />
      {block.type !== "header" && (
        <RichTextEditor
          key={`${step.id}:${language}`}
          label={t("editor.blockBody")}
          placeholder={t("editor.blockBodyPlaceholder")}
          value={block.body}
          onChange={(body) => onChange({ ...block, body }, `body:${step.id}`)}
        />
      )}
    </div>
  );
}
