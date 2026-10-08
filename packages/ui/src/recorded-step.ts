import {
  CODE_LANGUAGES,
  asRightClick,
  CODE_LANGUAGE_LABELS,
  clickPhrase,
  compareSortKeys,
  describeCode,
  describeCommand,
  describeFormula,
  describeInput,
  keyBetween,
  keyCombo,
  nameClick,
  phraseFor,
  readableFacts,
  renderPhrase,
  taskbarAppName,
  uiaToStepTarget,
} from "@amluto-steps/core";
import type {
  ClickFact,
  CodeLanguage,
  DragFact,
  CommandFact,
  KeysFact,
  NavigationFact,
  PageClickFact,
  PageInputFact,
  Phrase,
  RecordedStep,
  StepTarget,
  StepWording,
  RecordingFact,
  RecordingSettings,
  TypingFact,
} from "@amluto-steps/core";

export { taskbarAppName };

/** A phrase in the words new recordings are written in (Settings: language and tone). */
const say = (phrase: Phrase, wording: StepWording) =>
  renderPhrase(phrase, wording.language, wording.tone);

/**
 * A recorded step's id is `capture-<sequence>`, and its screenshot is `<media id>.webp` in the
 * session folder. These four are the only places that know those shapes.
 */
export const captureStepId = (sequence: number) => `capture-${sequence}`;
/** The capture sequence a recorded step came from, for "Start again"; null for any other step. */
export const captureSequenceOf = (stepId: string): number | null => {
  const match = /^capture-(\d+)$/.exec(stepId);
  return match ? Number(match[1]) : null;
};
export const mediaIdOf = (imageFile: string) => imageFile.replace(/\.webp$/i, "");
export const imageFileOf = (mediaId: string) => `${mediaId}.webp`;

const toIsoDate = (milliseconds: number): string => new Date(milliseconds).toISOString();

const baseStep = (
  fact: RecordingFact,
  action: string,
  actionText: string,
  target: unknown,
  targetName: string,
  targetKind: string,
  reviewRequired = false,
): RecordedStep => {
  const capturedAt = toIsoDate(fact.recordedAt);
  return {
    id: captureStepId(fact.sequence),
    sortKey: fact.sequence.toString(36).padStart(10, "0"),
    kind: "interaction",
    action,
    actionText,
    textParts: { verb: action, target: targetName, kind: targetKind },
    showValue: false,
    textEdited: false,
    notes: null,
    altText: null,
    context: { app: null, windowTitle: "" },
    target,
    media: null,
    highlight: null,
    crop: null,
    redactions: [],
    annotations: [],
    block: null,
    capturedAt,
    updatedAt: capturedAt,
    updatedBy: "",
    formatVersion: 1,
    ...(reviewRequired ? { reviewRequired: true } : {}),
  };
};

/** Circle diameter, as a percentage of the image width. */
const CLICK_CIRCLE_WIDTH = 3.1;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The click highlight: a circle centred on the click, stored as its bounding box (top-left and
 * size, % of the image) like every other highlight, so the viewer and exporters draw it the same
 * way. The height is scaled by the image's shape so the circle comes out round. Near an edge the
 * box may extend past the image; it is clipped when drawn, never moved off the click.
 */
export function clickHighlight(
  click: { x: number; y: number },
  imageWidth: number,
  imageHeight: number,
): { shape: "circle"; x: number; y: number; w: number; h: number } {
  const w = CLICK_CIRCLE_WIDTH;
  const h = imageWidth > 0 && imageHeight > 0 ? (w * imageWidth) / imageHeight : w;
  return {
    shape: "circle",
    x: round3(click.x - w / 2),
    y: round3(click.y - h / 2),
    w,
    h: round3(h),
  };
}

type Capture = ClickFact["capture"];

