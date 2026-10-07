import {
  GuessLimit,
  checkPassword,
  hashPassword,
  parseGuideHistory,
  parseGuideLock,
  withEvent,
  type GuideHistory,
  type GuideLock,
  type HistoryEvent,
  type Who,
} from "@amluto-steps/core";

import type { GuideRef, LibraryBridge } from "../library-bridge";

/**
 * Password locks on guides (docs/spec/03-data-and-sharing.md#password-locks, 04/10/2026).
 *
 * Every library the app uses goes through `withGuideLocks`, for the desktop and the browser
 * extension alike: a locked guide's changes, moves and deletes are refused until it's unlocked
 * with its password, for this editing session only. Viewing, exporting, duplicating, copying,
 * merging and comments are never refused. The storage underneath only keeps the lock and history
 * files; what a lock allows is decided here (`CHANGES_GUIDE`). It also counts saves and records
 * who saved last, and runs the asking for passwords, given the dialogs to show (06/10/2026).
 */

/** A change refused because the guide is locked; its message is who locked it. */
export class GuideLockedError extends Error {
  readonly code = "guideLocked";
}

/** How a password went. */
export type UnlockResult =
  { kind: "unlocked"; recovery: boolean } | { kind: "wrong" } | { kind: "wait"; ms: number };

/** A guide an action is for, as the password prompt names it. */
export interface GuideTarget extends GuideRef {
  title: string;
}

/** A locked guide: who locked it, and when. */
export interface LockTarget extends GuideTarget {
  locked: { by: string; at: string };
}

/**
 * The password dialog, which the UI provides. Each password typed goes to `attempt`, whose answer
 * the dialog shows ("wrong", "wait"), until one opens the guide (true) or it's cancelled (false).
 * `action` is its button ("Unlock", "Move to Bin"…).
 */
export type PasswordPrompt = (
  target: LockTarget,
  action: string,
  attempt: (password: string) => Promise<UnlockResult>,
) => Promise<boolean>;

/** How a password typed in the list of locked guides went, and what's left in the list. */
export type ListAttempt =
  | { kind: "wrong" }
  | { kind: "wait"; ms: number }
  | {
      kind: "done";
      /** The guide it was typed for, then any others it opened, each with the action run. */
      done: LockTarget[];
      /** Opened, but the action failed; they stay in the list. */
      failed: { target: LockTarget; problem: unknown }[];
      left: LockTarget[];
    };

/**
 * The list of locked guides a bulk action left, which the UI provides: a password is typed for
 * one guide and goes to `attempt`, until the list is closed. `body` says what the action is.
 */
export type LockedListPrompt = (
  targets: LockTarget[],
  body: string,
  attempt: (target: LockTarget, password: string) => Promise<ListAttempt>,
) => Promise<void>;

export interface GuideLockDeps {
  /** Who is acting now: the display name, and the PC and login when they're recorded. */
  who: () => Promise<Omit<Who, "at">>;
  /** IT's recovery password hash, if set. */
  recoveryPassword: () => string | null;
  /** The dialogs that ask for passwords. */
  prompts: { password: PasswordPrompt; list: LockedListPrompt };
  now?: () => Date;
  /** PBKDF2 rounds for new passwords (tests use fewer). */
  iterations?: number;
}

export interface GuideLocks {
  /** The wrapped library: use it for everything. */
  readonly library: LibraryBridge;
  lockOf(guide: GuideRef): Promise<GuideLock | null>;
  history(guide: GuideRef): Promise<GuideHistory>;
  /** Unlocked with its password in this session (or not locked at all). */
  isOpen(guide: GuideRef): boolean;
  /** Tries a password: unlocks the guide for this session when it's right. */
  unlock(guide: GuideRef, password: string): Promise<UnlockResult>;
  /**
   * Runs `action` on a guide (a move, a rename, the Bin…). A locked guide that isn't open asks for
   * its password first and is locked again afterwards. False when the prompt was cancelled.
   */
  runOnGuide(guide: GuideTarget, label: string, action: () => Promise<unknown>): Promise<boolean>;
  /**
   * Unlock to edit: asks for the password, and the guide stays open for this editing session,
   * until the editor lets go of it. False when the prompt was cancelled.
   */
  unlockToEdit(guide: GuideTarget, label: string): Promise<boolean>;
  /**
   * The locked guides a bulk action left (Move to, Move to Bin, Remove lock): each is done once
   * its password is given in the list, and that password is also tried on the others, so any it
   * opens are done too. A miss there isn't counted as a wrong try, as nobody typed it for them.
   * Each is locked again once done. Answers when the list is closed.
   */
  runOnLocked(
    targets: LockTarget[],
    body: string,
    act: (target: LockTarget) => Promise<unknown>,
  ): Promise<void>;
  /** Ends this session's unlock (the editor closed, a bulk action finished). */
  relock(guide: GuideRef): void;
  lock(guide: GuideRef, password: string): Promise<void>;
  /** Takes the lock off for good; the password is asked first (`unlock`). */
  removeLock(guide: GuideRef): Promise<void>;
  /** A new password; the guide must be unlocked with the old one first. */
  changePassword(guide: GuideRef, password: string): Promise<void>;
}

