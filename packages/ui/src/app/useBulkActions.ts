import { useTranslation } from "react-i18next";

import { moveGuide } from "./move";
import type { ToastMessage } from "../components/Toast";
import { errorMessage } from "../errors";
import type {
  LibraryBridge,
  LibraryGuideSummary,
  LibraryInfo,
  TrashEntry,
} from "../library-bridge";
import { mergeGuides, mergeId } from "../library/merge";
import type { MergeRequest } from "../library/MergeDialog";
import { toDoc } from "./documents";
import type { GuideLocks } from "../library/guide-locks";
import { askCount, showLockedList } from "../library/LockDialogs";

/** What happened to each guide in a batch. */
interface Outcome<T> {
  done: { guide: LibraryGuideSummary; result: T }[];
  /** Someone else is editing it, so it was left alone. */
  editing: { guide: LibraryGuideSummary; name: string }[];
  /** Locked with a password (04/10/2026): offered afterwards, one password at a time. */
  locked: LibraryGuideSummary[];
  failed: { guide: LibraryGuideSummary; problem: unknown }[];
}

/**
 * Several guides at once, from the library's selection bar (01/10/2026): Move to, Copy to
 * and Move to Bin. Each guide is tried on its own, so one that can't go doesn't stop the rest;
 * guides someone else is editing are left alone and named; one Undo reverses the whole batch
 * (docs/spec/04-editor.md#several-guides-at-once).
 */