/** A field's box, a little larger than the field, kept inside the picture. */
function fieldHighlight(field: { x: number; y: number; w: number; h: number }) {
  const pad = 0.4;
  const x = Math.max(0, field.x - pad);
  const y = Math.max(0, field.y - pad);
  return {
    shape: "box" as const,
    x: round3(x),
    y: round3(y),
    w: round3(Math.min(100 - x, field.w + pad * 2)),
    h: round3(Math.min(100 - y, field.h + pad * 2)),
  };
}

/** A screenshot as a step's media, or null when the recorder took none. */
const mediaOf = (capture: Capture | null): RecordedStep["media"] =>
  capture?.image
    ? {
        id: mediaIdOf(capture.image),
        width: capture.width,
        height: capture.height,
        scale: capture.scale,
        captureRect: [capture.rect.left, capture.rect.top, capture.rect.right, capture.rect.bottom],
      }
    : null;

const asLanguage = (language: string): CodeLanguage =>
  (CODE_LANGUAGES as readonly string[]).includes(language) ? (language as CodeLanguage) : "plain";

/** A command run in a terminal (docs/spec/02-capture.md#terminals): "Run in PowerShell". */
function commandStep(fact: RecordingFact, record: CommandFact, wording: StepWording): RecordedStep {
  const language = asLanguage(record.language);
  const where = CODE_LANGUAGE_LABELS[language] || "terminal";
  const step = baseStep(
    fact,
    "command",
    describeCommand(language, wording),
    null,
    where,
    "terminal",
    record.checkScreenshot,
  );
  step.textParts.verb = "Run";
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  step.media = mediaOf(record.capture);
  step.code = {
    text: record.command,
    language,
    output: record.output,
    outputShortened: record.outputShortened,
  };
  return step;
}

/**
 * Typing with no field to read it from (docs/spec/02-capture.md#keys): code in an editor, a formula
 * in an Excel cell, or text anywhere else, which reads like a field's value and has the same
 * Show typed value and Remove value.
 */
function typingStep(
  fact: RecordingFact,
  record: TypingFact,
  wording: StepWording,
  settings: RecordingSettings,
): RecordedStep {
  const review = record.checkScreenshot || record.approximate;
  if (record.form === "formula" || record.form === "code") {
    const formula = record.form === "formula";
    const step = baseStep(
      fact,
      formula ? "formula" : "code",
      formula ? describeFormula(record.cell, wording) : describeCode(wording),
      null,
      formula ? (record.cell ?? "") : "",
      formula ? "formula" : "code",
      review,
    );
    step.textParts.verb = "Type";
    step.context = { app: record.window.exe, windowTitle: record.window.title };
    step.media = mediaOf(record.capture);
    step.code = {
      text: record.text,
      language: formula ? "excel" : asLanguage(record.language),
      output: null,
      outputShortened: false,
    };
    return step;
  }
  // A cell is named as one; anywhere else, by the element that had the keyboard.
  const target = record.cell
    ? { tagName: "TD", role: "gridcell", labelText: record.cell }
    : record.element
      ? uiaToStepTarget(record.element)
      : null;
  const label = record.cell ?? (record.element?.labeledBy || record.element?.name || "");
  // Typing into something unnamed keeps its text out of the wording unless chosen (A1): the value
  // is still kept, and can be shown step by step.
  const shown = Boolean(label) || settings.showUnnamedTyping;
  const actionText = say(
    phraseFor(
      "input",
      target && { ...target, value: shown ? record.text : undefined },
      target || !shown ? null : record.text,
    ) ?? (shown ? { key: "typeValue", value: record.text } : { key: "type" }),
    wording,
  );
  const step = baseStep(
    fact,
    "input",
    actionText,
    target && record.approximate ? { ...target, approximate: true } : target,
    label,
    record.cell ? "cell" : "field",
    review,
  );
  step.textParts.verb = "Type";
  step.textParts.value = record.text;
  step.showValue = shown;
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  step.media = mediaOf(record.capture);
  return step;
}

