export { App, RecorderBar, ShortcutPopup } from "./App";
export { RecorderPanel } from "./recorder/RecorderPanel";
export type { Capabilities } from "./capabilities";
export type { Area, Point, TextReader, Words } from "./screen-words";
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
  AppWindows,
  Brands,
  CaptureMonitor,
  ExtensionLink,
  FaceSet,
  Fonts,
  Host,
  HotkeyAction,
  HotkeyBinding,
  Hotkeys,
  LinkStatus,
  LocalFonts,
  MediaDestination,
  MediaRename,
  RecorderBridge,
  RecorderRestarted,
  RecorderSnapshot,
  Recording,
  RecordingJournal,
  RecoverySession,
  RecorderError,
  RecorderFinished,
  RecorderStepAdded,
  SettingsFiles,
  StartOptions,
  Support,
  UpdateChannel,
  UpdateInfo,
  Updates,
  WebPage,
} from "./recorder-bridge";
export { HOTKEY_ACTIONS, noHotkeys } from "./bridge/hotkeys";
export type { ExportFiles } from "./export/export-files";
export type {
  Bin,
  CommentThread,
  Comments,
  ConflictChoice,
  DraftInfo,
  GuideConflict,
  GuideCopies,
  GuideFiles,
  GuideLockFiles,
  EditLock,
  Editing,
  FileDialogs,
  FileFilter,
  GuideMetaFiles,
  GuideStats,
  Libraries,
  LibraryBridge,
  SharedEditing,
  StepsFiles,
  Versions,
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
// The library's fakes, for the preview's made-up library and the tests (07/10/2026).
export { fakeLibrary } from "./library-fake";
export type { FakeComment, FakeLibrary, FakeLibraryOptions } from "./library-fake";
