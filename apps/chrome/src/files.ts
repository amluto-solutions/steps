/**
 * Choosing files and saving them in the browser, behind the same calls the desktop's file dialogs
 * answer: a pick returns a token that stands for the file chosen (the UI treats it as a path),
 * and reading or writing goes through that token. Chrome's file pickers are used, so a save goes
 * where the person chooses; where they're refused, a download instead.
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface FileAccess {
  pickFile(title: string, filters: FileFilter[]): Promise<string | null>;
  pickSaveLocation(
    title: string,
    defaultName: string,
    filters: FileFilter[],
  ): Promise<string | null>;
  read(token: string): Promise<Uint8Array>;
  /** Saves to where the token was chosen; answers the file's name. */
  write(token: string, bytes: Uint8Array, type: string): Promise<string>;
  /** A folder to save several files into, asked for once; null when cancelled or unavailable. */
  pickFolder?(title: string): Promise<string | null>;
  /**
   * Saves a file in that folder under a name no other file has, then reads it back and checks
   * every byte, so nothing is removed on the strength of a file that didn't arrive whole.
   * Answers the name it was saved under.
   */
  saveInFolder?(token: string, name: string, bytes: Uint8Array, type: string): Promise<string>;
}

/** Firefox: "Export and remove" saves into the Downloads folder (see `saveToDownloads`). */
const DOWNLOADS_FOLDER = "downloads";

/**
 * Saves a file to the Downloads folder through the downloads API (Firefox, which has no folder
 * picker), and waits until the browser says it's written: complete, still there, and every byte
 * of it. Only then may the guide leave the browser. Answers the name it was saved under.
 */
export async function saveToDownloads(
  name: string,
  bytes: Uint8Array,
  type: string,
  api: typeof chrome.downloads = chrome.downloads,
): Promise<string> {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  try {
    const id = await api.download({
      url,
      filename: name,
      conflictAction: "uniquify",
      saveAs: false,
    });
    const item = await new Promise<chrome.downloads.DownloadItem>((resolve, reject) => {
      const check = async () => {
        const [found] = await api.search({ id });
        if (!found || found.state === "interrupted") {
          api.onChanged.removeListener(changed);
          reject(new Error(`${name} couldn't be saved.`));
        } else if (found.state === "complete") {
          api.onChanged.removeListener(changed);
          resolve(found);
        }
      };
      const changed = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id === id && delta.state) void check();
      };
      api.onChanged.addListener(changed);
      void check();
    });
    if (!item.exists || item.bytesReceived !== bytes.length)
      throw new Error(`${name} didn't save whole.`);
    return item.filename.split(/[\\/]/).pop() || name;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Saves as a download, into the browser's downloads folder (or where Chrome asks). */
export function download(name: string, bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}
type ShowOpen = (options: {
  types?: PickerType[];
  multiple?: boolean;
}) => Promise<FileSystemFileHandle[]>;
type ShowFolder = (options: { mode: "readwrite" }) => Promise<FileSystemDirectoryHandle>;
type ShowSave = (options: {
  suggestedName?: string;
  types?: PickerType[];
}) => Promise<FileSystemFileHandle>;
interface WritableHandle {
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}

const pickerTypes = (filters: FileFilter[]): PickerType[] =>
  filters.map((filter) => ({
    description: filter.name,
    accept: { "application/octet-stream": filter.extensions.map((extension) => `.${extension}`) },
  }));

/** A cancelled picker is a null answer, as the desktop dialogs give. */
const cancelled = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function browserFiles(): FileAccess {
  const chosen = new Map<string, File>();
  const targets = new Map<string, { name: string; handle: FileSystemFileHandle | null }>();
  const folders = new Map<string, FileSystemDirectoryHandle>();
  let next = 0;
  const token = (kind: string) => {
    next += 1;
    return `${kind}:${next}`;
  };
  const picker = globalThis as unknown as {
    showOpenFilePicker?: ShowOpen;
    showSaveFilePicker?: ShowSave;
    showDirectoryPicker?: ShowFolder;
  };

  return {
    async pickFile(_title, filters) {
      let file: File | null = null;
      if (picker.showOpenFilePicker) {
        try {
          const [handle] = await picker.showOpenFilePicker({ types: pickerTypes(filters) });
          file = handle ? await handle.getFile() : null;
        } catch (error) {
          if (cancelled(error)) return null;
          throw error;
        }
      } else {
        file = await new Promise<File | null>((resolve) => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = filters
            .flatMap((filter) => filter.extensions.map((ext) => `.${ext}`))
            .join(",");
          input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
          input.addEventListener("cancel", () => resolve(null));
          input.click();
        });
      }
      if (!file) return null;
      const id = token("file");
      chosen.set(id, file);
      return id;
    },

    async pickSaveLocation(_title, defaultName, filters) {
      const id = token("save");
      if (picker.showSaveFilePicker) {
        try {
          const handle = await picker.showSaveFilePicker({
            suggestedName: defaultName,
            types: pickerTypes(filters),
          });
          targets.set(id, { name: handle.name, handle });
          return id;
        } catch (error) {
          if (cancelled(error)) return null;
          // Refused (say, by policy): fall back to a download.
        }
      }
      targets.set(id, { name: defaultName, handle: null });
      return id;
    },

    async read(id) {
      const file = chosen.get(id);
      if (!file) throw new Error("That file is no longer available. Choose it again.");
      chosen.delete(id);
      return new Uint8Array(await file.arrayBuffer());
    },

    async pickFolder() {
      // Firefox has no folder picker: the guides go to its Downloads folder instead.
      if (!picker.showDirectoryPicker) return chrome.downloads ? DOWNLOADS_FOLDER : null;
      try {
        const handle = await picker.showDirectoryPicker({ mode: "readwrite" });
        const id = token("folder");
        folders.set(id, handle);
        return id;
      } catch (error) {
        if (cancelled(error)) return null;
        throw error;
      }
    },

    async saveInFolder(id, name, bytes, type) {
      if (id === DOWNLOADS_FOLDER) return saveToDownloads(name, bytes, type);
      const folder = folders.get(id);
      if (!folder) throw new Error("Choose the folder again.");
      const saved = await freeName(folder, name);
      const handle = await folder.getFileHandle(saved, { create: true });
      const writable = await (handle as unknown as WritableHandle).createWritable();
      await writable.write(new Blob([bytes.slice()], { type }));
      await writable.close();
      const back = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      if (!sameBytes(back, bytes)) throw new Error(`${saved} didn't save whole.`);
      return saved;
    },

    async write(id, bytes, type) {
      const target = targets.get(id);
      if (!target) throw new Error("Choose where to save it again.");
      targets.delete(id);
      if (!target.handle) return download(target.name, bytes, type);
      const writable = await (target.handle as unknown as WritableHandle).createWritable();
      await writable.write(new Blob([bytes.slice()], { type }));
      await writable.close();
      return target.name;
    },
  };
}

/** "Payroll.amlsteps", or "Payroll (2).amlsteps" and so on when that name is taken. */
async function freeName(folder: FileSystemDirectoryHandle, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 1; copy < 1000; copy += 1) {
    const candidate = copy === 1 ? name : `${stem} (${copy})${extension}`;
    try {
      await folder.getFileHandle(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error(`Too many files called ${name} in that folder.`);
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
