import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import type { EditorDoc } from "../editor/document";
import { GuideEditor, type GuideEditorProps } from "../editor/GuideEditor";
import { errorMessage } from "../errors";
import type {
  CommentThread,
  ConflictChoice,
  DraftInfo,
  EditLock,
  GuideConflict,
  LibraryBridge,
  LibraryGuideSummary,
  ReviewComment,
} from "../library-bridge";
import { formatDateTime, formatTime } from "../library/dates";
import { useLatest } from "../useLatest";
import { CommentsPanel } from "./CommentsPanel";
import { TakeOverDialog } from "./dialogs";
import { toDoc } from "./documents";
import { useFingerprintWatch } from "./useLibraryWatch";

/** How often a read-only guide asks whether the other person is done. */
const CHECK_EVERY_MS = 30_000;
/** A refused edit says why at most this often, not on every key. */
const REFUSED_NOTICE_MS = 4_000;

type LockState = { kind: "checking" } | { kind: "editing" } | { kind: "readOnly"; lock: EditLock };

/** A step's wording and who last changed it, from a step file as saved. */
const stepOf = (value: unknown) => {
  const step = (value ?? {}) as { actionText?: unknown; updatedBy?: unknown };
  return {
    text: typeof step.actionText === "string" ? step.actionText : "",
    by: typeof step.updatedBy === "string" ? step.updatedBy : "",
  };
};
const guideOf = (value: unknown) => {
  const guide = (value ?? {}) as { title?: unknown; updatedBy?: unknown };
  return {
    title: typeof guide.title === "string" ? guide.title : "",
    by: typeof guide.updatedBy === "string" ? guide.updatedBy : "",
  };
};
const conflictKey = (conflict: GuideConflict) =>
  conflict.kind === "restored" ? conflict.id : conflict.file;

export interface LibraryGuideEditorProps extends Omit<
  GuideEditorProps,
  "initial" | "readOnly" | "banner" | "onRefused" | "onLockLost" | "headerActions" | "sidePanel"
> {
  library: LibraryBridge;
  libraryId: string;
  initial: EditorDoc;
  /** Opens another guide (a draft opened as a copy). */
  onOpenGuide: (summary: LibraryGuideSummary) => void;
}

/**
 * A guide from a library, with its edit lock (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive).
 * Opening takes the lock, or shows the guide read-only with who is editing and Take over editing;
 * a read-only guide keeps showing the other person's changes as they sync, and becomes editable
 * when they're done. If someone takes over, unsaved changes are kept as a draft on the guide, and
 * drafts are offered to whoever opens it: nothing disappears silently.
 */
