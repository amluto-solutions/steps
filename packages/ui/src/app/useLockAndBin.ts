import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { Host } from "../bridge/host";
import type { MenuEntry } from "../components/Menu";
import type { ToastMessage } from "../components/Toast";
import { errorMessage } from "../errors";
import type { GuideRef, LibraryBridge, LibraryGuideSummary, TrashEntry } from "../library-bridge";
import {
  withGuideLocks,
  type GuideLockDeps,
  type GuideLocks,
  type LockTarget,
} from "../library/guide-locks";
import {
  askCount,
  askNewPassword,
  askUnlock,
  showLockedList,
  showProperties,
} from "../library/LockDialogs";
import { policy } from "../settings/policy";
import { readRecordPcAndLogin } from "../settings/preferences";
import { askConfirm } from "./ask";
import { underEditLock } from "./edit-lock";

/**
 * The guide locks every library goes through (docs/spec/03-data-and-sharing.md#password-locks),
 * asking with the app's password dialogs; null without a library. Made again only if the display
 * name changes, which forgets this session's unlocks.
 */
export function useLibraryLocks(context: {
  library: LibraryBridge | undefined;
  host: Pick<Host, "machineIdentity">;
  author: string;
  /** Fewer PBKDF2 rounds, for tests. */
  iterations?: GuideLockDeps["iterations"];
}): GuideLocks | null {
  const { t } = useTranslation();
  const { library, host, author, iterations } = context;
  // Kept between renders: the locks remember which guides were unlocked this session.
  return useMemo(
    () =>
      library
        ? withGuideLocks(library, {
            who: async () => {
              const machine = readRecordPcAndLogin()
                ? await host.machineIdentity().catch(() => null)
                : null;
              return {
                by: author.trim() || t("locks.someone"),
                login: machine?.login ?? "",
                pc: machine?.pc ?? "",
              };
            },
            recoveryPassword: () => policy().guideLockRecoveryPassword,
            prompts: { password: askUnlock, list: showLockedList },
            ...(iterations ? { iterations } : {}),
          })
        : null,
    [library, host, author, t, iterations],
  );
}

/** The questions the lock and Bin actions ask; tests answer them with stand-ins. */
export interface LockAndBinDialogs {
  /** A new password, typed twice; null when cancelled. */
  newPassword: (title: string, body: string | null, yes: string) => Promise<string | null>;
  /** Typing the number of guides to confirm deleting several. */
  count: (title: string, count: number, yes: string) => Promise<boolean>;
  confirm: (title: string, body: string, yes: string) => Promise<boolean>;
  properties: (libraryId: string, guideId: string) => Promise<void>;
}

const DIALOGS: LockAndBinDialogs = {
  newPassword: askNewPassword,
  count: askCount,
  confirm: askConfirm,
  properties: showProperties,
};

/**
 * The guide-lock and Bin actions of the library and the editor's guide menu
 * (docs/spec/03-data-and-sharing.md#password-locks): Lock, Remove lock, Change password and
 * Properties, one guide or several, and Move to Bin with its Undo, Restore, Delete for good and
 * Empty Bin. What a password opens is the guide locks' to decide; this only wires the menus and
 * the Bin to them and says how each went.
 */
