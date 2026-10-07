/**
 * How the UI reaches guide libraries (the desktop's `library_*` commands; Steps for Chrome's
 * library in the browser and its shared folders, `apps/chrome/src/folder/router.ts`). JSON files
 * come back unparsed and are validated by the `packages/core` schemas before use.
 */

/** A guide in a library: the two ids always travel together. */
export interface GuideRef {
  libraryId: string;
  guideId: string;
}

export interface LibraryInfo {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  /** Set by the organisation through policy, so it can't be changed or removed here. */
  managed: boolean;
  /** In a folder OneDrive or SharePoint syncs: others with access may see the originals. */
  synced: boolean;
  guideCount: number;
  /**
   * Steps for Chrome: the browser needs the person's permission to open this library's folder
   * again (`allowAccess`, from a click). Its guides can't be listed until then.
   */
  needsAccess?: boolean | undefined;
  /** Steps for Chrome: the library kept in the browser itself, which can't be taken off the list. */
  builtIn?: boolean | undefined;
}

export interface LibraryGuideSummary {
  id: string;
  title: string;
  updatedAt: string;
  stepCount: number;
  tags: string[];
  owner: string;
  reviewBy: string | null;
  thumbnailMediaId: string | null;
  /** Open review comment threads (absent from a library that predates comments). */
  openComments?: number | undefined;
  /** Steps for Chrome: the bytes the guide takes in browser storage (its versions included). */
  sizeBytes?: number | undefined;
  /** Locked with a password: who, and when (docs/spec/03-data-and-sharing.md#password-locks). */
  locked?: { by: string; at: string } | undefined;
}

/** A guide's password lock and history files as stored, unparsed (`null` where there's none). */
export interface GuideMetaFiles {
  lock: unknown;
  history: unknown;
}

/** What Properties shows about a guide's files. */
export interface GuideStats {
  pictures: number;
  /** On disk or in browser storage. */
  bytes: number;
}

/** Steps for Chrome: what the library takes in browser storage, and what the browser has left. */
export interface StorageUse {
  /** The guides' own bytes: pictures, steps, versions and comments, the Bin's included. */
  libraryBytes: number;
  /** `navigator.storage.estimate()`: everything Steps stores, and what it may; null if unknown. */
  usedBytes: number | null;
  quotaBytes: number | null;
}

/** A guide that matches a search of its wording (steps, notes, blocks, title, tags, owner). */
export interface GuideSearchHit {
  guideId: string;
  /** Where the words were found, when the card's title, tags and owner don't show them. */
  foundIn: { stepNumber: number | null; snippet: string } | null;
}

export interface RawGuideDocument {
  guide: unknown;
  steps: unknown[];
}

export interface MediaInfo {
  id: string;
  width: number;
  height: number;
}

export interface TrashEntry {
  trashId: string;
  guideId: string;
  title: string;
  deletedAt: string;
}

/** A screenshot for a guide built from parts (Merge guides): where it is, and its new id. */
export interface MediaFrom {
  fromLibraryId: string;
  fromGuideId: string;
  mediaId: string;
  newMediaId: string;
}

export interface VersionInfo {
  id: string;
  createdAt: string;
  note: string;
  createdBy: string;
  stepCount: number;
}

/** Who is editing a guide in a shared library (its `.lock`). */
export interface EditLock {
  name: string;
  pc: string;
  session: string;
  counter: number;
  /** ISO 8601, for "since 10:32"; never used to decide staleness. */
  since: string;
}

/** Whether a guide opened for editing, or read-only because someone else is editing it. */
export type Editing = { kind: "editing" } | { kind: "readOnly"; lock: EditLock };

/** A displaced editor's unsaved work, kept on the guide. */
export interface DraftInfo {
  id: string;
  by: string;
  /** ISO 8601. */
  at: string;
  stepCount: number;
}

/**
 * Something in a guide for a person to decide about: a sync client's conflict copy of a step or
 * of the guide's details, or a step someone deleted that came back because someone else edited it.
 */
export type GuideConflict =
  | { kind: "step"; file: string; id: string; from: string; ours: unknown; theirs: unknown }
  | { kind: "guide"; file: string; from: string; ours: unknown; theirs: unknown }
  | { kind: "restored"; id: string; deletedBy: string; step: unknown };

export type ConflictChoice = "keepOurs" | "keepTheirs" | "keepBoth";

/** A review comment (docs/spec/04-editor.md#review-comments). */
export interface ReviewComment {
  id: string;
  text: string;
  by: string;
  at: string;
  /** Written by this person on this PC, so they may delete it. */
  mine: boolean;
}

/** A thread: its first comment, on a step (`stepId`) or the whole guide, and its replies. */
export interface CommentThread extends ReviewComment {
  stepId: string | null;
  replies: ReviewComment[];
  resolved: { by: string; at: string } | null;
}

