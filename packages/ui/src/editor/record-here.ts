import type { GuideStep } from "@amluto-steps/core";

import type { MediaRename } from "../bridge/recording-journal";

/**
 * Record steps here (docs/spec/04-editor.md#record-steps-here): an ordinary recording whose steps,
 * when it stops, go into the guide open in the editor rather than becoming a new draft.
 */

/** Where the new steps go: after a step of the guide, or first. */
export interface RecordAt {
  /** The step they go after; null puts them first. */
  afterId: string | null;
  /** Where that step was, in case it has gone (deleted) by the time the recording stops. */
  afterIndex: number;
}

/** What the editor's Record steps here (or Re-record these steps) asks the app for. */
export interface RecordHereRequest extends RecordAt {
  /** The guide's title, said on the start dialog and the recording bar. */
  title: string;
}

/**
 * An open editor as a recording made into its guide reaches it when it stops. The editor offers
 * one while it's open; one that has closed, or lost the guide's edit lock, can't take the steps.
 */
export interface StepInserter {
  /** Whether the guide can be changed here now (it isn't read-only). */
  canInsert(): boolean;
  /**
   * Puts `steps` in after `at` as one undo step and selects the first of them; false when the
   * guide can't be changed here now.
   */
  insert(steps: GuideStep[], at: RecordAt): boolean;
  /** Writes what's waiting; rejects if a write failed (the editor tries again by itself). */
  flush(): Promise<void>;
}

/** Where, in `steps` as they are now, the new steps go after (-1 for first). */
export function insertionIndex(steps: readonly GuideStep[], at: RecordAt): number {
  if (at.afterId === null) return -1;
  const found = steps.findIndex((step) => step.id === at.afterId);
  return found >= 0 ? found : Math.min(at.afterIndex, steps.length - 1);
}

/**
 * The recorded steps with new ids, and their screenshots' new ids, for a guide that has its own:
 * recordings name theirs `capture-12` and `click-12`, so the guide's first recording almost
 * certainly used the same names. A screenshot two steps share (typing borrows the one before) is
 * copied once.
 */
export function withNewIds(
  steps: readonly GuideStep[],
  newId: (prefix: string) => string,
): { steps: GuideStep[]; media: MediaRename[] } {
  const renamed = new Map<string, string>();
  const fresh = steps.map((step) => {
    const mediaId = step.media?.id;
    if (!step.media || !mediaId) return { ...step, id: newId("step") };
    let newMediaId = renamed.get(mediaId);
    if (!newMediaId) {
      newMediaId = newId("image");
      renamed.set(mediaId, newMediaId);
    }
    return { ...step, id: newId("step"), media: { ...step.media, id: newMediaId } };
  });
  return {
    steps: fresh,
    media: [...renamed].map(([mediaId, newMediaId]) => ({ mediaId, newMediaId })),
  };
}
