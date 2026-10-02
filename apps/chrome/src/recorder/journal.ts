import type { RecordedStep, RecordingFact } from "@amluto-steps/core";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { Json } from "../library/db";
import { errors, isSafeId, LibraryError, text } from "../library/ids";
import { dataUrl } from "../library/images";
import type { PublishTarget } from "../library/store";

/**
 * The Chrome edition's recording journal (docs/spec/03-data-and-sharing.md#app-data-desktop-per-user
 * does the same on disk): every fact as it happens, screenshots, and the draft being reviewed, kept
 * apart from the library until Save. It lives in IndexedDB, so it outlasts the background worker,
 * which Chrome stops when idle, and a closed tab.
 */

export interface StoredSession {
  sessionId: string;
  title: string;
  author: string;
  startedAt: number;
  stopped: boolean;
  /** Facts at or before this sequence were dropped by "Start again". */
  restartAfter: number | null;
}

export interface RecoverySession {
  sessionId: string;
  title: string;
  eventCount: number;
  stopped: boolean;
  savedGuideId: string | null;
}

interface JournalSchema extends DBSchema {
  sessions: { key: string; value: StoredSession };
  facts: {
    key: [string, number];
    value: { sessionId: string; sequence: number; fact: RecordingFact };
    indexes: { session: string };
  };
  steps: {
    key: [string, string];
    value: { sessionId: string; id: string; step: RecordedStep };
    indexes: { session: string };
  };
  images: {
    key: [string, string];
    value: { sessionId: string; name: string; image: Blob; width: number; height: number };
    indexes: { session: string };
  };
  drafts: { key: string; value: { sessionId: string; guide: Json; steps: Record<string, Json> } };
}

export type JournalDb = IDBPDatabase<JournalSchema>;

const PER_SESSION = ["facts", "steps", "images"] as const;

export function openJournal(name = "steps-recordings"): Promise<JournalDb> {
  return openDB<JournalSchema>(name, 1, {
    upgrade(db) {
      db.createObjectStore("sessions", { keyPath: "sessionId" });
      db.createObjectStore("facts", { keyPath: ["sessionId", "sequence"] }).createIndex(
        "session",
        "sessionId",
      );
      db.createObjectStore("steps", { keyPath: ["sessionId", "id"] }).createIndex(
        "session",
        "sessionId",
      );
      db.createObjectStore("images", { keyPath: ["sessionId", "name"] }).createIndex(
        "session",
        "sessionId",
      );
      db.createObjectStore("drafts", { keyPath: "sessionId" });
    },
  });
}

const stepSequence = (id: string) => {
  const match = /^capture-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
};