/** Someone took over a guide this app was editing. */
export interface LockLost {
  libraryId: string;
  guideId: string;
  lock: EditLock;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/*
 * The library bridge is split into small interfaces by what they're for (07/10/2026), so a part of
 * the UI can ask for only what it uses, and each has its own fake (`library-fake.ts`) and its own
 * laws in the contract suite (`packages/ui/src/library-contract.ts`), run against every edition's
 * adapter. `LibraryBridge` is all of them: what an edition provides, and what the guide locks wrap
 * (`CHANGES_GUIDE` classes every method of every part).
 */

/** The list of libraries (Settings > Libraries). */
export interface Libraries {
  /** Steps for Chrome: asks the browser again for a library's folder; true when it's allowed. */
  allowAccess?(libraryId: string): Promise<boolean>;
  listLibraries(): Promise<LibraryInfo[]>;
  addLibrary(name: string, path: string): Promise<LibraryInfo>;
  renameLibrary(libraryId: string, name: string): Promise<LibraryInfo>;
  removeLibrary(libraryId: string): Promise<void>;
  setDefaultLibrary(libraryId: string): Promise<LibraryInfo>;
  /** The desktop: opens a library's folder in Explorer. Absent in the browser, which can't. */
  openFolder?(libraryId: string): Promise<void>;
  /** Steps for Chrome (docs/spec/03-data-and-sharing.md#chrome-edition-storage). */
  storageUse?(libraryId: string): Promise<StorageUse>;
}

/** A library's guides and their pictures: listing, searching, opening and changing them. */
export interface GuideFiles {
  listGuides(libraryId: string): Promise<LibraryGuideSummary[]>;
  searchGuides(libraryId: string, query: string): Promise<GuideSearchHit[]>;
  loadGuide(libraryId: string, guideId: string): Promise<RawGuideDocument>;
  createGuide(libraryId: string, title: string): Promise<RawGuideDocument>;
  saveGuide(libraryId: string, guideId: string, guide: unknown): Promise<void>;
  saveStep(libraryId: string, guideId: string, step: unknown): Promise<void>;
  deleteStep(libraryId: string, guideId: string, stepId: string): Promise<void>;
  importImage(libraryId: string, guideId: string, bytes: Uint8Array): Promise<MediaInfo>;
  /**
   * Retake: after `delayMs`, the window in front becomes a new image in the guide, in the quality
   * Settings chose (Balanced when left out).
   */
  retakeImage(
    libraryId: string,
    guideId: string,
    delayMs: number,
    excluded: string[],
    quality?: "balanced" | "original",
  ): Promise<MediaInfo>;
  loadImage(
    libraryId: string,
    guideId: string,
    mediaId: string,
    thumbnail: boolean,
  ): Promise<string>;
  /** Pictures and size, for Properties; absent where it can't be told. */
  guideStats?(libraryId: string, guideId: string): Promise<GuideStats>;
}

/**
 * A guide's password lock and history (`password-lock.json`, `history.json`). Storage only:
 * what a lock allows is decided by `withGuideLocks` (library/guide-locks.ts). Neither file goes
 * with a copy; a move takes both, and the Bin takes the lock off.
 */
export interface GuideLockFiles {
  guideMeta(libraryId: string, guideId: string): Promise<GuideMetaFiles>;
  /** Writes the lock, or takes it off (`null`). */
  writeGuideLock(libraryId: string, guideId: string, lock: unknown): Promise<void>;
  writeGuideHistory(libraryId: string, guideId: string, history: unknown): Promise<void>;
}

/**
 * Editing a guide in a library others share (docs/spec/03-data-and-sharing.md): the edit lock,
 * changes made elsewhere, sync conflicts, and the drafts of anyone displaced.
 */
export interface SharedEditing {
  /** Takes the guide's edit lock, or says who holds it. */
  openForEditing(libraryId: string, guideId: string, takeOver: boolean): Promise<Editing>;
  releaseLock(libraryId: string, guideId: string): Promise<void>;
  onLockLost(handler: (lost: LockLost) => void): Promise<() => void>;
  /** Changes whenever the library's guides change on disk (live refresh). */
  fingerprint(libraryId: string): Promise<string>;
  guideFingerprint(libraryId: string, guideId: string): Promise<string>;
  listConflicts(libraryId: string, guideId: string): Promise<GuideConflict[]>;
  /** `conflict` is the copy's file, or a restored step's id. */
  resolveConflict(
    libraryId: string,
    guideId: string,
    conflict: string,
    choice: ConflictChoice,
  ): Promise<void>;
  saveDraft(
    libraryId: string,
    guideId: string,
    draft: { guide: unknown; steps: unknown[] },
  ): Promise<void>;
  listDrafts(libraryId: string, guideId: string): Promise<DraftInfo[]>;
  discardDraft(libraryId: string, guideId: string, draftId: string): Promise<void>;
  draftToCopy(
    libraryId: string,
    guideId: string,
    draftId: string,
    title: string,
  ): Promise<LibraryGuideSummary>;
}

/** Review comments. They need no edit lock: anyone can comment while someone else edits. */
export interface Comments {
  listComments(libraryId: string, guideId: string): Promise<CommentThread[]>;
  /** Starts a thread (`replyTo` null) or replies to one; returns the new comment's id. */
  addComment(
    libraryId: string,
    guideId: string,
    stepId: string | null,
    replyTo: string | null,
    text: string,
  ): Promise<string>;
  resolveComment(
    libraryId: string,
    guideId: string,
    thread: string,
    resolved: boolean,
  ): Promise<void>;
  deleteComment(libraryId: string, guideId: string, comment: string): Promise<void>;
}

/** A library's Bin. */
export interface Bin {
  trashGuide(libraryId: string, guideId: string): Promise<TrashEntry>;
  listTrash(libraryId: string): Promise<TrashEntry[]>;
  restoreGuide(libraryId: string, trashId: string): Promise<LibraryGuideSummary>;
  /** Deletes a guide in the Bin for good: it can't be undone, so the UI asks first. */
  deleteTrashed(libraryId: string, trashId: string): Promise<void>;
  /** Empties the Bin for good; answers how many guides were deleted. */
  emptyTrash(libraryId: string): Promise<number>;
}

/** Guides made from others (Duplicate, Copy to, Merge guides), and Move to. */
export interface GuideCopies {
  duplicateGuide(libraryId: string, guideId: string, title: string): Promise<LibraryGuideSummary>;
  /**
   * Merge guides: writes a new guide (its id new) worked out from parts of others, in any
   * libraries, with their screenshots copied under new ids. The guides it came from are only read.
   */
  createFromParts(
    libraryId: string,
    guide: unknown,
    steps: unknown[],
    media: MediaFrom[],
  ): Promise<LibraryGuideSummary>;
  copyGuide(
    fromLibraryId: string,
    guideId: string,
    toLibraryId: string,
  ): Promise<LibraryGuideSummary>;
  moveGuide(
    fromLibraryId: string,
    guideId: string,
    toLibraryId: string,
  ): Promise<LibraryGuideSummary>;
}

/** A guide's saved versions, and burning its blurs in. */
export interface Versions {
  saveVersion(libraryId: string, guideId: string, note: string): Promise<VersionInfo>;
  listVersions(libraryId: string, guideId: string): Promise<VersionInfo[]>;
  loadVersion(libraryId: string, guideId: string, versionId: string): Promise<RawGuideDocument>;
  restoreVersion(libraryId: string, guideId: string, versionId: string): Promise<RawGuideDocument>;
  /**
   * Burns every blur into its screenshot for good, in the guide and its saved versions, and
   * deletes the unblurred originals. Returns how many screenshots changed.
   */
  applyRedactions(libraryId: string, guideId: string): Promise<number>;
}

/** Steps files (`.amlsteps`): a guide saved as one file, and opened from one. */
export interface StepsFiles {
  exportAmlsteps(
    libraryId: string,
    guideId: string,
    destination: string,
    includeOriginals: boolean,
  ): Promise<void>;
  importAmlsteps(libraryId: string, source: string): Promise<LibraryGuideSummary>;
  /** Steps for Chrome: a folder to export into, asked for once; null when cancelled or unavailable. */
  pickExportFolder?(title: string): Promise<string | null>;
  /**
   * Steps for Chrome, "Export and remove": saves the guide as an `.amlsteps` file in that folder,
   * reads the file back to check it, and only then deletes the guide from the browser for good.
   * Answers the file's name.
   */
  exportAndRemove?(libraryId: string, guideId: string, folder: string): Promise<string>;
}

/** The standard file dialogs; each answers null when cancelled. */
export interface FileDialogs {
  /** The folder picker. */
  pickFolder(title: string): Promise<string | null>;
  /** The open-file dialog. */
  pickFile(title: string, filters: FileFilter[]): Promise<string | null>;
  /** The save-file dialog. */
  pickSaveLocation(
    title: string,
    defaultName: string,
    filters: FileFilter[],
  ): Promise<string | null>;
}

/**
 * How the UI reaches guide libraries: every part above, as each edition provides it (the
 * desktop's `library_*` commands; Steps for Chrome's library in the browser and its shared
 * folders, `apps/chrome/src/folder/router.ts`).
 */
export interface LibraryBridge
  extends
    Libraries,
    GuideFiles,
    GuideLockFiles,
    SharedEditing,
    Comments,
    Bin,
    GuideCopies,
    Versions,
    StepsFiles,
    FileDialogs {}
