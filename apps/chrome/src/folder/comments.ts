import type { CommentThread, ReviewComment } from "@amluto-steps/ui";

import { errors, newId, nowIso } from "../library/ids";

import type { Dir } from "./dir";
import { byName, checked, createJson, isObject, jsonFiles } from "./files";
import type { FolderLibrary } from "./library";

/**
 * Review comments in a shared library, as the desktop's `library/src/comments.rs`: every action
 * (a comment, a reply, a resolve, a reopen) is its own file in `comments\`, written once and never
 * changed, so two people commenting at once never make a sync conflict. A thread's state is its
 * latest resolve or reopen.
 */

export const MAX_COMMENT = 5000;

/** Who is commenting: the name in Settings and this browser (`pc`). */
export interface Commenter {
  name: string;
  pc: string;
}

type Action = "comment" | "resolve" | "reopen";

/** One file in `comments\`, in the desktop's field order. */
interface Entry {
  formatVersion: number;
  id: string;
  action: Action;
  thread: string | null;
  stepId: string | null;
  text: string;
  by: string;
  pc: string;
  at: string;
}

const optionalText = (value: unknown) => (typeof value === "string" ? value : null);

/** A file as serde reads it: required fields must be there, optional ones may be left out. */
function parseEntry(value: unknown): Entry | null {
  if (!isObject(value)) return null;
  const { formatVersion, id, action, by, at } = value;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion) || formatVersion < 0)
    return null;
  if (typeof id !== "string" || typeof by !== "string" || typeof at !== "string") return null;
  if (action !== "comment" && action !== "resolve" && action !== "reopen") return null;
  if (value.thread !== undefined && value.thread !== null && typeof value.thread !== "string")
    return null;
  if (value.stepId !== undefined && value.stepId !== null && typeof value.stepId !== "string")
    return null;
  return {
    formatVersion,
    id,
    action,
    thread: optionalText(value.thread),
    stepId: optionalText(value.stepId),
    text: typeof value.text === "string" ? value.text : "",
    by,
    pc: typeof value.pc === "string" ? value.pc : "",
    at,
  };
}

/** Every readable entry; a file whose name isn't its id is a stray copy and is left out. */
async function readEntries(folder: Dir | null): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const [name, value] of await jsonFiles(folder)) {
    const entry = parseEntry(value);
    if (entry && `${entry.id}.json` === name) entries.push(entry);
  }
  // Clocks on different PCs may disagree, so ties and near-ties only need to be stable.
  return entries.sort((a, b) => byName(a.at, b.at) || byName(a.id, b.id));
}

const isBy = (entry: Entry, who: Commenter) => entry.by === who.name && entry.pc === who.pc;

const asComment = (entry: Entry, who: Commenter): ReviewComment => ({
  id: entry.id,
  text: entry.text,
  by: entry.by,
  at: entry.at,
  mine: isBy(entry, who),
});

/** The threads, oldest first; replies and resolves whose thread has gone are left out. */
function threads(entries: Entry[], who: Commenter): CommentThread[] {
  const result: CommentThread[] = entries
    .filter((entry) => entry.action === "comment" && entry.thread === null)
    .map((entry) => ({
      ...asComment(entry, who),
      stepId: entry.stepId,
      replies: [],
      resolved: null,
    }));
  for (const entry of entries) {
    const found = result.find((thread) => thread.id === entry.thread);
    if (!found) continue;
    if (entry.action === "comment") found.replies.push(asComment(entry, who));
    else if (entry.action === "resolve") found.resolved = { by: entry.by, at: entry.at };
    else found.resolved = null;
  }
  return result;
}

const nobody: Commenter = { name: "", pc: "" };

/** How many of a guide's threads are open, for its card. */
export async function openCommentCount(guideFolder: Dir): Promise<number> {
  return threads(await readEntries(await guideFolder.folder("comments")), nobody).filter(
    (thread) => thread.resolved === null,
  ).length;
}