/** A key combination: "Press "Ctrl + Shift + N"", as the Add-shortcut popup writes it. */
function keysStep(fact: RecordingFact, record: KeysFact, wording: StepWording): RecordedStep {
  const combo = keyCombo(record);
  const step = baseStep(
    fact,
    "keypress",
    say({ key: "press", keys: combo }, wording),
    null,
    combo,
    "shortcut",
  );
  step.textParts.verb = "Press";
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  step.media = mediaOf(record.capture);
  return step;
}

/** What names a page element, for a step's `textParts.target`. */
const pageName = (target: StepTarget | null, title: string) =>
  target?.labelText ||
  target?.ariaLabel ||
  target?.innerText ||
  target?.alt ||
  target?.placeholder ||
  target?.name ||
  target?.value ||
  title;

function clickStep(fact: RecordingFact, record: ClickFact, wording: StepWording): RecordedStep {
  // A framework's name for the element is no name, here as in its naming.
  const element = record.element && readableFacts(record.element);
  // In Chrome or Edge, what the page itself said the element was, when it named it
  // (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
  const page = record.page ? { ...record.page.target } : null;
  const naming = nameClick({ element, window: record.window, page });
  // A right-click says so (04/10/2026), or a context menu's choice seems to come from nowhere.
  const right = record.button === "right";
  const phrase = clickPhrase(naming);
  const fromPage = naming.source === "page";
  const step = baseStep(
    fact,
    "click",
    say(right ? asRightClick(phrase) : phrase, wording),
    fromPage ? page : element ? uiaToStepTarget(element) : null,
    fromPage ? pageName(page, record.window.title) : element?.name || record.window.title || "",
    // A taskbar button is marked as one, so 1.0.0 can work its wording out again.
    fromPage
      ? page?.tagName?.toLowerCase() || "page"
      : naming.source === "taskbar"
        ? "taskbar"
        : element?.controlType.toLowerCase() || "window",
    naming.needsReview,
  );
  step.naming = naming;
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  if (right) step.textParts.verb = "rightClick";
  step.media = mediaOf(record.capture);
  if (record.clickPct) {
    step.highlight = clickHighlight(record.clickPct, record.capture.width, record.capture.height);
  }
  return step;
}

function navigationStep(
  fact: RecordingFact,
  record: NavigationFact,
  wording: StepWording,
): RecordedStep {
  const step = baseStep(
    fact,
    "navigation",
    say({ key: "goTo", site: record.origin }, wording),
    record.origin,
    record.origin,
    "website",
  );
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  // The page it arrived at (04/10/2026).
  if (record.capture?.image) step.media = mediaOf(record.capture);
  return step;
}

/**
 * Excel's fill handle (08/10/2026): `Fill "H8" down to "H250"`, the cells filled boxed, or with
 * no end cell, `Fill "H8" down the column`, its handle ringed. A drag whose end no cell was found
 * under asks to be checked; a double-click has no end cell to find.
 */
function fillStep(fact: RecordingFact, record: DragFact, wording: StepWording): RecordedStep {
  const range = record.to === null ? record.from : `${record.from}:${record.to}`;
  const step = baseStep(
    fact,
    "click",
    say({ key: "fill", from: record.from, to: record.to }, wording),
    { tagName: "TD", role: "gridcell", labelText: range },
    range,
    "cells",
    record.to === null && record.fill === "drag",
  );
  step.textParts.verb = "fill";
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  const { capture } = record;
  if (capture?.image) step.media = mediaOf(capture);
  if (record.selectionPct) step.highlight = fieldHighlight(record.selectionPct);
  else if (record.handlePct && capture)
    step.highlight = clickHighlight(record.handlePct, capture.width, capture.height);
  return step;
}

/** Cells selected by dragging (04/10/2026): "Select "D38:F42"", the selection boxed. */
function dragStep(fact: RecordingFact, record: DragFact, wording: StepWording): RecordedStep {
  if (record.fill || record.to === null) return fillStep(fact, record, wording);
  const range = `${record.from}:${record.to}`;
  const step = baseStep(
    fact,
    "click",
    say({ key: "selectRange", range }, wording),
    { tagName: "TD", role: "gridcell", labelText: range },
    range,
    "cells",
  );
  step.textParts.verb = "selectRange";
  step.context = { app: record.window.exe, windowTitle: record.window.title };
  if (record.capture?.image) step.media = mediaOf(record.capture);
  if (record.selectionPct) step.highlight = fieldHighlight(record.selectionPct);
  return step;
}

