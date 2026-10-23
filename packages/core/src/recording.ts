import { z } from "zod";

import type { StepCode } from "./code.ts";
import { isLanguage } from "./languages.ts";
import { TONES } from "./step-text/phrase.ts";
import { TITLE_BAR_BUTTONS, type ClickNaming } from "./step-text/click-naming.ts";

export const recorderPreferencesSchema = z
  .object({
    displayName: z.string().max(120),
    libraryFolder: z.string().min(1),
  })
  .strict();
export type RecorderPreferences = z.infer<typeof recorderPreferencesSchema>;

/**
 * The settings a recording's steps are built with, read once at Record (IT policy applied) and
 * saved with the recording (docs/spec/02-capture.md#recording-settings). Its live steps and a
 * draft rebuilt from its journal later use the same value, so a setting changed mid-recording
 * applies from the next recording.
 */
export const recordingSettingsSchema = z.object({
  /** Typing into something unnamed shows its text in the step (A1); off unless chosen. */
  showUnnamedTyping: z.boolean(),
  /**
   * The language and tone its steps are worded in, kept so a rebuild after a restart words them
   * as the live steps were. Steps take it as its own value (`useStepWording`).
   */
  wording: z
    .object({
      language: z.string().refine((code): boolean => isLanguage(code)),
      tone: z.enum(TONES),
    })
    .optional(),
});
export type RecordingSettings = z.infer<typeof recordingSettingsSchema>;
/** Settings as they start, unless the person or IT changed them. */
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = { showUnnamedTyping: false };

const rect = z.object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() });
/**
 * The site a navigation step names: a normalised origin (`https://example.test:8443`), or, where
 * the browser hides the scheme as Edge and Chrome do, just the host and any port it shows
 * (`example.test`, `127.0.0.1:8124`). Never a path, a query or anything else.
 */
const siteOrigin = z
  .string()
  .max(300)
  .refine((value) => {
    if (/^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/i.test(value)) return true;
    if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(value)) return true;
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value
      );
    } catch {
      return false;
    }
  });
const ancestor = z.object({ controlType: z.string(), name: z.string() });
/** What UI Automation or AT-SPI said about an element (`UiaElementFacts`). */
const element = z
  .object({
    controlType: z.string(),
    localizedControlType: z.string(),
    name: z.string(),
    automationId: z.string(),
    helpText: z.string(),
    ariaRole: z.string(),
    ariaProperties: z.string(),
    className: z.string(),
    frameworkId: z.string(),
    isPassword: z.boolean(),
    labeledBy: z.string().nullable(),
    bounds: rect.nullable(),
    /** Nearest first, up to four (06/10/2026). */
    ancestors: z.array(ancestor).optional(),
    /** Recordings made before then kept only the nearest, here; one may still be opened. */
    parent: ancestor.nullable().optional(),
    sensitive: z.boolean(),
    /**
     * A spreadsheet cell with a filter drop-down (Excel's `HasFilterDropdown`): its words, the
     * header the filter is on (12/10/2026, #70); absent otherwise, and in older recordings.
     */
    filterHeader: z.string().max(2_000).optional(),
    /**
     * The class of the Document the element's parents stopped at (Word's body, `_WwG`), so a
     * click in a document's text is told from one on a control (12/10/2026, #74); absent when
     * they stopped anywhere else, and in older recordings.
     */
    documentClass: z.string().max(256).optional(),
  })
  .transform(({ ancestors, parent, ...facts }) => ({
    ...facts,
    ancestors: ancestors ?? (parent ? [parent] : []),
  }));

/**
 * What the Chrome edition records (docs/spec/02-capture.md#chrome-edition): facts from the page
 * itself, so the wording rules get the element's own names rather than UI Automation's.
 */
const pageText = z.string().max(2_000).optional();
/** A page element's step facts, as the wording rules read them (`StepTarget`). */
const pageTarget = z
  .object({
    tagName: pageText,
    elementType: pageText,
    ariaLabel: pageText,
    innerText: pageText,
    placeholder: pageText,
    name: pageText,
    labelText: pageText,
    alt: pageText,
    role: pageText,
    value: pageText,
  })
  .strict();

