import type {
  Bin,
  Comments,
  DraftInfo,
  EditLock,
  FileDialogs,
  GuideConflict,
  GuideCopies,
  GuideFiles,
  GuideLockFiles,
  GuideSearchHit,
  Libraries,
  LibraryBridge,
  LibraryGuideSummary,
  LibraryInfo,
  LockLost,
  MediaInfo,
  RawGuideDocument,
  ReviewComment,
  SharedEditing,
  StepsFiles,
  TrashEntry,
  VersionInfo,
  Versions,
} from "./library-bridge";

/*
 * The library bridge's fakes (07/10/2026): one per small interface, each over one store of guides
 * kept in memory (`FakeLibraryData`), and `fakeLibrary` putting them all together. Tests use them
 * in place of partial casts, and the preview builds its made-up library on them. They keep the
 * contract every edition keeps (`packages/ui/src/library-contract.ts`).
 */

type Json = Record<string, unknown>;

/** A picture in a guide: its size and the data URL it's shown from. */
export interface FakeMedia {
  width: number;
  height: number;
  url: string;
}

/** One guide as the fake keeps it. */
export interface FakeGuide {
  guide: Json;
  steps: Map<string, Json>;
  media: Map<string, FakeMedia>;
  /** `password-lock.json` and `history.json`, as written. */
  lock: unknown;
  history: unknown;
  /** Review comments: threads and their replies, oldest first. */
  comments: FakeComment[];
  versions: { info: VersionInfo; document: RawGuideDocument }[];
  /** Pictures whose blurs have been burned in. */
  burned: Set<string>;
  /** Someone else editing it, in a shared library; null when nobody is. */
  editor: EditLock | null;
  /** Sync conflicts waiting for a decision. */
  conflicts: GuideConflict[];
  drafts: { info: DraftInfo; document: RawGuideDocument }[];
}

/** A review comment as the fake keeps it: a thread's first comment, or a reply (`replyTo`). */
export interface FakeComment {
  id: string;
  text: string;
  by: string;
  at: string;
  stepId: string | null;
  replyTo: string | null;
  resolved: { by: string; at: string } | null;
}

/** One library as the fake keeps it. */
export interface FakeLibraryRecord {
  id: string;
  name: string;
  path: string;
  synced: boolean;
  guides: Map<string, FakeGuide>;
  /** The Bin, by its entries' ids. */
  trash: Map<string, { entry: TrashEntry; guide: FakeGuide }>;
}

/** What the file dialogs answer: a path, or null as when cancelled. */
export interface FakePicks {
  folder: string | null;
  file: string | null;
  saveLocation: string | null;
}

/** Everything the fake library keeps, shared by the fakes of each part. */
export interface FakeLibraryData {
  libraries: Map<string, FakeLibraryRecord>;
  defaultId: string;
  /** Steps files saved, by path. */
  files: Map<string, RawGuideDocument>;
  picks: FakePicks;
  /** Everyone listening for a lost edit lock. */
  lockLost: Set<(lost: LockLost) => void>;
  /** Whoever is using it: the author of new guides and comments. */
  me: string;
  now: () => string;
  newId: (prefix: string) => string;
}

/** A refusal, with the same codes as the editions' (`errors.<code>` in en.json). */
class FakeLibraryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fail = (code: string, message: string) => Promise.reject(new FakeLibraryError(code, message));

export interface FakeLibraryOptions {
  /** The libraries there are, the first the default; one empty "My guides" (`lib-1`) if none. */
  libraries?: {
    id: string;
    name: string;
    path?: string;
    /** In a folder OneDrive or SharePoint syncs. */
    synced?: boolean;
    guides?: RawGuideDocument[];
  }[];
  picks?: Partial<FakePicks>;
  me?: string;
  now?: () => Date;
}

const newGuide = (guide: Json, steps = new Map<string, Json>()): FakeGuide => ({
  guide,
  steps,
  media: new Map(),
  lock: null,
  history: null,
  comments: [],
  versions: [],
  burned: new Set(),
  editor: null,
  conflicts: [],
  drafts: [],
});

