import type {
  ConflictChoice,
  DraftInfo,
  EditLock,
  GuideConflict,
  LibraryGuideSummary,
} from "@amluto-steps/ui";

import { errors, newId, nowIso } from "../library/ids";

import {
  byName,
  checked,
  isObject,
  jsonFiles,
  obj,
  readJson,
  tryJson,
  writeJson,
  type Json,
} from "./files";
import { readSteps, type FolderLibrary } from "./library";

/**
 * What makes a folder library shared, as the desktop's `locks.rs`, `conflicts.rs` and
 * `drafts.rs` (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive): the
 * advisory edit lock, a sync client's conflict copies, a step deleted on one PC and edited on
 * another, and a displaced editor's unsaved work. Nothing here compares clocks.
 */

const LOCK_FILE = ".lock";

/** Who is opening a guide to edit it. */
export interface LockHolder {
  name: string;
  pc: string;
  session: string;
}

export type LockOutcome = { kind: "mine"; lock: EditLock } | { kind: "theirs"; lock: EditLock };
export type Heartbeat = { kind: "held"; counter: number } | { kind: "displaced"; lock: EditLock };

/** A `.lock` as serde reads it; an unreadable one (half-synced) counts as none. */
function parseLock(value: unknown): EditLock | null {
  if (!isObject(value)) return null;
  const { name, pc, session, counter, since } = value;
  if (typeof name !== "string" || typeof pc !== "string" || typeof session !== "string")
    return null;
  if (typeof counter !== "number" || !Number.isInteger(counter) || counter < 0) return null;
  if (typeof since !== "string") return null;
  return { name, pc, session, counter, since };
}

const writeLock = (library: FolderLibrary, guideId: string, lock: EditLock) =>
  library.guideDir(guideId).then((folder) =>
    writeJson(folder, LOCK_FILE, {
      name: lock.name,
      pc: lock.pc,
      session: lock.session,
      counter: lock.counter,
      since: lock.since,
    }),
  );

const fresh = (holder: LockHolder): EditLock => ({ ...holder, counter: 0, since: nowIso() });

/** The guide's lock, or null when nobody is editing it. */
export async function readLock(library: FolderLibrary, guideId: string): Promise<EditLock | null> {
  return parseLock(await tryJson(await library.guideDir(guideId), LOCK_FILE));
}

/**
 * Takes the lock when nobody holds it or this session does; `takeOver` takes it from someone
 * else (confirmed, or seen to have gone stale). Otherwise the guide is theirs.
 */
export async function openForEditing(
  library: FolderLibrary,
  guideId: string,
  holder: LockHolder,
  takeOver: boolean,
): Promise<LockOutcome> {
  const lock = await readLock(library, guideId);
  if (lock && lock.session !== holder.session && !takeOver) return { kind: "theirs", lock };
  if (lock && lock.session === holder.session) return { kind: "mine", lock };
  const mine = fresh(holder);
  await writeLock(library, guideId, mine);
  return { kind: "mine", lock: mine };
}

/**
 * Raises this session's counter. A lock that has gone is written again; one with another session
 * in it means someone took over.
 */
export async function heartbeat(
  library: FolderLibrary,
  guideId: string,
  holder: LockHolder,
): Promise<Heartbeat> {
  const found = await readLock(library, guideId);
  if (found && found.session !== holder.session) return { kind: "displaced", lock: found };
  const lock = found ? { ...found, counter: found.counter + 1 } : fresh(holder);
  await writeLock(library, guideId, lock);
  return { kind: "held", counter: lock.counter };
}

/** Lets go when the editor closes; someone else's lock is left alone. */
export async function releaseLock(
  library: FolderLibrary,
  guideId: string,
  session: string,
): Promise<void> {
  const folder = await library.guideDir(guideId);
  if (parseLock(await tryJson(folder, LOCK_FILE))?.session === session)
    await folder.remove(LOCK_FILE);
}

/** Whether this session may write the guide: it holds the lock, or nobody does. */
export async function mayWrite(
  library: FolderLibrary,
  guideId: string,
  session: string,
): Promise<boolean> {
  const lock = await readLock(library, guideId);
  return lock === null || lock.session === session;
}

