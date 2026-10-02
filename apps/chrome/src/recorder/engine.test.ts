import "fake-indexeddb/auto";

import { recordingFactSchema } from "@amluto-steps/core";
import { beforeEach, describe, expect, it } from "vitest";

import { createEngine, safeTitle, type Engine, type EngineEvent, type PageFacts } from "./engine";
import { journal, openJournal, type Journal } from "./journal";

let count = 0;
let engine: Engine;
let log: Journal;
let events: EngineEvent[];
let capturing: boolean;
let shots: number;
let originals: boolean[];
let clock: number;
let saved: unknown;
let kept: { image: Blob; lines: unknown[] }[];
/** A tab that's no longer in front when its screenshot would be taken. */
const behind = 9;

const tab: PageFacts = {
  tabId: 4,
  windowId: 1,
  title: "Invoices - Finance",
  url: "https://finance.example.test/invoices/42?token=secret",
};

const make = async (reuseSaved = false) => {
  engine = createEngine({
    journal: log,
    load: () => Promise.resolve(reuseSaved ? (saved as never) : undefined),
    save: (value) => {
      saved = structuredClone(value);
      return Promise.resolve();
    },
    screenshot: (_windowId, tabId, original) => {
      if (tabId === behind) return Promise.resolve(null);
      shots += 1;
      originals.push(original);
      return Promise.resolve({ image: new Blob(["png"]), width: 1920, height: 1080 });
    },
    capturing: (on) => {
      capturing = on;
      return Promise.resolve();
    },
    keepText: (image, lines) => {
      kept.push({ image, lines });
      return Promise.resolve();
    },
    broadcast: (event) => events.push(event),
    author: () => "Sam",
    now: () => clock,
  });
};

beforeEach(async () => {
  count += 1;
  log = journal(await openJournal(`engine-${count}`));
  events = [];
  capturing = false;
  shots = 0;
  originals = [];
  clock = 1_000;
  saved = undefined;
  kept = [];
  await make();
});

const button = { tagName: "BUTTON", innerText: "Approve" };
const pointer = { target: button, clickPct: { x: 50, y: 50 }, elementPct: null, scale: 2 };