export async function listComments(
  library: FolderLibrary,
  guideId: string,
  who: Commenter,
): Promise<CommentThread[]> {
  const folder = await library.guideDir(guideId);
  return threads(await readEntries(await folder.folder("comments")), who);
}

async function writeEntry(library: FolderLibrary, guideId: string, entry: Entry) {
  const folder = await (await library.guideDir(guideId)).makeFolder("comments");
  await createJson(folder, `${entry.id}.json`, entry);
}

async function findThread(
  library: FolderLibrary,
  guideId: string,
  thread: string,
  who: Commenter,
): Promise<CommentThread> {
  checked(thread, "comment");
  const found = (await listComments(library, guideId, who)).find((each) => each.id === thread);
  if (!found) throw errors.invalid("that comment has been deleted");
  return found;
}

/** Starts a thread (`replyTo` null) on a step or the whole guide, or replies; answers its id. */
export async function addComment(
  library: FolderLibrary,
  guideId: string,
  stepId: string | null,
  replyTo: string | null,
  body: string,
  who: Commenter,
): Promise<string> {
  const text = body.trim();
  if (!text || [...text].length > MAX_COMMENT)
    throw errors.invalid(`a comment has 1 to ${MAX_COMMENT} characters`);
  if (stepId !== null) checked(stepId, "step");
  if (replyTo !== null) await findThread(library, guideId, replyTo, who);
  const entry: Entry = {
    formatVersion: 1,
    id: newId(),
    action: "comment",
    thread: replyTo,
    // A reply belongs to its thread, which already says what it's about.
    stepId: replyTo === null ? stepId : null,
    text,
    by: who.name,
    pc: who.pc,
    at: nowIso(),
  };
  await writeEntry(library, guideId, entry);
  return entry.id;
}

/** Resolves or reopens a thread; doing what's already done changes nothing. */
export async function setCommentResolved(
  library: FolderLibrary,
  guideId: string,
  thread: string,
  resolved: boolean,
  who: Commenter,
): Promise<void> {
  const found = await findThread(library, guideId, thread, who);
  if ((found.resolved !== null) === resolved) return;
  await writeEntry(library, guideId, {
    formatVersion: 1,
    id: newId(),
    action: resolved ? "resolve" : "reopen",
    thread,
    stepId: null,
    text: "",
    by: who.name,
    pc: who.pc,
    at: nowIso(),
  });
}

/**
 * Deletes one of your own comments: a reply, or a thread nobody has replied to (with its resolves
 * and reopens). A thread with replies stays, so nobody else's words go with it.
 */
export async function deleteComment(
  library: FolderLibrary,
  guideId: string,
  comment: string,
  who: Commenter,
): Promise<void> {
  checked(comment, "comment");
  const folder = await (await library.guideDir(guideId)).folder("comments");
  const entries = await readEntries(folder);
  const target = entries.find((entry) => entry.id === comment && entry.action === "comment");
  if (!folder || !target) throw errors.invalid("that comment has been deleted");
  if (!isBy(target, who)) throw errors.invalid("only the person who wrote a comment can delete it");
  const remove = [target.id];
  if (target.thread === null) {
    const rest = entries.filter((entry) => entry.thread === comment);
    if (rest.some((entry) => entry.action === "comment"))
      throw errors.invalid("a comment with replies can't be deleted");
    remove.push(...rest.map((entry) => entry.id));
  }
  for (const id of remove) await folder.remove(`${id}.json`);
}

/** A comment moving into a folder library: its file there, written on `pc`. */
export function commentFile(
  entry: {
    id: string;
    action: Action;
    thread: string | null;
    stepId: string | null;
    text: string;
    by: string;
    at: string;
  },
  pc: string,
): Entry {
  return {
    formatVersion: 1,
    id: entry.id,
    action: entry.action,
    thread: entry.thread,
    stepId: entry.stepId,
    text: entry.text,
    by: entry.by,
    pc,
    at: entry.at,
  };
}

export { parseEntry as parseCommentFile };
