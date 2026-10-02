import {
  CODE_LANGUAGE_LABELS,
  calloutOfBlock,
  type CalloutKind,
  type CodeLanguage,
  type PluralForms,
} from "@amluto-steps/core";

import { EXPORT_WORD_TEMPLATES, type ExportWordTemplates } from "./wording";

import type { RenderBlock } from "./model";

/** The words one export is written in (docs/spec/05-export.md#languages). */
export interface ExportWords {
  /** The language they're in. */
  language: string;
  beforeYouStart: string;
  youreDone: string;
  madeWith: string;
  /** Where "Made with Steps" links to. */
  madeWithUrl: string;
  preparedBy: (name: string) => string;
  page: (current: number, total: number) => string;
  /** The page line with its `{current}` and `{total}` slots, for Word, which fills them itself. */
  pageTemplate: string;
  output: string;
  outputLines: (count: number) => string;
  shortened: string;
  copy: string;
  copied: string;
  contents: string;
  firstSteps: string;
  untitledSection: string;
  stepRange: (first: number | null, last: number | null) => string;
  documentControl: string;
  control: ExportWordTemplates["control"];
  dateBy: (date: string, by: string) => string;
  /** The line under the title: step count, reading time and date, the same in every format. */
  coverParts: (stepCount: number, minutes: number, date: string) => string[];
  untitledGuide: string;
  screenshotFor: (number: number, text: string) => string;
  callouts: Record<CalloutKind, string>;
  /** A code block's label: the language's own words for a terminal or a formula, else its name. */
  codeLabel: (language: CodeLanguage) => string;
  player: ExportWordTemplates["player"];
}

/** Fills `{slots}` in one pass, so words with braces in them are never filled in again. */
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (whole, slot: string) =>
    values[slot] === undefined ? whole : String(values[slot]),
  );

const counted = (forms: PluralForms, count: number, language: string) => {
  let category: Intl.LDMLPluralRule = "other";
  try {
    category = new Intl.PluralRules(language).select(count);
  } catch {
    // An engine without this language's rules uses the general form.
  }
  return fill(forms[category] ?? forms.other, { count });
};

/** The export words in `language` (English when exports aren't in it yet). */
export function exportWords(language = "en"): ExportWords {
  const found = EXPORT_WORD_TEMPLATES[language];
  const words = found ?? EXPORT_WORD_TEMPLATES.en ?? missing();
  const lang = found ? language : "en";
  return {
    language: lang,
    beforeYouStart: words.beforeYouStart,
    youreDone: words.youreDone,
    madeWith: words.madeWith,
    madeWithUrl: "https://steps.amluto.com/",
    preparedBy: (name) => fill(words.preparedBy, { name }),
    page: (current, total) => fill(words.page, { current, total }),
    pageTemplate: words.page,
    output: words.output,
    outputLines: (count) => counted(words.outputLines, count, lang),
    shortened: words.shortened,
    copy: words.copy,
    copied: words.copied,
    contents: words.contents,
    firstSteps: words.firstSteps,
    untitledSection: words.untitledSection,
    stepRange: (first, last) =>
      first === null
        ? ""
        : first === last || last === null
          ? fill(words.step, { number: first })
          : fill(words.steps, { first, last }),
    documentControl: words.documentControl,
    control: words.control,
    dateBy: (date, by) => (by ? fill(words.dateBy, { date, by }) : date),
    coverParts: (stepCount, minutes, date) => [
      counted(words.stepCount, stepCount, lang),
      fill(words.minutes, { minutes }),
      date,
    ],
    untitledGuide: words.untitledGuide,
    screenshotFor: (number, text) => fill(words.screenshotFor, { number, text }),
    callouts: words.callouts,
    codeLabel: (code) => words.codeLabels[code] ?? CODE_LANGUAGE_LABELS[code],
    player: words.player,
  };
}

function missing(): never {
  throw new Error("The English export words are missing.");
}

