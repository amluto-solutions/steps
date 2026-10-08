import type { EditLock, GuideRef, SharedEditing } from "../library-bridge";

/** What became of a change made under a guide's edit lock. */
export type UnderLock<T> = { done: true; value: T } | { done: false; lock: EditLock };

/**
 * A change made from the guide list, under the guide's edit lock as every change to it is
 * (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive). Opening takes a lock
 * this PC's earlier run left, or one this PC has seen go stale, so neither blocks the change
 * (08/10/2026: a lock left by a run that closed without letting go refused Move and Move to Bin
 * for days). Someone else's live lock is theirs: `takeOver` asks whether to take it, and without
 * it (Move, Move to Bin) the change waits until they close the guide, since their unsaved edits
 * would be kept as a draft in a guide that's no longer there. The lock is let go afterwards.
 */
export async function underEditLock<T>(
  library: Pick<SharedEditing, "openForEditing" | "releaseLock">,
  { libraryId, guideId }: GuideRef,
  takeOver: ((lock: EditLock) => Promise<boolean>) | null,
  change: () => Promise<T>,
): Promise<UnderLock<T>> {
  const editing = await library.openForEditing(libraryId, guideId, false);
  if (editing.kind === "readOnly") {
    if (!takeOver || !(await takeOver(editing.lock))) return { done: false, lock: editing.lock };
    await library.openForEditing(libraryId, guideId, true);
  }
  try {
    return { done: true, value: await change() };
  } finally {
    // A guide that has moved or gone to the Bin has no lock left here to let go of.
    await library.releaseLock(libraryId, guideId).catch(() => undefined);
  }
}
