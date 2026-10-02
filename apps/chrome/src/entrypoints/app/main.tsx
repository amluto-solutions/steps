import "@amluto-steps/ui/styles.css";

import {
  App,
  appLanguage,
  applyTheme,
  initI18n,
  parsePolicy,
  readTheme,
  rememberPolicy,
  setAppLanguage,
  setPolicy,
} from "@amluto-steps/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { openBridges } from "../../setup";

initI18n();
applyTheme(readTheme());

// The full app in a browser tab (docs/spec/02-capture.md#chrome-edition): the library in this
// browser profile's IndexedDB, recordings reviewed and saved here.
const { library, recorder } = await openBridges();
try {
  setPolicy(parsePolicy(await recorder.getPolicy()));
} catch {
  // No policy readable: the person's own settings apply.
}
// For the side panel, which reads no policy itself.
rememberPolicy();
await setAppLanguage(appLanguage());
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App recorder={recorder} library={library} />
    </StrictMode>,
  );
}
