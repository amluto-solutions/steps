import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_SETTINGS,
  recordingFactSchema,
  type GuideStep,
  type OcrLine,
  type RecordingFact,
} from "@amluto-steps/core";

import { factToStep } from "../recorded-step";
import { screenWords } from "../screen-words";
import { fakeScreenshot, fakeTextReader } from "../bridge/screen-words-fake";
import autoresponders from "./recordings/autoresponders.json";
import forwarders from "./recordings/forwarders.json";
import { recordingToDraft, type RecordingData } from "./recording-to-draft";

/** A journal from a real recording (`recordings/`), as the recorder hands it back. */
const journal = (fixture: { facts: unknown[] }): RecordingFact[] =>
  recordingFactSchema.array().parse(fixture.facts);

/** A recording as it opens with nothing but its journal's facts. */
const recording = (facts: RecordingFact[]): Omit<RecordingData, "words"> => ({
  facts,
  saved: [],
  live: [],
  restart: null,
  wording: { language: "en", tone: "casual" },
  settings: DEFAULT_RECORDING_SETTINGS,
});

/** A word on a click's screenshot, right where it was clicked, as text recognition reads it. */
const wordAtClick = (facts: RecordingFact[], image: string, text: string): OcrLine[] => {
  const fact = facts.find(
    (each) => "capture" in each.record && each.record.capture?.image === image,
  );
  const at = fact && "clickPct" in fact.record ? fact.record.clickPct : null;
  if (!at) throw new Error(`no click on ${image}`);
  return [{ words: [{ text, x: at.x - 3, y: at.y - 1, w: 6, h: 2 }] }];
};

/** Screen words for one recording's screenshots, by media id; the others have none. */
const wordsOn = (screens: Record<string, OcrLine[] | "unavailable">) =>
  screenWords(fakeTextReader(screens), async (mediaId) => fakeScreenshot(mediaId));

const texts = (steps: GuideStep[]) => steps.map((step) => step.actionText);