// ---------- conflicts ----------

interface DeleteNote {
  by: string;
  session: string;
  at: string;
}

const parseNote = (value: unknown): DeleteNote | null => {
  const note = obj(value);
  return typeof note.by === "string" &&
    typeof note.session === "string" &&
    typeof note.at === "string"
    ? { by: note.by, session: note.session, at: note.at }
    : null;
};

/** Leaves a note that this session deleted a step, so an edit made elsewhere comes back flagged. */
export async function noteDelete(
  library: FolderLibrary,
  guideId: string,
  stepId: string,
  by: string,
  session: string,
): Promise<void> {
  const folder = await (await library.guideDir(guideId)).makeFolder("deleted");
  await writeJson(folder, `${checked(stepId, "step")}.json`, { by, session, at: nowIso() });
}

/** Forgets this session's own delete note when the step is saved again (Undo). */
export async function forgetOwnDelete(
  library: FolderLibrary,
  guideId: string,
  stepId: string,
  session: string,
): Promise<void> {
  const name = `${checked(stepId, "step")}.json`;
  const folder = await (await library.guideDir(guideId)).folder("deleted");
  if (folder && parseNote(await tryJson(folder, name))?.session === session)
    await folder.remove(name);
}

/** `abc-PC.json` without `.json`: Rust's `trim_end_matches(".json")`. */
const stemOf = (file: string) => file.replace(/(\.json)+$/, "");

