import { openDB, type DBSchema } from "idb";

import { newId } from "../library/ids";

import { handleDir, type Dir } from "./dir";

/**
 * The shared folders this browser knows as libraries (the desktop's `libraries.json`), kept in
 * IndexedDB with their File System Access handles, and which library new recordings go to. The
 * browser's own library is always there too; removing a folder from the list never touches it.
 */

/** A library folder as the router uses it. */
export interface FolderHandle {
  /** The folder's own name: the browser never says where it is. */
  readonly name: string;
  /**
   * Whether Steps may read and write it now. With `ask` (only from a click), asks the person when
   * the browser wants to, as after a restart.
   */
  permitted(ask: boolean): Promise<boolean>;
  open(): Dir;
  same(other: FolderHandle): Promise<boolean>;
}

export interface RegisteredFolder {
  id: string;
  name: string;
  folder: FolderHandle;
}

export interface FolderRegistry {
  list(): Promise<RegisteredFolder[]>;
  put(entry: RegisteredFolder): Promise<void>;
  remove(id: string): Promise<void>;
  /** Where new recordings go; null for the browser's own library. */
  defaultId(): Promise<string | null>;
  setDefaultId(id: string | null): Promise<void>;
}

// ---------- the browser's folders ----------

type Permission = "granted" | "denied" | "prompt";
interface PermissionHandle {
  queryPermission(options: { mode: "readwrite" }): Promise<Permission>;
  requestPermission(options: { mode: "readwrite" }): Promise<Permission>;
}

/** A folder the person chose, as the registry keeps it. */
export function handleFolder(
  handle: FileSystemDirectoryHandle,
): FolderHandle & { handle: FileSystemDirectoryHandle } {
  const asking = handle as unknown as PermissionHandle;
  return {
    handle,
    name: handle.name,
    async permitted(ask) {
      try {
        if ((await asking.queryPermission({ mode: "readwrite" })) === "granted") return true;
        // Without a click the browser refuses to ask, which is the same as no.
        return ask && (await asking.requestPermission({ mode: "readwrite" })) === "granted";
      } catch {
        return false;
      }
    },
    open: () => handleDir(handle),
    async same(other) {
      const theirs = (other as Partial<{ handle: FileSystemDirectoryHandle }>).handle;
      return theirs ? handle.isSameEntry(theirs) : false;
    },
  };
}

type ShowFolder = (options: {
  mode: "readwrite";
  id?: string;
}) => Promise<FileSystemDirectoryHandle>;

/** Whether this browser can choose folders (Chrome and Edge can; Firefox can't). */
export const canPickFolders = () =>
  typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** The folder picker, for a new library; null when cancelled. */
export async function pickLibraryFolder(): Promise<FolderHandle | null> {
  const show = (globalThis as unknown as { showDirectoryPicker: ShowFolder }).showDirectoryPicker;
  try {
    return handleFolder(await show({ mode: "readwrite", id: "steps-library" }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

interface RegistrySchema extends DBSchema {
  folders: { key: string; value: { id: string; name: string; handle: FileSystemDirectoryHandle } };
  meta: { key: string; value: string };
}

const DEFAULT = "defaultLibrary";

export async function openFolderRegistry(name = "steps-folders"): Promise<FolderRegistry> {
  const db = await openDB<RegistrySchema>(name, 1, {
    upgrade(database) {
      database.createObjectStore("folders", { keyPath: "id" });
      database.createObjectStore("meta");
    },
  });
  return {
    list: async () =>
      (await db.getAll("folders")).map((row) => ({
        id: row.id,
        name: row.name,
        folder: handleFolder(row.handle),
      })),
    async put(entry) {
      const handle = (entry.folder as Partial<{ handle: FileSystemDirectoryHandle }>).handle;
      if (!handle) throw new Error("Only a folder chosen in this browser can be a library.");
      await db.put("folders", { id: entry.id, name: entry.name, handle });
    },
    remove: (id) => db.delete("folders", id),
    defaultId: async () => (await db.get("meta", DEFAULT)) ?? null,
    async setDefaultId(id) {
      if (id === null) await db.delete("meta", DEFAULT);
      else await db.put("meta", id, DEFAULT);
    },
  };
}

// ---------- this browser, and this page ----------

const PC_KEY = "steps-pc";

/**
 * What stands for "this PC" on locks and comments (the desktop uses the computer's name, which a
 * browser can't read): made once per browser profile and kept.
 */
export async function browserPcId(): Promise<string> {
  const stored = (await chrome.storage.local.get(PC_KEY))[PC_KEY] as unknown;
  if (typeof stored === "string" && stored) return stored;
  const made = `browser-${newId().slice(16, 24)}`;
  await chrome.storage.local.set({ [PC_KEY]: made });
  return made;
}

const SESSION_LOCK = "steps-session-";

/**
 * Holds a Web Lock named after this page's editing session for as long as the page is open, so
 * another page can tell a lock left by a closed page (taken over at once) from one held by a
 * page still open, which is someone else editing (docs/spec/03-data-and-sharing.md).
 */
export function holdSession(session: string): void {
  void navigator.locks
    ?.request(`${SESSION_LOCK}${session}`, () => new Promise<void>(() => undefined))
    .catch(() => undefined);
}

/** Whether a page of Steps in this browser still has that session open. */
export async function sessionAlive(session: string): Promise<boolean> {
  if (!navigator.locks) return true;
  const state = await navigator.locks.query();
  return [...(state.held ?? []), ...(state.pending ?? [])].some(
    (lock) => lock.name === `${SESSION_LOCK}${session}`,
  );
}
