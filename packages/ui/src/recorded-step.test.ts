// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  ENGLISH,
  parseStep,
  wordStepIn,
  type RecordedStep,
  type RecordingFact,
  type RecordingSettings,
  type StepWording,
} from "@amluto-steps/core";
import {
  captureSequenceOf,
  captureStepId,
  clickHighlight,
  factToStep as makeStep,
  imageFileOf,
  mediaIdOf,
  dropReplacedValues,
  dropTrailingOpens,
  applyDrags,
  borrowScreenshots,
  orderRecordedSteps,
} from "./recorded-step";

const wording = ENGLISH;
/** A recording's settings as they start: typing into something unnamed keeps its text out. */
const settings: RecordingSettings = { showUnnamedTyping: false };

/** Every step these tests make, to check below that each words itself again from its facts. */
const made: RecordedStep[] = [];
const factToStep = (
  fact: RecordingFact,
  words: StepWording,
  recording: RecordingSettings = settings,
) => {
  const step = makeStep(fact, words, recording);
  if (step) made.push(step);
  return step;
};

const manualFact: RecordingFact = {
  sessionId: "session-1",
  recordedAt: 1_790_246_400_000,
  sequence: 5,
  record: {
    kind: "manual",
    id: 7,
    tickMs: 100,
    purpose: "captureNow",
    actionText: "Capture this screen",
    window: {
      title: "Settings",
      exe: "SystemSettings.exe",
      pid: 10,
      frame: { left: 0, top: 0, right: 100, bottom: 100 },
      elevation: "notElevated",
      remoteSession: false,
    },
    capture: {
      mode: "window",
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      monitor: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      width: 100,
      height: 100,
      image: "manual-7.webp",
    },
    clickPct: { x: 50, y: 25 },
  },
};

describe("recorded facts become guide steps", () => {
  it("keeps the manual screenshot, without the last click's marker (F009)", () => {
    const step = factToStep(manualFact, wording);

    expect(step?.action).toBe("manual");
    expect(step?.actionText).toBe("Capture this screen");
    expect(step?.media?.id).toBe("manual-7");
    // The pointer was where the last click left it: no circle on a screenshot nobody clicked.
    expect(step?.highlight).toBeNull();
  });

  it("centres the click circle on the click, round on a wide image, even at an edge", () => {
    // 1920 × 1032 like a real window capture; a click in the bottom-right corner.
    const highlight = clickHighlight({ x: 99, y: 98 }, 1920, 1032);
    expect(highlight.w).toBe(3.1);
    expect(highlight.h).toBeCloseTo((3.1 * 1920) / 1032, 3);
    expect(highlight.x + highlight.w / 2).toBeCloseTo(99, 2);
    expect(highlight.y + highlight.h / 2).toBeCloseTo(98, 2);
    // Same size in pixels both ways, so it draws as a circle.
    expect((highlight.w / 100) * 1920).toBeCloseTo((highlight.h / 100) * 1032, 1);
  });

  it("marks missed clicks as steps that need review", () => {
    const missed = factToStep(
      {
        ...manualFact,
        sequence: 6,
        record: { kind: "missed", count: 2, afterId: 7 },
      },
      wording,
    );

    expect(missed?.reviewRequired).toBe(true);
    expect(missed?.actionText).toBe("2 clicks missed here");
  });

  it("maps foreground changes to Open app steps", () => {
    const fact: RecordingFact = {
      sessionId: "session-1",
      recordedAt: 1_790_246_400_000,
      sequence: 8,
      record: {
        kind: "appSwitch",
        tickMs: 100,
        window: {
          title: "Quarterly report — Excel",
          exe: "excel.exe",
          pid: 12,
          frame: { left: 0, top: 0, right: 100, bottom: 100 },
          elevation: "notElevated",
          remoteSession: false,
        },
      },
    };
    const step = factToStep(fact, wording);
    expect(step?.action).toBe("appswitch");
    expect(step?.actionText).toBe('Open "Quarterly report — Excel"');
    expect(step?.context.app).toBe("excel.exe");
  });

  it("maps site origin changes to navigation steps", () => {
    const fact: RecordingFact = {
      sessionId: "session-1",
      recordedAt: 1_790_246_400_000,
      sequence: 9,
      record: {
        kind: "navigation",
        tickMs: 150,
        origin: "https://example.test",
        window: {
          title: "Example — Chrome",
          exe: "chrome.exe",
          pid: 13,
          frame: { left: 0, top: 0, right: 100, bottom: 100 },
          elevation: "notElevated",
          remoteSession: false,
        },
      },
    };
    const step = factToStep(fact, wording);
    expect(step?.action).toBe("navigation");
    expect(step?.actionText).toBe('Go to "https://example.test"');
    expect(step?.context.app).toBe("chrome.exe");
  });
});

