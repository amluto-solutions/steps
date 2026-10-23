export { wordStep } from "./wording.ts";
export {
  DEFAULT_TONE,
  ELEMENT_KINDS,
  ENGLISH,
  QUOTE_LIMIT,
  TONES,
  asDoubleClick,
  asRightClick,
  isTone,
  phraseFor,
  renderPhrase,
  shorten,
  taskbarAppName,
  typingInDocument,
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
  TITLE_BAR_BUTTONS,
  clickPhrase,
  menuItemFor,
  nameClick,
  namingOfStep,
  windowTitleOf,
  withScreenWords,
  withoutEllipsis,
  withoutShortcut,
} from "./click-naming.ts";
export type {
  ClickEvidence,
  ClickNaming,
  ClickWindow,
  MenuItem,
  NamingSource,
  ScreenEvidence,
  StoredClick,
  TitleBarButton,
} from "./click-naming.ts";
export type { StepAction, StepTarget, UiaAncestor, UiaElementFacts } from "./types.ts";
export { describeInput, isWordBody, readableFacts, uiaToStepTarget } from "./uia-adapter.ts";