const guideFrom = (document: RawGuideDocument): FakeGuide => {
  const { guide, steps } = structuredClone(document) as { guide: Json; steps: Json[] };
  return newGuide(guide, new Map(steps.map((step) => [String(step.id), step])));
};

export function fakeLibraryData(options: FakeLibraryOptions = {}): FakeLibraryData {
  let ids = 0;
  const given = options.libraries ?? [{ id: "lib-1", name: "My guides" }];
  const libraries = new Map<string, FakeLibraryRecord>();
  for (const library of given) {
    const guides = new Map<string, FakeGuide>();
    for (const document of library.guides ?? [])
      guides.set(String((document.guide as Json).id), guideFrom(document));
    libraries.set(library.id, {
      id: library.id,
      name: library.name,
      path: library.path ?? library.name,
      synced: library.synced ?? false,
      guides,
      trash: new Map(),
    });
  }
  return {
    libraries,
    defaultId: given[0]?.id ?? "",
    files: new Map(),
    picks: { folder: null, file: null, saveLocation: null, ...options.picks },
    lockLost: new Set(),
    me: options.me ?? "Robin",
    now: () => (options.now ?? (() => new Date()))().toISOString(),
    newId: (prefix) => {
      ids += 1;
      return `${prefix}-${ids}`;
    },
  };
}

const sortKeyOf = (step: Json) => String(step.sortKey ?? "");
const stepsOf = (guide: FakeGuide) =>
  [...guide.steps.values()].sort((a, b) => (sortKeyOf(a) < sortKeyOf(b) ? -1 : 1));

const documentOf = (guide: FakeGuide): RawGuideDocument => ({
  guide: structuredClone(guide.guide),
  steps: structuredClone(stepsOf(guide)),
});

const mediaIdOf = (step: Json) => {
  const media = step.media as { id?: unknown } | null | undefined;
  return typeof media?.id === "string" ? media.id : null;
};

const lockedOf = (guide: FakeGuide) => {
  const locked = (guide.lock as { locked?: { by?: unknown; at?: unknown } } | null)?.locked;
  return locked ? { locked: { by: String(locked.by), at: String(locked.at) } } : {};
};

const summaryOf = (guide: FakeGuide): LibraryGuideSummary => ({
  ...lockedOf(guide),
  id: String(guide.guide.id),
  title: String(guide.guide.title ?? ""),
  updatedAt: String(guide.guide.updatedAt ?? ""),
  stepCount: guide.steps.size,
  tags: Array.isArray(guide.guide.tags) ? (guide.guide.tags as string[]) : [],
  owner: String(guide.guide.owner ?? ""),
  reviewBy: typeof guide.guide.reviewBy === "string" ? guide.guide.reviewBy : null,
  thumbnailMediaId:
    stepsOf(guide)
      .map(mediaIdOf)
      .find((id) => id !== null) ?? null,
  openComments: guide.comments.filter((each) => each.replyTo === null && each.resolved === null)
    .length,
});

/** The library's record, or a refusal. */
const libraryIn = (data: FakeLibraryData, libraryId: string) => {
  const found = data.libraries.get(libraryId);
  return found ? Promise.resolve(found) : fail("libraryNotFound", libraryId);
};

const guideIn = async (data: FakeLibraryData, libraryId: string, guideId: string) => {
  const found = (await libraryIn(data, libraryId)).guides.get(guideId);
  return found ?? fail("guideNotFound", guideId);
};

/** A picture's size from its PNG header; 0 × 0 for anything else. */
const pngSize = (bytes: Uint8Array) => {
  const png = bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return png ? { width: view.getUint32(16), height: view.getUint32(20) } : { width: 0, height: 0 };
};

