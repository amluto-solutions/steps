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

import type { LibraryBridge } from "../library-bridge";

/**
 * Password locks on guides (docs/spec/03-data-and-sharing.md#password-locks, 04/10/2026).
 *
 * Every library the app uses goes through `withGuideLocks`, for the desktop and the browser
 * extension alike: a locked guide's changes, moves and deletes are refused until it's unlocked
 * with its password, for this editing session only. Viewing, exporting, duplicating, copying,
 * merging and comments are never refused. The storage underneath only keeps the lock and history
 * files; what a lock allows is decided here. It also counts saves and records who saved last.
 */

/** A change refused because the guide is locked; its message is who locked it. */
export class GuideLockedError extends Error {
  readonly code = "guideLocked";
}

/** How a password went. */
export type UnlockResult =
  { kind: "unlocked"; recovery: boolean } | { kind: "wrong" } | { kind: "wait"; ms: number };

export interface GuideLockDeps {
  /** Who is acting now: the display name, and the PC and login when they're recorded. */
  who: () => Promise<Omit<Who, "at">>;
  /** IT's recovery password hash, if set. */
  recoveryPassword: () => string | null;
  now?: () => Date;
  /** PBKDF2 rounds for new passwords (tests use fewer). */
  iterations?: number;
}

export interface GuideLocks {
  /** The wrapped library: use it for everything. */
  readonly library: LibraryBridge;
  lockOf(libraryId: string, guideId: string): Promise<GuideLock | null>;
  history(libraryId: string, guideId: string): Promise<GuideHistory>;
  /** Unlocked with its password in this session (or not locked at all). */
  isOpen(libraryId: string, guideId: string): boolean;
  /** Tries a password: unlocks the guide for this session when it's right. */
  unlock(libraryId: string, guideId: string, password: string): Promise<UnlockResult>;
  /**
   * The several-guides screen: a password that just opened one guide is also tried on the others.
   * A miss here isn't counted as a wrong try, as nobody typed it for that guide.
   */
  unlockIfMatches(libraryId: string, guideId: string, password: string): Promise<boolean>;
  /** Ends this session's unlock (the editor closed, a bulk action finished). */
  relock(libraryId: string, guideId: string): void;
  lock(libraryId: string, guideId: string, password: string): Promise<void>;
  /** Takes the lock off for good; the password is asked first (`unlock`). */
  removeLock(libraryId: string, guideId: string): Promise<void>;
  /** A new password; the guide must be unlocked with the old one first. */
  changePassword(libraryId: string, guideId: string, password: string): Promise<void>;
}

const keyOf = (libraryId: string, guideId: string) => `${libraryId}\u0000${guideId}`;

/** What a guide's own changes are: refused while it's locked, and counted as saves. */
const CHANGES = [
  "saveGuide",
  "saveStep",
  "deleteStep",
  "resolveConflict",
  "applyRedactions",
  "restoreVersion",
] as const;