export function useBulkActions(context: {
  library: LibraryBridge | undefined;
  libraryId: string | null;
  libraries: LibraryInfo[];
  refreshGuides: (libraryId: string | null) => Promise<void>;
  notify: (message: Omit<ToastMessage, "id">) => void;
  setBusy: (busy: boolean) => void;
  author: string;
  /** Opens a guide in the editor (Merge's Open). */
  openGuide: (libraryId: string, guideId: string) => void;
  /** Password locks: a locked guide is left for the list of locked guides. */
  locks: GuideLocks | null;
}) {
  const { t } = useTranslation();
  const { library, libraryId, libraries, refreshGuides, notify, setBusy, author, openGuide } =
    context;
  const { locks } = context;

  /** Runs `action` on each guide, skipping any someone else is editing when `needsLock`. */
  const each = async <T>(
    from: string,
    guides: LibraryGuideSummary[],
    needsLock: boolean,
    action: (guide: LibraryGuideSummary) => Promise<T>,
  ): Promise<Outcome<T>> => {
    const outcome: Outcome<T> = { done: [], editing: [], locked: [], failed: [] };
    if (!library) return outcome;
    for (const guide of guides) {
      try {
        if (needsLock && guide.locked && !locks?.isOpen(from, guide.id)) {
          outcome.locked.push(guide);
          continue;
        }
        if (needsLock) {
          // Asked first, so the person editing it can be named; the lock is let go at once,
          // and the command checks again as it runs.
          const editing = await library.openForEditing(from, guide.id, false);
          if (editing.kind === "readOnly") {
            outcome.editing.push({ guide, name: editing.lock.name });
            continue;
          }
          await library.releaseLock(from, guide.id).catch(() => undefined);
        }
        outcome.done.push({ guide, result: await action(guide) });
      } catch (problem) {
        outcome.failed.push({ guide, problem });
      }
    }
    return outcome;
  };

  /** The toast after a batch: what was done, what was left and why, and Undo. */
  const report = <T>(outcome: Outcome<T>, doneText: string, undo: (() => Promise<void>) | null) => {
    const parts = outcome.done.length ? [doneText] : [];
    for (const { guide, name } of outcome.editing)
      parts.push(t("library.bulk.editing", { title: guide.title, name }));
    if (outcome.locked.length) parts.push(t("locks.bulkLocked", { count: outcome.locked.length }));
    for (const { guide, problem } of outcome.failed)
      parts.push(
        t("library.bulk.failed", {
          title: guide.title,
          reason: errorMessage(problem, t("library.actionFailed")),
        }),
      );
    const left = outcome.editing.length + outcome.failed.length;
    notify({
      text: parts.join(" "),
      ...(left > 0 ? { kind: "error" as const } : {}),
      ...(undo && outcome.done.length
        ? {
            action: {
              label: t("common.undo"),
              run: () => {
                setBusy(true);
                void undo()
                  .catch((problem: unknown) =>
                    notify({
                      kind: "error",
                      text: errorMessage(problem, t("library.actionFailed")),
                    }),
                  )
                  .finally(() => {
                    setBusy(false);
                  });
              },
            },
          }
        : {}),
    });
  };

  const nameOf = (id: string) => libraries.find((item) => item.id === id)?.name ?? "";

  /** The locked guides a batch left, each done once its password is given. */
  const offerLocked = async (
    from: string,
    locked: LibraryGuideSummary[],
    body: string,
    act: (guide: LibraryGuideSummary) => Promise<unknown>,
  ) => {
    await showLockedList(
      locked.flatMap((guide) =>
        guide.locked
          ? [{ libraryId: from, guideId: guide.id, title: guide.title, locked: guide.locked }]
          : [],
      ),
      body,
      async (target) => {
        const guide = locked.find((item) => item.id === target.guideId);
        if (guide) await act(guide);
      },
    );
    await refreshGuides(from);
  };

  /** Puts a guide made by a batch in the Bin and deletes it for good: Undo of a copy. */
  const unmake = async (where: string, guideId: string) => {
    if (!library) return;
    const entry = await library.trashGuide(where, guideId);
    await library.deleteTrashed(where, entry.trashId);
  };

  const move = async (guides: LibraryGuideSummary[], to: string) => {
    if (!library || !libraryId) return;
    const from = libraryId;
    setBusy(true);
    let outcome: Outcome<LibraryGuideSummary> | null = null;
    try {
      outcome = await each(from, guides, true, (guide) => moveGuide(library, from, guide.id, to));
      const moved = outcome;
      await refreshGuides(from);
      report(
        moved,
        t("library.bulk.moved", { count: moved.done.length, name: nameOf(to) }),
        async () => {
          // Each guide moves back where it was.
          for (const { result } of moved.done) await moveGuide(library, to, result.id, from);
          await refreshGuides(from);
        },
      );
    } finally {
      setBusy(false);
    }
    if (outcome?.locked.length)
      await offerLocked(
        from,
        outcome.locked,
        t("locks.listBodyMove", { name: nameOf(to) }),
        (guide) => moveGuide(library, from, guide.id, to),
      );
  };

  const copy = async (guides: LibraryGuideSummary[], to: string) => {
    if (!library || !libraryId) return;
    const from = libraryId;
    setBusy(true);
    try {
      const outcome = await each(from, guides, false, (guide) =>
        library.copyGuide(from, guide.id, to),
      );
      // Say what a copy leaves behind.
      report(
        outcome,
        t("library.bulk.copied", { count: outcome.done.length, name: nameOf(to) }),
        async () => {
          for (const { result } of outcome.done) await unmake(to, result.id);
        },
      );
    } finally {
      setBusy(false);
    }
  };

  const trash = async (guides: LibraryGuideSummary[]) => {
    if (!library || !libraryId) return;
    const from = libraryId;
    // Several at once: the number is typed to confirm (04/10/2026).
    if (
      guides.length > 1 &&
      !(await askCount(
        t("locks.binTitle", { count: guides.length }),
        guides.length,
        t("library.toTrash"),
      ))
    )
      return;
    setBusy(true);
    let left: LibraryGuideSummary[] = [];
    try {
      const outcome = await each(from, guides, true, (guide) => library.trashGuide(from, guide.id));
      left = outcome.locked;
      await refreshGuides(from);
      report(outcome, t("library.bulk.trashed", { count: outcome.done.length }), async () => {
        for (const { result } of outcome.done) await library.restoreGuide(from, result.trashId);
        await refreshGuides(from);
      });
    } finally {
      setBusy(false);
    }
    await offerLocked(from, left, t("locks.listBodyBin"), (guide) =>
      library.trashGuide(from, guide.id),
    );
  };

  /**
   * Merge guides (docs/spec/04-editor.md#merge-guides): the new guide is worked out from the
   * guides as they are on disk now, written to the chosen library with a first version saying
   * where it came from, and, if asked, the originals go to their Bins. Undo puts the new guide in
   * the Bin (nothing is lost for 30 days) and brings back any originals.
   */
  const merge = async (request: MergeRequest) => {
    if (!library) return;
    setBusy(true);
    try {
      const parts = await Promise.all(
        request.parts.map(async (part) => ({
          libraryId: part.libraryId,
          doc: toDoc(await library.loadGuide(part.libraryId, part.guide.id)),
        })),
      );
      const merged = mergeGuides(parts, {
        title: request.title,
        headings: request.headings,
        author,
        now: new Date(),
        newId: mergeId,
      });
      const made = await library.createFromParts(
        request.libraryId,
        merged.guide,
        merged.steps,
        merged.media,
      );
      const titles = parts.map((part) => `“${part.doc.guide.title}”`).join(", ");
      // A version note is capped, so a long list of titles is cut short.
      await library
        .saveVersion(request.libraryId, made.id, t("merge.version", { titles }).slice(0, 400))
        .catch(() => undefined);

      const binned: { libraryId: string; entry: TrashEntry }[] = [];
      const left: Outcome<TrashEntry> = { done: [], editing: [], locked: [], failed: [] };
      if (request.binOriginals)
        for (const part of request.parts) {
          const outcome = await each(part.libraryId, [part.guide], true, (guide) =>
            library.trashGuide(part.libraryId, guide.id),
          );
          for (const { result } of outcome.done)
            binned.push({ libraryId: part.libraryId, entry: result });
          left.editing.push(...outcome.editing);
          left.locked.push(...outcome.locked);
          left.failed.push(...outcome.failed);
        }
      await refreshGuides(libraryId);

      const message = [t("merge.done", { count: parts.length, title: made.title })];
      if (binned.length) message.push(t("merge.binned", { count: binned.length }));
      for (const { guide, name } of left.editing)
        message.push(t("library.bulk.editing", { title: guide.title, name }));
      // A locked original stays as it is: merging only reads it.
      for (const guide of left.locked) message.push(t("locks.mergeKept", { title: guide.title }));
      for (const { guide, problem } of left.failed)
        message.push(
          t("library.bulk.failed", {
            title: guide.title,
            reason: errorMessage(problem, t("library.actionFailed")),
          }),
        );
      notify({
        text: message.join(" "),
        ...(left.editing.length + left.failed.length > 0 ? { kind: "error" as const } : {}),
        action: { label: t("library.open"), run: () => openGuide(request.libraryId, made.id) },
        secondAction: {
          label: t("common.undo"),
          run: () => {
            setBusy(true);
            void (async () => {
              await library.trashGuide(request.libraryId, made.id);
              for (const { libraryId: from, entry } of binned)
                await library.restoreGuide(from, entry.trashId);
              await refreshGuides(libraryId);
            })()
              .catch((problem: unknown) =>
                notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) }),
              )
              .finally(() => {
                setBusy(false);
              });
          },
        },
      });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) });
    } finally {
      setBusy(false);
    }
  };

  return { move, copy, trash, merge };
}
