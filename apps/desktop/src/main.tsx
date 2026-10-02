import "@amluto-steps/ui/styles.css";

import {
  App,
  appLanguage,
  applyTheme,
  initI18n,
  rememberPolicy,
  setAppLanguage,
  readTheme,
  RecorderBar,
  parsePolicy,
  setPolicy,
  ShortcutPopup,
} from "@amluto-steps/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopLibrary } from "./library-bridge";
import { desktopRecorder } from "./recorder-bridge";

initI18n();
// Every window follows the theme chosen in Settings (kept in this app's local storage).
applyTheme(readTheme());

const isPopup = window.location.search.includes("shortcut-popup");
const isBar = window.location.search.includes("recorder-bar");

// IT policy is read before the main window renders, so no screen shows a setting it then takes
// away. The recorder bar and popup don't show settings, and aren't allowed to read policy.
if (!isPopup && !isBar) {
  try {
    setPolicy(parsePolicy(await desktopRecorder.getPolicy()));
  } catch {
    // No policy readable: the user's own settings apply.
  }
  // For the recording bar and popup, which can't read policy themselves.
  rememberPolicy();
}
// Every window in the same language: IT's, the person's, or Windows' (docs/spec/07-settings-and-policy.md#language).
await setAppLanguage(appLanguage());

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {isPopup ? (
        <ShortcutPopup recorder={desktopRecorder} />
      ) : isBar ? (
        <RecorderBar recorder={desktopRecorder} />
      ) : (
        <App recorder={desktopRecorder} library={desktopLibrary} />
      )}
    </StrictMode>,
  );
}