/** The journal's reads and writes; the recorder bridge and the background both use it. */
export function journal(db: JournalDb) {
  const session = async (sessionId: string) => {
    if (!isSafeId(sessionId)) throw errors.invalidId("recording");
    const found = await db.get("sessions", sessionId);
    if (!found) throw new LibraryError("sessionNotFound", "That recording is no longer here.");
    return found;
  };

  const forget = async (sessionId: string) => {
    const tx = db.transaction(["sessions", "drafts", ...PER_SESSION], "readwrite");
    for (const store of PER_SESSION) {
      const index = tx.objectStore(store).index("session");
      for (const key of await index.getAllKeys(IDBKeyRange.only(sessionId)))
        await tx.objectStore(store).delete(key);
    }
    await tx.objectStore("drafts").delete(sessionId);
    await tx.objectStore("sessions").delete(sessionId);
    await tx.done;
  };

  return {
    startSession: (value: StoredSession) => db.put("sessions", value),
    session,
    updateSession: async (sessionId: string, change: Partial<StoredSession>) => {
      await db.put("sessions", { ...(await session(sessionId)), ...change });
    },

    appendFact: (fact: RecordingFact) =>
      db.put("facts", { sessionId: fact.sessionId, sequence: fact.sequence, fact }),
    facts: async (sessionId: string) =>
      (await db.getAllFromIndex("facts", "session", sessionId))
        .sort((a, b) => a.sequence - b.sequence)
        .map((row) => row.fact),

    appendStep: (sessionId: string, step: RecordedStep) =>
      db.put("steps", { sessionId, id: step.id, step }),
    steps: async (sessionId: string) =>
      (await db.getAllFromIndex("steps", "session", sessionId)).map((row) => row.step),

    putImage: (sessionId: string, name: string, image: Blob, width: number, height: number) =>
      db.put("images", { sessionId, name, image, width, height }),
    loadImage: async (sessionId: string, name: string) => {
      const found = await db.get("images", [sessionId, name]);
      if (!found) throw errors.imageNotFound();
      return dataUrl(found.image);
    },

    loadDraft: async (sessionId: string) => {
      const draft = await db.get("drafts", sessionId);
      return draft ? { guide: draft.guide, steps: Object.values(draft.steps) } : null;
    },
    saveDraft: async (sessionId: string, guide: unknown, steps: unknown[]) => {
      const byId = Object.fromEntries(
        steps
          .map((step) => [text(step as Json, "id"), step as Json])
          .filter(([id]) => isSafeId(id)),
      );
      await db.put("drafts", { sessionId, guide: guide as Json, steps: byId });
    },
    saveDraftGuide: async (sessionId: string, guide: unknown) => {
      const draft = await db.get("drafts", sessionId);
      await db.put("drafts", { sessionId, guide: guide as Json, steps: draft?.steps ?? {} });
    },
    saveDraftStep: async (sessionId: string, step: unknown) => {
      const draft = await db.get("drafts", sessionId);
      if (!draft)
        throw new LibraryError("draftNotFound", "Open the recording again, then try once more.");
      const id = text(step as Json, "id");
      if (!isSafeId(id)) throw errors.invalidId("step");
      await db.put("drafts", { ...draft, steps: { ...draft.steps, [id]: step as Json } });
    },
    deleteDraftStep: async (sessionId: string, stepId: string) => {
      const draft = await db.get("drafts", sessionId);
      if (!draft) return;
      const steps = Object.fromEntries(Object.entries(draft.steps).filter(([id]) => id !== stepId));
      await db.put("drafts", { ...draft, steps });
    },

    recoveries: async (): Promise<RecoverySession[]> =>
      Promise.all(
        (await db.getAll("sessions")).map(async (stored) => ({
          sessionId: stored.sessionId,
          title: stored.title,
          eventCount: await db.countFromIndex("facts", "session", stored.sessionId),
          stopped: stored.stopped,
          savedGuideId: null,
        })),
      ),

    discard: forget,

    /**
     * Save: the draft the person reviewed (or, without one, the recorded steps after any "Start
     * again") becomes a guide in the library, with the screenshots its steps use, and the journal
     * goes. A guide already published from this recording only needs the clean-up.
     */
    async finalize(
      sessionId: string,
      guide: Json,
      /** The default library: the browser's own, or a shared folder. */
      target: PublishTarget,
      /** The name in Settings now, for a recording started before one was given. */
      currentName = "",
    ): Promise<void> {
      const stored = await session(sessionId);
      const guideId = text(guide, "id");
      if (!isSafeId(guideId))
        throw new LibraryError("invalidGuide", "The guide has an invalid id.");
      const existing = await target.recordingOf(guideId);
      if (existing !== null) {
        if (existing === sessionId) return forget(sessionId);
        throw errors.guideExists();
      }
      const draft = await db.get("drafts", sessionId);
      const steps: Json[] = draft
        ? Object.values(draft.steps)
        : (await db.getAllFromIndex("steps", "session", sessionId))
            .map((row) => row.step as unknown as Json)
            .filter((step) => {
              const sequence = stepSequence(text(step, "id"));
              return (
                stored.restartAfter === null || sequence === null || sequence > stored.restartAfter
              );
            });
      const author = stored.author || currentName;
      const published: Json = {
        ...guide,
        recordingSessionId: sessionId,
        owner: author,
        createdBy: author,
        updatedBy: author,
      };
      const used = new Set(
        steps.map((step) => (step.media as { id?: unknown } | null)?.id).filter(isSafeId),
      );
      const images = await Promise.all(
        [...used].map((id) => db.get("images", [sessionId, `${id}.webp`])),
      );
      await target.publish(
        guideId,
        published,
        steps,
        images.flatMap((image) =>
          image
            ? [
                {
                  id: image.name.replace(/\.webp$/, ""),
                  image: image.image,
                  width: image.width,
                  height: image.height,
                },
              ]
            : [],
        ),
      );
      await forget(sessionId);
    },
  };
}

export type Journal = ReturnType<typeof journal>;