const windowFacts = z.object({
  title: z.string(),
  exe: z.string().nullable(),
  pid: z.number(),
  frame: rect,
  elevation: z.string(),
  remoteSession: z.boolean(),
  /**
   * The program's own name ("Microsoft Edge"), from its version details: null when it gives none,
   * or only its file name (since #50); absent in recordings made before 0.2.7.
   */
  appName: z.string().nullable().optional(),
  /**
   * For a store app's frame (`ApplicationFrameHost.exe`), the app it shows, by its package's
   * display name ("Calculator"); absent for other windows, when it wasn't found, and in
   * recordings made before #50. `appNameOf` names a window's app from these facts.
   */
  hostedApp: z.string().nullable().optional(),
  /**
   * For a frame Windows draws round another program's window, that program's file
   * (`TextInputHost.exe`: Windows 11 shows the emoji panel in a frame of `explorer.exe`'s); absent
   * for other windows, and in recordings made before #109. The click naming knows Windows' input
   * panel by it.
   */
  hostedExe: z.string().max(260).nullable().optional(),
  /**
   * For a click in a pop-up (a menu, a drop-down list: a top-level window without a title bar of
   * Windows'), the title of the window it came from, as the recorder found it as the button went
   * down ("" when that has none); absent for other windows, a pop-up of the Windows shell's, and
   * in recordings made before #106. A click nothing named is named by it, not by the pop-up's
   * own title, which isn't on screen (WinUI's pop-up host is "Pop-upHost" in en-GB).
   */
  ownerTitle: z.string().nullable().optional(),
  /** The taskbar, Start or the desktop: part of Windows, not an app. */
  shell: z.boolean().optional(),
});
/** Where notification toasts show on a screenshot, as percentages of it. */
const notificationAreas = z
  .array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
  .max(50)
  .optional();

/**
 * A screenshot the recorder took, and where it came from. `notifications` are where a notification
 * toast shows in it, as percentages of it (12/10/2026, docs/spec/02-capture.md#on-each-click): the
 * desktop recognises toasts by their window, and they're suggested for blurring.
 */
const captureFacts = z.object({
  mode: z.enum(["window", "monitor"]),
  rect,
  monitor: rect,
  scale: z.number(),
  width: z.number(),
  height: z.number(),
  image: z.string().nullable(),
  notifications: notificationAreas,
});

/**
 * The most items of a menu a click keeps, and the longest name each may have (`menus.rs`): 200
 * characters, which JavaScript counts as up to two units each.
 */
const MENU_ITEMS = 64;
const MENU_ITEM_UNITS = 200 * 2;

const click = z.object({
  kind: z.literal("click"),
  id: z.number(),
  tickMs: z.number(),
  button: z.enum(["left", "right", "middle"]),
  injected: z.boolean(),
  x: z.number(),
  y: z.number(),
  window: windowFacts,
  capture: captureFacts,
  clickPct: z.object({ x: z.number(), y: z.number() }).nullable(),
  element: element.nullable(),
  elementPct: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  uia: z.object({
    status: z.enum(["ok", "timeout", "error", "skipped"]),
    ms: z.number(),
    retried: z.boolean(),
    error: z.string().nullable(),
    /**
     * The element was read under the resting pointer before the click (its pre-read), not after
     * it (docs/spec/02-capture.md#on-each-click, #92); absent otherwise, and in older recordings.
     */
    preRead: z.boolean().optional(),
  }),
  screenshotMs: z.number(),
  queueDelayMs: z.number(),
  /**
   * What Steps for Chrome or Edge said this click in a web page was
   * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together): the element's own facts,
   * which word the step in place of UI Automation's.
   */
  page: z.object({ target: pageTarget }).optional(),
  /**
   * The window's own title-bar button the click was on, from Windows' hit test as the button went
   * down (12/10/2026, #48); absent anywhere else, and in older recordings.
   */
  titleBarButton: z.enum(TITLE_BAR_BUTTONS).optional(),
  /**
   * The left button went down on the filter drop-down of the spreadsheet header clicked, told from
   * the cell's box (12/10/2026, #70); absent anywhere else, and in older recordings.
   */
  filterButton: z.boolean().optional(),
  /**
   * The window clicked had gone from the click when the screenshot was taken, so the picture shows
   * what was behind it there (12/10/2026, #48); absent in older recordings.
   */
  windowGone: z.boolean().optional(),
  /**
   * The items of the open menu the click landed in, as UI Automation read them when the menu
   * opened, each with its box on the screenshot (% of it) when it had one (12/10/2026, #56): a
   * name read from the screenshot is matched against them. Absent off a menu, on Linux, and in
   * older recordings.
   */
  menuItems: z
    .array(
      z.object({
        name: z.string().max(MENU_ITEM_UNITS),
        box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
      }),
    )
    .max(MENU_ITEMS)
    .optional(),
  /**
   * The menu `menuItems` are from was still showing as the button went down: read in a window of
   * its own (a pop-up), which was under the pointer then (#106), so the item whose box holds the
   * click is the one clicked, with or without words. Absent otherwise, and in older recordings.
   */
  menuShowing: z.boolean().optional(),
});

