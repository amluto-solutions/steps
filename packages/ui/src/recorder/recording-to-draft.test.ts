import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDING_SETTINGS,
  recordingFactSchema,
  type GuideStep,
  type OcrLine,
  type RecordingFact,
  wordStepIn,
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

  it("never names a click from a screenshot taken after its window had gone (F019, #48)", async () => {
    // The Dashboard click above, as if its window had closed before its screenshot was taken:
    // the word at the click would then be another window's.
    const facts = journal(autoresponders).map((fact) =>
      fact.record.kind === "click" && fact.record.capture.image === "click-19.webp"
        ? { ...fact, record: { ...fact.record, windowGone: true } }
        : fact,
    );
    const draft = await recordingToDraft({
      ...recording(facts),
      words: wordsOn({ "click-19": wordAtClick(facts, "click-19.webp", "Dashboard") }),
    });
    const step = draft.steps[20];
    expect(step?.actionText).toBe('Click in "Site Tools > Email Autoresponders - Google Chrome"');
    expect(step?.naming?.source).toBe("window");
    expect(step?.reviewRequired).toBe(true);
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

describe("a click on a menu that closed before it could be read (#56)", () => {
  /** Paint's File menu, open over Paint, as UI Automation read it when it opened. */
  const fileMenu = ["New", "Open", "Save", "Save as", "Print"].map((name, row) => ({
    name,
    box: { x: 1, y: 10 + row * 4, w: 14, h: 3.6 },
  }));
  /** Paint's Save as, clicked: the menu went with the click, so it was never read. */
  const saveAs = (menuItems?: typeof fileMenu): RecordingFact =>
    recordingFactSchema.parse({
      sessionId: "s",
      recordedAt: 1_790_246_400_100,
      sequence: 1,
      record: {
        kind: "click",
        id: 1,
        tickMs: 100,
        button: "left",
        injected: false,
        x: 96,
        y: 227,
        window: {
          title: "Untitled - Paint",
          exe: "mspaint.exe",
          pid: 4,
          frame: { left: 0, top: 0, right: 1920, bottom: 1032 },
          elevation: "notElevated",
          remoteSession: false,
          appName: null,
        },
        capture: {
          mode: "window",
          rect: { left: 0, top: 0, right: 1920, bottom: 1032 },
          monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
          scale: 1,
          width: 1920,
          height: 1032,
          image: "click-1.webp",
        },
        clickPct: { x: 5, y: 23.5 },
        element: null,
        elementPct: null,
        uia: {
          status: "error",
          ms: 12,
          retried: false,
          error: "the window clicked in closed before it could be read",
        },
        screenshotMs: 30,
        queueDelayMs: 1,
        windowGone: false,
        ...(menuItems ? { menuItems } : {}),
      },
    });
  const words = wordsOn({
    "click-1": [{ words: [{ text: "Sav", x: 2.5, y: 22.9, w: 2.2, h: 1.5 }] }],
  });

  it("is named by the menu's item its screenshot's words are, needing no check", async () => {
    const { steps } = await recordingToDraft({ ...recording([saveAs(fileMenu)]), words });
    expect(texts(steps)).toEqual(['Click "Save as"']);
    expect(steps[0]?.naming).toEqual({
      name: "Save as",
      kind: "menuItem",
      source: "menu",
      needsReview: false,
    });
    expect(steps[0]?.reviewRequired).toBe(false);
    expect(steps[0] && wordStepIn(steps[0], "en", "plain")).toBe('Select "Save as" in the menu');
  });

  it("keeps the words read, flagged, when the recording kept no menu", async () => {
    const { steps } = await recordingToDraft({ ...recording([saveAs()]), words });
    expect(texts(steps)).toEqual(['Click "Sav"']);
    expect(steps[0]?.naming?.source).toBe("screen");
    expect(steps[0]?.reviewRequired).toBe(true);
  });
});

describe("a quick click in a WinUI menu (#106)", () => {
  /** Paint's File menu, as UI Automation read it when its pop-up host showed. */
  const fileMenu = ["New", "Open", "Save", "Save as", "Print"].map((name, row) => ({
    name,
    box: { x: 1, y: 10 + row * 4, w: 14, h: 3.6 },
  }));
  /**
   * Save, clicked at once (12/10/2026): the pointer never rested, the lookup timed out, and the
   * menu had gone by the time its screenshot was checked. The window under the press was the
   * pop-up host, which came from Paint's window.
   */
  const quickSave = (more: Record<string, unknown> = {}): RecordingFact =>
    recordingFactSchema.parse({
      sessionId: "s",
      recordedAt: 1_790_246_400_200,
      sequence: 2,
      record: {
        kind: "click",
        id: 2,
        tickMs: 200,
        button: "left",
        injected: false,
        x: 96,
        y: 227,
        window: {
          title: "Pop-upHost",
          exe: "mspaint.exe",
          pid: 4,
          frame: { left: 8, top: 82, right: 328, bottom: 642 },
          elevation: "notElevated",
          remoteSession: false,
          appName: null,
          ownerTitle: "Untitled - Paint",
        },
        capture: {
          mode: "window",
          rect: { left: 0, top: 0, right: 1920, bottom: 1032 },
          monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
          scale: 1,
          width: 1920,
          height: 1032,
          image: "click-2.webp",
        },
        clickPct: { x: 5, y: 19.5 },
        element: null,
        elementPct: null,
        uia: { status: "timeout", ms: 350, retried: false, error: null },
        screenshotMs: 30,
        queueDelayMs: 1,
        windowGone: true,
        menuItems: fileMenu,
        menuShowing: true,
        ...more,
      },
    });

  it("reads as the window it came from while recording", async () => {
    const { steps } = await recordingToDraft({ ...recording([quickSave()]), words: null });
    expect(texts(steps)).toEqual(['Click in "Untitled - Paint"']);
    expect(steps[0]?.reviewRequired).toBe(true);
  });

  it("is named by the item whose box holds it when the draft opens, needing no check", async () => {
    // Paint's canvas showed at the click once the menu had gone: its words name nothing.
    const words = wordsOn({
      "click-2": [{ words: [{ text: "Sketch", x: 2.5, y: 18.9, w: 3.2, h: 1.5 }] }],
    });
    const { steps } = await recordingToDraft({ ...recording([quickSave()]), words });
    expect(texts(steps)).toEqual(['Click "Save"']);
    expect(steps[0]?.naming).toEqual({
      name: "Save",
      kind: "menuItem",
      source: "menu",
      needsReview: false,
    });
    expect(steps[0]?.reviewRequired).toBe(false);
  });

  it("is named by the item's box though its screenshot couldn't be read", async () => {
    const words = wordsOn({ "click-2": "unavailable" });
    const { steps } = await recordingToDraft({ ...recording([quickSave()]), words });
    expect(texts(steps)).toEqual(['Click "Save"']);
  });

  it("stays the window it came from when the menu may not have shown under the press", async () => {
    const words = wordsOn({ "click-2": [] });
    const { steps } = await recordingToDraft({
      ...recording([quickSave({ menuShowing: undefined })]),
      words,
    });
    expect(texts(steps)).toEqual(['Click in "Untitled - Paint"']);
    expect(steps[0]?.reviewRequired).toBe(true);
  });
});

describe("a double-click (12/10/2026, #55)", () => {
  const explorer = {
    title: "Documents - File Explorer",
    exe: "explorer.exe",
    pid: 4,
    frame: { left: 0, top: 0, right: 1920, bottom: 1032 },
    elevation: "notElevated",
    remoteSession: false,
    appName: "Windows Explorer",
  };
  const file = {
    controlType: "ListItem",
    localizedControlType: "item",
    name: "Budget.xlsx",
    automationId: "1",
    helpText: "",
    ariaRole: "",
    ariaProperties: "",
    className: "UIItem",
    frameworkId: "DirectUI",
    isPassword: false,
    labeledBy: null,
    bounds: { left: 300, top: 200, right: 700, bottom: 222 },
    ancestors: [{ controlType: "List", name: "Items View" }],
    sensitive: false,
  };
  type Click = Extract<RecordingFact["record"], { kind: "click" }>;
  const fact = (sequence: number, record: RecordingFact["record"]): RecordingFact =>
    recordingFactSchema.parse({
      sessionId: "s",
      recordedAt: 1_790_246_400_000 + sequence * 100,
      sequence,
      record,
    });
  /** A press the recorder made a step of, as it writes it. */
  const click = (sequence: number, patch: Partial<Click> = {}) =>
    fact(sequence, {
      kind: "click",
      id: sequence,
      tickMs: sequence * 100,
      button: "left",
      injected: false,
      x: 500,
      y: 211,
      window: explorer,
      capture: {
        mode: "window",
        rect: { left: 0, top: 0, right: 1920, bottom: 1032 },
        monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
        scale: 1,
        width: 1920,
        height: 1032,
        image: `click-${String(sequence)}.webp`,
      },
      clickPct: { x: 26.042, y: 20.446 },
      element: file,
      elementPct: { x: 15.625, y: 19.38, w: 20.833, h: 2.132 },
      uia: { status: "ok", ms: 40, retried: false, error: null },
      screenshotMs: 30,
      queueDelayMs: 1,
      windowGone: false,
      ...patch,
    });
  /** The second press of a double-click, which the recorder collapses into the click `of`. */
  const second = (sequence: number, of: number) =>
    fact(sequence, { kind: "double", of, tickMs: sequence * 100 });
  const draft = (facts: RecordingFact[], patch: Partial<RecordingData> = {}) =>
    recordingToDraft({ ...recording(facts), words: null, ...patch });

  it("on a file in File Explorer reads Double-click, one step", async () => {
    const { steps } = await draft([click(1), second(2, 1)]);
    expect(texts(steps)).toEqual(['Double-click "Budget.xlsx"']);
    expect(steps[0]?.textParts.verb).toBe("doubleClick");
    // Worded again from what it stores, in another tone or language: still a double-click.
    expect(steps[0] && wordStepIn(steps[0], "en", "formal")).toBe('Double-click "Budget.xlsx".');
    expect(steps[0] && wordStepIn(steps[0], "de", "formal")).toBe(
      "Doppelklicken Sie auf „Budget.xlsx“.",
    );
  });

  it("leaves single clicks as they were", async () => {
    const { steps } = await draft([click(1), click(5, { tickMs: 1_500 })]);
    expect(texts(steps)).toEqual(['Click "Budget.xlsx"', 'Click "Budget.xlsx"']);
    expect(steps.map((step) => step.textParts.verb)).toEqual(["click", "click"]);
  });

  it("says so though its step was journalled as a click before the second press", async () => {
    const facts = [click(1), second(2, 1)];
    const { wording, settings } = recording(facts);
    const journalled = facts.flatMap((each) => factToStep(each, wording, settings) ?? []);
    expect(texts(journalled as GuideStep[])).toEqual(['Click "Budget.xlsx"']);
    const { steps } = await draft(facts, { saved: journalled });
    expect(texts(steps)).toEqual(['Double-click "Budget.xlsx"']);
  });

  it("on Excel's fill handle is still one Fill step (#66)", async () => {
    const excel = { ...explorer, title: "Book1 - Excel", exe: "EXCEL.EXE", appName: "Excel" };
    const cell = { ...file, controlType: "DataItem", name: "H8", className: "" };
    const facts = [
      click(1, { window: excel, element: cell }),
      click(2, { window: excel, element: { ...cell, name: "I9" }, tickMs: 1_000 }),
      second(3, 2),
      fact(4, {
        kind: "drag",
        id: 2 ** 48 + 4,
        of: 2,
        tickMs: 1_100,
        from: "H8",
        to: null,
        fill: "double",
        window: excel,
        capture: null,
        selectionPct: null,
        handlePct: { x: 82.188, y: 56.686 },
      }),
    ];
    const { steps } = await draft(facts);
    expect(texts(steps)).toEqual(['Click "H8"', 'Fill "H8" down the column']);
  });

  it("on a window's title-bar button keeps its words (#48)", async () => {
    const book = { ...explorer, title: "Book1 - Excel", exe: "EXCEL.EXE" };
    const { steps } = await draft([
      click(1, { window: book, element: null, titleBarButton: "maximise" }),
      second(2, 1),
    ]);
    expect(texts(steps)).toEqual(['Maximise "Book1 - Excel"']);
    expect(steps[0]?.textParts.verb).toBe("click");
  });

  it("with the right button stays a right-click", async () => {
    const { steps } = await draft([click(1, { button: "right" }), second(2, 1)]);
    expect(texts(steps)).toEqual(['Right-click "Budget.xlsx"']);
  });

  it("on something unnamed says so, and keeps saying so once named from the screen", async () => {
    const facts = [click(1, { element: null }), second(2, 1)];
    expect(texts((await draft(facts)).steps)).toEqual([
      'Double-click in "Documents - File Explorer"',
    ]);
    const { steps } = await draft(facts, {
      words: wordsOn({ "click-1": wordAtClick(facts, "click-1.webp", "Budget.xlsx") }),
    });
    expect(texts(steps)).toEqual(['Double-click "Budget.xlsx"']);
    expect(steps[0]?.naming?.source).toBe("screen");
  });
});