export function useLockAndBin(context: {
  /** The guide locks every library goes through; null without a library. */
  locks: GuideLocks | null;
  /** The library showing. */
  libraryId: string | null;
  guides: LibraryGuideSummary[];
  trash: TrashEntry[];
  refreshGuides: (libraryId: string | null) => Promise<void>;
  notify: (message: Omit<ToastMessage, "id">) => void;
  /** Runs an action with the app busy, saying `done` after it or why it failed. */
  run: (action: () => Promise<unknown>, done?: string) => Promise<void>;
  /** The display name, which a new lock names. */
  author: string;
  dialogs?: Partial<LockAndBinDialogs>;
}) {
  const { t } = useTranslation();
  const { locks, libraryId, guides, trash, refreshGuides, notify, run, author } = context;
  const library = locks?.library;
  const dialogs = { ...DIALOGS, ...context.dialogs };

  /**
   * Before a change, move or delete: a locked guide asks for its password, unlocking it for this
   * one action (or the editing session it's open in), as the guide locks decide.
   */
  const withPassword = async (
    ref: GuideRef,
    title: string,
    label: string,
    action: () => Promise<void>,
  ) => {
    if (locks) await locks.runOnGuide({ ...ref, title }, label, action);
    else await action();
  };

  const lockGuides = async (items: { ref: GuideRef; title: string }[]) => {
    if (!locks || items.length === 0) return;
    const first = items[0];
    const password = await dialogs.newPassword(
      items.length === 1 && first
        ? t("locks.lockTitle", { title: first.title })
        : t("locks.lockManyTitle", { count: items.length }),
      t("locks.lockBody", { name: author || t("locks.someone") }),
      t("locks.lockButton"),
    );
    if (!password) return;
    await run(async () => {
      let done = 0;
      for (const { ref } of items) {
        const already = await locks.lockOf(ref).catch(() => null);
        if (already) continue;
        await locks.lock(ref, password);
        done += 1;
      }
      await refreshGuides(libraryId);
      notify({
        text:
          items.length === 1 && first
            ? t("locks.locked", { title: first.title })
            : [
                t("locks.lockedMany", { count: done }),
                ...(items.length > done
                  ? [t("locks.alreadyLocked", { count: items.length - done })]
                  : []),
              ].join(" "),
      });
    });
  };

  const removeLock = (ref: GuideRef, title: string) =>
    withPassword(ref, title, t("locks.removeButton"), () =>
      run(
        async () => {
          await locks?.removeLock(ref);
          await refreshGuides(ref.libraryId);
        },
        t("locks.removed", { title }),
      ),
    );

  const changePassword = (ref: GuideRef, title: string) =>
    withPassword(ref, title, t("locks.next"), async () => {
      const password = await dialogs.newPassword(
        t("locks.newPasswordTitle", { title }),
        null,
        t("locks.changeButton"),
      );
      if (!password) return;
      await run(
        () => locks?.changePassword(ref, password) ?? Promise.resolve(),
        t("locks.changed", { title }),
      );
    });

  /** Lock…, or Remove lock… and Change password…, by whether the guide is locked. */
  const lockEntries = (ref: GuideRef, title: string): MenuEntry[] => {
    if (!locks) return [];
    const summary = guides.find((guide) => guide.id === ref.guideId);
    if (summary?.locked)
      return [
        {
          label: t("locks.removeLock"),
          icon: "lock",
          onSelect: () => void removeLock(ref, title),
        },
        {
          label: t("locks.changePassword"),
          icon: "lock",
          onSelect: () => void changePassword(ref, title),
        },
      ];
    return policy().disableGuideLocks
      ? []
      : [
          {
            label: t("locks.lock"),
            icon: "lock",
            onSelect: () => void lockGuides([{ ref, title }]),
          },
        ];
  };

  /**
   * Move to Bin. From the list it's done under the guide's edit lock (`held`: the editor holds
   * it), and never taken from someone editing it: their unsaved edits would have nowhere to go.
   */
  const trashGuide = async (ref: GuideRef, title: string, held: boolean) => {
    if (!library) return;
    const { libraryId: id, guideId } = ref;
    try {
      const bin = () => library.trashGuide(id, guideId);
      const binned = held
        ? { done: true as const, value: await bin() }
        : await underEditLock(library, ref, null, bin);
      if (!binned.done) {
        notify({ kind: "error", text: t("library.binEditing", { name: binned.lock.name }) });
        return;
      }
      const entry = binned.value;
      await refreshGuides(id);
      notify({
        text: t("library.trashed", { title }),
        action: {
          label: t("common.undo"),
          run: () =>
            void run(async () => {
              await library.restoreGuide(id, entry.trashId);
              await refreshGuides(id);
            }),
        },
      });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) });
    }
  };

  /**
   * The end of a guide's menu: its lock entries, Properties, and Move to Bin. `held` when the menu
   * is the editor's, which holds the guide's edit lock.
   */
  const guideEntries = (ref: GuideRef, title: string, held = false): MenuEntry[] => [
    ...lockEntries(ref, title),
    {
      label: t("locks.properties"),
      icon: "info",
      onSelect: () => void dialogs.properties(ref.libraryId, ref.guideId),
    },
    "divider",
    {
      label: t("library.toTrash"),
      icon: "trash",
      danger: true,
      onSelect: () =>
        void withPassword(ref, title, t("locks.toBin"), () => trashGuide(ref, title, held)),
    },
  ];

  /** Delete for good, from the Bin: asked about first, as it can't be undone. */
  const deleteForGood = async (entry: TrashEntry) => {
    if (!library || !libraryId) return;
    const sure = await dialogs.confirm(
      t("library.deleteForGoodTitle", { title: entry.title }),
      t("library.deleteForGoodBody"),
      t("library.deleteForGood"),
    );
    if (!sure) return;
    await run(
      async () => {
        try {
          await library.deleteTrashed(libraryId, entry.trashId);
        } finally {
          await refreshGuides(libraryId);
        }
      },
      t("library.deletedForGood", { title: entry.title }),
    );
  };

  /** Empty Bin: one guide is confirmed, several by typing how many (04/10/2026). */
  const emptyTrash = async () => {
    if (!library || !libraryId || trash.length === 0) return;
    const sure =
      trash.length > 1
        ? await dialogs.count(
            t("locks.emptyTitle", { count: trash.length }),
            trash.length,
            t("library.emptyTrash"),
          )
        : await dialogs.confirm(
            t("library.emptyTrashTitle"),
            t("library.emptyTrashBody", { count: trash.length }),
            t("library.emptyTrash"),
          );
    if (!sure) return;
    await run(async () => {
      try {
        const count = await library.emptyTrash(libraryId);
        notify({ text: t("library.trashEmptied", { count }) });
      } finally {
        // Some may have gone even if one couldn't: the list shows what's left.
        await refreshGuides(libraryId);
      }
    });
  };

  const restore = async (entry: TrashEntry) => {
    if (!library || !libraryId) return;
    await run(
      async () => {
        await library.restoreGuide(libraryId, entry.trashId);
        await refreshGuides(libraryId);
      },
      t("library.restored", { title: entry.title }),
    );
  };

  /** The Bin's own actions, as the Bin view takes them. */
  const bin = { onRestore: restore, onDeleteForGood: deleteForGood, onEmpty: emptyTrash };

  /** Remove lock on several: one list, where each password is tried on them all. */
  const removeLocks = async (items: LockTarget[]) => {
    if (!locks) return;
    await locks.runOnLocked(items, t("locks.listBodyRemove"), (target) => locks.removeLock(target));
    await refreshGuides(libraryId);
  };

  /** Lock and Remove lock for the guides chosen in the library showing. */
  const bulkLocks: {
    onLock?: (chosen: LibraryGuideSummary[]) => void;
    onRemoveLock?: (chosen: LibraryGuideSummary[]) => void;
  } =
    locks && libraryId
      ? {
          ...(policy().disableGuideLocks
            ? {}
            : {
                onLock: (chosen: LibraryGuideSummary[]) =>
                  void lockGuides(
                    chosen
                      .filter((guide) => !guide.locked)
                      .map((guide) => ({
                        ref: { libraryId, guideId: guide.id },
                        title: guide.title,
                      })),
                  ),
              }),
          onRemoveLock: (chosen: LibraryGuideSummary[]) =>
            void removeLocks(
              chosen.flatMap((guide) =>
                guide.locked
                  ? [{ libraryId, guideId: guide.id, title: guide.title, locked: guide.locked }]
                  : [],
              ),
            ),
        }
      : {};

  return { withPassword, guideEntries, bulkLocks, bin };
}
