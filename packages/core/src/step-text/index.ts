export { wordStep } from "./wording.ts";
export {
  DEFAULT_TONE,
  ELEMENT_KINDS,
  ENGLISH,
  QUOTE_LIMIT,
  TONES,
  asRightClick,
  isTone,
  phraseFor,
  renderPhrase,
  shorten,
  taskbarAppName,
} from "./phrase.ts";
export type {
  ElementKind,
  LanguagePhrases,
  Phrase,
  Phrasebook,
  PluralForms,
  StepWording,
  Terminal,
  Tone,
} from "./phrase.ts";
export { phraseOfStep, wordStepIn } from "./reword.ts";
export type { PhraseFacts } from "./reword.ts";
export {
  NAMING_SOURCES,
  clickPhrase,
  nameClick,
  namingOfStep,
  withScreenWords,
} from "./click-naming.ts";
export type {
  ClickEvidence,
  ClickNaming,
  NamingSource,
  ScreenEvidence,
  StoredClick,
} from "./click-naming.ts";
export type { StepAction, StepTarget, UiaAncestor, UiaElementFacts } from "./types.ts";
export { describeInput, readableFacts, uiaToStepTarget } from "./uia-adapter.ts";
