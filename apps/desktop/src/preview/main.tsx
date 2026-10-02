import "@amluto-steps/ui/styles.css";

import {
  App,
  appLanguage,
  applyTheme,
  initI18n,
  readTheme,
  RecorderBar,
  setAppLanguage,
} from "@amluto-steps/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { previewBarRecorder, previewLibrary, previewRecorder } from "./bridges";

// The main window with made-up guides, for checking screens in a browser without Tauri. Only the
// Vite dev server serves it (`/preview.html`); the app build contains index.html alone. Add
// `?recorder-bar` for the recording bar (with `&keys` and `&paused` for those states).
initI18n();
// The language Settings or the browser chooses, as the app does at start.
await setAppLanguage(appLanguage());
applyTheme(readTheme());

const params = new URLSearchParams(window.location.search);
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      {params.has("recorder-bar") ? (
        <RecorderBar
          recorder={previewBarRecorder({ keys: params.has("keys"), paused: params.has("paused") })}
        />
      ) : (
        <App recorder={previewRecorder} library={previewLibrary} />
      )}
    </StrictMode>,
  );
}
