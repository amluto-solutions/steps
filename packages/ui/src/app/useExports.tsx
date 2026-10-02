import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BrandProfile } from "@amluto-steps/core";

import type { MenuEntry } from "../components/Menu";
import type { ToastMessage } from "../components/Toast";
import type { Edit, EditorDoc, History } from "../editor/document";
import { applyChanges, emptyHistory, invertChanges, recordEdit } from "../editor/document";
import type { Stamp } from "../editor/edits";
import type { EditorHooks } from "../editor/useGuideEditor";
import { errorMessage } from "../errors";
import { ExportDialog, type ExportFormat } from "../export/ExportDialog";
import type { LibraryBridge } from "../library-bridge";
import { formatDate } from "../library/dates";
import type { RecorderBridge } from "../recorder-bridge";
import { toDoc, type GuideRef } from "./documents";
import { draftStore, libraryStore } from "./stores";

/** The open editor's way of making an edit (undoable, saved like any other). */
export type EditorApply = (make: (doc: EditorDoc, stamp: Stamp) => Edit | null) => Edit | null;

/** What is being exported: a guide in a library, or an unsaved recording. */
export type ExportSource =
  | ({ kind: "guide"; title: string } & GuideRef)
  | { kind: "draft"; sessionId: string; title: string };

/**
 * Exporting (docs/spec/05-export.md): the "Export as" menu, the review dialog it opens, and the
 * automatic version each export saves.
 */