/**
 * A drag replaces the click it began with: the drag's step takes the click's place, and the
 * click's step goes (04/10/2026). So does a fill, dragged or double-clicked (08/10/2026).
 */
export function applyDrags(
  steps: readonly RecordedStep[],
  facts: readonly RecordingFact[],
): RecordedStep[] {
  const clickFact = new Map<number, RecordingFact>();
  for (const fact of facts) if (fact.record.kind === "click") clickFact.set(fact.record.id, fact);
  const replaced = new Map<string, string>();
  for (const fact of facts) {
    if (fact.record.kind !== "drag") continue;
    const started = clickFact.get(fact.record.of);
    if (started) replaced.set(captureStepId(started.sequence), captureStepId(fact.sequence));
  }
  if (replaced.size === 0) return [...steps];
  const sortKeys = new Map(steps.map((step) => [step.id, step.sortKey]));
  return steps
    .filter((step) => !replaced.has(step.id))
    .map((step) => {
      const click = [...replaced].find(([, drag]) => drag === step.id)?.[0];
      const sortKey = click ? sortKeys.get(click) : undefined;
      return sortKey ? { ...step, sortKey } : step;
    });
}

/**
 * A click in a web page (the Chrome edition): named by the naming module from the page's own facts
 * about the element, the same evidence the desktop gets through the extension link, with the tab's
 * title for its window; "Click in" the page, flagged, when nothing names it.
 */
function pageClickStep(
  fact: RecordingFact,
  record: PageClickFact,
  wording: StepWording,
): RecordedStep {
  const target = record.target ? { ...record.target } : null;
  const title = record.page.title.trim();
  const naming = nameClick({ element: null, window: { title, exe: null }, page: target });
  const step = baseStep(
    fact,
    "click",
    say(clickPhrase(naming), wording),
    target,
    pageName(target, title),
    target?.tagName?.toLowerCase() || "page",
    naming.needsReview,
  );
  step.naming = naming;
  step.context = { app: null, windowTitle: record.page.title };
  const { capture } = record;
  step.media = capture.image
    ? {
        id: mediaIdOf(capture.image),
        width: capture.width,
        height: capture.height,
        scale: capture.scale,
        captureRect: null,
      }
    : null;
  if (record.clickPct)
    step.highlight = clickHighlight(record.clickPct, capture.width, capture.height);
  return step;
}

/** A field in a web page typed in, read when focus left it. */
function pageInputStep(
  fact: RecordingFact,
  record: PageInputFact,
  wording: StepWording,
): RecordedStep {
  const target = { ...record.target };
  const actionText = say(
    phraseFor("input", { ...target, value: record.value ?? undefined }) ?? { key: "type" },
    wording,
  );
  const label = target.labelText || target.ariaLabel || target.placeholder || target.name || "";
  const step = baseStep(fact, "input", actionText, target, label, "field");
  step.showValue = record.value !== null;
  if (record.value !== null) step.textParts.value = record.value;
  step.context = { app: null, windowTitle: record.page.title };
  return step;
}

/**
 * A recorded fact as a guide step, its text cut to the step format's limits
 * (packages/core/src/guide.ts): a very long typed value, field name or window title must never
 * make a whole recording fail to open. `settings` are the recording's own, saved when it started:
 * never what Settings says now, so its live steps and a rebuild from its journal agree.
 */
export function factToStep(
  fact: RecordingFact,
  wording: StepWording,
  settings: RecordingSettings,
): RecordedStep | null {
  const step = buildStep(fact, wording, settings);
  return step && fitToFormat(step);
}

