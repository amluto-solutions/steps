export { App, RecorderBar, ShortcutPopup } from "./App";
export { RecorderPanel } from "./recorder/RecorderPanel";
export { isBrowserEdition, isLinux } from "./recorder-bridge";
export { factToStep } from "./recorded-step";
export { initI18n, setAppLanguage } from "./i18n";
export {
  appLanguage,
  applyTheme,
  rememberPolicy,
  onExcludedSitesSaved,
  readChoices,
  readExcludedSites,
  readTheme,
  saveExcludedSites,
} from "./settings/preferences";
export { NO_POLICY, parsePolicy, setPolicy, type Policy } from "./settings/policy";
export type {
  HotkeyAction,
  HotkeyBinding,
  LinkStatus,
  RecorderBridge,
  RecorderRestarted,
  RecorderSnapshot,
  RecoverySession,
  RecorderError,
  RecorderFinished,
  RecorderStepAdded,
  UpdateChannel,
  UpdateInfo,
} from "./recorder-bridge";
export type {
  CommentThread,
  ConflictChoice,
  DraftInfo,
  GuideConflict,
  EditLock,
  Editing,
  FileFilter,
  LibraryBridge,
  LockLost,
  LibraryGuideSummary,
  StorageUse,
  LibraryInfo,
  MediaInfo,
  ReviewComment,
  RawGuideDocument,
  TrashEntry,
  VersionInfo,
} from "./library-bridge";
