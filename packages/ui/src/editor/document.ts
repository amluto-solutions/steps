import { compareSortKeys, type Guide, type GuideStep } from "@amluto-steps/core";

/** What the editor holds for one open guide. Steps are always kept in sort-key order. */
export interface EditorDoc {
  guide: Guide;
  steps: GuideStep[];
}

/**
 * One file-level change. An edit is a list of these, so undo is the same list with `before` and
 * `after` swapped, and saving writes exactly the files that changed: `after: null` deletes a step
 * file (docs/spec/04-editor.md#undo-and-versions).
 */
export type Change =
  | { kind: "guide"; before: Guide; after: Guide }
  | { kind: "step"; id: string; before: GuideStep | null; after: GuideStep | null };

export interface Edit {
  /** Shown as "Undo <label>". */
  label: string;
  changes: Change[];
  /** Edits with the same key made in quick succession (typing) merge into one undo step. */
  coalesceKey?: string;
  at: number;
}

export const sortSteps = (steps: GuideStep[]): GuideStep[] =>
  [...steps].sort(
    (left, right) =>
      compareSortKeys(left.sortKey, right.sortKey) || compareSortKeys(left.id, right.id),
  );

/** Applies changes forwards (`"do"`) or backwards (`"undo"`). */
export function applyChanges(
  doc: EditorDoc,
  changes: Change[],
  direction: "do" | "undo",
): EditorDoc {
  let guide = doc.guide;
  const steps = new Map(doc.steps.map((step) => [step.id, step]));
  for (const change of direction === "do" ? changes : [...changes].reverse()) {
    if (change.kind === "guide") {
      guide = direction === "do" ? change.after : change.before;
      continue;
    }
    const next = direction === "do" ? change.after : change.before;
    if (next) steps.set(change.id, next);
    else steps.delete(change.id);
  }
  return { guide, steps: sortSteps([...steps.values()]) };
}

/** The changes that undoing (or redoing) an edit writes to disk. */
export const invertChanges = (changes: Change[]): Change[] =>
  [...changes]
    .reverse()
    .map((change) =>
      change.kind === "guide"
        ? { kind: "guide", before: change.after, after: change.before }
        : { kind: "step", id: change.id, before: change.after, after: change.before },
    );

/**
 * Merges a later edit into an earlier one: each file keeps its first `before` and last `after`,
 * and changes that end where they started disappear.
 */
export function mergeEdits(first: Edit, second: Edit): Edit {
  const byKey = new Map<string, Change>();
  for (const change of [...first.changes, ...second.changes]) {
    const key = change.kind === "guide" ? "guide" : `step:${change.id}`;
    const earlier = byKey.get(key);
    if (!earlier) {
      byKey.set(key, change);
    } else if (earlier.kind === "guide" && change.kind === "guide") {
      byKey.set(key, { kind: "guide", before: earlier.before, after: change.after });
    } else if (earlier.kind === "step" && change.kind === "step") {
      byKey.set(key, { kind: "step", id: change.id, before: earlier.before, after: change.after });
    }
  }
  const changes = [...byKey.values()].filter((change) => change.before !== change.after);
  return { ...first, changes, at: second.at };
}

/** Undo and redo stacks. Pure: every function returns new objects. */
export interface History {
  past: Edit[];
  future: Edit[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

/** Typing within this long of the previous keystroke joins the same undo step. */
export const COALESCE_MS = 1500;
const HISTORY_LIMIT = 500;

export function recordEdit(history: History, edit: Edit): History {
  const last = history.past.at(-1);
  if (
    last &&
    edit.coalesceKey !== undefined &&
    last.coalesceKey === edit.coalesceKey &&
    edit.at - last.at < COALESCE_MS
  ) {
    return { past: [...history.past.slice(0, -1), mergeEdits(last, edit)], future: [] };
  }
  return { past: [...history.past, edit].slice(-HISTORY_LIMIT), future: [] };
}

export interface Stepped {
  doc: EditorDoc;
  history: History;
  /** The files to write for this undo or redo. */
  changes: Change[];
  label: string;
}

export function undo(doc: EditorDoc, history: History): Stepped | null {
  const edit = history.past.at(-1);
  if (!edit) return null;
  return {
    doc: applyChanges(doc, edit.changes, "undo"),
    history: { past: history.past.slice(0, -1), future: [...history.future, edit] },
    changes: invertChanges(edit.changes),
    label: edit.label,
  };
}

export function redo(doc: EditorDoc, history: History): Stepped | null {
  const edit = history.future.at(-1);
  if (!edit) return null;
  return {
    doc: applyChanges(doc, edit.changes, "do"),
    history: { past: [...history.past, edit], future: history.future.slice(0, -1) },
    changes: edit.changes,
    label: edit.label,
  };
}