describe("step ids and screenshot files", () => {
  it("reads back the capture sequence only from a recorded step's id", () => {
    expect(captureSequenceOf(captureStepId(42))).toBe(42);
    expect(captureSequenceOf("step-abc")).toBeNull();
    expect(captureSequenceOf("capture-12x")).toBeNull();
  });

  it("turns a media id into its file and back", () => {
    expect(mediaIdOf(imageFileOf("shot-7"))).toBe("shot-7");
    expect(mediaIdOf("shot-7.WEBP")).toBe("shot-7");
  });
});

describe("steps fit the step format however long the recorded text", () => {
  it("cuts a very long typed value, field name and window title, so the step always opens", () => {
    const element = {
      controlType: "Edit",
      localizedControlType: "edit",
      name: "N".repeat(5_000),
      automationId: "",
      helpText: "",
      ariaRole: "",
      ariaProperties: "",
      className: "",
      frameworkId: "",
      isPassword: false,
      labeledBy: null,
      bounds: null,
      ancestors: [],
      sensitive: false,
    };
    const step = factToStep(
      {
        sessionId: "s",
        recordedAt: 1_790_246_400_000,
        sequence: 4,
        record: {
          kind: "input",
          tickMs: 1,
          element,
          value: "v".repeat(3_000),
          withheld: null,
        },
      } as RecordingFact,
      wording,
    ) as RecordedStep;
    expect(step.textParts.value).toHaveLength(2_000);
    expect(step.textParts.target.length).toBeLessThanOrEqual(2_000);
    expect(() => parseStep(step)).not.toThrow();
  });

  it("shows a field's own screenshot, from when focus arrived, with the field boxed (04/10/2026)", () => {
    const element = {
      controlType: "Edit",
      localizedControlType: "edit",
      name: "Verification Code",
      automationId: "",
      helpText: "",
      ariaRole: "",
      ariaProperties: "",
      className: "",
      frameworkId: "",
      isPassword: false,
      labeledBy: null,
      bounds: null,
      ancestors: [],
      sensitive: false,
    };
    const step = factToStep(
      {
        sessionId: "s",
        recordedAt: 1_790_246_400_000,
        sequence: 5,
        record: {
          kind: "input",
          tickMs: 1,
          element,
          value: null,
          withheld: "setting-off",
          id: 1,
          window: {
            title: "SiteGround Login - Google Chrome",
            exe: "chrome.exe",
            pid: 7,
            frame: { left: 0, top: 0, right: 1920, bottom: 1032 },
            elevation: "notElevated",
            remoteSession: false,
          },
          capture: {
            mode: "window",
            rect: { left: 0, top: 0, right: 1920, bottom: 1032 },
            monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
            scale: 1,
            width: 1920,
            height: 1032,
            image: "field-1.webp",
          },
          elementPct: { x: 40, y: 50, w: 20, h: 4 },
        },
      } as RecordingFact,
      wording,
    ) as RecordedStep;
    expect(step.media?.width).toBe(1920);
    expect(step.highlight).toEqual({ shape: "box", x: 39.6, y: 49.6, w: 20.8, h: 4.8 });
    expect(step.context.windowTitle).toBe("SiteGround Login - Google Chrome");
    expect(() => parseStep(step)).not.toThrow();
  });
});

