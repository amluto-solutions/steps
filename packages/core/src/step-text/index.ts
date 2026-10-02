export { wordStep } from "./wording.ts";
export {
  DEFAULT_TONE,
  ENGLISH,
  QUOTE_LIMIT,
  TONES,
  isTone,
  phraseFor,
  phraseOfStep,
  renderPhrase,
  shorten,
  taskbarAppName,
  wordStepIn,
} from "./phrase.ts";
export type {
  ElementKind,
  LanguagePhrases,
  Phrase,
  PhraseFacts,
  Phrasebook,
  PluralForms,
  StepWording,
  Terminal,
  Tone,
} from "./phrase.ts";
export type { StepAction, StepTarget, UiaElementFacts } from "./types.ts";
export { describeClick, describeInput, uiaToStepTarget } from "./uia-adapter.ts";
export type { ClickWording } from "./uia-adapter.ts";
