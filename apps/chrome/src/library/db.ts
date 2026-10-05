import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { Rect } from "./blur";

/**
 * The Chrome edition's library in IndexedDB (docs/spec/03-data-and-sharing.md#chrome-edition-storage):
 * the same guide and step JSON as the desktop's folders, and pictures as Blobs, never base64.
 */

export type Json = Record<string, unknown>;

export interface StoredGuide {
  id: string;
  guide: Json;
}

export interface StoredStep {
  guideId: string;
  id: string;
  step: Json;
}

export interface StoredMedia {
  guideId: string;
  id: string;
  image: Blob;
  /** Made the first time a thumbnail is asked for. */
  thumbnail: Blob | null;
  width: number;
  height: number;
}

export interface VersionInfo {
  id: string;
  createdAt: string;
  note: string;
  createdBy: string;
  stepCount: number;
}

export interface StoredVersion {
  guideId: string;
  id: string;
  info: VersionInfo;
  guide: Json;
  steps: Json[];
}

export interface TrashEntry {
  trashId: string;
  guideId: string;
  title: string;
  deletedAt: string;
}

/** A guide in the Bin, with everything that goes with it. */
export interface StoredTrash {
  trashId: string;
  entry: TrashEntry;
  guide: StoredGuide;
  steps: StoredStep[];
  media: StoredMedia[];
  versions: StoredVersion[];
  comments: StoredComment[];
  burned: StoredBurn | null;
}

/** Areas already burned into each burned copy, so applying blur again changes nothing. */
export interface StoredBurn {
  guideId: string;
  burned: Record<string, Rect[]>;
}

/** One comment action, written once: a comment, reply, resolve or reopen. */
export interface StoredComment {
  guideId: string;
  id: string;
  action: "comment" | "resolve" | "reopen";
  thread: string | null;
  stepId: string | null;
  text: string;
  by: string;
  at: string;
}

interface LibrarySchema extends DBSchema {
  guides: { key: string; value: StoredGuide };
  steps: { key: [string, string]; value: StoredStep; indexes: { guide: string } };
  media: { key: [string, string]; value: StoredMedia; indexes: { guide: string } };
  versions: { key: [string, string]; value: StoredVersion; indexes: { guide: string } };
  comments: { key: [string, string]; value: StoredComment; indexes: { guide: string } };
  burned: { key: string; value: StoredBurn };
  trash: { key: string; value: StoredTrash };
  /**
   * `revision`: raised by every change, for the live refresh. `lock:<guideId>` and
   * `history:<guideId>`: a guide's password lock and history (04/10/2026), kept out of the guide's
   * own record so nothing that copies a guide can take them along.
   */
  meta: { key: string; value: number | Json };
}

export type LibraryDb = IDBPDatabase<LibrarySchema>;

/** Every store a guide's data lives in, for transactions that touch a whole guide. */
export const GUIDE_STORES = ["guides", "steps", "media", "versions", "comments", "burned"] as const;

export function openLibraryDb(name = "steps-library"): Promise<LibraryDb> {
  return openDB<LibrarySchema>(name, 1, {
    upgrade(db) {
      db.createObjectStore("guides", { keyPath: "id" });
      for (const store of ["steps", "media", "versions", "comments"] as const)
        db.createObjectStore(store, { keyPath: ["guideId", "id"] }).createIndex("guide", "guideId");
      db.createObjectStore("burned", { keyPath: "guideId" });
      db.createObjectStore("trash", { keyPath: "trashId" });
      db.createObjectStore("meta");
    },
  });
}