/** How soon after a click focus leaves the field it was taken from. */
const FOCUS_LEAVE_LAG_MS = 500;
/**
 * How far an app switch can trail the click that brought its window forward. On Linux the
 * window manager marks the window active only after the click has arrived.
 */
const ACTIVATION_LAG_MS = 500;

const bySortKey = (left: RecordedStep, right: RecordedStep) =>
  compareSortKeys(left.sortKey, right.sortKey) || compareSortKeys(left.id, right.id);

/** Milliseconds from tick `from` to tick `to`. Ticks wrap every 49.7 days, hence unsigned. */
const ticksBetween = (from: number, to: number) => (to - from) >>> 0;

type Element = NonNullable<ClickFact["element"]>;
/**
 * Whether a click and a typing step are about the same field. Fields named only by their label
 * (GTK's, on Linux) are told apart by it; a field with no name, id or label at all, by where it
 * is.
 */
const sameElement = (left: Element | null, right: Element) => {
  if (
    left === null ||
    left.controlType !== right.controlType ||
    left.name !== right.name ||
    left.automationId !== right.automationId ||
    (left.labeledBy ?? "") !== (right.labeledBy ?? "")
  ) {
    return false;
  }
  const anonymous = !right.name && !right.automationId && !right.labeledBy;
  return !anonymous || !left.bounds || !right.bounds
    ? true
    : JSON.stringify(left.bounds) === JSON.stringify(right.bounds);
};

/**
 * Some kinds of step reach the journal after the click they belong before
 * (docs/spec/02-capture.md#events), and are moved in front of it. `steps` may be in any order;
 * the result is sorted, and only those steps' sort keys change.
 *
 * - **A typing step** is read when focus leaves its field, which is when the next click lands:
 *   it goes before that click. Not before a click in the field itself.
 *   Later addresses stay where they arrived, after the click that changed the site.
 * - **An `Open` step** can trail the click that brought its window forward (the window manager
 *   marks it active once the click has arrived, on Linux): it goes before a click in that same
 *   window just before it.
 */
export function orderRecordedSteps(
  steps: readonly RecordedStep[],
  facts: readonly RecordingFact[],
): RecordedStep[] {
  const kept = new Set(steps.map((step) => step.id));
  const ordered = facts
    .filter((fact) => kept.has(captureStepId(fact.sequence)))
    .sort((left, right) => left.sequence - right.sequence);
  const clicksBefore = (fact: RecordingFact) =>
    ordered.flatMap((other) =>
      other.sequence < fact.sequence && other.record.kind === "click"
        ? [{ sequence: other.sequence, click: other.record }]
        : [],
    );
  let placed = [...steps].sort(bySortKey);
  const moveBefore = (fact: RecordingFact, sequence: number) => {
    const at = placed.findIndex((step) => step.id === captureStepId(sequence));
    const target = placed[at];
    const sortKey = target && keyBetween(placed[at - 1]?.sortKey ?? null, target.sortKey);
    if (!sortKey) return;
    const id = captureStepId(fact.sequence);
    placed = placed.map((step) => (step.id === id ? { ...step, sortKey } : step)).sort(bySortKey);
  };
  for (const fact of ordered) {
    const record = fact.record;
    if (record.kind === "input") {
      const mover = clicksBefore(fact).at(-1);
      if (
        mover &&
        ticksBetween(mover.click.tickMs, record.tickMs) <= FOCUS_LEAVE_LAG_MS &&
        !sameElement(mover.click.element, record.element)
      ) {
        moveBefore(fact, mover.sequence);
      }
    } else if (record.kind === "pageInput") {
      const mover = ordered
        .filter((other) => other.sequence < fact.sequence && other.record.kind === "pageClick")
        .at(-1);
      const click = mover?.record.kind === "pageClick" ? mover.record : null;
      if (
        mover &&
        click &&
        ticksBetween(click.tickMs, record.tickMs) <= FOCUS_LEAVE_LAG_MS &&
        JSON.stringify(click.target) !== JSON.stringify(record.target)
      ) {
        moveBefore(fact, mover.sequence);
      }
    } else if (record.kind === "appSwitch") {
      // A "Go to" stays where it was written (04/10/2026): it's only made for an address typed
      // or picked in the address bar, which always comes after the click into the bar. Moving a
      // browser's first address before the clicks it trailed was for the page a recording started
      // on, which no longer makes a step; it put "Go to" before "Click the address bar".
      const mover = clicksBefore(fact).at(-1);
      if (
        mover &&
        mover.click.window.pid === record.window.pid &&
        mover.click.window.title === record.window.title &&
        ticksBetween(mover.click.tickMs, record.tickMs) <= ACTIVATION_LAG_MS
      ) {
        moveBefore(fact, mover.sequence);
      }
    } else if (record.kind === "command" || record.kind === "typing" || record.kind === "keys") {
      // Written once a command's output settled or a stretch of typing ended, so after steps
      // that came later: it goes before the first of them.
      const later = ordered.find(
        (other) =>
          other.sequence < fact.sequence &&
          "tickMs" in other.record &&
          isAfter(record.tickMs, other.record.tickMs),
      );
      if (later) moveBefore(fact, later.sequence);
    }
  }
  return placed;
}