export function withGuideLocks(inner: LibraryBridge, deps: GuideLockDeps): GuideLocks {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  const open = new Set<string>();
  /** Editing sessions that have changed their guide, to count as one save when they end. */
  const editing = new Map<string, boolean>();
  const guesses = new GuessLimit();

  const lockOf = async (libraryId: string, guideId: string) =>
    parseGuideLock((await inner.guideMeta(libraryId, guideId)).lock);
  const history = async (libraryId: string, guideId: string) =>
    parseGuideHistory((await inner.guideMeta(libraryId, guideId)).history);

  const stamp = async (): Promise<Who> => ({ ...(await deps.who()), at: now() });

  const addEvent = async (libraryId: string, guideId: string, kind: HistoryEvent["kind"]) => {
    const event = { ...(await stamp()), kind };
    const before = await history(libraryId, guideId);
    await inner.writeGuideHistory(libraryId, guideId, withEvent(before, event));
  };

  /** One save: a session that changed the guide, or a change made outside one (a rename). */
  const countSave = async (libraryId: string, guideId: string) => {
    const before = await history(libraryId, guideId);
    await inner.writeGuideHistory(libraryId, guideId, {
      ...before,
      saves: before.saves + 1,
      lastSaved: await stamp(),
    });
  };

  /** Refuses unless the guide isn't locked or is unlocked in this session. */
  const mayChange = async (libraryId: string, guideId: string) => {
    if (open.has(keyOf(libraryId, guideId))) return;
    const lock = await lockOf(libraryId, guideId).catch(() => null);
    if (lock) throw new GuideLockedError(lock.locked.by);
  };

  const changed = async (libraryId: string, guideId: string) => {
    const key = keyOf(libraryId, guideId);
    if (editing.has(key)) editing.set(key, true);
    // A history that can't be written never stops the change itself.
    else await countSave(libraryId, guideId).catch(() => undefined);
  };

  const library: LibraryBridge = Object.create(inner) as LibraryBridge;
  for (const name of CHANGES) {
    const original = inner[name] as (...args: unknown[]) => Promise<unknown>;
    (library as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
      const [libraryId, guideId] = args as [string, string];
      await mayChange(libraryId, guideId);
      const result = await original.apply(inner, args);
      await changed(libraryId, guideId);
      return result;
    };
  }

  Object.assign(library, {
    async openForEditing(libraryId: string, guideId: string, takeOver: boolean) {
      const result = await inner.openForEditing(libraryId, guideId, takeOver);
      if (result.kind === "editing") editing.set(keyOf(libraryId, guideId), false);
      return result;
    },
    async releaseLock(libraryId: string, guideId: string) {
      const key = keyOf(libraryId, guideId);
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
    // Moving and deleting need the password too; the Bin takes the lock off.
    async trashGuide(libraryId: string, guideId: string) {
      await mayChange(libraryId, guideId);
      const wasLocked = (await lockOf(libraryId, guideId).catch(() => null)) !== null;
      const entry = await inner.trashGuide(libraryId, guideId);
      open.delete(keyOf(libraryId, guideId));
      if (wasLocked) await addEvent(libraryId, guideId, "binned").catch(() => undefined);
      return entry;
    },
    async moveGuide(fromLibraryId: string, guideId: string, toLibraryId: string) {
      await mayChange(fromLibraryId, guideId);
      return inner.moveGuide(fromLibraryId, guideId, toLibraryId);
    },
    // A guide's lock is changed only through `lock`, `removeLock` and `changePassword`.
    writeGuideLock: () => Promise.reject(new Error("guideLockDirect")),
    ...(inner.exportAndRemove
      ? {
          async exportAndRemove(libraryId: string, guideId: string, folder: string) {
            await mayChange(libraryId, guideId);
            return inner.exportAndRemove?.(libraryId, guideId, folder) ?? "";
          },
        }
      : {}),
  } satisfies Partial<LibraryBridge>);

  const writeLock = async (libraryId: string, guideId: string, password: string, who: Who) => {
    const lock: GuideLock = {
      formatVersion: 1,
      locked: who,
      password: await hashPassword(password, deps.iterations),
    };
    await inner.writeGuideLock(libraryId, guideId, lock);
  };

  return {
    library,
    lockOf,
    history,
    isOpen: (libraryId, guideId) => open.has(keyOf(libraryId, guideId)),

    async unlock(libraryId, guideId, password) {
      const key = keyOf(libraryId, guideId);
      const wait = guesses.waitFor(key);
      if (wait > 0) return { kind: "wait", ms: wait };
      const lock = await lockOf(libraryId, guideId);
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
        await addEvent(libraryId, guideId, "unlockedWithRecovery").catch(() => undefined);
        return { kind: "unlocked", recovery: true };
      }
      guesses.failed(key);
      return { kind: "wrong" };
    },

    async unlockIfMatches(libraryId, guideId, password) {
      const key = keyOf(libraryId, guideId);
      if (guesses.waitFor(key) > 0) return false;
      const lock = await lockOf(libraryId, guideId);
      if (lock && !(await checkPassword(password, lock.password))) return false;
      open.add(key);
      return true;
    },

    relock(libraryId, guideId) {
      open.delete(keyOf(libraryId, guideId));
    },

    async lock(libraryId, guideId, password) {
      // Locking someone else's lock over would take it from them.
      if (await lockOf(libraryId, guideId)) throw new GuideLockedError((await stamp()).by);
      await writeLock(libraryId, guideId, password, await stamp());
      open.delete(keyOf(libraryId, guideId));
      await addEvent(libraryId, guideId, "locked").catch(() => undefined);
    },

    async removeLock(libraryId, guideId) {
      const lock = await lockOf(libraryId, guideId);
      if (!lock) return;
      if (!open.has(keyOf(libraryId, guideId))) throw new GuideLockedError(lock.locked.by);
      await inner.writeGuideLock(libraryId, guideId, null);
      open.delete(keyOf(libraryId, guideId));
      await addEvent(libraryId, guideId, "lockRemoved").catch(() => undefined);
    },

    async changePassword(libraryId, guideId, password) {
      const lock = await lockOf(libraryId, guideId);
      if (!lock) return;
      if (!open.has(keyOf(libraryId, guideId))) throw new GuideLockedError(lock.locked.by);
      // The guide still says who locked it, and when; the history says who changed the password.
      await writeLock(libraryId, guideId, password, lock.locked);
      open.delete(keyOf(libraryId, guideId));
      await addEvent(libraryId, guideId, "passwordChanged").catch(() => undefined);
    },
  };
}
