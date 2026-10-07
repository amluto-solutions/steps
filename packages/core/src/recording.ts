import { z } from "zod";

import type { StepCode } from "./code.ts";
import { isLanguage } from "./languages.ts";
import { TONES } from "./step-text/phrase.ts";
import type { ClickNaming } from "./step-text/click-naming.ts";

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
  /** The program's own name ("Microsoft Edge"); absent in recordings made before 0.2.7. */
  appName: z.string().nullable().optional(),
  /** The taskbar, Start or the desktop: part of Windows, not an app. */
  shell: z.boolean().optional(),
});
const click = z.object({
  kind: z.literal("click"),
  id: z.number(),
  tickMs: z.number(),
  button: z.enum(["left", "right", "middle"]),
  injected: z.boolean(),
  x: z.number(),
  y: z.number(),
  window: windowFacts,
  capture: z.object({
    mode: z.enum(["window", "monitor"]),
    rect,
    monitor: rect,
    scale: z.number(),
    width: z.number(),
    height: z.number(),
    image: z.string().nullable(),
  }),
  clickPct: z.object({ x: z.number(), y: z.number() }).nullable(),
  element: element.nullable(),
  elementPct: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  uia: z.object({
    status: z.enum(["ok", "timeout", "error", "skipped"]),
    ms: z.number(),
    retried: z.boolean(),
    error: z.string().nullable(),
  }),
  screenshotMs: z.number(),
  queueDelayMs: z.number(),
  /**
   * What Steps for Chrome or Edge said this click in a web page was
   * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together): the element's own facts,
   * which word the step in place of UI Automation's.
   */
  page: z.object({ target: pageTarget }).optional(),
});

const captureFacts = z.object({
  mode: z.enum(["window", "monitor"]),
  rect,
  monitor: rect,
  scale: z.number(),
  width: z.number(),
  height: z.number(),
  image: z.string().nullable(),
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

/** A stretch of typing with no field to read it from: an editor, a document, an Excel cell. */
const typing = z.object({
  kind: z.literal("typing"),
  id: z.number().nonnegative(),
  tickMs: z.number().int().nonnegative(),
  window: windowFacts,
  capture: captureFacts.nullable(),
  element: element.nullable(),
  text: z.string(),
  form: z.enum(["code", "text", "formula"]),
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
  capture: z.object({
    mode: z.enum(["window", "monitor"]),
    rect,
    monitor: rect,
    scale: z.number(),
    width: z.number(),
    height: z.number(),
    image: z.string().nullable(),
  }),
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
  // Cells selected by dragging (04/10/2026): it replaces the click `of`.
  z.object({
    kind: z.literal("drag"),
    id: z.number(),
    of: z.number(),
    tickMs: z.number(),
    from: z.string().max(40),
    to: z.string().max(40),
    window: windowFacts,
    capture: click.shape.capture.nullable(),
    selectionPct: click.shape.elementPct,
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
export type CaptureRecord = z.infer<typeof record>;
export type ClickFact = z.infer<typeof click>;
export type InputFact = z.infer<typeof input>;
export type ManualFact = z.infer<typeof manual>;
export type AppSwitchFact = Extract<z.infer<typeof record>, { kind: "appSwitch" }>;
export type NavigationFact = Extract<z.infer<typeof record>, { kind: "navigation" }>;
export type DragFact = Extract<z.infer<typeof record>, { kind: "drag" }>;
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
  })
  .strip();

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