/**
 * Drops a field's value that a later one replaced: focus can leave a box and come back with
 * nothing else done between (a file name box's suggestions list takes focus as it opens), and
 * each time focus leaves, the box's value is read. Save As made "Type "steps-t"" and then
 * "Type "steps-test-note"". Only the last read, when no other step came between, is kept.
 */
export function dropReplacedValues(
  steps: readonly RecordedStep[],
  facts: readonly RecordingFact[],
): RecordedStep[] {
  const kept = new Set(steps.map((step) => step.id));
  const ordered = facts
    .filter((fact) => kept.has(captureStepId(fact.sequence)))
    .sort((left, right) => left.sequence - right.sequence);
  const replaced = new Set<string>();
  ordered.forEach((fact, index) => {
    const next = ordered[index + 1];
    if (
      fact.record.kind === "input" &&
      next?.record.kind === "input" &&
      sameElement(fact.record.element, next.record.element)
    ) {
      replaced.add(captureStepId(fact.sequence));
    }
  });
  return steps.filter((step) => !replaced.has(step.id));
}

/**
 * Gives a typing step without a screenshot the one before it, when that's in the same window:
 * usually the click into the very field, highlighted (04/10/2026: guides flicked between steps with
 * screenshots and steps without). Typing is read as focus leaves a field, with no screenshot of its
 * own, and taking one then would show what was typed. The step keeps its own words; only the
 * picture is shared.
 */
export function borrowScreenshots(steps: readonly RecordedStep[]): RecordedStep[] {
  return steps.map((step, index) => {
    if (step.media?.id || !["input", "code", "formula"].includes(step.action)) return step;
    const before = steps[index - 1];
    if (!before?.media?.id || before.context.windowTitle !== step.context.windowTitle) return step;
    return { ...step, media: { ...before.media }, highlight: before.highlight };
  });
}

/**
 * Drops "Open" steps at the end of a recording, in order: closing the last app puts another in
 * front, and stopping from the taskbar can too, but the guide never went there. Found live: a
 * guide ending "Open "Windows Explorer"" after Edge was closed. A recording of nothing else keeps
 * them.
 */
export function dropTrailingOpens(steps: readonly RecordedStep[]): RecordedStep[] {
  let end = steps.length;
  while (end > 0 && steps[end - 1]?.action === "appswitch") end -= 1;
  return end === 0 ? [...steps] : steps.slice(0, end);
}

/** Whether tick `later` comes after tick `earlier`, allowing for the 49.7-day wrap. */
const isAfter = (earlier: number, later: number) => {
  const gap = ticksBetween(earlier, later);
  return gap > 0 && gap < 2 ** 31;
};

const cut = (text: string, limit: number) => (text.length > limit ? text.slice(0, limit) : text);