const dataUrl = (bytes: Uint8Array) =>
  `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;

/** A new picture, kept in the guide. */
const keepPicture = (data: FakeLibraryData, guide: FakeGuide, picture: FakeMedia): MediaInfo => {
  const id = data.newId("media");
  guide.media.set(id, picture);
  return { id, width: picture.width, height: picture.height };
};

/**
 * Search as the editions do it: every word of the query somewhere in the card (title, tags,
 * owner) or the wording; where the card doesn't show a word, the first step that has it.
 */
function search(guide: FakeGuide, query: string): GuideSearchHit | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const card = summaryOf(guide);
  const cardText = `${card.title} ${card.tags.join(" ")} ${card.owner}`.toLowerCase();
  const passages = stepsOf(guide).map((step, index) => ({
    number: index + 1,
    snippet: String(step.actionText ?? ""),
    text: `${String(step.actionText ?? "")} ${JSON.stringify(step.notes ?? "")}`.toLowerCase(),
  }));
  const all = `${cardText} ${passages.map((passage) => passage.text).join(" ")}`;
  if (words.length === 0 || !words.every((word) => all.includes(word))) return null;
  const word = words.find((each) => !cardText.includes(each));
  const found = word ? passages.find((passage) => passage.text.includes(word)) : undefined;
  return {
    guideId: card.id,
    foundIn: found ? { stepNumber: found.number, snippet: found.snippet } : null,
  };
}

/** A library's guides and their pictures, kept in memory. */
export function fakeGuideFiles(data: FakeLibraryData): GuideFiles {
  const touch = (guide: FakeGuide) => {
    guide.guide.updatedAt = data.now();
  };
  return {
    async listGuides(libraryId) {
      return [...(await libraryIn(data, libraryId)).guides.values()].map(summaryOf);
    },
    async searchGuides(libraryId, query) {
      const guides = [...(await libraryIn(data, libraryId)).guides.values()];
      return guides.flatMap((guide) => search(guide, query) ?? []);
    },
    async loadGuide(libraryId, guideId) {
      return documentOf(await guideIn(data, libraryId, guideId));
    },
    async createGuide(libraryId, title) {
      const library = await libraryIn(data, libraryId);
      const now = data.now();
      const guide: Json = {
        id: data.newId("guide"),
        title,
        description: "",
        intro: null,
        outro: null,
        brandProfileId: null,
        tags: [],
        owner: data.me,
        reviewBy: null,
        createdAt: now,
        createdBy: data.me,
        updatedAt: now,
        updatedBy: data.me,
        formatVersion: 1,
      };
      const stored = newGuide(guide);
      library.guides.set(String(guide.id), stored);
      return documentOf(stored);
    },
    async saveGuide(libraryId, guideId, guide) {
      const stored = await guideIn(data, libraryId, guideId);
      const value = structuredClone(guide) as Json;
      if (value.id !== guideId) return fail("invalidRequest", "The guide's id doesn't match.");
      stored.guide = value;
    },
    async saveStep(libraryId, guideId, step) {
      const stored = await guideIn(data, libraryId, guideId);
      const value = structuredClone(step) as Json;
      stored.steps.set(String(value.id), value);
      touch(stored);
    },
    async deleteStep(libraryId, guideId, stepId) {
      const stored = await guideIn(data, libraryId, guideId);
      stored.steps.delete(stepId);
      touch(stored);
    },
    async importImage(libraryId, guideId, bytes) {
      const stored = await guideIn(data, libraryId, guideId);
      return keepPicture(data, stored, { ...pngSize(bytes), url: dataUrl(bytes) });
    },
    // The window in front is a plain 1280 × 800 picture here.
    async retakeImage(libraryId, guideId) {
      const stored = await guideIn(data, libraryId, guideId);
      return keepPicture(data, stored, { width: 1280, height: 800, url: "data:image/png;base64," });
    },
    async loadImage(libraryId, guideId, mediaId) {
      const picture = (await guideIn(data, libraryId, guideId)).media.get(mediaId);
      return picture ? picture.url : fail("imageNotFound", mediaId);
    },
    async guideStats(libraryId, guideId) {
      const stored = await guideIn(data, libraryId, guideId);
      const bytes = [...stored.media.values()].reduce(
        (sum, picture) => sum + picture.url.length,
        0,
      );
      return { pictures: stored.media.size, bytes };
    },
  };
}

/** Each guide's password lock and history, kept with it. */
export function fakeGuideLockFiles(data: FakeLibraryData): GuideLockFiles {
  return {
    async guideMeta(libraryId, guideId) {
      const guide = await guideIn(data, libraryId, guideId);
      return { lock: structuredClone(guide.lock), history: structuredClone(guide.history) };
    },
    async writeGuideLock(libraryId, guideId, lock) {
      (await guideIn(data, libraryId, guideId)).lock = structuredClone(lock);
    },
    async writeGuideHistory(libraryId, guideId, history) {
      (await guideIn(data, libraryId, guideId)).history = structuredClone(history);
    },
  };
}

/** Each library's Bin. As in every edition, the Bin takes a guide's password lock off. */
export function fakeBin(data: FakeLibraryData): Bin {
  const binned = async (libraryId: string, trashId: string) => {
    const found = (await libraryIn(data, libraryId)).trash.get(trashId);
    return found ?? fail("trashNotFound", trashId);
  };
  return {
    async trashGuide(libraryId, guideId) {
      const library = await libraryIn(data, libraryId);
      const guide = await guideIn(data, libraryId, guideId);
      const entry: TrashEntry = {
        trashId: data.newId("trash"),
        guideId,
        title: String(guide.guide.title ?? ""),
        deletedAt: data.now(),
      };
      library.guides.delete(guideId);
      guide.lock = null;
      library.trash.set(entry.trashId, { entry, guide });
      return { ...entry };
    },
    async listTrash(libraryId) {
      return [...(await libraryIn(data, libraryId)).trash.values()].map(({ entry }) => ({
        ...entry,
      }));
    },
    async restoreGuide(libraryId, trashId) {
      const library = await libraryIn(data, libraryId);
      const { entry, guide } = await binned(libraryId, trashId);
      if (library.guides.has(entry.guideId)) return fail("guideExists", entry.guideId);
      library.trash.delete(trashId);
      library.guides.set(entry.guideId, guide);
      return summaryOf(guide);
    },
    async deleteTrashed(libraryId, trashId) {
      await binned(libraryId, trashId);
      (await libraryIn(data, libraryId)).trash.delete(trashId);
    },
    async emptyTrash(libraryId) {
      const library = await libraryIn(data, libraryId);
      const count = library.trash.size;
      library.trash.clear();
      return count;
    },
  };
}

/** Review comments on each guide; only their writer may delete them, a thread once it's alone. */
export function fakeComments(data: FakeLibraryData): Comments {
  const reviewComment = (comment: FakeComment): ReviewComment => ({
    id: comment.id,
    text: comment.text,
    by: comment.by,
    at: comment.at,
    mine: comment.by === data.me,
  });
  const threadIn = async (libraryId: string, guideId: string, thread: string) => {
    const guide = await guideIn(data, libraryId, guideId);
    const found = guide.comments.find((each) => each.id === thread && each.replyTo === null);
    return found ?? fail("invalidRequest", "that comment has been deleted");
  };
  return {
    async listComments(libraryId, guideId) {
      const { comments } = await guideIn(data, libraryId, guideId);
      return comments
        .filter((each) => each.replyTo === null)
        .map((thread) => ({
          ...reviewComment(thread),
          stepId: thread.stepId,
          resolved: thread.resolved ? { ...thread.resolved } : null,
          replies: comments.filter((each) => each.replyTo === thread.id).map(reviewComment),
        }));
    },
    async addComment(libraryId, guideId, stepId, replyTo, text) {
      const guide = await guideIn(data, libraryId, guideId);
      if (replyTo !== null) await threadIn(libraryId, guideId, replyTo);
      const trimmed = text.trim();
      if (!trimmed) return fail("invalidRequest", "a comment has some words");
      const comment: FakeComment = {
        id: data.newId("comment"),
        text: trimmed,
        by: data.me,
        at: data.now(),
        stepId: replyTo === null ? stepId : null,
        replyTo,
        resolved: null,
      };
      guide.comments.push(comment);
      return comment.id;
    },
    async resolveComment(libraryId, guideId, thread, resolved) {
      const found = await threadIn(libraryId, guideId, thread);
      found.resolved = resolved ? { by: data.me, at: data.now() } : null;
    },
    async deleteComment(libraryId, guideId, comment) {
      const guide = await guideIn(data, libraryId, guideId);
      const found = guide.comments.find((each) => each.id === comment);
      if (!found) return fail("invalidRequest", "that comment has been deleted");
      if (found.by !== data.me)
        return fail("invalidRequest", "only the person who wrote a comment can delete it");
      if (guide.comments.some((each) => each.replyTo === comment))
        return fail("invalidRequest", "a comment with replies can't be deleted");
      guide.comments = guide.comments.filter((each) => each.id !== comment);
    },
  };
}

/** Each guide's saved versions, and its burned-in blurs. */
export function fakeVersions(data: FakeLibraryData): Versions {
  const save = (guide: FakeGuide, note: string): VersionInfo => {
    const info: VersionInfo = {
      id: data.newId("version"),
      createdAt: data.now(),
      note,
      createdBy: data.me,
      stepCount: guide.steps.size,
    };
    guide.versions.push({ info, document: documentOf(guide) });
    return { ...info };
  };
  const versionIn = async (libraryId: string, guideId: string, versionId: string) => {
    const guide = await guideIn(data, libraryId, guideId);
    const found = guide.versions.find((each) => each.info.id === versionId);
    return found ?? fail("versionNotFound", versionId);
  };
  return {
    async saveVersion(libraryId, guideId, note) {
      return save(await guideIn(data, libraryId, guideId), note.trim());
    },
    async listVersions(libraryId, guideId) {
      const guide = await guideIn(data, libraryId, guideId);
      return guide.versions.map((each) => ({ ...each.info })).reverse();
    },
    async loadVersion(libraryId, guideId, versionId) {
      return structuredClone((await versionIn(libraryId, guideId, versionId)).document);
    },
    // As the editions do, the guide as it was is kept as a version first.
    async restoreVersion(libraryId, guideId, versionId) {
      const guide = await guideIn(data, libraryId, guideId);
      const { document } = await versionIn(libraryId, guideId, versionId);
      save(guide, "Before restoring");
      guide.guide = { ...(structuredClone(document.guide) as Json), id: guideId };
      guide.steps = new Map(
        (structuredClone(document.steps) as Json[]).map((step) => [String(step.id), step]),
      );
      return documentOf(guide);
    },
    // Each picture under a blur, in the guide or its versions, not yet burned in.
    async applyRedactions(libraryId, guideId) {
      const guide = await guideIn(data, libraryId, guideId);
      const steps = [
        ...guide.steps.values(),
        ...guide.versions.flatMap((each) => each.document.steps as Json[]),
      ];
      const blurred = new Set(
        steps
          .filter((step) => Array.isArray(step.redactions) && step.redactions.length > 0)
          .flatMap((step) => mediaIdOf(step) ?? [])
          .filter((mediaId) => !guide.burned.has(mediaId)),
      );
      for (const mediaId of blurred) guide.burned.add(mediaId);
      return blurred.size;
    },
  };
}

/** A guide put into a library under a free id: its own, or a new one when that's taken. */
const putGuide = (
  data: FakeLibraryData,
  library: FakeLibraryRecord,
  guide: FakeGuide,
  id = String(guide.guide.id),
) => {
  const free = library.guides.has(id) ? data.newId("guide") : id;
  guide.guide = { ...guide.guide, id: free };
  library.guides.set(free, guide);
  return summaryOf(guide);
};

/** A copy of a guide's steps and pictures, without its lock, history, comments or versions. */
const copyOf = (guide: FakeGuide): FakeGuide => {
  const copy = guideFrom(documentOf(guide));
  copy.media = new Map(guide.media);
  return copy;
};

/** Duplicate, Copy to, Move to and Merge guides, between the fake's libraries. */
export function fakeGuideCopies(data: FakeLibraryData): GuideCopies {
  return {
    async duplicateGuide(libraryId, guideId, title) {
      const library = await libraryIn(data, libraryId);
      const copy = copyOf(await guideIn(data, libraryId, guideId));
      copy.guide.title = title;
      return putGuide(data, library, copy, data.newId("guide"));
    },
    async createFromParts(libraryId, guide, steps, media) {
      const library = await libraryIn(data, libraryId);
      const made = guideFrom({ guide, steps });
      for (const item of media) {
        const from = await guideIn(data, item.fromLibraryId, item.fromGuideId);
        const picture = from.media.get(item.mediaId);
        if (!picture) return fail("imageNotFound", item.mediaId);
        made.media.set(item.newMediaId, picture);
      }
      if (library.guides.has(String(made.guide.id)))
        return fail("guideExists", String(made.guide.id));
      return putGuide(data, library, made);
    },
    async copyGuide(fromLibraryId, guideId, toLibraryId) {
      const copy = copyOf(await guideIn(data, fromLibraryId, guideId));
      return putGuide(data, await libraryIn(data, toLibraryId), copy);
    },
    // A move takes the guide's lock and history with it.
    async moveGuide(fromLibraryId, guideId, toLibraryId) {
      const from = await libraryIn(data, fromLibraryId);
      const to = await libraryIn(data, toLibraryId);
      const guide = await guideIn(data, fromLibraryId, guideId);
      if (from === to) return summaryOf(guide);
      from.guides.delete(guideId);
      return putGuide(data, to, guide);
    },
  };
}

/**
 * Shared editing, for one person: a guide opens for editing unless a test has put someone else
 * in `editor`, and takes their place when asked to. A lost lock reaches every listener through
 * `FakeLibrary.loseLock`. The fingerprints are the guides themselves, so any change shows.
 */
export function fakeSharedEditing(data: FakeLibraryData): SharedEditing {
  const draftIn = async (libraryId: string, guideId: string, draftId: string) => {
    const guide = await guideIn(data, libraryId, guideId);
    const found = guide.drafts.find((each) => each.info.id === draftId);
    return found ?? fail("invalidRequest", "that draft has gone");
  };
  return {
    async openForEditing(libraryId, guideId, takeOver) {
      const guide = await guideIn(data, libraryId, guideId);
      if (guide.editor && !takeOver) return { kind: "readOnly", lock: { ...guide.editor } };
      guide.editor = null;
      return { kind: "editing" };
    },
    async releaseLock(libraryId, guideId) {
      await guideIn(data, libraryId, guideId);
    },
    onLockLost(handler) {
      data.lockLost.add(handler);
      return Promise.resolve(() => {
        data.lockLost.delete(handler);
      });
    },
    async fingerprint(libraryId) {
      const library = await libraryIn(data, libraryId);
      return JSON.stringify([...library.guides.values()].map(documentOf));
    },
    async guideFingerprint(libraryId, guideId) {
      return JSON.stringify(documentOf(await guideIn(data, libraryId, guideId)));
    },
    async listConflicts(libraryId, guideId) {
      return structuredClone((await guideIn(data, libraryId, guideId)).conflicts);
    },
    async resolveConflict(libraryId, guideId, conflict) {
      const guide = await guideIn(data, libraryId, guideId);
      guide.conflicts = guide.conflicts.filter(
        (each) => (each.kind === "restored" ? each.id : each.file) !== conflict,
      );
    },
    async saveDraft(libraryId, guideId, draft) {
      const guide = await guideIn(data, libraryId, guideId);
      const info: DraftInfo = {
        id: data.newId("draft"),
        by: data.me,
        at: data.now(),
        stepCount: draft.steps.length,
      };
      guide.drafts.push({ info, document: structuredClone(draft) });
    },
    async listDrafts(libraryId, guideId) {
      return (await guideIn(data, libraryId, guideId)).drafts.map((each) => ({ ...each.info }));
    },
    async discardDraft(libraryId, guideId, draftId) {
      const guide = await guideIn(data, libraryId, guideId);
      guide.drafts = guide.drafts.filter((each) => each.info.id !== draftId);
    },
    async draftToCopy(libraryId, guideId, draftId, title) {
      const library = await libraryIn(data, libraryId);
      const guide = await guideIn(data, libraryId, guideId);
      const draft = await draftIn(libraryId, guideId, draftId);
      const copy = guideFrom(draft.document);
      copy.guide.title = title;
      guide.drafts = guide.drafts.filter((each) => each !== draft);
      return putGuide(data, library, copy, data.newId("guide"));
    },
  };
}

/** The list of libraries; a library's path is only a name here. */
export function fakeLibraries(data: FakeLibraryData): Libraries {
  const infoOf = (library: FakeLibraryRecord): LibraryInfo => ({
    id: library.id,
    name: library.name,
    path: library.path,
    isDefault: library.id === data.defaultId,
    managed: false,
    synced: library.synced,
    guideCount: library.guides.size,
  });
  return {
    listLibraries: () => Promise.resolve([...data.libraries.values()].map(infoOf)),
    addLibrary(name, path) {
      if ([...data.libraries.values()].some((each) => each.path === path))
        return fail("libraryExists", path);
      const library: FakeLibraryRecord = {
        id: data.newId("library"),
        name,
        path,
        synced: false,
        guides: new Map(),
        trash: new Map(),
      };
      data.libraries.set(library.id, library);
      return Promise.resolve(infoOf(library));
    },
    async renameLibrary(libraryId, name) {
      const library = await libraryIn(data, libraryId);
      library.name = name;
      return infoOf(library);
    },
    async removeLibrary(libraryId) {
      await libraryIn(data, libraryId);
      data.libraries.delete(libraryId);
    },
    async setDefaultLibrary(libraryId) {
      const library = await libraryIn(data, libraryId);
      data.defaultId = libraryId;
      return infoOf(library);
    },
    async openFolder(libraryId) {
      await libraryIn(data, libraryId);
    },
  };
}

/** Steps files, kept in memory by path; one opened again comes in as a new guide if need be. */
export function fakeStepsFiles(data: FakeLibraryData): StepsFiles {
  return {
    async exportAmlsteps(libraryId, guideId, destination) {
      data.files.set(destination, documentOf(await guideIn(data, libraryId, guideId)));
    },
    async importAmlsteps(libraryId, source) {
      const library = await libraryIn(data, libraryId);
      const document = data.files.get(source);
      if (!document) return fail("invalidRequest", "That isn't a Steps file.");
      return putGuide(data, library, guideFrom(document));
    },
  };
}

/** The file dialogs, answering what `data.picks` says. */
export function fakeFileDialogs(data: FakeLibraryData): FileDialogs {
  return {
    pickFolder: () => Promise.resolve(data.picks.folder),
    pickFile: () => Promise.resolve(data.picks.file),
    pickSaveLocation: () => Promise.resolve(data.picks.saveLocation),
  };
}

export interface FakeLibrary extends LibraryBridge {
  /** What it keeps, for a test to look at or change. */
  readonly data: FakeLibraryData;
  /** Someone took over a guide this window was editing: tells every listener. */
  loseLock(lost: LockLost): void;
}

/** A whole library bridge in memory, made of each part's fake over one store of guides. */
export function fakeLibrary(options: FakeLibraryOptions = {}): FakeLibrary {
  const data = fakeLibraryData(options);
  return {
    data,
    loseLock: (lost) => {
      for (const handler of data.lockLost) handler(lost);
    },
    ...fakeLibraries(data),
    ...fakeGuideFiles(data),
    ...fakeGuideLockFiles(data),
    ...fakeSharedEditing(data),
    ...fakeComments(data),
    ...fakeBin(data),
    ...fakeGuideCopies(data),
    ...fakeVersions(data),
    ...fakeStepsFiles(data),
    ...fakeFileDialogs(data),
  };
}