/** Everything in the guide someone needs to decide about. */
export async function listConflicts(
  library: FolderLibrary,
  guideId: string,
): Promise<GuideConflict[]> {
  const folder = await library.guideDir(guideId);
  const found: GuideConflict[] = [];
  const stepsDir = await folder.folder("steps");
  const steps = await readSteps(stepsDir);
  const stepById = (id: string) => steps.find((step) => step.id === id);

  // Conflict copies of steps.
  for (const [file, theirs] of await jsonFiles(stepsDir)) {
    const id = obj(theirs).id;
    const stem = stemOf(file);
    if (typeof id !== "string" || stem === id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    // The version in the guide; a copy of a step whose own file is gone is the step itself.
    const ours = stepById(id);
    if (!ours) continue;
    found.push({
      kind: "step",
      file,
      id,
      from: (stem.startsWith(id) ? stem.slice(id.length) : stem).replace(/^[- ]+/, ""),
      ours,
      theirs,
    });
  }

  // Conflict copies of guide.json.
  const ours = await tryJson(folder, "guide.json");
  if (ours !== null)
    for (const [file, theirs] of await jsonFiles(folder)) {
      const stem = stemOf(file);
      if (file === "guide.json" || !stem.startsWith("guide")) continue;
      if (JSON.stringify(obj(theirs).id) !== JSON.stringify(obj(ours).id)) continue;
      found.push({
        kind: "guide",
        file,
        from: stem.replace(/^(guide)+/, "").replace(/^[- ]+/, ""),
        ours,
        theirs,
      });
    }

  // Steps one person deleted and another's edit brought back.
  for (const [file, value] of await jsonFiles(await folder.folder("deleted"))) {
    const id = stemOf(file);
    const step = stepById(id);
    const note = parseNote(value);
    if (step && note) found.push({ kind: "restored", id, deletedBy: note.by, step });
  }
  return found;
}

const keyOf = (conflict: GuideConflict) =>
  conflict.kind === "restored" ? conflict.id : conflict.file;

/**
 * Settles one conflict, named as `listConflicts` gave it. It's looked up in a fresh listing, so
 * only a file the listing found is touched, and one settled elsewhere meanwhile is nothing to do.
 */
export async function resolveConflict(
  library: FolderLibrary,
  guideId: string,
  conflict: string,
  choice: ConflictChoice,
): Promise<void> {
  const folder = await library.guideDir(guideId);
  const found = (await listConflicts(library, guideId)).find((item) => keyOf(item) === conflict);
  if (!found) return;
  if (found.kind === "restored") {
    // Keeping it forgets the delete; deleting it deletes it again.
    await (await folder.folder("deleted"))?.remove(`${found.id}.json`);
    if (choice === "keepOurs") await library.deleteStep(guideId, found.id);
    return;
  }
  if (found.kind === "step") {
    if (choice === "keepTheirs") await library.saveStep(guideId, found.theirs);
    if (choice === "keepBoth") {
      const after = obj(found.ours).sortKey;
      // Straight after the version in the guide.
      await library.saveStep(guideId, {
        ...obj(found.theirs),
        id: newId(),
        sortKey: `${typeof after === "string" ? after : "a0"}m`,
      });
    }
    await (await folder.folder("steps"))?.remove(found.file);
    return;
  }
  if (choice === "keepBoth")
    throw errors.invalid("A guide's details can't be kept twice: choose one.");
  if (choice === "keepTheirs") await library.saveGuide(guideId, found.theirs);
  await folder.remove(found.file);
}

// ---------- drafts ----------

/** Keeps a displaced editor's whole guide as a draft named by their session. */
export async function saveDraft(
  library: FolderLibrary,
  guideId: string,
  session: string,
  by: string,
  draft: { guide: unknown; steps: unknown[] },
): Promise<void> {
  const id = checked(session, "draft");
  if (!isObject(draft.guide) || !Array.isArray(draft.steps))
    throw errors.invalid("A draft needs the guide and its steps.");
  const folder = await (await library.guideDir(guideId)).makeFolder("drafts");
  await writeJson(folder, `${id}.json`, {
    id,
    by,
    at: nowIso(),
    guide: draft.guide,
    steps: draft.steps,
  });
}

/** The guide's drafts, oldest first; unreadable (half-synced) ones are skipped. */
export async function listDrafts(library: FolderLibrary, guideId: string): Promise<DraftInfo[]> {
  const folder = await (await library.guideDir(guideId)).folder("drafts");
  const drafts: DraftInfo[] = [];
  for (const [, value] of await jsonFiles(folder)) {
    const draft = obj(value);
    if (
      typeof draft.id === "string" &&
      typeof draft.by === "string" &&
      typeof draft.at === "string" &&
      Array.isArray(draft.steps)
    )
      drafts.push({ id: draft.id, by: draft.by, at: draft.at, stepCount: draft.steps.length });
  }
  return drafts.sort((a, b) => byName(a.at, b.at) || byName(a.id, b.id));
}

export async function discardDraft(
  library: FolderLibrary,
  guideId: string,
  draftId: string,
): Promise<void> {
  const name = `${checked(draftId, "draft")}.json`;
  await (await (await library.guideDir(guideId)).folder("drafts"))?.remove(name);
}

/**
 * Opens a draft as a new guide beside the original: a duplicate (so the screenshots come too)
 * with the draft's wording and steps. The draft is then removed.
 */
export async function draftToCopy(
  library: FolderLibrary,
  guideId: string,
  draftId: string,
  title: string,
): Promise<LibraryGuideSummary> {
  const name = `${checked(draftId, "draft")}.json`;
  const drafts = await (await library.guideDir(guideId)).folder("drafts");
  const draft = drafts ? await readJson(drafts, name) : undefined;
  if (!drafts || draft === undefined) throw errors.invalid("That draft isn't there any more.");
  const fields = obj(draft).guide;
  if (!isObject(fields)) throw errors.invalid("The draft has no guide.");
  const copy = await library.duplicateGuide(guideId, title);
  const folder = await library.guideDir(copy.id);
  const original = obj(await readJson(folder, "guide.json"));
  // The copy keeps its own identity; the draft brings the wording.
  const identity = ["id", "title", "createdAt", "createdBy", "recordingSessionId"];
  const guide: Json = Object.fromEntries(
    Object.entries(fields).filter(([field]) => !identity.includes(field)),
  );
  for (const field of identity) if (field in original) guide[field] = original[field];
  guide.updatedAt = nowIso();
  await library.saveGuide(copy.id, guide);
  const steps = await folder.makeFolder("steps");
  for (const entry of await steps.entries()) await steps.remove(entry.name, true);
  const draftSteps = obj(draft).steps;
  for (const step of Array.isArray(draftSteps) ? draftSteps : [])
    await library.saveStep(copy.id, step);
  await drafts.remove(name);
  return library.summary(copy.id);
}
