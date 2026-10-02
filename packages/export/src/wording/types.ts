import type { CalloutKind, CodeLanguage, PluralForms } from "@amluto-steps/core";

/** The words every export uses, in one language (docs/spec/05-export.md#languages). */
export interface ExportWordTemplates {
  beforeYouStart: string;
  youreDone: string;
  madeWith: string;
  /** `{name}` */
  preparedBy: string;
  /** `{current}`, `{total}` */
  page: string;
  output: string;
  outputLines: PluralForms;
  shortened: string;
  copy: string;
  copied: string;
  /** The contents page (docs/spec/05-export.md#contents-and-document-control). */
  contents: string;
  firstSteps: string;
  untitledSection: string;
  /** `{number}` */
  step: string;
  /** `{first}`, `{last}` */
  steps: string;
  /** The document-control page. */
  documentControl: string;
  control: {
    title: string;
    owner: string;
    preparedBy: string;
    created: string;
    updated: string;
    reviewBy: string;
    exported: string;
    notSet: string;
    history: string;
    date: string;
    by: string;
    note: string;
    steps: string;
    noVersions: string;
  };
  /** `{date}`, `{by}` */
  dateBy: string;
  stepCount: PluralForms;
  /** `{minutes}` */
  minutes: string;
  untitledGuide: string;
  /** A screenshot's alt text when none was written: `{number}`, `{text}`. */
  screenshotFor: string;
  /** The coloured boxes' labels, in capitals as documentation boxes label themselves. */
  callouts: Record<CalloutKind, string>;
  /** Code labels a language has its own words for ("Eingabeaufforderung"); the rest are names. */
  codeLabels: Partial<Record<CodeLanguage, string>>;
  /** The walkthrough player's own words; `{number}`, `{total}`, `{percent}`, `{text}`, `{alt}`. */
  player: Record<
    | "play"
    | "pause"
    | "speed"
    | "reduceMotion"
    | "allSteps"
    | "backToPlayer"
    | "fullScreen"
    | "thumbnails"
    | "back"
    | "next"
    | "start"
    | "startAgain"
    | "goToStep"
    | "percentDone"
    | "stepCard"
    | "announce"
    | "language",
    string
  >;
}
