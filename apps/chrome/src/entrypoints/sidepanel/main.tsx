import "@amluto-steps/ui/styles.css";

import {
  appLanguage,
  applyTheme,
  initI18n,
  readTheme,
  RecorderPanel,
  setAppLanguage,
} from "@amluto-steps/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { openBridges, openStepsTab } from "../../setup";

initI18n();
applyTheme(readTheme());
await setAppLanguage(appLanguage());

// The recorder beside the page (docs/spec/02-capture.md#chrome-edition).
const { recorder } = await openBridges();
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RecorderPanel recorder={recorder} onOpenSteps={() => void openStepsTab()} />
    </StrictMode>,
  );
}