/** English: the words exports have always used. */
export const EXPORT_WORDS: ExportWords = exportWords("en");

let current: ExportWords = EXPORT_WORDS;

/**
 * The words of the export being built. Each build runs inside `withWords` for its language (set
 * from its model), and English is back afterwards, so a helper anywhere in a build (a coloured
 * box's label deep in a note, say) uses the right words without each one being handed them.
 */
export const currentWords = (): ExportWords => current;

export function withWords<T>(next: ExportWords, build: () => T): T {
  const previous = current;
  current = next;
  try {
    return build();
  } finally {
    current = previous;
  }
}

/** The greys, lines and panels every export shares; brand colours come from the look. */
export const EXPORT_PALETTE = {
  ink: "#1A1A1A",
  muted: "#4F5F73",
  faint: "#8A96A6",
  line: "#DFE5EC",
  panel: "#F1F4F8",
  /** Code blocks on screen (the web page): navy, as in the app. */
  codeBackground: "#0E2542",
  codeHeader: "#16345A",
  codeInk: "#E2E8F0",
  codeLabel: "#B9C8DA",
  codeCopy: "#48CDEB",
  /** Code blocks on paper (PDF and Word): light, so they print. */
  codePaper: "#EEF2F7",
  codeRule: "#B7C3D1",
} as const;

/** Monospace for code, in every format. Word and the web page name fonts Windows has. */
export const CODE_FONTS = "'Cascadia Mono', Consolas, 'Courier New', monospace";

/**
 * Each coloured box's label and colours: the same in every format and every brand, since the
 * colour says what kind of box it is (blue note, green tip, amber warning, red important).
 */
export const CALLOUT_LOOK: Record<
  CalloutKind,
  {
    bar: string;
    fill: string;
    /** The label and icon's colour: dark enough on the fill for small bold text. */
    ink: string;
    /** The icon, a 24 × 24 path drawn with the even-odd rule (the marks are holes). */
    icon: string;
    /** The icon as a character, for Word and the clipboard, where drawings don't survive. */
    symbol: string;
  }
> = {
  note: {
    bar: "#1E6EBC",
    fill: "#E8F1FB",
    ink: "#154C85",
    icon: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z M11 10h2v7h-2Z M11 6.5h2v2h-2Z",
    symbol: "ℹ",
  },
  tip: {
    bar: "#1E8A4C",
    fill: "#E7F5EC",
    ink: "#14613A",
    icon: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20Z M10.6 16.2L6.4 12l1.4-1.4l2.8 2.8l5.6-5.6l1.4 1.4Z",
    symbol: "✔",
  },
  warning: {
    bar: "#DC8A00",
    fill: "#FFF4DE",
    ink: "#7A4B00",
    icon: "M12 2L1 21h22L12 2Z M11 9h2v6h-2Z M11 16.5h2v2h-2Z",
    symbol: "⚠",
  },
  important: {
    bar: "#D92D20",
    fill: "#FDECEA",
    ink: "#A3160C",
    icon: "M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z M11 6.5h2v7h-2Z M11 15.5h2v2h-2Z",
    symbol: "❗",
  },
};

/** A kind's icon as an SVG, in its ink unless another colour is given. */
export const calloutIconSvg = (kind: CalloutKind, colour = CALLOUT_LOOK[kind].ink) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${colour}" fill-rule="evenodd" d="${CALLOUT_LOOK[kind].icon}"/></svg>`;

/** A coloured box's label, in capitals, in the export's words ("WARNING", "WARNUNG"). */
export const calloutName = (kind: CalloutKind) => currentWords().callouts[kind];

/** A coloured-box block's kind, label and colours; its heading, if it has one, is its label. */
export function blockLook(block: Pick<RenderBlock, "type" | "heading">) {
  const kind = calloutOfBlock(block.type) ?? "note";
  const look = CALLOUT_LOOK[kind];
  return { ...look, kind, label: block.heading || calloutName(kind) };
}