function fitToFormat(step: RecordedStep): RecordedStep {
  const parts = step.textParts;
  return {
    ...step,
    actionText: cut(step.actionText, 2_000),
    textParts: {
      ...parts,
      verb: cut(parts.verb, 200),
      target: cut(parts.target, 2_000),
      kind: cut(parts.kind, 200),
      ...(parts.value === undefined ? {} : { value: cut(parts.value, 2_000) }),
    },
    context: {
      app: step.context.app === null ? null : cut(step.context.app, 260),
      windowTitle: cut(step.context.windowTitle, 2_000),
    },
  };
}

function buildStep(
  fact: RecordingFact,
  wording: StepWording,
  settings: RecordingSettings,
): RecordedStep | null {
  const record = fact.record;
  if (record.kind === "pageClick") return pageClickStep(fact, record, wording);
  if (record.kind === "pageInput") return pageInputStep(fact, record, wording);
  if (record.kind === "pageNavigation") {
    const step = baseStep(
      fact,
      "navigation",
      say({ key: "goTo", site: record.origin }, wording),
      record.origin,
      record.origin,
      "website",
    );
    step.context = { app: null, windowTitle: record.page.title };
    return step;
  }
  if (record.kind === "click") return clickStep(fact, record, wording);
  if (record.kind === "drag") return dragStep(fact, record, wording);
  if (record.kind === "input") {
    const target = uiaToStepTarget(record.element);
    const actionText = describeInput(record.element, record.value ?? undefined, wording);
    const label = record.element.labeledBy || record.element.name;
    const step = baseStep(fact, "input", actionText, target, label, "field");
    step.showValue = record.value !== null;
    if (record.value !== null) step.textParts.value = record.value;
    // Its own screenshot, from when focus arrived in the field, with the field boxed (04/10/2026).
    if (record.capture?.image) {
      step.media = mediaOf(record.capture);
      if (record.window)
        step.context = { app: record.window.exe, windowTitle: record.window.title };
      if (record.elementPct) step.highlight = fieldHighlight(record.elementPct);
    }
    return step;
  }
  // The count is kept with the step, so its wording can be worked out again in another language.
  if (record.kind === "missed" || record.kind === "touch") {
    const step = baseStep(
      fact,
      "manual",
      say({ key: record.kind, count: record.count }, wording),
      null,
      record.kind,
      "warning",
      true,
    );
    step.textParts.value = String(record.count);
    return step;
  }
  if (record.kind === "appSwitch") {
    const name = record.window.appName || record.window.title || record.window.exe || "application";
    const step = baseStep(
      fact,
      "appswitch",
      say({ key: "open", app: name }, wording),
      null,
      name,
      "application",
    );
    step.context = { app: record.window.exe, windowTitle: record.window.title };
    if (record.capture) step.media = mediaOf(record.capture);
    return step;
  }
  if (record.kind === "navigation") return navigationStep(fact, record, wording);
  if (record.kind === "command") return commandStep(fact, record, wording);
  if (record.kind === "typing") return typingStep(fact, record, wording, settings);
  if (record.kind === "keys") return keysStep(fact, record, wording);
  if (record.kind === "manual" && record.purpose === "captureNow") {
    const targetName = record.window.title || record.window.exe || "";
    const step = baseStep(
      fact,
      "manual",
      say({ key: "captureNow" }, wording),
      null,
      targetName,
      "screenshot",
    );
    if (record.capture.image) {
      step.media = {
        id: mediaIdOf(record.capture.image),
        width: record.capture.width,
        height: record.capture.height,
        scale: record.capture.scale,
        captureRect: [
          record.capture.rect.left,
          record.capture.rect.top,
          record.capture.rect.right,
          record.capture.rect.bottom,
        ],
      };
    }
    step.context = { app: record.window.exe, windowTitle: record.window.title };
    // No click marker: the pointer was where the last click left it, not on anything this step
    // is about, and the circle read as a click that never happened (F009).
    return step;
  }
  return null;
}