describe("steps written after the click they belong before", () => {
  const edge = (title = "Supplier form - Microsoft Edge", pid = 40) => ({
    title,
    exe: "msedge.exe",
    pid,
    frame: { left: 0, top: 0, right: 100, bottom: 100 },
    elevation: "notElevated",
    remoteSession: false,
  });
  const fact = (sequence: number, record: RecordingFact["record"]): RecordingFact => ({
    sessionId: "s",
    recordedAt: 1_790_246_400_000 + sequence,
    sequence,
    record,
  });
  const open = (sequence: number, tickMs: number) =>
    fact(sequence, { kind: "appSwitch", tickMs, window: edge() });
  const goTo = (sequence: number, tickMs: number, window = edge()) =>
    fact(sequence, { kind: "navigation", tickMs, origin: "127.0.0.1:8123", window });
  const field = {
    controlType: "Edit",
    localizedControlType: "edit",
    name: "Supplier name",
    automationId: "name",
    helpText: "",
    ariaRole: "",
    ariaProperties: "",
    className: "",
    frameworkId: "Chrome",
    isPassword: false,
    labeledBy: null as string | null,
    bounds: null,
    ancestors: [],
    sensitive: false,
  };
  const typed = (sequence: number, tickMs: number) =>
    fact(sequence, { kind: "input", tickMs, element: field, value: null, withheld: null });
  const click = (
    sequence: number,
    tickMs: number,
    window = edge(),
    element: typeof field | null = null,
  ) =>
    fact(sequence, {
      ...(manualFact.record as object),
      kind: "click",
      id: sequence,
      tickMs,
      button: "left",
      injected: false,
      x: 1,
      y: 1,
      window,
      element,
      elementPct: null,
      uia: { status: "ok", ms: 1, retried: false, error: null },
      screenshotMs: 1,
      queueDelayMs: 0,
    } as RecordingFact["record"]);
  const order = (facts: RecordingFact[]) =>
    orderRecordedSteps(
      facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
      facts,
    ).map((step) => step.actionText);

  it("replaces the click a drag began with by the cells it selected (04/10/2026)", () => {
    const excel = edge("Book1 - Excel");
    const drag = fact(3, {
      kind: "drag",
      id: 1 << 20,
      of: 2,
      tickMs: 2_400,
      from: "D38",
      to: "F42",
      window: excel,
      capture: null,
      selectionPct: { x: 10, y: 20, w: 30, h: 10 },
    });
    const facts = [click(1, 1_000, excel), click(2, 2_000, excel), drag];
    const steps = applyDrags(
      facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
      facts,
    );
    expect(steps.map((step) => step.actionText)).toEqual([
      'Click in "Book1 - Excel"',
      'Select "D38:F42"',
    ]);
    const selected = steps[1];
    expect(selected?.highlight).toEqual({ shape: "box", x: 9.6, y: 19.6, w: 30.8, h: 10.8 });
    expect(selected?.sortKey).toBe(
      steps.find((step) => step.id === "capture-2")?.sortKey ??
        factToStep(click(2, 2_000, excel), wording)?.sortKey,
    );
    expect(() => parseStep(selected)).not.toThrow();
  });

  describe("Excel's fill handle (08/10/2026)", () => {
    const excel = edge("Book1 - Excel");
    const capture = {
      mode: "window" as const,
      rect: { left: 0, top: 0, right: 1920, bottom: 1032 },
      monitor: { left: 0, top: 0, right: 1920, bottom: 1080 },
      scale: 1,
      width: 1920,
      height: 1032,
      image: "drag-281474976710656.webp",
    };
    const fill = (
      sequence: number,
      of: number,
      to: string | null,
      how: "drag" | "double",
      selectionPct: { x: number; y: number; w: number; h: number } | null = null,
    ) =>
      fact(sequence, {
        kind: "drag",
        id: 2 ** 48 + sequence,
        of,
        tickMs: 2_400,
        from: "H8",
        to,
        fill: how,
        window: excel,
        capture,
        selectionPct,
        handlePct: { x: 82.188, y: 56.686 },
      });
    const steps = (facts: RecordingFact[]) =>
      applyDrags(
        facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
        facts,
      );

    it("replaces the click on its handle by the cells it filled, boxed", () => {
      // The press on H8's corner pixel, which UI Automation put in I9.
      const facts = [
        click(1, 1_000, excel),
        click(2, 2_000, excel),
        fill(3, 2, "H250", "drag", { x: 64.583, y: 55.233, w: 17.604, h: 40 }),
      ];
      const made = steps(facts);
      expect(made.map((step) => step.actionText)).toEqual([
        'Click in "Book1 - Excel"',
        'Fill "H8" down to "H250"',
      ]);
      expect(made[1]?.highlight?.shape).toBe("box");
      expect(made[1]?.reviewRequired).toBeUndefined();
      expect(made[1]?.textParts).toMatchObject({ verb: "fill", target: "H8:H250" });
      expect(() => parseStep(made[1])).not.toThrow();
    });

    it("words a double-click as down the column, its handle ringed", () => {
      const facts = [click(2, 2_000, excel), fill(3, 2, null, "double")];
      const [step] = steps(facts);
      expect(step?.actionText).toBe('Fill "H8" down the column');
      expect(step?.highlight).toEqual(clickHighlight({ x: 82.188, y: 56.686 }, 1920, 1032));
      expect(step?.reviewRequired).toBeUndefined();
      expect(step?.sortKey).toBe(factToStep(click(2, 2_000, excel), wording)?.sortKey);
      expect(step && wordStepIn(step, "en", "plain")).toBe("Fill cell H8 down the column");
    });

    it("keeps a drag whose end cell wasn't found, asking to be checked", () => {
      const [step] = steps([click(2, 2_000, excel), fill(3, 2, null, "drag")]);
      expect(step?.actionText).toBe('Fill "H8" down the column');
      expect(step?.reviewRequired).toBe(true);
    });

    it("says where a fill went that isn't straight down", () => {
      const [step] = steps([click(2, 2_000, excel), fill(3, 2, "K8", "drag")]);
      expect(step?.actionText).toBe('Fill "H8" to "K8"');
      expect(step && wordStepIn(step, "en", "formal")).toBe("Fill cell H8 to cell K8.");
    });
  });

  it("follows the click into the address bar (04/10/2026)", () => {
    // Only a typed or picked address is a step now, so it comes after that click; it had been
    // moved before it, as a browser's first address once was.
    const facts = [open(1, 1_000), click(2, 2_000), click(3, 2_500), goTo(4, 3_200)];
    expect(order(facts)).toEqual([
      'Open "Supplier form - Microsoft Edge"',
      'Click in "Supplier form - Microsoft Edge"',
      'Click in "Supplier form - Microsoft Edge"',
      'Go to "127.0.0.1:8123"',
    ]);
  });

  it("stays after a click that changed the page, a click long before, or another browser", () => {
    const link = [click(1, 2_000, edge("Old page - Microsoft Edge")), goTo(2, 2_600)];
    expect(order(link)[0]).toMatch(/^Click/);
    const late = [click(1, 2_000), goTo(2, 9_000)];
    expect(order(late)[0]).toMatch(/^Click/);
    const other = [click(1, 2_000, edge(undefined, 41)), goTo(2, 2_600)];
    expect(order(other)[0]).toMatch(/^Click/);
  });

  it("moves only the first address: later ones follow the click that changed the site", () => {
    const facts = [goTo(1, 500), click(2, 2_000), goTo(3, 2_600)];
    expect(order(facts)).toEqual([
      'Go to "127.0.0.1:8123"',
      'Click in "Supplier form - Microsoft Edge"',
      'Go to "127.0.0.1:8123"',
    ]);
  });

  it("puts an Open step before the click that brought its window forward", () => {
    // Found on Linux: the window manager marks a clicked window active after the click arrives.
    const facts = [click(1, 2_000), open(2, 2_040)];
    expect(order(facts)[0]).toMatch(/^Open/);
    const later = [click(1, 2_000), open(2, 3_000)];
    expect(order(later)[0]).toMatch(/^Click/);
    const elsewhere = [click(1, 2_000, edge("Another window - Microsoft Edge")), open(2, 2_040)];
    expect(order(elsewhere)[0]).toMatch(/^Click/);
  });

  it("gives a sort key that stays valid in a step file", () => {
    const facts = [open(1, 1_000), click(2, 2_000), goTo(3, 3_200)];
    const placed = orderRecordedSteps(
      facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
      facts,
    );
    for (const step of placed) expect(() => parseStep(step)).not.toThrow();
  });

  it("puts typing before the click that took focus from the field", () => {
    // Found live: the value is read when focus leaves, which is when the next click lands.
    const facts = [click(1, 1_000, edge(), field), click(2, 4_000), typed(3, 4_000)];
    expect(order(facts).map((text) => text.split(" ")[0])).toEqual(["Click", "Type", "Click"]);
  });

  it("tells fields named only by their label apart (GTK, on Linux)", () => {
    // Found on Linux: GTK entries have no name of their own, only a label.
    const gtk = (label: string) => ({ ...field, name: "", automationId: "", labeledBy: label });
    const supplier = gtk("Supplier");
    const pin = gtk("Card PIN");
    const facts = [
      click(1, 1_000, edge(), supplier),
      click(2, 4_000, edge(), pin),
      fact(3, { kind: "input", tickMs: 4_002, element: supplier, value: "Acme", withheld: null }),
    ];
    expect(order(facts)).toEqual([
      'Click "Supplier" field',
      'Type "Acme" in "Supplier" field',
      'Click "Card PIN" field',
    ]);
  });

  it("drops Open steps the recording ended on, unless that's all there is", () => {
    const steps = (facts: RecordingFact[]) =>
      dropTrailingOpens(
        orderRecordedSteps(
          facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
          facts,
        ),
      ).map((step) => step.action);
    expect(steps([open(1, 1_000), click(2, 2_000), open(3, 9_000), open(4, 9_500)])).toEqual([
      "appswitch",
      "click",
    ]);
    expect(steps([open(1, 1_000)])).toEqual(["appswitch"]);
  });

  it("keeps only the last value read from a box focus left twice, with nothing between", () => {
    const value = (sequence: number, text: string) =>
      fact(sequence, {
        kind: "input",
        tickMs: sequence * 100,
        element: field,
        value: text,
        withheld: null,
      });
    const kept = (facts: RecordingFact[]) =>
      dropReplacedValues(
        facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
        facts,
      ).map((step) => step.textParts.value ?? step.actionText);
    // Found live: Save As's file name box lost focus to its suggestions list part-way through.
    expect(kept([value(1, "steps-t"), value(2, "steps-test-note")])).toEqual(["steps-test-note"]);
    // A click between means the box was filled in twice: both stay.
    expect(kept([value(1, "first"), click(2, 1_000), value(3, "second")])).toHaveLength(3);
  });

  it("leaves typing after a click in the field itself, or when focus left by the keyboard", () => {
    const inField = [
      click(1, 1_000, edge(), field),
      click(2, 3_000, edge(), field),
      typed(3, 3_100),
    ];
    expect(order(inField).at(-1)).toMatch(/^Type/);
    const tabbed = [click(1, 1_000, edge(), field), click(2, 2_000), typed(3, 6_000)];
    expect(order(tabbed).at(-1)).toMatch(/^Type/);
  });

  it("words a taskbar click by its app, and names Open steps by the program", () => {
    // A real recording: one click on Edge's taskbar button made four steps.
    const taskbar = {
      title: "",
      exe: "explorer.exe",
      pid: 7,
      frame: { left: 0, top: 1000, right: 1920, bottom: 1048 },
      elevation: "notElevated",
      remoteSession: false,
      appName: "Windows Explorer",
      shell: true,
    };
    const button = {
      ...field,
      controlType: "Button",
      name: "New tab and 6 more pages - Work - Microsoft\u{200B} Edge - 1 running window",
    };
    const step = factToStep(click(1, 1_000, taskbar, button), wording);
    expect(step?.actionText).toBe('Click "Microsoft Edge" on the taskbar');
    // A pinned app that isn't running has just its name.
    const pinned = factToStep(click(2, 1_000, taskbar, { ...button, name: "Outlook" }), wording);
    expect(pinned?.actionText).toBe('Click "Outlook" on the taskbar');

    const opened = fact(3, {
      kind: "appSwitch",
      tickMs: 2_000,
      window: { ...edge("New tab - Work - Microsoft Edge"), appName: "Microsoft Edge" },
    });
    expect(factToStep(opened, wording)?.actionText).toBe('Open "Microsoft Edge"');
  });

  it("words a click in Chrome or Edge by what the page said, when it named the element", () => {
    // UI Automation saw only the icon inside the button.
    const icon = { ...field, controlType: "Image", name: "", automationId: "" };
    const withPage = (target: Record<string, string>) =>
      fact(1, {
        ...(click(1, 1_000, edge("Invoices - Microsoft Edge"), icon).record as object),
        page: { target },
      } as RecordingFact["record"]);
    const step = factToStep(
      withPage({ tagName: "BUTTON", innerText: "Approve invoice" }),
      wording,
    ) as RecordedStep;
    expect(step.actionText).toBe('Click "Approve invoice"');
    expect(step.target).toEqual({ tagName: "BUTTON", innerText: "Approve invoice" });
    expect(step.textParts).toMatchObject({ target: "Approve invoice", kind: "button" });
    expect(step.reviewRequired).toBeUndefined();
    expect(() => parseStep(step)).not.toThrow();

    // Nothing named on the page: UI Automation's wording, as without Steps for Chrome.
    const unnamed = factToStep(withPage({ tagName: "DIV" }), wording);
    expect(unnamed?.actionText).toBe('Click in "Invoices - Microsoft Edge"');
    expect(unnamed?.reviewRequired).toBe(true);
  });

  it("keeps what each click is called with its step (06/10/2026)", () => {
    const window = edge("Site Tools > Dashboard - Google Chrome");
    const inside = {
      ...field,
      controlType: "Group",
      name: "",
      automationId: "",
      ancestors: [{ controlType: "ListItem", name: "Forwarders" }],
    } as unknown as typeof field;
    const step = factToStep(click(1, 1_000, window, inside), wording) as RecordedStep;
    expect(step.actionText).toBe('Click "Forwarders"');
    expect(step.naming).toEqual({
      name: "Forwarders",
      kind: "listItem",
      source: "ancestor",
      needsReview: false,
    });
    expect(parseStep(step).naming).toEqual(step.naming);

    const pane = { ...field, controlType: "Pane", name: "", automationId: "" };
    const unnamed = factToStep(click(2, 1_000, window, pane), wording);
    expect(unnamed?.naming).toEqual({
      name: "Site Tools > Dashboard - Google Chrome",
      kind: "other",
      source: "window",
      needsReview: true,
    });
    expect(unnamed?.reviewRequired).toBe(true);
  });

  it("keeps a UI framework's name out of the step, as the recorder no longer does (06/10/2026)", () => {
    const window = edge("Untitled - Notepad");
    const host = { ...field, controlType: "Pane", name: "PopupHost", automationId: "" };
    const step = factToStep(click(1, 1_000, window, host), wording) as RecordedStep;
    expect(step.actionText).toBe('Click in "Untitled - Notepad"');
    // As for any unnamed click, the window's title.
    expect(step.textParts.target).toBe("Untitled - Notepad");
    expect(JSON.stringify(step.target)).not.toContain("PopupHost");
  });
});

