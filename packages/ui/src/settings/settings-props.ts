import type { Link } from "../app/useLink";
import type { Capabilities } from "../capabilities";
import type { Updates } from "../app/useUpdates";
import type { ToastMessage } from "../components/Toast";
import type { FileDialogs, Libraries, LibraryInfo, StorageUse } from "../library-bridge";
import type { CaptureMonitor, RecorderBridge } from "../recorder-bridge";
import type { BrandProfile } from "@amluto-steps/core";
import type { RecordingChoices, Theme } from "./preferences";

// The settings screen's sections and the props every section gets.

export type SettingsSection =
  | "general"
  | "libraries"
  | "recording"
  | "shortcuts"
  | "privacy"
  | "export"
  | "brands"
  | "appearance"
  | "about";

export interface SettingsProps {
  recorder: RecorderBridge | undefined;
  /** What this copy of Steps has: each section shows only what it can do. */
  capabilities: Capabilities;
  library: (Libraries & FileDialogs) | undefined;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  /** Recording or an unsaved recording: recorder settings wait until it's saved or discarded. */
  locked: boolean;
  displayName: string;
  onDisplayName: (name: string) => Promise<void>;
  autoStart: boolean;
  onAutoStart: (enabled: boolean) => void;
  choices: RecordingChoices;
  onChoices: (choices: RecordingChoices) => void;
  monitors: CaptureMonitor[];
  inputSource: "rawInput" | "hook";
  onInputSource: (source: "rawInput" | "hook") => void;
  libraries: LibraryInfo[];
  onLibrariesChanged: () => Promise<void>;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  /** Brands deployed by IT policy, shown read-only. */
  managedBrandIds?: string[] | undefined;
  /** The brand profile whose colours theme the app. */
  appColours: string;
  onAppColours: (id: string) => void;
  /** Settings are set by the organisation (registry policy), so import is switched off. */
  managed: boolean;
  onImportSettings: () => void;
  onExportSettings: () => void;
  /** "Back up all" and Restore (settings, brands and the list of libraries). */
  onBackUpAll?: (() => void) | undefined;
  onRestore?: (() => void) | undefined;
  notify: (toast: Omit<ToastMessage, "id">) => void;
  version: string;
  /** Updates for the downloadable .exe (docs/spec/10-distribution.md#updates-for-the-exe). */
  updates?: Updates | undefined;
  /** Steps for Windows and Steps for Chrome and Edge together, where either has it. */
  link?: Link | undefined;
  brands: BrandProfile[];
  onBrandsChanged: () => Promise<void>;
  blurTerms: string[];
  onBlurTerms: (terms: string[]) => void;
  /** Steps for Chrome: what the library takes in browser storage (General, "Browser storage"). */
  storage?: StorageUse | null | undefined;
}