export function LibraryGuideEditor(props: LibraryGuideEditorProps) {
  const { t } = useTranslation();
  const { library, libraryId, notify } = props;
  const guideId = props.initial.guide.id;
  const [doc, setDoc] = useState(props.initial);
  /** Remounts the editor on a fresh copy from disk (taking over, the other person's changes). */
  const [generation, setGeneration] = useState(0);
  const [lock, setLock] = useState<LockState>({ kind: "checking" });
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [conflicts, setConflicts] = useState<GuideConflict[]>([]);
  const [comments, setComments] = useState<CommentThread[]>([]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const commentsButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const lastRefused = useRef(0);
  const notifyRef = useLatest(notify);
  const holding = useRef(false);

  const reload = useCallback(async () => {
    const next = toDoc(await library.loadGuide(libraryId, guideId));
    setDoc(next);
    setGeneration((current) => current + 1);
  }, [library, libraryId, guideId]);

  const refreshConflicts = useCallback(async () => {
    setConflicts(await library.listConflicts(libraryId, guideId).catch(() => []));
  }, [library, libraryId, guideId]);

  const refreshComments = useCallback(async () => {
    setComments(await library.listComments(libraryId, guideId).catch(() => []));
  }, [library, libraryId, guideId]);

  const refreshDrafts = useCallback(async () => {
    setDrafts(await library.listDrafts(libraryId, guideId).catch(() => []));
  }, [library, libraryId, guideId]);

  const open = useCallback(
    async (takeOver: boolean) => {
      const editing = await library.openForEditing(libraryId, guideId, takeOver);
      holding.current = editing.kind === "editing";
      setLock(editing);
      return editing;
    },
    [library, libraryId, guideId],
  );

  // Open: take the lock or learn who has it; let go of it when the editor closes.
  useEffect(() => {
    let live = true;
    library
      .openForEditing(libraryId, guideId, false)
      .then(async (editing) => {
        holding.current = editing.kind === "editing";
        if (!live) return;
        setLock(editing);
        // Read-only from the copy on disk: the one opened a moment ago may be behind theirs.
        if (editing.kind === "readOnly") await reload();
      })
      .catch((problem: unknown) => {
        // A library that can't say (an older folder, a drive gone) is edited as before.
        holding.current = false;
        if (live) setLock({ kind: "editing" });
        console.error(problem);
      });
    library
      .listDrafts(libraryId, guideId)
      .then((found) => live && setDrafts(found))
      .catch(() => undefined);
    library
      .listConflicts(libraryId, guideId)
      .then((found) => live && setConflicts(found))
      .catch(() => undefined);
    library
      .listComments(libraryId, guideId)
      .then((found) => live && setComments(found))
      .catch(() => undefined);
    return () => {
      live = false;
      if (holding.current) void library.releaseLock(libraryId, guideId).catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per guide opened
  }, [libraryId, guideId]);

  // Read-only: follow their changes, and become editable when they're done.
  useEffect(() => {
    if (lock.kind !== "readOnly") return undefined;
    const timer = window.setInterval(() => {
      void open(false)
        .then((editing) => (editing.kind === "editing" ? reload() : undefined))
        .catch(() => undefined);
    }, CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [lock.kind, open, reload]);

  // Any synced change: conflicts, drafts and comments are looked for again, and a read-only guide
  // shows it.
  useFingerprintWatch(
    () => library.guideFingerprint(libraryId, guideId),
    lock.kind !== "checking",
    () => {
      void refreshConflicts();
      void refreshDrafts();
      void refreshComments();
      if (lock.kind === "readOnly") void reload().catch(() => undefined);
    },
  );

  // Someone took over while this app was editing.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let live = true;
    void library
      .onLockLost((lost) => {
        if (lost.libraryId !== libraryId || lost.guideId !== guideId) return;
        holding.current = false;
        setLock({ kind: "readOnly", lock: lost.lock });
        notifyRef.current({ text: t("editor.lock.lost", { name: lost.lock.name }) });
        // Remounting writes anything waiting; refused, it becomes a draft (onLockLost below).
        void reload().catch(() => undefined);
      })
      .then((unlisten) => {
        if (live) stop = unlisten;
        else unlisten();
      });
    return () => {
      live = false;
      stop?.();
    };
  }, [library, libraryId, guideId, reload, notifyRef, t]);

  /** A save was refused: keep the unsaved guide as a draft, then show theirs read-only. */
  const keepAsDraft = useCallback(
    (unsaved: EditorDoc) => {
      holding.current = false;
      void library
        .saveDraft(libraryId, guideId, { guide: unsaved.guide, steps: unsaved.steps })
        .then(() => {
          notifyRef.current({ text: t("editor.lock.keptAsDraft") });
          void refreshDrafts();
        })
        .catch((problem: unknown) =>
          notifyRef.current({
            kind: "error",
            text: errorMessage(problem, t("editor.lock.draftFailed")),
          }),
        );
      void open(false)
        .then(() => reload())
        .catch(() => undefined);
    },
    [library, libraryId, guideId, notifyRef, t, refreshDrafts, open, reload],
  );

  const takeOver = async () => {
    setConfirming(false);
    try {
      const editing = await open(true);
      if (editing.kind === "editing") await reload();
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("editor.lock.takeOverFailed")) });
    }
  };

  const openDraft = async (draft: DraftInfo) => {
    try {
      const copy = await library.draftToCopy(
        libraryId,
        guideId,
        draft.id,
        t("editor.drafts.copyTitle", { title: doc.guide.title, name: draft.by }),
      );
      await refreshDrafts();
      props.onOpenGuide(copy);
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("editor.drafts.failed")) });
    }
  };

  const discardDraft = async (draft: DraftInfo) => {
    await library.discardDraft(libraryId, guideId, draft.id).catch(() => undefined);
    await refreshDrafts();
  };

  const resolve = async (conflict: GuideConflict, choice: ConflictChoice) => {
    try {
      await library.resolveConflict(libraryId, guideId, conflictKey(conflict), choice);
      await refreshConflicts();
      await reload();
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("editor.conflicts.failed")) });
    }
  };

  const conflictBanner = (conflict: GuideConflict) => {
    const choices: { choice: ConflictChoice; label: string }[] = [];
    let message: string;
    if (conflict.kind === "step") {
      const ours = stepOf(conflict.ours);
      const theirs = stepOf(conflict.theirs);
      message = t("editor.conflicts.step", { from: conflict.from });
      choices.push(
        { choice: "keepOurs", label: t("editor.conflicts.keep", ours) },
        { choice: "keepTheirs", label: t("editor.conflicts.keep", theirs) },
        { choice: "keepBoth", label: t("editor.conflicts.keepBoth") },
      );
    } else if (conflict.kind === "guide") {
      const ours = guideOf(conflict.ours);
      const theirs = guideOf(conflict.theirs);
      message = t("editor.conflicts.guide", { from: conflict.from });
      choices.push(
        {
          choice: "keepOurs",
          label: t("editor.conflicts.keep", { text: ours.title, by: ours.by }),
        },
        {
          choice: "keepTheirs",
          label: t("editor.conflicts.keep", { text: theirs.title, by: theirs.by }),
        },
      );
    } else {
      const step = stepOf(conflict.step);
      message = t("editor.conflicts.restored", {
        deletedBy: conflict.deletedBy,
        text: step.text,
        editedBy: step.by,
      });
      choices.push(
        { choice: "keepTheirs", label: t("editor.conflicts.keepIt") },
        { choice: "keepOurs", label: t("editor.conflicts.deleteIt") },
      );
    }
    return (
      <div
        key={conflictKey(conflict)}
        role="status"
        className="flex flex-wrap items-center gap-3 border-b border-panel bg-callout-important-soft px-5 py-2.5 text-sm text-callout-important-ink"
      >
        <Icon name="warning" size={16} />
        <span className="min-w-0 flex-1">{message}</span>
        {choices.map(({ choice, label }) => (
          <button
            key={choice}
            type="button"
            className="btn max-w-72 truncate"
            title={label}
            onClick={() => void resolve(conflict, choice)}
          >
            {label}
          </button>
        ))}
      </div>
    );
  };

  const addComment = async (stepId: string | null, replyTo: string | null, text: string) => {
    try {
      await library.addComment(libraryId, guideId, stepId, replyTo, text);
      await refreshComments();
      return true;
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("comments.failed")) });
      return false;
    }
  };

  const closeComments = () => {
    setCommentsOpen(false);
    commentsButtonRef.current?.focus();
  };

  const changeComments = async (change: () => Promise<void>) => {
    try {
      await change();
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("comments.failed")) });
    }
    await refreshComments();
  };

  const openComments = comments.filter((thread) => !thread.resolved).length;
  const commentsButton = (
    <button
      ref={commentsButtonRef}
      type="button"
      className="btn"
      aria-pressed={commentsOpen}
      onClick={() => setCommentsOpen((open) => !open)}
    >
      <Icon name="comment" size={16} />
      <span className="max-lg:sr-only">{t("comments.button")}</span>
      {openComments > 0 && (
        <span className="chip bg-selected font-semibold text-link">
          <span className="sr-only">{t("comments.openCount", { count: openComments })}</span>
          <span aria-hidden="true">{openComments}</span>
        </span>
      )}
    </button>
  );

  const readOnly = lock.kind === "readOnly";
  const banner = (
    <>
      {lock.kind === "readOnly" && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-panel bg-callout-note-soft px-5 py-2.5 text-sm text-callout-note-ink"
        >
          <Icon name="lock" size={16} />
          <span className="flex-1">
            {t("editor.lock.readOnly", { name: lock.lock.name, time: formatTime(lock.lock.since) })}
          </span>
          <button type="button" className="btn" onClick={() => setConfirming(true)}>
            {t("editor.lock.takeOver")}
          </button>
        </div>
      )}
      {conflicts.map(conflictBanner)}
      {drafts.map((draft) => (
        <div
          key={draft.id}
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-panel bg-callout-warning-soft px-5 py-2.5 text-sm text-callout-warning-ink"
        >
          <Icon name="history" size={16} />
          <span className="flex-1">
            {t("editor.drafts.banner", {
              name: draft.by,
              when: formatDateTime(draft.at),
              count: draft.stepCount,
            })}
          </span>
          <button type="button" className="btn" onClick={() => void openDraft(draft)}>
            {t("editor.drafts.open")}
          </button>
          <button type="button" className="btn" onClick={() => void discardDraft(draft)}>
            {t("editor.drafts.discard")}
          </button>
        </div>
      ))}
    </>
  );

  return (
    <>
      <GuideEditor
        {...props}
        key={generation}
        initial={doc}
        readOnly={readOnly}
        banner={banner}
        headerActions={commentsButton}
        sidePanel={
          commentsOpen
            ? (view) => (
                <CommentsPanel
                  threads={comments}
                  view={view}
                  onAdd={addComment}
                  onResolve={(thread, resolved) =>
                    changeComments(() =>
                      library.resolveComment(libraryId, guideId, thread.id, resolved),
                    )
                  }
                  onDelete={(comment: ReviewComment) =>
                    changeComments(() => library.deleteComment(libraryId, guideId, comment.id))
                  }
                  onClose={closeComments}
                />
              )
            : undefined
        }
        onRefused={() => {
          if (lock.kind !== "readOnly" || Date.now() - lastRefused.current < REFUSED_NOTICE_MS)
            return;
          lastRefused.current = Date.now();
          notify({ text: t("editor.lock.refused", { name: lock.lock.name }) });
        }}
        onLockLost={keepAsDraft}
      />
      {confirming && lock.kind === "readOnly" && (
        <TakeOverDialog
          name={lock.lock.name}
          onCancel={() => setConfirming(false)}
          onTakeOver={() => void takeOver()}
        />
      )}
    </>
  );
}

/** The guide editor for either kind of guide: a library guide with its lock, or a recording's draft. */
export function AnyGuideEditor({
  library,
  libraryId,
  onOpenGuide,
  ...props
}: GuideEditorProps & {
  library: LibraryBridge | undefined;
  libraryId: string | undefined;
  onOpenGuide: (summary: LibraryGuideSummary) => void;
}) {
  return library && libraryId ? (
    <LibraryGuideEditor
      {...props}
      library={library}
      libraryId={libraryId}
      onOpenGuide={onOpenGuide}
    />
  ) : (
    <GuideEditor {...props} />
  );
}