describe("what's typed becomes steps (docs/spec/02-capture.md#keys)", () => {
  const terminal = {
    title: "Windows PowerShell",
    exe: "WindowsTerminal.exe",
    pid: 50,
    frame: { left: 0, top: 0, right: 100, bottom: 100 },
    elevation: "notElevated",
    remoteSession: false,
  };
  const capture = manualFact.record.kind === "manual" ? manualFact.record.capture : null;
  const fact = (sequence: number, record: RecordingFact["record"]): RecordingFact => ({
    sessionId: "s",
    recordedAt: 1_790_246_400_000 + sequence,
    sequence,
    record,
  });
  const command = (sequence: number, tickMs: number, language = "powershell") =>
    fact(sequence, {
      kind: "command",
      id: 2 ** 48 + sequence,
      tickMs,
      window: terminal,
      capture: capture && { ...capture, image: `command-${sequence}.webp` },
      terminal: "windowsTerminal",
      language,
      command: "Get-Mailbox -Identity sales",
      output: "Name  Alias\nsales sales",
      outputShortened: false,
      checkScreenshot: false,
    });
  const typing = (
    form: "code" | "text" | "formula",
    text: string,
    cell: string | null = null,
    extra: Partial<{ approximate: boolean; checkScreenshot: boolean }> = {},
  ) =>
    fact(9, {
      kind: "typing",
      id: 2 ** 48 + 9,
      tickMs: 900,
      window: { ...terminal, exe: form === "code" ? "Code.exe" : "EXCEL.EXE" },
      capture: null,
      element: null,
      text,
      form,
      language: form === "formula" ? "excel" : "plain",
      cell,
      approximate: false,
      checkScreenshot: false,
      ...extra,
    });

  it("a command is a code step with its output, worded by the shell", () => {
    const step = factToStep(command(4, 400), wording);
    expect(step?.action).toBe("command");
    expect(step?.actionText).toBe("Run in PowerShell");
    expect(step?.code).toEqual({
      text: "Get-Mailbox -Identity sales",
      language: "powershell",
      output: "Name  Alias\nsales sales",
      outputShortened: false,
    });
    expect(step?.media?.id).toBe("command-4");
    expect(factToStep(command(5, 400, "cmd"), wording)?.actionText).toBe("Run in Command Prompt");
    expect(factToStep(command(6, 400, "zsh"), wording)?.code?.language).toBe("plain");
    expect(factToStep(command(6, 400, "zsh"), wording)?.actionText).toBe("Run in the terminal");
    expect(() => parseStep(step)).not.toThrow();
  });

  it("formulas, code and text each read as they should", () => {
    const formula = factToStep(typing("formula", "=SUM(B2:B3)", "B6"), wording);
    expect(formula?.actionText).toBe("Type the formula in cell B6");
    expect(formula?.code).toMatchObject({ text: "=SUM(B2:B3)", language: "excel" });
    expect(factToStep(typing("formula", "=A1", null), wording)?.actionText).toBe(
      "Type the formula in the selected cell",
    );
    const code = factToStep(typing("code", "fn main() {}"), wording);
    expect(code?.actionText).toBe("Type this code");
    expect(code?.code?.text).toBe("fn main() {}");
    // Text in a cell is a typed value, with Show typed value and Remove value.
    const cell = factToStep(typing("text", "Q3 total", "B6"), wording);
    expect(cell?.action).toBe("input");
    expect(cell?.actionText).toBe('Type "Q3 total" in cell B6');
    expect(cell?.textParts.value).toBe("Q3 total");
    expect(cell?.showValue).toBe(true);
    // Typing into something unnamed keeps its text out unless chosen (A1): it's still kept.
    const unnamed = factToStep(typing("text", "Dear Sam"), wording);
    expect(unnamed?.actionText).toBe("Type");
    expect(unnamed?.textParts.value).toBe("Dear Sam");
    expect(unnamed?.showValue).toBe(false);
    expect(
      factToStep(typing("text", "Dear Sam"), wording, { showUnnamedTyping: true })?.actionText,
    ).toBe('Type "Dear Sam"');
  });

  it("follows the recording's own settings, never what Settings says now", () => {
    // Switched on in Settings mid-recording: this recording started with it off.
    window.localStorage.setItem("amluto-steps-show-unnamed-typing", "true");
    try {
      const step = factToStep(typing("text", "Dear Sam"), wording, { showUnnamedTyping: false });
      expect(step?.actionText).toBe("Type");
      expect(step?.showValue).toBe(false);
    } finally {
      window.localStorage.removeItem("amluto-steps-show-unnamed-typing");
    }
  });

  it("flags typing that may not match, and screenshots that need checking", () => {
    expect(
      factToStep(typing("text", "x", null, { approximate: true }), wording)?.reviewRequired,
    ).toBe(true);
    expect(
      factToStep(typing("code", "x", null, { checkScreenshot: true }), wording)?.reviewRequired,
    ).toBe(true);
    expect(factToStep(typing("code", "x"), wording)?.reviewRequired).toBeUndefined();
  });

  it("a key combination reads like the Add-shortcut popup's", () => {
    const step = factToStep(
      fact(3, {
        kind: "keys",
        id: 2 ** 48 + 3,
        tickMs: 300,
        window: terminal,
        capture: null,
        ctrl: true,
        alt: false,
        shift: true,
        win: false,
        vkey: 0x4e,
        key: "n",
      }),
      wording,
    );
    expect(step?.action).toBe("keypress");
    expect(step?.actionText).toBe('Press "Ctrl + Shift + N"');
    expect(step?.textParts).toMatchObject({ target: "Ctrl + Shift + N", kind: "shortcut" });
  });

  it("a command written after later steps goes back to when Enter was pressed", () => {
    // The output took 1.5 s to settle; a click came in the meantime.
    const click = fact(1, { ...(manualFact.record as object), tickMs: 1_000 } as never);
    const later = fact(2, { ...(manualFact.record as object), tickMs: 2_500 } as never);
    const facts = [click, later, command(3, 1_200)];
    const placed = orderRecordedSteps(
      facts.map((each) => factToStep(each, wording)).filter((step) => step !== null),
      facts,
    );
    expect(placed.map((step) => step.id)).toEqual(["capture-1", "capture-3", "capture-2"]);
  });
});