/** A command run in a terminal (only with "Record what's typed"). */
const command = z.object({
  kind: z.literal("command"),
  id: z.number().nonnegative(),
  tickMs: z.number().int().nonnegative(),
  window: windowFacts,
  capture: captureFacts.nullable(),
  terminal: z.string(),
  language: z.string(),
  command: z.string(),
  output: z.string().nullable(),
  outputShortened: z.boolean(),
  checkScreenshot: z.boolean(),
});

/**
 * A stretch of typing with no field to read it from: an editor, a document, an Excel cell. Its
 * `form` `goTo` is a cell's reference typed into Excel's Name Box or Go To, the cell gone to
 * (12/10/2026, #69).
 */
const typing = z.object({
  kind: z.literal("typing"),
  id: z.number().nonnegative(),
  tickMs: z.number().int().nonnegative(),
  window: windowFacts,
  capture: captureFacts.nullable(),
  element: element.nullable(),
  text: z.string(),
  form: z.enum(["code", "text", "formula", "goTo"]),
  language: z.string(),
  cell: z.string().nullable(),
  approximate: z.boolean(),
  checkScreenshot: z.boolean(),
});

/** A key combination (not copy, paste and the other noise). */
const keys = z.object({
  kind: z.literal("keys"),
  id: z.number().nonnegative(),
  tickMs: z.number().int().nonnegative(),
  window: windowFacts,
  capture: captureFacts.nullable(),
  ctrl: z.boolean(),
  alt: z.boolean(),
  shift: z.boolean(),
  win: z.boolean(),
  vkey: z.number().int().nonnegative(),
  key: z.string().nullable(),
});

const input = z.object({
  kind: z.literal("input"),
  tickMs: z.number(),
  element,
  value: z.string().nullable(),
  withheld: z.string().nullable(),
  // The field's screenshot from when focus arrived in it (04/10/2026); absent before then, or
  // where none was taken.
  id: z.number().optional(),
  window: windowFacts.optional(),
  capture: click.shape.capture.optional(),
  elementPct: click.shape.elementPct.optional(),
});

const manual = z.object({
  kind: z.literal("manual"),
  // Older native builds journaled nanosecond ids beyond JS's safe integer range.
  id: z.number().nonnegative().refine(Number.isInteger),
  tickMs: z.number().int().nonnegative(),
  purpose: z.enum(["captureNow", "shortcut"]),
  actionText: z.string(),
  window: windowFacts,
  capture: captureFacts,
  clickPct: z.object({ x: z.number(), y: z.number() }).nullable(),
});

/** The tab and page a fact happened in; never the page's address beyond its site. */
const pageFacts = z.object({
  tabId: z.number().int(),
  title: z.string().max(2_000),
  origin: siteOrigin.nullable(),
});
/** The visible part of the page, captured when the pointer went down. */
const pageCapture = z.object({
  image: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}\.webp$/)
    .nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
});
const pageClick = z.object({
  kind: z.literal("pageClick"),
  id: z.number().int().nonnegative(),
  tickMs: z.number().int().nonnegative(),
  page: pageFacts,
  capture: pageCapture,
  target: pageTarget.nullable(),
  /** The click, as % of the screenshot. */
  clickPct: z.object({ x: z.number(), y: z.number() }).nullable(),
  /** The element's box, as % of the screenshot. */
  elementPct: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
});
const pageInput = z.object({
  kind: z.literal("pageInput"),
  tickMs: z.number().int().nonnegative(),
  page: pageFacts,
  target: pageTarget,
  /** Null when not read: a secret field, or a recording without "Record what's typed". */
  value: z.string().max(20_000).nullable(),
  withheld: z.enum(["sensitive", "off"]).nullable(),
});
const pageNavigation = z.object({
  kind: z.literal("pageNavigation"),
  tickMs: z.number().int().nonnegative(),
  page: pageFacts,
  origin: siteOrigin,
});

