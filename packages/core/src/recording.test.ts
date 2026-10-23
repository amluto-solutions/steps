import { describe, expect, it } from "vitest";

import { recordingFactSchema } from "./recording";

const manualScreenshot = {
  sessionId: "session-1",
  recordedAt: 1_790_246_400_000,
  sequence: 1,
  record: {
    kind: "manual",
    id: 1,
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
      image: "manual-1.webp",
    },
    clickPct: { x: 50, y: 25 },
  },
};

describe("recording fact schema", () => {
  it("accepts user-requested screenshot facts with saved media", () => {
    expect(recordingFactSchema.parse(manualScreenshot)).toEqual(manualScreenshot);
  });

  it("can recover a screenshot fact from older builds with a nanosecond id", () => {
    const legacy = {
      ...manualScreenshot,
      record: { ...manualScreenshot.record, id: 1_790_340_127_255_044_900 },
    };
    expect(recordingFactSchema.parse(legacy)).toEqual(legacy);
    expect(() =>
      recordingFactSchema.parse({
        ...manualScreenshot,
        record: { ...manualScreenshot.record, id: 1.5 },
      }),
    ).toThrow();
  });

  it("keeps where a notification toast shows on a screenshot, for every kind of capture", () => {
    const notifications = [{ x: 80.2, y: 75, w: 18.9, h: 19.4 }];
    const withToast = {
      ...manualScreenshot,
      record: {
        ...manualScreenshot.record,
        capture: { ...manualScreenshot.record.capture, notifications },
      },
    };
    expect(recordingFactSchema.parse(withToast)).toEqual(withToast);
    const click = {
      ...manualScreenshot,
      record: {
        kind: "click",
        id: 2,
        tickMs: 120,
        button: "left",
        injected: false,
        x: 10,
        y: 10,
        window: manualScreenshot.record.window,
        capture: { ...manualScreenshot.record.capture, notifications },
        clickPct: { x: 10, y: 10 },
        element: null,
        elementPct: null,
        uia: { status: "timeout", ms: 350, retried: false, error: null },
        screenshotMs: 20,
        queueDelayMs: 1,
      },
    };
    expect(recordingFactSchema.parse(click)).toEqual(click);
    const keys = {
      ...manualScreenshot,
      record: {
        kind: "keys",
        id: 3,
        tickMs: 130,
        window: manualScreenshot.record.window,
        capture: { ...manualScreenshot.record.capture, notifications },
        ctrl: true,
        alt: false,
        shift: false,
        win: false,
        vkey: 83,
        key: null,
      },
    };
    expect(recordingFactSchema.parse(keys)).toEqual(keys);
  });

  it("keeps the items of a menu a click landed in, as long as the recorder keeps them (#56)", () => {
    const click = (menuItems: unknown[]) => ({
      ...manualScreenshot,
      record: {
        kind: "click",
        id: 2,
        tickMs: 120,
        button: "left",
        injected: false,
        x: 10,
        y: 10,
        window: manualScreenshot.record.window,
        capture: manualScreenshot.record.capture,
        clickPct: { x: 10, y: 10 },
        element: null,
        elementPct: null,
        uia: { status: "error", ms: 3, retried: false, error: null },
        screenshotMs: 20,
        queueDelayMs: 1,
        menuItems,
      },
    });
    // The recorder cuts a name at 200 characters, each of which may be two units here.
    const longest = "📁".repeat(200);
    const items = [
      { name: "Format Cells…", box: { x: 40.5, y: 49.8, w: 14.2, h: 2.4 } },
      { name: longest, box: null },
    ];
    expect(recordingFactSchema.parse(click(items))).toEqual(click(items));
    const tooMany = Array.from({ length: 65 }, () => ({ name: "Recent", box: null }));
    expect(() => recordingFactSchema.parse(click(tooMany))).toThrow();
  });

  it("rejects unsafe session identifiers and unknown manual purposes", () => {
    expect(() =>
      recordingFactSchema.parse({ ...manualScreenshot, sessionId: "../outside" }),
    ).toThrow();
    expect(() =>
      recordingFactSchema.parse({
        ...manualScreenshot,
        record: { ...manualScreenshot.record, purpose: "arbitrary" },
      }),
    ).toThrow();
  });

  it("accepts foreground application change facts", () => {
    const fact = {
      sessionId: "session-1",
      recordedAt: 1_790_246_400_000,
      sequence: 2,
      record: {
        kind: "appSwitch",
        tickMs: 125,
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
    expect(recordingFactSchema.parse(fact)).toEqual(fact);
  });

  describe("an element's parents", () => {
    const field = {
      controlType: "Edit",
      localizedControlType: "edit",
      name: "Email",
      automationId: "",
      helpText: "",
      ariaRole: "",
      ariaProperties: "",
      className: "",
      frameworkId: "Chrome",
      isPassword: false,
      labeledBy: null,
      bounds: null,
      sensitive: false,
    };
    const inputFact = (element: object) => ({
      sessionId: "session-1",
      recordedAt: 1_790_246_400_000,
      sequence: 4,
      record: { kind: "input", tickMs: 140, element, value: null, withheld: "setting-off" },
    });
    const elementOf = (parsed: unknown) =>
      (parsed as { record: { element: Record<string, unknown> } }).record.element;

    it("keeps up to four, nearest first", () => {
      const ancestors = [
        { controlType: "Group", name: "" },
        { controlType: "ListItem", name: "Forwarders" },
        { controlType: "List", name: "Email" },
      ];
      expect(elementOf(recordingFactSchema.parse(inputFact({ ...field, ancestors })))).toEqual({
        ...field,
        ancestors,
      });
    });

    it("reads the one parent a recording made before 06/10/2026 kept", () => {
      const parent = { controlType: "Group", name: "Sign in" };
      expect(elementOf(recordingFactSchema.parse(inputFact({ ...field, parent })))).toEqual({
        ...field,
        ancestors: [parent],
      });
      expect(elementOf(recordingFactSchema.parse(inputFact({ ...field, parent: null })))).toEqual({
        ...field,
        ancestors: [],
      });
    });
  });

  it("requires a normalized HTTP site origin in navigation facts", () => {
    const fact = {
      sessionId: "session-1",
      recordedAt: 1_790_246_400_000,
      sequence: 3,
      record: {
        kind: "navigation",
        tickMs: 125,
        origin: "https://example.test",
        window: {
          title: "Example — Edge",
          exe: "msedge.exe",
          pid: 12,
          frame: { left: 0, top: 0, right: 100, bottom: 100 },
          elevation: "notElevated",
          remoteSession: false,
        },
      },
    };
    expect(recordingFactSchema.parse(fact)).toEqual(fact);
    expect(() =>
      recordingFactSchema.parse({
        ...fact,
        record: { ...fact.record, origin: "https://example.test/private?q=secret" },
      }),
    ).toThrow();
    expect(() =>
      recordingFactSchema.parse({
        ...fact,
        record: { ...fact.record, origin: "file:///private" },
      }),
    ).toThrow();
    // Edge and Chrome hide the scheme: the site as the browser shows it.
    for (const origin of ["127.0.0.1:8124", "www.example.test", "localhost:3000", "[::1]:8080"])
      expect(
        recordingFactSchema.parse({ ...fact, record: { ...fact.record, origin } }),
      ).toBeTruthy();
    for (const origin of ["example.test/private", "a b", "mailto:x@y.test", "user@example.test"])
      expect(() =>
        recordingFactSchema.parse({ ...fact, record: { ...fact.record, origin } }),
      ).toThrow();
  });
});
