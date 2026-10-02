import "fake-indexeddb/auto";

import { recordingFactSchema, type RecordedStep, type RecordingFact } from "@amluto-steps/core";
import { beforeEach, describe, expect, it } from "vitest";

import { openLibraryDb, type LibraryDb } from "../library/db";
import { browserTarget } from "../library/store";
import { journal, openJournal, type Journal } from "./journal";

let count = 0;
let log: Journal;
let library: LibraryDb;

beforeEach(async () => {
  count += 1;
  log = journal(await openJournal(`journal-${count}`));
  library = await openLibraryDb(`library-${count}`);
  await log.startSession({
    sessionId: "s1",
    title: "Pay an invoice",
    author: "Sam",
    startedAt: 1,
    stopped: false,
    restartAfter: null,
  });
});

const page = { tabId: 1, title: "Invoices", origin: "https://finance.example.test" };
const fact = (sequence: number): RecordingFact =>
  recordingFactSchema.parse({
    sessionId: "s1",
    recordedAt: 1_790_000_000_000 + sequence,
    sequence,
    record: { kind: "pageNavigation", tickMs: sequence, page, origin: page.origin },
  });

const step = (sequence: number, mediaId: string | null = null) =>
  ({
    id: `capture-${sequence}`,
    sortKey: String(sequence).padStart(10, "0"),
    kind: "interaction",
    action: "click",
    actionText: `Click ${sequence}`,
    media: mediaId ? { id: mediaId, width: 10, height: 10, scale: 1, captureRect: null } : null,
  }) as unknown as RecordedStep;

describe("the recording journal", () => {
  it("keeps facts in the order they happened, however they were written", async () => {
    await log.appendFact(fact(3));
    await log.appendFact(fact(1));
    await log.appendFact(fact(2));
    expect((await log.facts("s1")).map((each) => each.sequence)).toEqual([1, 2, 3]);
    expect(await log.recoveries()).toEqual([
      {
        sessionId: "s1",
        title: "Pay an invoice",
        eventCount: 3,
        stopped: false,
        savedGuideId: null,
      },
    ]);
  });

  it("saves the draft being reviewed, step by step", async () => {
    await log.saveDraft("s1", { id: "s1", title: "Pay" }, [step(1), step(2)]);
    await log.saveDraftStep("s1", { ...step(2), actionText: "Reworded" });
    await log.deleteDraftStep("s1", "capture-1");
    const draft = await log.loadDraft("s1");
    expect(draft?.steps).toEqual([{ ...step(2), actionText: "Reworded" }]);
  });

  it("publishes the draft to the library on Save, with its author and screenshots, then forgets it", async () => {
    await log.putImage("s1", "shot.webp", new Blob(["image"]), 10, 10);
    await log.putImage("s1", "unused.webp", new Blob(["image"]), 10, 10);
    await log.appendFact(fact(1));
    await log.saveDraft("s1", { id: "s1", title: "Pay" }, [step(1, "shot")]);
    await log.finalize(
      "s1",
      { id: "s1", title: "Pay", owner: "", formatVersion: 1 },
      browserTarget(library),
    );

    const guide = await library.get("guides", "s1");
    expect(guide?.guide).toMatchObject({
      title: "Pay",
      owner: "Sam",
      createdBy: "Sam",
      recordingSessionId: "s1",
    });
    expect((await library.getAll("steps")).map((each) => each.id)).toEqual(["capture-1"]);
    expect((await library.getAll("media")).map((each) => each.id)).toEqual(["shot"]);
    expect(await log.recoveries()).toEqual([]);
  });

  it("leaves steps from before a Start again out when there's no draft", async () => {
    await log.appendStep("s1", step(1));
    await log.appendStep("s1", step(2));
    await log.updateSession("s1", { restartAfter: 1 });
    await log.finalize("s1", { id: "s1", title: "Pay" }, browserTarget(library));
    expect((await library.getAll("steps")).map((each) => each.id)).toEqual(["capture-2"]);
  });

  it("only cleans up a recording already published, and refuses to overwrite another guide", async () => {
    await library.put("guides", { id: "s1", guide: { id: "s1", recordingSessionId: "s1" } });
    await log.finalize("s1", { id: "s1" }, browserTarget(library));
    expect(await log.recoveries()).toEqual([]);

    await log.startSession({
      sessionId: "s2",
      title: "Other",
      author: "Sam",
      startedAt: 2,
      stopped: true,
      restartAfter: null,
    });
    await library.put("guides", { id: "taken", guide: { id: "taken" } });
    await expect(log.finalize("s2", { id: "taken" }, browserTarget(library))).rejects.toMatchObject(
      {
        code: "guideExists",
      },
    );
  });

  it("credits the name given since, for a recording started before there was one", async () => {
    await log.updateSession("s1", { author: "" });
    await log.finalize("s1", { id: "s1", title: "Pay" }, browserTarget(library), "Robin");
    expect((await library.get("guides", "s1"))?.guide).toMatchObject({ owner: "Robin" });
  });
});
