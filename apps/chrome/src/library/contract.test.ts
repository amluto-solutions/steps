import "fake-indexeddb/auto";

import { libraryContract } from "@amluto-steps/ui/library-contract";

import type { FileAccess } from "../files";
import { memoryDir } from "../folder/dir";
import type { FolderHandle, FolderRegistry, RegisteredFolder } from "../folder/registry";
import { createLibraryRouter } from "../folder/router";

import { openLibraryDb } from "./db";
import type { ImageCodec } from "./images";
import { BROWSER_LIBRARY_ID, createBrowserLibrary } from "./store";

/** A PNG header with this size: all the codec below reads. */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** Drawing without a canvas: every picture is a PNG header with its size; pixels are grey. */
const codec: ImageCodec = {
  async measure(blob) {
    const view = new DataView(await blob.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20) };
  },
  render: (_blob, width, height) => Promise.resolve(new Blob([png(width, height).slice()])),
  pixels: () =>
    Promise.resolve({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128), width: 8, height: 8 }),
  encode: (image) => Promise.resolve(new Blob([png(image.width, image.height).slice()])),
};

/** Files in memory, by the token a save was given. */
function memoryFiles(): FileAccess {
  const saved = new Map<string, Uint8Array>();
  return {
    pickFile: () => Promise.resolve(null),
    pickSaveLocation: () => Promise.resolve(null),
    read: (token) => Promise.resolve(saved.get(token) ?? new Uint8Array()),
    write: (token, bytes) => {
      saved.set(token, bytes);
      return Promise.resolve(token);
    },
  };
}

function memoryRegistry(): FolderRegistry {
  const folders = new Map<string, RegisteredFolder>();
  let chosen: string | null = null;
  return {
    list: () => Promise.resolve([...folders.values()]),
    put: (entry) => {
      folders.set(entry.id, entry);
      return Promise.resolve();
    },
    remove: (id) => {
      folders.delete(id);
      return Promise.resolve();
    },
    defaultId: () => Promise.resolve(chosen),
    setDefaultId: (id) => {
      chosen = id;
      return Promise.resolve();
    },
  };
}

let count = 0;

/**
 * Steps for Chrome's library as its pages have it (`setup.ts`): the router over the library in
 * the browser, with a shared folder added as a second library.
 */
async function chromeLibrary() {
  count += 1;
  const db = await openLibraryDb(`contract-${count}`);
  const files = memoryFiles();
  const shared = memoryDir("Shared");
  const handle: FolderHandle = {
    name: "Shared",
    permitted: () => Promise.resolve(true),
    open: () => shared,
    same: (other) => Promise.resolve(other.open() === shared),
  };
  const library = createLibraryRouter({
    browser: createBrowserLibrary({
      db,
      codec,
      displayName: () => "Robin",
      files,
      appVersion: "9.9.9",
    }),
    db,
    registry: memoryRegistry(),
    codec,
    files,
    appVersion: "9.9.9",
    displayName: () => "Robin",
    pc: "PC-1",
    session: `session-${count}`,
    pickFolder: () => Promise.resolve(handle),
  });
  const token = await library.pickFolder("Choose");
  const folderId = (await library.addLibrary("Shared", token ?? "")).id;
  return { library, folderId };
}

libraryContract("Steps for Chrome, the library in the browser", async () => {
  const { library, folderId } = await chromeLibrary();
  return { library, libraryId: BROWSER_LIBRARY_ID, otherLibraryId: folderId };
});

libraryContract("Steps for Chrome, a shared folder", async () => {
  const { library, folderId } = await chromeLibrary();
  return { library, libraryId: folderId, otherLibraryId: BROWSER_LIBRARY_ID };
});
