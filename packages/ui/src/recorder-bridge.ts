import type { AppWindows } from "./bridge/app-windows";
import type { Brands } from "./bridge/brands";
import type { ExtensionLink } from "./bridge/extension-link";
import type { Fonts } from "./bridge/fonts";
import type { Host } from "./bridge/host";
import type { Hotkeys } from "./bridge/hotkeys";
import type { Recording } from "./bridge/recording";
import type { RecordingJournal } from "./bridge/recording-journal";
import type { SettingsFiles } from "./bridge/settings-files";
import type { Support } from "./bridge/support";
import type { Updates } from "./bridge/updates";
import type { Capabilities } from "./capabilities";
import type { ExportFiles } from "./export/export-files";
import type { TextReader } from "./screen-words";

export type { AppWindows } from "./bridge/app-windows";
export type { Brands } from "./bridge/brands";
export type { ExtensionLink, LinkStatus } from "./bridge/extension-link";
export type { FaceSet, Fonts, LocalFonts } from "./bridge/fonts";
export type { Host } from "./bridge/host";
export type { HotkeyAction, HotkeyBinding, Hotkeys } from "./bridge/hotkeys";
export type {
  CaptureMonitor,
  RecorderError,
  RecorderFinished,
  RecorderRestarted,
  RecorderSnapshot,
  RecorderStepAdded,
  Recording,
  StartOptions,
} from "./bridge/recording";
export type {
  MediaDestination,
  MediaRename,
  RecordingJournal,
  RecoverySession,
} from "./bridge/recording-journal";
export type { SettingsFiles } from "./bridge/settings-files";
export type { Support, WebPage } from "./bridge/support";
export type { UpdateChannel, UpdateInfo, Updates } from "./bridge/updates";

/**
 * Everything an edition does that the page can't do itself, as small interfaces by capability
 * (split 07/10/2026, #31; docs/spec/01-architecture.md#edition-interfaces). Each part of the UI
 * takes only the interfaces it uses, each has a fake in `@amluto-steps/ui/fakes`, and one
 * contract test per interface runs against the desktop's, Steps for Chrome's and the preview's
 * versions. Every member is required, so an edition (or the preview) missing one doesn't compile;
 * what an edition lacks, its capabilities say, and its version answers with nothing.
 */
export interface RecorderBridge
  extends
    Recording,
    RecordingJournal,
    AppWindows,
    Hotkeys,
    Updates,
    Brands,
    Fonts,
    Support,
    ExtensionLink,
    SettingsFiles,
    Host,
    TextReader,
    ExportFiles {
  /** What this edition has, stated once by its adapter; the UI shows or hides features by it. */
  readonly capabilities: Capabilities;
}