describe("the Chrome recorder", () => {
  it("records clicks with a screenshot each, reusing one taken a moment before", async () => {
    const started = await engine.start("Pay an invoice", {
      keys: false,
      excluded: [],
      sensitive: [],
    });
    expect(started).toMatchObject({ state: "recording", stepCount: 0 });
    expect(capturing).toBe(true);

    await engine.pointer(tab, pointer);
    clock += 200; // too soon for Chrome to take another
    await engine.pointer(tab, pointer);
    clock += 600;
    await engine.pointer(tab, pointer);
    expect(shots).toBe(2);

    const facts = await log.facts(started.sessionId as string);
    expect(facts.map((fact) => fact.sequence)).toEqual([1, 2, 3]);
    // Every fact is valid in the shared format, and names the page by its site only.
    for (const fact of facts) recordingFactSchema.parse(fact);
    expect(facts[0]?.record).toMatchObject({
      kind: "pageClick",
      page: { origin: "https://finance.example.test", title: "Invoices - Finance" },
      capture: { width: 1920, height: 1080, scale: 2 },
    });
    expect(JSON.stringify(facts)).not.toContain("token=secret");
    expect((await engine.getState()).stepCount).toBe(3);
  });

  it("reads a typed value only when asked to, and never from a secret field", async () => {
    await engine.start("Typing", { keys: true, excluded: [], sensitive: [] });
    const field = { tagName: "INPUT", labelText: "Supplier" };
    await engine.input(tab, { target: field, value: "Acme", sensitive: false });
    await engine.input(tab, { target: field, value: "hunter2", sensitive: true });
    const { sessionId } = await engine.getState();
    const records = (await log.facts(sessionId as string)).map((fact) => fact.record);
    expect(records).toMatchObject([
      { kind: "pageInput", value: "Acme", withheld: null },
      { kind: "pageInput", value: null, withheld: "sensitive" },
    ]);

    await engine.stop();
    await engine.start("No typing", { keys: false, excluded: [], sensitive: [] });
    await engine.input(tab, { target: field, value: "Acme", sensitive: false });
    const second = (await engine.getState()).sessionId as string;
    expect((await log.facts(second))[0]?.record).toMatchObject({ value: null, withheld: "off" });
  });

  it("makes a step of a change of site, not of every page on it", async () => {
    await engine.start("Sites", { keys: false, excluded: [], sensitive: [] });
    await engine.navigated(tab);
    await engine.navigated({ ...tab, url: "https://finance.example.test/other" });
    await engine.navigated({ ...tab, url: "https://bank.example.test/" });
    const { sessionId } = await engine.getState();
    expect(
      (await log.facts(sessionId as string)).map((fact) =>
        fact.record.kind === "pageNavigation" ? fact.record.origin : null,
      ),
    ).toEqual(["https://finance.example.test", "https://bank.example.test"]);
  });

  it("keeps nothing from an excluded site, not even a screenshot", async () => {
    const bank = { ...tab, url: "https://online.bank.example.test/pay" };
    await engine.start("Excluded", {
      keys: true,
      excluded: ["bank.example.test"],
      sensitive: [],
    });
    await engine.navigated(bank);
    await engine.pointer(bank, pointer);
    await engine.input(bank, { target: { labelText: "Payee" }, value: "Acme", sensitive: false });
    await engine.pointer(tab, pointer);
    // Excluded during the recording, from the side panel.
    await engine.exclude("finance.example.test");
    clock += 1_000;
    await engine.pointer(tab, pointer);
    const { sessionId } = await engine.getState();
    const records = (await log.facts(sessionId as string)).map((fact) => fact.record.kind);
    expect(records).toEqual(["pageClick"]);
    expect(shots).toBe(1);
  });

  it("keeps nothing from an excluded site in a frame, and keeps an unplaced frame click", async () => {
    await engine.start("Frames", { keys: true, excluded: ["pay.example.test"], sensitive: [] });
    const payFrame = { ...tab, frameUrl: "https://checkout.pay.example.test/card" };
    await engine.pointer(payFrame, pointer);
    await engine.input(payFrame, { target: { labelText: "Name" }, value: "Sam", sensitive: false });
    const unplaced = { ...pointer, clickPct: null };
    await engine.pointer({ ...tab, frameUrl: "https://editor.example.test/" }, unplaced);
    const { sessionId } = await engine.getState();
    const facts = await log.facts(sessionId as string);
    expect(facts.map((fact) => fact.record.kind)).toEqual(["pageClick"]);
    expect(facts[0]?.record).toMatchObject({ clickPct: null, elementPct: null });
    expect(recordingFactSchema.safeParse(facts[0]).success).toBe(true);
  });

  it("leaves out a click whose tab was switched away from before its screenshot", async () => {
    await engine.start("Switched", { keys: false, excluded: [], sensitive: [] });
    await engine.pointer({ ...tab, tabId: behind }, pointer);
    const { sessionId } = await engine.getState();
    expect(await log.facts(sessionId as string)).toEqual([]);
    expect(shots).toBe(0);
  });

  it("takes screenshots at the quality the recording started with", async () => {
    await engine.start("Balanced", { keys: false, excluded: [], sensitive: [] });
    await engine.pointer(tab, pointer);
    await engine.stop();
    await engine.forgetSession((await engine.getState()).sessionId as string);
    await engine.start("Original", { keys: false, excluded: [], sensitive: [], original: true });
    clock += 1_000;
    await engine.pointer(tab, pointer);
    expect(originals).toEqual([false, true]);
  });

  it("keeps the words on screen with each new screenshot, for blur suggestions", async () => {
    await engine.start("Words", { keys: false, excluded: ["bank.example.test"], sensitive: [] });
    const text = [{ words: [{ text: "sam@example.com", x: 1, y: 1, w: 10, h: 2 }] }];
    await engine.pointer(tab, { ...pointer, text });
    clock += 100; // the same screenshot again: its words are already kept
    await engine.pointer(tab, { ...pointer, text });
    clock += 1_000;
    await engine.pointer({ ...tab, url: "https://bank.example.test/" }, { ...pointer, text });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.lines).toEqual(text);
  });

  it("withholds fields the organisation names as secret", async () => {
    await engine.start("Policy", { keys: true, excluded: [], sensitive: ["staff number"] });
    await engine.input(tab, {
      target: { tagName: "INPUT", labelText: "Staff number" },
      value: "E12345",
      sensitive: false,
    });
    const { sessionId } = await engine.getState();
    expect((await log.facts(sessionId as string))[0]?.record).toMatchObject({
      value: null,
      withheld: "sensitive",
    });
  });

  it("records nothing while paused, and stops with the recording left to review", async () => {
    const { sessionId } = await engine.start("Pause", { keys: false, excluded: [], sensitive: [] });
    await engine.pause();
    await engine.pointer(tab, pointer);
    await engine.resume();
    await engine.pointer(tab, pointer);
    const stopped = await engine.stop();
    expect(stopped).toMatchObject({ state: "idle", sessionId });
    expect(capturing).toBe(false);
    expect(events.at(-2)).toMatchObject({
      type: "recorder:finished",
      finished: { sessionId, title: "Pause" },
    });
    expect(await log.recoveries()).toMatchObject([{ sessionId, eventCount: 1, stopped: true }]);
  });

  it("carries on after Chrome restarts its background worker", async () => {
    const { sessionId } = await engine.start("Restart", {
      keys: false,
      excluded: [],
      sensitive: [],
    });
    await engine.pointer(tab, pointer);
    await make(true); // a fresh engine, reading what the last one saved
    clock += 1000;
    await engine.pointer(tab, pointer);
    expect((await log.facts(sessionId as string)).map((fact) => fact.sequence)).toEqual([1, 2]);
  });

  it("throws a recording away on Discard", async () => {
    await engine.start("Discard", { keys: false, excluded: [], sensitive: [] });
    await engine.pointer(tab, pointer);
    expect(await engine.discard()).toMatchObject({ state: "idle", sessionId: null });
    expect(await log.recoveries()).toEqual([]);
  });
});

describe("page titles", () => {
  it("never keeps an address that stands in for a title", () => {
    const url = "https://finance.example.test/invoices/42?token=secret";
    expect(safeTitle("finance.example.test/invoices/42?token=secret", url)).toBe(
      "finance.example.test",
    );
    expect(safeTitle(url, url)).toBe("finance.example.test");
    expect(safeTitle("Invoices - Finance", url)).toBe("Invoices - Finance");
  });
});