// Rewording a guide (Language and tone, docs/spec/04-editor.md#language-and-tone) works the words
// out again from what each step stored: in English and the casual tone, that must give back exactly
// what was recorded.
describe("every recorded step words itself again from its facts", () => {
  it("gives back its words in English, casual", () => {
    expect(made.length).toBeGreaterThan(5);
    for (const step of made)
      expect({ id: step.id, words: wordStepIn(step, "en", "casual") }).toEqual({
        id: step.id,
        words: step.actionText,
      });
  });

  it("gives back the same words as 1.0.0 saved it, without its naming", () => {
    expect(made.some((step) => step.naming)).toBe(true);
    for (const step of made)
      expect({
        id: step.id,
        words: wordStepIn({ ...step, naming: undefined }, "en", "casual"),
      }).toEqual({ id: step.id, words: step.actionText });
  });
});

describe("typing steps' screenshots", () => {
  const step = (id: string, action: string, title: string, media: string | null): RecordedStep =>
    ({
      id,
      action,
      context: { app: null, windowTitle: title },
      media: media ? { id: media, width: 100, height: 50, scale: 1, captureRect: null } : null,
      highlight: media ? { shape: "circle", x: 10, y: 10, w: 5, h: 5 } : null,
    }) as unknown as RecordedStep;

  it("take the click's before them in the same window, and keep their own when they have one", () => {
    const steps = borrowScreenshots([
      step("a", "click", "Sign in", "m1"),
      step("b", "input", "Sign in", null),
      step("c", "click", "Sign in", "m2"),
      step("d", "input", "Another window", null),
      step("e", "input", "Sign in", "m3"),
    ]);
    expect(steps.map((item) => item.media?.id ?? null)).toEqual(["m1", "m1", "m2", null, "m3"]);
    expect(steps[1]?.highlight).toEqual(steps[0]?.highlight);
  });
});
