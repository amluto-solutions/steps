import type { RecorderBridge } from "@amluto-steps/ui";
import {
  appWindowsContract,
  brandsContract,
  exportFilesContract,
  extensionLinkContract,
  fontsContract,
  hostContract,
  hotkeysContract,
  recordingContract,
  recordingJournalContract,
  settingsFilesContract,
  supportContract,
  updatesContract,
  type Subject,
} from "@amluto-steps/ui/contracts";

import { previewRecorder } from "./recorder";

// The preview's recorder bridge keeps the same contracts as the editions, so a screen checked in
// the preview behaves there as in the app. Its text reader is the UI's fake with the preview's
// own words on every screenshot; the fake's contract is run in `packages/ui`.
const preview = (): Subject<RecorderBridge> => {
  const bridge = previewRecorder();
  return { part: bridge, capabilities: bridge.capabilities };
};

recordingContract("the preview", preview);
recordingJournalContract("the preview", preview);
appWindowsContract("the preview", preview);
hotkeysContract("the preview", preview);
updatesContract("the preview", preview);
brandsContract("the preview", preview);
fontsContract("the preview", preview);
supportContract("the preview", preview);
extensionLinkContract("the preview", preview);
settingsFilesContract("the preview", preview);
hostContract("the preview", preview);
exportFilesContract("the preview", preview);
