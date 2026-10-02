import { LibraryError } from "../library/ids";

/**
 * A folder, as a shared library needs it (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome):
 * a File System Access directory handle in Chrome and Edge, or folders in memory for tests. Names
 * are single segments; the library walks paths itself.
 */

export interface FileStat {
  size: number;
  /** Milliseconds since 1970. */
  modified: number;
}

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface Dir {
  readonly name: string;
  /** What's directly inside, in no set order; empty when the folder has gone. */
  entries(): Promise<DirEntry[]>;
  /** A folder inside, or null when there's none. */
  folder(name: string): Promise<Dir | null>;
  /** A folder inside, made when missing. */
  makeFolder(name: string): Promise<Dir>;
  /** A file's contents, or null when there's none. */
  read(name: string): Promise<Blob | null>;
  /** A file's size and time, without reading it; null when there's none. */
  stat(name: string): Promise<FileStat | null>;
  /** Replaces or creates a file, so a reader sees the old file or the new one, never half. */
  write(name: string, data: Blob | Uint8Array | string): Promise<void>;
  /** Creates a file that isn't there yet; `exists` when it is. */
  create(name: string, data: Blob | Uint8Array | string): Promise<void>;
  /** Removes a file, or a folder with `recursive`; one already gone is fine. */
  remove(name: string, recursive?: boolean): Promise<void>;
  /** Whether both are the same folder on disk. */
  same(other: Dir): Promise<boolean>;
}

/** A file that was expected not to exist, did. */
export const exists = (name: string) =>
  new LibraryError("storageError", `Steps could not read or write the library: ${name} exists.`);

const storage = (error: unknown) =>
  error instanceof LibraryError
    ? error
    : new LibraryError(
        "storageError",
        `Steps could not read or write the library: ${error instanceof Error ? error.message : String(error)}`,
      );

/** Runs a folder operation, turning the browser's errors into the library's. */
export async function guarded<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw storage(error);
  }
}

const bytes = (data: Blob | Uint8Array | string): Blob =>
  data instanceof Blob ? data : new Blob([typeof data === "string" ? data : data.slice()]);

/** The folder at `path` under `dir`, or null when any part is missing. */
export async function walk(dir: Dir, ...path: string[]): Promise<Dir | null> {
  let current: Dir | null = dir;
  for (const name of path) {
    if (!current) return null;
    current = await current.folder(name);
  }
  return current;
}

// ---------- the browser's folders ----------

/** Missing, or a file where a folder was asked for (and the other way round). */
const absent = (error: unknown) =>
  error instanceof DOMException &&
  (error.name === "NotFoundError" || error.name === "TypeMismatchError");

/** A folder the person chose, through the File System Access API. */
export function handleDir(
  handle: FileSystemDirectoryHandle,
): Dir & { handle: FileSystemDirectoryHandle } {
  const file = async (name: string) => {
    try {
      return await handle.getFileHandle(name);
    } catch (error) {
      if (absent(error)) return null;
      throw storage(error);
    }
  };
  const put = async (name: string, data: Blob | Uint8Array | string) => {
    // A writable writes a swap file beside the target and swaps it in on close, so readers
    // (and a sync client) only ever see a whole file.
    const target = await handle.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    try {
      await writable.write(bytes(data));
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    await writable.close();
  };
  return {
    handle,
    name: handle.name,
    async entries() {
      const found: DirEntry[] = [];
      try {
        for await (const [name, child] of handle.entries())
          found.push({ name, kind: child.kind === "directory" ? "directory" : "file" });
      } catch (error) {
        if (absent(error)) return [];
        throw storage(error);
      }
      return found;
    },
    async folder(name) {
      try {
        return handleDir(await handle.getDirectoryHandle(name));
      } catch (error) {
        if (absent(error)) return null;
        throw storage(error);
      }
    },
    makeFolder: (name) =>
      guarded(async () => handleDir(await handle.getDirectoryHandle(name, { create: true }))),
    async read(name) {
      const found = await file(name);
      if (!found) return null;
      try {
        return await found.getFile();
      } catch (error) {
        if (absent(error)) return null;
        throw storage(error);
      }
    },
    async stat(name) {
      const found = await file(name);
      if (!found) return null;
      try {
        const got = await found.getFile();
        return { size: got.size, modified: got.lastModified };
      } catch (error) {
        if (absent(error)) return null;
        throw storage(error);
      }
    },
    write: (name, data) => guarded(() => put(name, data)),
    async create(name, data) {
      if (await file(name)) throw exists(name);
      await guarded(() => put(name, data));
    },
    async remove(name, recursive = false) {
      try {
        await handle.removeEntry(name, { recursive });
      } catch (error) {
        if (!absent(error)) throw storage(error);
      }
    },
    async same(other) {
      const theirs = (other as Partial<{ handle: FileSystemDirectoryHandle }>).handle;
      return theirs ? handle.isSameEntry(theirs) : false;
    },
  };
}

// ---------- folders in memory, for tests ----------

interface MemoryFile {
  data: Blob;
  modified: number;
}
interface MemoryFolder {
  children: Map<string, MemoryFile | MemoryFolder>;
}
const isFolder = (node: MemoryFile | MemoryFolder | undefined): node is MemoryFolder =>
  node !== undefined && "children" in node;

/** The last time a file in memory was written: each write is later, so a change always shows. */
let tick = 0;

/** Folders in memory, behaving as the browser's do; `failWrites` makes writes fail, as a full disk. */
export function memoryDir(
  name = "library",
  node: MemoryFolder = { children: new Map() },
  options: { failWrites?: (name: string) => boolean } = {},
): Dir & { node: MemoryFolder } {
  const fileAt = (child: string) => {
    const found = node.children.get(child);
    return found && !isFolder(found) ? found : null;
  };
  const put = (child: string, data: Blob | Uint8Array | string) => {
    if (options.failWrites?.(child)) throw storage(new Error(`${child} couldn't be written`));
    if (isFolder(node.children.get(child))) throw storage(new Error(`${child} is a folder`));
    tick = Math.max(Date.now(), tick + 1);
    node.children.set(child, { data: bytes(data), modified: tick });
  };
  return {
    node,
    name,
    entries: () =>
      Promise.resolve(
        [...node.children].map(([child, value]) => ({
          name: child,
          kind: isFolder(value) ? ("directory" as const) : ("file" as const),
        })),
      ),
    folder(child) {
      const found = node.children.get(child);
      return Promise.resolve(isFolder(found) ? memoryDir(child, found, options) : null);
    },
    makeFolder(child) {
      let found = node.children.get(child);
      if (found && !isFolder(found))
        return Promise.reject(storage(new Error(`${child} is a file`)));
      if (!found) {
        found = { children: new Map() };
        node.children.set(child, found);
      }
      return Promise.resolve(memoryDir(child, found, options));
    },
    read: (child) => Promise.resolve(fileAt(child)?.data ?? null),
    stat(child) {
      const found = fileAt(child);
      return Promise.resolve(found ? { size: found.data.size, modified: found.modified } : null);
    },
    async write(child, data) {
      put(child, data);
    },
    async create(child, data) {
      if (node.children.has(child)) throw exists(child);
      put(child, data);
    },
    async remove(child, recursive = false) {
      const found = node.children.get(child);
      if (isFolder(found) && found.children.size > 0 && !recursive)
        throw storage(new Error(`${child} isn't empty`));
      node.children.delete(child);
    },
    same: (other) => Promise.resolve((other as Partial<{ node: MemoryFolder }>).node === node),
  };
}