const record = z.discriminatedUnion("kind", [
  pageClick,
  pageInput,
  pageNavigation,
  click,
  input,
  manual,
  command,
  typing,
  keys,
  z.object({
    kind: z.literal("appSwitch"),
    tickMs: z.number().int().nonnegative(),
    window: windowFacts,
    capture: captureFacts.nullable().optional(),
    // No click, tap or key came in the moments before the app came forward, so it may have come
    // forward by itself (12/10/2026, #67); absent in recordings made before then.
    unprompted: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("navigation"),
    tickMs: z.number().int().nonnegative(),
    origin: siteOrigin,
    window: windowFacts,
    // The page arrived at, once its address settled (04/10/2026); absent before then.
    id: z.number().optional(),
    capture: click.shape.capture.optional(),
  }),
  z.object({ kind: z.literal("double"), of: z.number(), tickMs: z.number() }),
  // Cells selected by dragging (04/10/2026), or filled with Excel's fill handle (08/10/2026): it
  // replaces the click `of`. A fill has no `to` when its handle was double-clicked (down the
  // column) or dragged to where no cell was found.
  z.object({
    kind: z.literal("drag"),
    id: z.number(),
    of: z.number(),
    tickMs: z.number(),
    from: z.string().max(40),
    to: z.string().max(40).nullable(),
    fill: z.enum(["drag", "double"]).optional(),
    window: windowFacts,
    capture: click.shape.capture.nullable(),
    selectionPct: click.shape.elementPct,
    handlePct: click.shape.clickPct.optional(),
  }),
  // A pencil or brush dragged across a canvas (Paint's, 12/10/2026, #73): it replaces the click
  // `of`, as a selection does. `fromPct` is where it began, on the screenshot taken as it ended.
  z.object({
    kind: z.literal("draw"),
    id: z.number(),
    of: z.number(),
    tickMs: z.number(),
    element,
    window: windowFacts,
    capture: click.shape.capture.nullable(),
    fromPct: click.shape.clickPct,
  }),
  z.object({ kind: z.literal("missed"), count: z.number(), afterId: z.number() }),
  z.object({ kind: z.literal("touch"), count: z.number(), tickMs: z.number() }),
  z.object({ kind: z.literal("state"), state: z.string(), reason: z.string(), tickMs: z.number() }),
]);

export const recordingFactSchema = z.object({
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  recordedAt: z.number().int().nonnegative(),
  sequence: z.number().int().positive(),
  record,
});

export type RecordingFact = z.infer<typeof recordingFactSchema>;
/** A recorded window: its title, its program and where it was. */
export type WindowFacts = z.infer<typeof windowFacts>;
export type CaptureRecord = z.infer<typeof record>;
export type ClickFact = z.infer<typeof click>;
export type InputFact = z.infer<typeof input>;
export type ManualFact = z.infer<typeof manual>;
export type AppSwitchFact = Extract<z.infer<typeof record>, { kind: "appSwitch" }>;
export type NavigationFact = Extract<z.infer<typeof record>, { kind: "navigation" }>;
export type DragFact = Extract<z.infer<typeof record>, { kind: "drag" }>;
export type DrawFact = Extract<z.infer<typeof record>, { kind: "draw" }>;
export type CommandFact = z.infer<typeof command>;
export type TypingFact = z.infer<typeof typing>;
export type KeysFact = z.infer<typeof keys>;
export type PageClickFact = z.infer<typeof pageClick>;
export type PageInputFact = z.infer<typeof pageInput>;
export type PageNavigationFact = z.infer<typeof pageNavigation>;