const keyOf = ({ libraryId, guideId }: GuideRef) => `${libraryId}\u0000${guideId}`;
const same = (one: GuideRef, other: GuideRef) =>
  one.libraryId === other.libraryId && one.guideId === other.guideId;

/** Every method of a library. */
export type LibraryMethod = {
  [K in keyof LibraryBridge]-?: NonNullable<LibraryBridge[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof LibraryBridge];

/**
 * Whether each library method changes an existing guide (06/10/2026). Those that do take the
 * library and the guide first, and are refused while it's locked; the rest go straight through.
 * Every method must be listed, so one added to `LibraryBridge` can't be left unguarded by default.
 */
export const CHANGES_GUIDE = {
  // A guide's own changes, counted as saves.
  saveGuide: true,
  saveStep: true,
  deleteStep: true,
  resolveConflict: true,
  applyRedactions: true,
  restoreVersion: true,
  // New pictures in its folder; a step that shows one is saved separately.
  importImage: true,
  retakeImage: true,
  // Moving it, the Bin and Export and remove; its lock file only through `lock` and the rest.
  moveGuide: true,
  trashGuide: true,
  exportAndRemove: true,
  writeGuideLock: true,

  // Libraries themselves.
  allowAccess: false,
  listLibraries: false,
  addLibrary: false,
  renameLibrary: false,
  removeLibrary: false,
  setDefaultLibrary: false,
  openFolder: false,
  storageUse: false,
  fingerprint: false,
  // Reading a guide.
  guideMeta: false,
  guideStats: false,
  listGuides: false,
  searchGuides: false,
  loadGuide: false,
  guideFingerprint: false,
  listConflicts: false,
  loadImage: false,
  listVersions: false,
  loadVersion: false,
  // The save count and lock events; written by this module, never a change of the guide's own.
  writeGuideHistory: false,
  // The edit lock: a locked guide opens read-only without it, so nothing takes it there.
  openForEditing: false,
  releaseLock: false,
  onLockLost: false,
  // Comments are open to anyone who can view.
  listComments: false,
  addComment: false,
  resolveComment: false,
  deleteComment: false,
  // Drafts: kept for whoever was displaced, and a locked guide never makes one.
  saveDraft: false,
  listDrafts: false,
  discardDraft: false,
  draftToCopy: false,
  // An export records a version, and exporting a locked guide is allowed.
  saveVersion: false,
  // New guides, or copies that come unlocked; a guide in the Bin has no lock.
  createGuide: false,
  duplicateGuide: false,
  copyGuide: false,
  createFromParts: false,
  importAmlsteps: false,
  exportAmlsteps: false,
  listTrash: false,
  restoreGuide: false,
  deleteTrashed: false,
  emptyTrash: false,
  // Pickers.
  pickFolder: false,
  pickFile: false,
  pickSaveLocation: false,
  pickExportFolder: false,
} as const satisfies Record<LibraryMethod, boolean>;

type GuideMethod = (libraryId: string, guideId: string, ...rest: never[]) => Promise<unknown>;

export function withGuideLocks(inner: LibraryBridge, deps: GuideLockDeps): GuideLocks {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const open = new Set<string>();
  /** Editing sessions that have changed their guide, to count as one save when they end. */
  const editing = new Map<string, boolean>();
  const guesses = new GuessLimit();

  const lockOf = async ({ libraryId, guideId }: GuideRef) =>
    parseGuideLock((await inner.guideMeta(libraryId, guideId)).lock);
  const history = async ({ libraryId, guideId }: GuideRef) =>
    parseGuideHistory((await inner.guideMeta(libraryId, guideId)).history);

  const stamp = async (): Promise<Who> => ({ ...(await deps.who()), at: now() });

  const addEvent = async (libraryId: string, guideId: string, kind: HistoryEvent["kind"]) => {
    const event = { ...(await stamp()), kind };
    const before = await history({ libraryId, guideId });
    await inner.writeGuideHistory(libraryId, guideId, withEvent(before, event));
  };

  /** One save: a session that changed the guide, or a change made outside one (a rename). */
  const countSave = async (libraryId: string, guideId: string) => {
    const before = await history({ libraryId, guideId });
    await inner.writeGuideHistory(libraryId, guideId, {
      ...before,
      saves: before.saves + 1,
      lastSaved: await stamp(),
    });
  };

  /** Refuses unless the guide isn't locked or is unlocked in this session. */
  const mayChange = async (libraryId: string, guideId: string) => {
    if (open.has(keyOf({ libraryId, guideId }))) return;
    const lock = await lockOf({ libraryId, guideId }).catch(() => null);
    if (lock) throw new GuideLockedError(lock.locked.by);
  };

  const changed = async (libraryId: string, guideId: string) => {
    const key = keyOf({ libraryId, guideId });
    if (editing.has(key)) editing.set(key, true);
    // A history that can't be written never stops the change itself.
    else await countSave(libraryId, guideId).catch(() => undefined);
  };

  const library: LibraryBridge = Object.create(inner) as LibraryBridge;

  /** What a guide-changing method does once allowed, where it's more than the change and a save. */
  const allowed: Partial<Record<LibraryMethod, GuideMethod>> = {
    async trashGuide(libraryId, guideId) {
      const guide = { libraryId, guideId };
      const wasLocked = (await lockOf(guide).catch(() => null)) !== null;
      // Recorded before the move: a guide in the Bin can't be reached to write it after (07/10/2026:
      // only the old hand-made test library could, so "binned" was never kept). Taken back out if
      // the Bin refuses the guide.
      const before = wasLocked ? await history(guide).catch(() => null) : null;
      if (before) await addEvent(libraryId, guideId, "binned").catch(() => undefined);
      try {
        const entry = await inner.trashGuide(libraryId, guideId);
        open.delete(keyOf(guide));
        return entry;
      } catch (problem) {
        if (before)
          await inner.writeGuideHistory(libraryId, guideId, before).catch(() => undefined);
        throw problem;
      }
    },
    // A move takes the lock along; neither it nor Export and remove counts as a save.
    moveGuide: (fromLibraryId, guideId, ...rest) =>
      (inner.moveGuide as GuideMethod).call(inner, fromLibraryId, guideId, ...rest),
    exportAndRemove: (libraryId, guideId, ...rest) =>
      (inner.exportAndRemove as GuideMethod).call(inner, libraryId, guideId, ...rest),
    // A guide's lock is changed only through `lock`, `removeLock` and `changePassword`.
    writeGuideLock: () => Promise.reject(new Error("guideLockDirect")),
  };

  for (const name of Object.keys(CHANGES_GUIDE) as LibraryMethod[]) {
    // Absent from this library (Export and remove is Steps for Chrome's only).
    if (!CHANGES_GUIDE[name] || inner[name] === undefined) continue;
    const original = inner[name] as GuideMethod;
    const then: GuideMethod =
      allowed[name] ??
      (async (libraryId, guideId, ...rest) => {
        const result = await original.call(inner, libraryId, guideId, ...rest);
        await changed(libraryId, guideId);
        return result;
      });
    (library as unknown as Record<string, GuideMethod>)[name] = async (
      libraryId,
      guideId,
      ...rest
    ) => {
      await mayChange(libraryId, guideId);
      return then(libraryId, guideId, ...rest);
    };
  }

  Object.assign(library, {
    async openForEditing(libraryId: string, guideId: string, takeOver: boolean) {
      const result = await inner.openForEditing(libraryId, guideId, takeOver);
      if (result.kind === "editing") editing.set(keyOf({ libraryId, guideId }), false);
      return result;
    },
    async releaseLock(libraryId: string, guideId: string) {
      const key = keyOf({ libraryId, guideId });
      const dirty = editing.get(key);
      editing.delete(key);
      open.delete(key);
      await inner.releaseLock(libraryId, guideId);
      if (dirty) await countSave(libraryId, guideId).catch(() => undefined);
    },
    async createGuide(libraryId: string, title: string) {
      const created = await inner.createGuide(libraryId, title);
      const id = (created.guide as { id?: unknown }).id;
      if (typeof id === "string")
        await inner
          .writeGuideHistory(libraryId, id, {
            formatVersion: 1,
            saves: 0,
            created: await stamp(),
            lastSaved: null,
            events: [],
          })
          .catch(() => undefined);
      return created;
    },
  } satisfies Partial<LibraryBridge>);

  const writeLock = async (libraryId: string, guideId: string, password: string, who: Who) => {
    const lock: GuideLock = {
      formatVersion: 1,
      locked: who,
      password: await hashPassword(password, deps.iterations),
    };
    await inner.writeGuideLock(libraryId, guideId, lock);
  };

  const unlock = async (guide: GuideRef, password: string): Promise<UnlockResult> => {
    const key = keyOf(guide);
    const wait = guesses.waitFor(key);
    if (wait > 0) return { kind: "wait", ms: wait };
    const lock = await lockOf(guide);
    if (!lock) {
      open.add(key);
      return { kind: "unlocked", recovery: false };
    }
    if (await checkPassword(password, lock.password)) {
      guesses.succeeded(key);
      open.add(key);
      return { kind: "unlocked", recovery: false };
    }
    const recovery = deps.recoveryPassword();
    if (recovery && (await checkPassword(password, recovery))) {
      guesses.succeeded(key);
      open.add(key);
      await addEvent(guide.libraryId, guide.guideId, "unlockedWithRecovery").catch(() => undefined);
      return { kind: "unlocked", recovery: true };
    }
    guesses.failed(key);
    return { kind: "wrong" };
  };

  /** Asks for the password of a guide that's locked and not open; "opened" when it was. */
  const ask = async (guide: GuideTarget, label: string) => {
    if (open.has(keyOf(guide))) return "open";
    const lock = await lockOf(guide).catch(() => null);
    if (!lock) return "open";
    const target = { ...guide, locked: { by: lock.locked.by, at: lock.locked.at } };
    const opened = await deps.prompts.password(target, label, (password) =>
      unlock(target, password),
    );
    return opened ? "opened" : "cancelled";
  };

  /** A password that opened one guide, tried on another; a miss isn't a wrong try. */
  const unlockIfMatches = async (guide: LockTarget, password: string) => {
    const key = keyOf(guide);
    if (guesses.waitFor(key) > 0) return false;
    const lock = await lockOf(guide);
    if (lock && !(await checkPassword(password, lock.password))) return false;
    open.add(key);
    return true;
  };

  return {
    library,
    lockOf,
    history,
    isOpen: (guide) => open.has(keyOf(guide)),
    unlock,

    async runOnGuide(guide, label, action) {
      const asked = await ask(guide, label);
      if (asked === "cancelled") return false;
      try {
        await action();
      } finally {
        if (asked === "opened") open.delete(keyOf(guide));
      }
      return true;
    },

    async unlockToEdit(guide, label) {
      return (await ask(guide, label)) !== "cancelled";
    },

    async runOnLocked(targets, body, act) {
      if (targets.length === 0) return;
      let left = targets;
      await deps.prompts.list(targets, body, async (target, password) => {
        const result = await unlock(target, password);
        if (result.kind !== "unlocked") return result;
        const opened = [target];
        for (const other of left)
          if (!same(other, target) && (await unlockIfMatches(other, password))) opened.push(other);
        const done: LockTarget[] = [];
        const failed: { target: LockTarget; problem: unknown }[] = [];
        for (const item of opened) {
          try {
            await act(item);
            done.push(item);
          } catch (problem) {
            failed.push({ target: item, problem });
          } finally {
            open.delete(keyOf(item));
          }
        }
        left = left.filter((item) => !done.some((one) => same(one, item)));
        return { kind: "done", done, failed, left };
      });
    },

    relock(guide) {
      open.delete(keyOf(guide));
    },

    async lock(guide, password) {
      const { libraryId, guideId } = guide;
      // Locking someone else's lock over would take it from them.
      if (await lockOf(guide)) throw new GuideLockedError((await stamp()).by);
      await writeLock(libraryId, guideId, password, await stamp());
      open.delete(keyOf(guide));
      await addEvent(libraryId, guideId, "locked").catch(() => undefined);
    },

    async removeLock(guide) {
      const { libraryId, guideId } = guide;
      const lock = await lockOf(guide);
      if (!lock) return;
      if (!open.has(keyOf(guide))) throw new GuideLockedError(lock.locked.by);
      await inner.writeGuideLock(libraryId, guideId, null);
      open.delete(keyOf(guide));
      await addEvent(libraryId, guideId, "lockRemoved").catch(() => undefined);
    },

    async changePassword(guide, password) {
      const { libraryId, guideId } = guide;
      const lock = await lockOf(guide);
      if (!lock) return;
      if (!open.has(keyOf(guide))) throw new GuideLockedError(lock.locked.by);
      // The guide still says who locked it, and when; the history says who changed the password.
      await writeLock(libraryId, guideId, password, lock.locked);
      open.delete(keyOf(guide));
      await addEvent(libraryId, guideId, "passwordChanged").catch(() => undefined);
    },
  };
}