describe("a recording becomes its draft", () => {
  it("replays a SiteGround journal into the finished draft", async () => {
    const facts = journal(autoresponders);
    const draft = await recordingToDraft({
      ...recording(facts),
      words: wordsOn({
        "click-19": wordAtClick(facts, "click-19.webp", "Dashboard"),
        "click-20": wordAtClick(facts, "click-20.webp", "Email"),
        "click-22": wordAtClick(facts, "click-22.webp", "Email"),
      }),
    });

    expect(draft.skipped).toBe(0);
    // The order is the draft the app opened from this recording: typing goes before what its
    // field's focus leaving trailed (the search before "Go to", the code before the click into
    // the password manager), and the three clicks the page didn't name are read from the screen.
    expect(texts(draft.steps)).toEqual([
      'Click "New tab"',
      'Type "site" in "Widgets" field',
      'Go to "siteground.co.uk"',
      'Click "Login"',
      'Click "Continue with Google"',
      'Click "Robin Example robin@example.com"',
      'Type in "Verification Code" field',
      'Click "Time-based One-Time Password Verification Code"',
      'Type in "Verification Code" field',
      'Click "SIGN IN"',
      'Click "My SiteGround Account"',
      'Click "My SiteGround Account"',
      'Click "My SiteGround Account > Websites"',
      'Click in "Site Tools > Dashboard - Google Chrome"',
      'Click "File Manager"',
      'Click "Hello, Robin! Your domain is not pointing to this site To point your domain name..."',
      'Click in "Site Tools > Dashboard - Google Chrome"',
      'Click "example.co.uk"',
      'Click "Email"',
      'Click "Autoresponders"',
      'Click "Dashboard"',
      'Press "Ctrl + -"',
      'Press "Ctrl + -"',
      'Press "Ctrl + ="',
      'Press "Ctrl + ="',
      'Press "Ctrl + ="',
      'Press "Ctrl + ="',
      'Press "Ctrl + ="',
      'Click "Email"',
      'Click "File Manager"',
      'Click "Email"',
      'Click "Forwarders"',
    ]);
    const dashboard = draft.steps[20];
    expect(dashboard?.naming).toEqual({
      name: "Dashboard",
      kind: "other",
      source: "screen",
      needsReview: true,
    });
    // Still unnamed: no words at the click.
    expect(draft.steps[13]?.reviewRequired).toBe(true);
  });

  it("replays a journal whose code was read twice from one field, keeping the last read", async () => {
    const facts = journal(forwarders);
    const draft = await recordingToDraft({
      ...recording(facts),
      words: wordsOn({
        "click-7": wordAtClick(facts, "click-7.webp", "SIGN IN"),
        "click-10": wordAtClick(facts, "click-10.webp", "Email"),
        "click-14": wordAtClick(facts, "click-14.webp", "Dashboard"),
        "click-15": "unavailable",
      }),
    });

    expect(draft.skipped).toBe(0);
    expect(texts(draft.steps)).toEqual([
      'Click in "New tab - Google Chrome"',
      'Go to "siteground.co.uk"',
      'Click "Login"',
      'Click "Continue with Google"',
      'Click in "Sign in – Google accounts - Google Chrome"',
      'Click "Verification Code" field',
      'Type in "Verification Code" field',
      'Click in "SiteGround Login - Google Chrome"',
      'Click "SIGN IN"',
      'Click "My SiteGround Account"',
      'Click "SITE TOOLS"',
      'Click "Email"',
      'Click "Forwarders"',
      'Click "Edit"',
      'Click "Edit Forward Rule friends@example.org"',
      'Click "Dashboard"',
      'Click in "Site Tools > Dashboard - Google Chrome"',
      // A click on the page's loading overlay: the overlay isn't what was clicked.
      'Click in "Site Tools > Dashboard - Google Chrome"',
      'Click in "Site Tools > Dashboard - Google Chrome"',
      'Click "Email Forwarders Select Domain example.co.uk Create New Rule Create New Rule Man..."',
      'Click "CREATE"',
    ]);
    // The second read of the code is the one kept.
    expect(draft.steps[6]?.id).toBe("capture-8");
  });

  it("ends at the last thing done, not an app that came to the front as it stopped", async () => {
    const facts = journal(forwarders);
    const last = facts.at(-1);
    if (last?.record.kind !== "click") throw new Error("no last click");
    // Closing Chrome at the end put File Explorer in front.
    const explorer = {
      ...last.record.window,
      title: "File Explorer",
      exe: "explorer.exe",
      pid: 4,
      appName: "File Explorer",
    };
    const opened: RecordingFact = {
      ...last,
      sequence: 23,
      record: { kind: "appSwitch", tickMs: last.record.tickMs + 2_000, window: explorer },
    };

    const draft = await recordingToDraft({ ...recording([...facts, opened]), words: null });

    expect(draft.steps).toHaveLength(21);
    expect(texts(draft.steps).at(-1)).toBe('Click "CREATE"');
  });

  it("shows the same steps while recording as the draft opens with, whatever was journalled", async () => {
    const facts = journal(forwarders);
    const { wording, settings } = recording(facts);
    // Each fact's step as the window built it live: most written to the journal, the last few
    // still being written when the recording stopped.
    const built = facts.flatMap((fact) => factToStep(fact, wording, settings) ?? []);

    const shown = await recordingToDraft({ ...recording(facts), words: null });
    const opened = await recordingToDraft({
      ...recording(facts),
      saved: built.slice(0, 15),
      live: built.slice(15),
      words: wordsOn({}),
    });

    expect(opened).toEqual(shown);
    expect(shown.steps).toHaveLength(21);
  });

  it("leaves out what came before Start again, journalled and live alike", async () => {
    const facts = journal(forwarders);
    const { wording, settings } = recording(facts);
    const built = facts.flatMap((fact) => factToStep(fact, wording, settings) ?? []);

    const draft = await recordingToDraft({
      ...recording(facts),
      saved: built.slice(0, 15),
      live: built.slice(15),
      restart: 10,
      words: null,
    });

    expect(draft.steps.map((step) => step.id)).toEqual(
      [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].map((sequence) => `capture-${sequence}`),
    );
  });

  it("keeps a shortcut shown with the popup in place of the screenshot its fact made", async () => {
    const facts = journal(autoresponders);
    const { wording, settings } = recording(facts);
    const click = facts.find((fact) => fact.sequence === 30);
    const screenshot = click && factToStep(click, wording, settings);
    if (!screenshot) throw new Error("no step 30");
    const shortcut = {
      ...screenshot,
      action: "keypress",
      actionText: 'Press "Ctrl + F"',
      textParts: { verb: "Press", target: "Ctrl + F", kind: "shortcut" },
    };

    const draft = await recordingToDraft({ ...recording(facts), saved: [shortcut], words: null });

    expect(texts(draft.steps)[29]).toBe('Press "Ctrl + F"');
    expect(draft.steps).toHaveLength(32);
  });

  it("leaves out and counts a journalled step that doesn't fit the format", async () => {
    const facts = journal(forwarders);
    const { wording, settings } = recording(facts);
    const first = facts[0] && factToStep(facts[0], wording, settings);
    if (!first) throw new Error("no first step");
    // Written before step text had a limit.
    const tooLong = { ...first, actionText: "x".repeat(3_000) };

    const draft = await recordingToDraft({ ...recording(facts), saved: [tooLong], words: null });

    expect(draft.skipped).toBe(1);
    expect(draft.steps).toHaveLength(20);
    expect(draft.steps[0]?.actionText).toBe('Go to "siteground.co.uk"');
  });
});