export interface RecordedStep {
  id: string;
  sortKey: string;
  kind: "interaction";
  action: string;
  actionText: string;
  textParts: { verb: string; target: string; kind: string; value?: string };
  showValue: boolean;
  textEdited: false;
  notes: null;
  altText: null;
  context: { app: string | null; windowTitle: string };
  target: unknown;
  media: {
    id: string | null;
    width: number | null;
    height: number | null;
    scale: number | null;
    captureRect: [number, number, number, number] | null;
    /** Where a notification toast showed on it, % of the image; absent when none did. */
    notifications?: { x: number; y: number; w: number; h: number }[];
  } | null;
  /** A click's circle, or a field's box (a typing step's own screenshot, 04/10/2026). */
  highlight: { shape: "circle" | "box"; x: number; y: number; w: number; h: number } | null;
  crop: null;
  redactions: [];
  annotations: [];
  block: null;
  code?: StepCode;
  capturedAt: string;
  updatedAt: string;
  updatedBy: string;
  formatVersion: 1;
  reviewRequired?: boolean;
  /** What a click is called (docs/spec/02-capture.md#click-naming). */
  naming?: ClickNaming;
}

/** Validate journal step files before they cross from the desktop bridge into review. */
export const recordedStepSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
    sortKey: z.string(),
    kind: z.literal("interaction"),
    action: z.string(),
    actionText: z.string(),
    textParts: z.object({
      verb: z.string(),
      target: z.string(),
      kind: z.string(),
      value: z.string().optional(),
    }),
    showValue: z.boolean(),
    textEdited: z.literal(false),
    notes: z.null(),
    altText: z.null(),
    context: z.object({ app: z.string().nullable(), windowTitle: z.string() }),
    target: z.unknown(),
    media: z
      .object({
        id: z.string().nullable(),
        width: z.number().nullable(),
        height: z.number().nullable(),
        scale: z.number().nullable(),
        captureRect: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
        notifications: notificationAreas,
      })
      .nullable(),
    highlight: z
      .object({
        shape: z.enum(["circle", "box"]),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      })
      .nullable(),
    crop: z.null(),
    redactions: z.tuple([]),
    annotations: z.tuple([]),
    block: z.null(),
    capturedAt: z.string(),
    updatedAt: z.string(),
    updatedBy: z.string(),
    formatVersion: z.literal(1),
    reviewRequired: z.boolean().optional(),
  })
  .passthrough()
  .transform((step) => step as RecordedStep);

/**
 * The recorder's events and state, as the Rust side sends them. Every Tauri event is checked
 * against its schema before the UI uses it (docs/engineering.md, validation).
 */
export const recorderSnapshotSchema = z
  .object({
    state: z.enum(["idle", "recording", "paused", "degraded", "stopping"]),
    reason: z.string().max(2_000).nullable(),
    sessionId: z.string().max(200).nullable(),
    stepCount: z.number().int().min(0),
    missedCount: z.number().int().min(0),
    inputSource: z.enum(["rawInput", "hook"]),
    /** The recording reads the keyboard: the bar shows "Keys recorded". */
    keysRecorded: z.boolean().catch(false),
    /** "Show a keyboard shortcut" is waiting for the keys: the bar says so. */
    waitingForKeys: z.boolean().catch(false),
  })
  .strip();

/** Where "Move the bar" last put the recording bar; null once it's dragged elsewhere. */
export const barPlaceSchema = z.enum(["left", "centre", "right"]).nullable();

/**
 * The link with Steps for Chrome and Edge, as the app reports it
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
 */
export const linkStatusSchema = z
  .object({
    available: z.boolean(),
    enabled: z.boolean(),
    connected: z.array(z.string().max(20)).max(8),
    problem: z.string().max(40).nullable(),
  })
  .strip();

export const recorderErrorSchema = z
  .object({ code: z.string().max(100), message: z.string().max(4_000) })
  .strip();

export const recorderFinishedSchema = z
  .object({
    sessionId: z.string().max(200),
    title: z.string().max(2_000),
    snapshot: recorderSnapshotSchema,
  })
  .strip();

export const recorderRestartedSchema = z
  .object({
    sessionId: z.string().max(200),
    afterSequence: z.number().int().min(0).nullable(),
  })
  .strip();

export const recorderStepAddedSchema = z
  .object({ sessionId: z.string().max(200), step: recordedStepSchema })
  .strip();