export function useExports(context: {
  recorder: RecorderBridge | undefined;
  library: LibraryBridge | undefined;
  notify: (message: Omit<ToastMessage, "id">) => void;
  run: (action: () => Promise<unknown>, done?: string) => Promise<void>;
  author: string;
  brands: BrandProfile[];
  blurTerms: string[];
  /** Saves an unsaved recording to the library, quietly; true once saved. */
  saveDraft?: (sessionId: string, flush: () => Promise<void>, doc: EditorDoc) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const { recorder, library, notify, run, author, brands, blurTerms, saveDraft } = context;
  const [exporting, setExporting] = useState<{
    format: ExportFormat;
    source: ExportSource;
    doc: EditorDoc;
    /** Writes the editor's pending edits, for exports read back from disk (.amlsteps). */
    flush: () => Promise<void>;
    /** The open editor, when exporting from it. */
    editor?: EditorHooks | undefined;
  } | null>(null);
  const [firstExport, setFirstExport] = useState(true);
  /**
   * Export… for several guides (01/10/2026): each gets its own review, one after another,
   * so none leaves the PC unchecked. Closing a review without exporting stops the rest.
   */
  const [queue, setQueue] = useState<{
    format: ExportFormat;
    sources: ExportSource[];
    index: number;
  } | null>(null);
  /** Whether the review now open has exported, so closing it moves on to the next. */
  const exportedThis = useRef(false);
  /**
   * The changes made in this review, for its Undo and Redo (30/09/2026). Recorded by the
   * editor's own rule, so quick typing joins into one step here exactly as it does there.
   */
  const [review, setReview] = useState<History>(emptyHistory);

  const openExport = async (
    format: ExportFormat,
    source: ExportSource,
    known?: EditorDoc,
    flush: () => Promise<void> = () => Promise.resolve(),
    editor?: EditorHooks,
  ) => {
    if (!library && source.kind === "guide") return;
    try {
      const doc =
        known ??
        (source.kind === "guide" && library
          ? toDoc(await library.loadGuide(source.libraryId, source.guideId))
          : null);
      if (!doc) return;
      setReview(emptyHistory());
      setExporting({ format, source, doc, flush, editor });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) });
    }
  };

  const exportMenu = (
    source: ExportSource,
    doc?: EditorDoc,
    flush?: () => Promise<void>,
    editor?: EditorHooks,
  ): MenuEntry[] => [
    { heading: t("export.as") },
    {
      label: t("export.pdf"),
      note: t("export.pdfNote"),
      leading: <span className="badge-file">{t("export.badges.pdf")}</span>,
      onSelect: () => void openExport("pdf", source, doc, flush, editor),
    },
    {
      label: t("export.word"),
      note: t("export.wordNote"),
      leading: <span className="badge-file">{t("export.badges.docx")}</span>,
      onSelect: () => void openExport("docx", source, doc, flush, editor),
    },
    {
      label: t("export.copy"),
      note: t("export.copyNote"),
      leading: <span className="badge-file">{t("export.badges.copy")}</span>,
      onSelect: () => void openExport("copy", source, doc, flush, editor),
    },
    {
      label: t("export.web"),
      note: t("export.webNote"),
      leading: <span className="badge-file">{t("export.badges.html")}</span>,
      onSelect: () => void openExport("html", source, doc, flush, editor),
    },
    {
      label: t("export.amlsteps.label"),
      note: source.kind === "guide" ? t("export.amlsteps.note") : t("export.saveFirst"),
      disabled: source.kind !== "guide" || !library,
      leading: <span className="badge-file badge-file-dark">{t("export.badges.amlsteps")}</span>,
      onSelect: () => void openExport("amlsteps", source, doc, flush, editor),
    },
  ];

  /** Several guides, each reviewed in turn. */
  const exportMany = (format: ExportFormat, sources: ExportSource[]) => {
    const [first] = sources;
    if (!first) return;
    exportedThis.current = false;
    setQueue(sources.length > 1 ? { format, sources, index: 0 } : null);
    void openExport(format, first);
  };

  /** The formats Export… offers for several guides: each a file, so not the clipboard. */
  const exportManyMenu = (sources: ExportSource[]): MenuEntry[] => [
    { heading: t("export.as") },
    ...(
      [
        ["pdf", "export.pdf", "export.badges.pdf"],
        ["docx", "export.word", "export.badges.docx"],
        ["html", "export.web", "export.badges.html"],
        ["amlsteps", "export.amlsteps.label", "export.badges.amlsteps"],
      ] as const
    ).map(([format, label, badge]) => ({
      label: t(label),
      note: t("export.eachReviewed", { count: sources.length }),
      leading: (
        <span className={`badge-file ${format === "amlsteps" ? "badge-file-dark" : ""}`}>
          {t(badge)}
        </span>
      ),
      onSelect: () => exportMany(format, sources),
    })),
  ];

  /** The review closed: on to the next guide if this one was exported, else stop. */
  const closeReview = () => {
    const next = queue && exportedThis.current ? queue.index + 1 : null;
    exportedThis.current = false;
    const following = next !== null ? queue?.sources[next] : undefined;
    if (queue && next !== null && following) {
      setQueue({ ...queue, index: next });
      void openExport(queue.format, following);
      return;
    }
    setQueue(null);
    setExporting(null);
  };

  /**
   * After an export: the file's location goes on the clipboard, an unsaved recording is saved to the
   * library (so exporting is all it takes), and a saved guide gets an automatic version
   * (docs/spec/05-export.md#after-export, docs/spec/04-editor.md#undo-and-versions).
   */
  const exported = async (
    format: ExportFormat,
    exportedFrom: NonNullable<typeof exporting>,
    message: string,
    path: string | null,
  ) => {
    const { source } = exportedFrom;
    setFirstExport(false);
    const parts = [message];
    if (path) {
      const copied = await navigator.clipboard
        ?.writeText(path)
        .then(() => true)
        .catch(() => false);
      if (copied) parts.push(t("export.pathCopied"));
    }
    if (source.kind === "draft" && saveDraft) {
      if (await saveDraft(source.sessionId, exportedFrom.flush, exportedFrom.doc))
        parts.push(t("export.draftSaved"));
    }
    const text = parts.join(" ");
    notify(
      path && recorder
        ? {
            text,
            action: {
              label: t("export.open"),
              run: () => void recorder.showExport(path, false).catch(() => undefined),
            },
            secondAction: {
              label: t("export.openLocation"),
              run: () => void recorder.showExport(path, true).catch(() => undefined),
            },
          }
        : { text },
    );
    if (source.kind === "guide" && library && format !== "copy") {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      void library
        .saveVersion(
          source.libraryId,
          source.guideId,
          t("versions.exported", {
            format: t(`export.formats.${format}`),
            date: formatDate(now),
            time,
          }),
        )
        .catch(() => undefined);
    }
  };

  /** Saves the steps a set of changes leaves, for a review opened from the library. */
  const saveSteps = (current: NonNullable<typeof exporting>, changes: Edit["changes"]) => {
    const source = current.source;
    if (source.kind !== "guide" || !library) return;
    void run(async () => {
      for (const change of changes)
        if (change.kind === "step" && change.after)
          await library.saveStep(source.libraryId, source.guideId, change.after);
    });
  };

  /**
   * Undo or Redo in the review: the editor's own when it's open (the review's changes are its
   * latest edits, since the review is on top of it), otherwise the steps are saved back.
   */
  const step = (direction: "undo" | "redo") => {
    const current = exporting;
    const edit = direction === "undo" ? review.past.at(-1) : review.future.at(-1);
    if (!current || !edit) return;
    if (current.editor) {
      if (direction === "undo") current.editor.undo();
      else current.editor.redo();
    } else {
      saveSteps(current, direction === "undo" ? invertChanges(edit.changes) : edit.changes);
    }
    setExporting({
      ...current,
      doc: applyChanges(current.doc, edit.changes, direction === "undo" ? "undo" : "do"),
    });
    setReview(
      direction === "undo"
        ? { past: review.past.slice(0, -1), future: [...review.future, edit] }
        : { past: [...review.past, edit], future: review.future.slice(0, -1) },
    );
  };

  const dialog =
    exporting && recorder && library ? (
      <ExportDialog
        // A fresh review for each guide when several are exported in turn.
        key={`${exporting.doc.guide.id}:${queue?.index ?? 0}`}
        format={exporting.format}
        doc={exporting.doc}
        preparedBy={author}
        recorder={recorder}
        firstExport={firstExport}
        brands={brands}
        blurTerms={blurTerms}
        pickSaveLocation={(title, name, filters) => library.pickSaveLocation(title, name, filters)}
        loadImage={(mediaId) =>
          (exporting.source.kind === "guide"
            ? libraryStore(library, exporting.source)
            : draftStore(recorder, exporting.source.sessionId)
          ).loadImage(mediaId, false)
        }
        onClose={closeReview}
        progress={
          queue
            ? {
                index: queue.index + 1,
                total: queue.sources.length,
                title: exporting.doc.guide.title,
              }
            : undefined
        }
        onShowStep={
          exporting.editor
            ? (stepId) => {
                setExporting(null);
                exporting.editor?.showStep(stepId);
              }
            : undefined
        }
        undo={review.past.length ? () => step("undo") : undefined}
        redo={review.future.length ? () => step("redo") : undefined}
        listVersions={
          exporting.source.kind === "guide"
            ? () => {
                const source = exporting.source;
                return source.kind === "guide"
                  ? library.listVersions(source.libraryId, source.guideId)
                  : Promise.resolve([]);
              }
            : undefined
        }
        saveAmlsteps={
          exporting.source.kind === "guide"
            ? async (path, includeOriginals) => {
                const source = exporting.source;
                if (source.kind !== "guide") return;
                // The file is built from the saved guide, so pending edits go to disk first.
                await exporting.flush();
                await library.exportAmlsteps(
                  source.libraryId,
                  source.guideId,
                  path,
                  includeOriginals,
                );
              }
            : undefined
        }
        edit={(make) => {
          const current = exporting;
          // From the editor: its own edit, so Undo and saving work as usual. From the library:
          // the changed steps are saved straight away.
          const made = current.editor
            ? current.editor.apply(make)
            : make(current.doc, { at: Date.now(), by: author });
          if (!made) return;
          if (!current.editor) saveSteps(current, made.changes);
          setExporting({ ...current, doc: applyChanges(current.doc, made.changes, "do") });
          setReview((history) => recordEdit(history, made));
        }}
        onExported={(format, message, path) => {
          exportedThis.current = true;
          void exported(format, exporting, message, path);
        }}
      />
    ) : null;

  return { exportMenu, exportManyMenu, dialog };
}
