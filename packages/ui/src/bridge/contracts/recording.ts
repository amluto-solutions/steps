import type { RecordedStep, RecordingSettings } from "@amluto-steps/core";
import { describe, expect, it, vi } from "vitest";

import type { RecorderFinished, RecorderSnapshot, Recording, StartOptions } from "../recording";
import type { RecordingJournal } from "../recording-journal";
import type { MakeSubject } from "./subject";

const SETTINGS: RecordingSettings = {
  showUnnamedTyping: true,
  wording: { language: "en", tone: "casual" },
};

/** The start dialog's choices for a contract's recording. */
export const START: StartOptions = { keys: false, output: false, settleMs: 0, settings: SETTINGS };

/** A step added outside the click pipeline, as the Add shortcut popup adds one. */
export const ADDED_STEP: RecordedStep = {
  id: "shortcut-1",
  sortKey: "0001",
  kind: "interaction",
  action: "keypress",
  actionText: 'Press "Ctrl + S"',
  textParts: { verb: "Press", target: "Ctrl + S", kind: "keys" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: null, windowTitle: "Invoices" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-10-07T10:00:00.000Z",
  updatedAt: "2026-10-07T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
};

const recordingNow = (snapshot: RecorderSnapshot) =>
  snapshot.state === "recording" || snapshot.state === "paused";

/** What the main window, the recording bar and the side panel rely on while recording. */
export function recordingContract(edition: string, make: MakeSubject<Recording>) {
  describe(`${edition}: recording`, () => {
    it("is idle until a recording starts", async () => {
      const { part } = await make();
      expect(await part.getState()).toMatchObject({ state: "idle" });
    });

    it("starts, pauses, resumes and stops, answering the recorder's state each time", async () => {
      const { part } = await make();
      const started = await part.start("Pay an invoice", START);
      expect(started.state).toBe("recording");
      expect(started.sessionId).toEqual(expect.any(String));
      expect(await part.pause()).toMatchObject({ state: "paused", sessionId: started.sessionId });
      expect((await part.getState()).state).toBe("paused");
      expect(await part.resume()).toMatchObject({ state: "recording" });
      expect(recordingNow(await part.stop())).toBe(false);
      expect(recordingNow(await part.getState())).toBe(false);
    });

    it("tells listeners the state as it changes, and that the recording has finished", async () => {
      const { part } = await make();
      const states: string[] = [];
      const finished: RecorderFinished[] = [];
      await part.onState((snapshot) => states.push(snapshot.state));
      await part.onFinished((end) => finished.push(end));
      const { sessionId } = await part.start("Pay an invoice", START);
      await part.stop();
      await vi.waitFor(() => expect(finished.map((end) => end.sessionId)).toEqual([sessionId]));
      expect(states).toContain("recording");
    });

    it("stops telling a listener once it stops listening", async () => {
      const { part } = await make();
      const states: string[] = [];
      const stop = await part.onState((snapshot) => states.push(snapshot.state));
      stop();
      await part.start("Pay an invoice", START);
      await part.discard();
      expect(states).toEqual([]);
    });

    it("discards a recording, leaving nothing recording", async () => {
      const { part } = await make();
      await part.start("Pay an invoice", START);
      expect(recordingNow(await part.discard())).toBe(false);
      expect(recordingNow(await part.getState())).toBe(false);
    });

    it("leaves an app out and lets it back in, answering the state", async () => {
      const { part } = await make();
      expect(await part.excludeApp("outlook.exe")).toMatchObject({ state: "idle" });
      expect(await part.includeApp("outlook.exe")).toMatchObject({ state: "idle" });
    });
  });
}

/** What recovery, the draft and Save rely on, after a recording. */
export function recordingJournalContract(
  edition: string,
  make: MakeSubject<Recording & RecordingJournal>,
) {
  /** A finished recording's session. */
  const recorded = async (part: Recording) => {
    const { sessionId } = await part.start("Pay an invoice", START);
    await part.stop();
    if (!sessionId) throw new Error("The recording had no session.");
    return sessionId;
  };

  describe(`${edition}: a recording's journal`, () => {
    it("lists a stopped recording for recovery, with the settings it started with", async () => {
      const { part } = await make();
      const sessionId = await recorded(part);
      await vi.waitFor(async () =>
        expect((await part.getRecoveries()).map((found) => found.sessionId)).toContain(sessionId),
      );
      expect(await part.getRecordingSettings(sessionId)).toEqual(SETTINGS);
      expect(await part.getRestartPoint(sessionId)).toBeNull();
      expect(Array.isArray(await part.getRecoveryRecords(sessionId))).toBe(true);
    });

    it("keeps a step added to the recording", async () => {
      const { part } = await make();
      const sessionId = await recorded(part);
      await part.appendStep(sessionId, ADDED_STEP);
      expect((await part.getSessionSteps(sessionId)).map((step) => step.id)).toContain(
        ADDED_STEP.id,
      );
    });

    it("keeps the draft made from it, step by step, until it's saved", async () => {
      const { part } = await make();
      const sessionId = await recorded(part);
      expect(await part.loadDraft(sessionId)).toBeNull();
      await part.saveDraft(sessionId, { title: "Pay an invoice" }, [
        { id: "s1", actionText: "Click Pay" },
        { id: "s2", actionText: "Click Confirm" },
      ]);
      await part.saveDraftStep(sessionId, { id: "s1", actionText: "Click Pay now" });
      await part.deleteDraftStep(sessionId, "s2");
      await part.saveDraftGuide(sessionId, { title: "Pay a supplier's invoice" });
      const draft = await part.loadDraft(sessionId);
      expect(draft?.guide).toMatchObject({ title: "Pay a supplier's invoice" });
      expect(draft?.steps).toEqual([{ id: "s1", actionText: "Click Pay now" }]);
    });
  });
}
