import type { OcrLine } from "@amluto-steps/core";
import type { RecorderBridge } from "@amluto-steps/ui";
import {
  fakeAppWindows,
  fakeBrands,
  fakeExportFiles,
  fakeExtensionLink,
  fakeFonts,
  fakeHost,
  fakeHotkeys,
  fakeRecorder,
  fakeSettingsFiles,
  fakeSupport,
  fakeTextReader,
  fakeUpdates,
  IDLE,
} from "@amluto-steps/ui/fakes";

import { desktopCapabilities } from "../edition";

/**
 * The made-up recorder bridge for looking at the UI in a plain browser (`/preview.html` on the
 * Vite dev server), built from the UI's fakes: nothing is recorded or written anywhere. It shows
 * Steps for Windows' screens, so it states Windows' capabilities. Every part is given, so a
 * method the preview lacks doesn't compile.
 */

/**
 * Two made-up personal details on every screenshot, so the suggested blurs can be seen: a small
 * email and a postcode. `?many-suggestions` adds fourteen more emails, for a long list.
 */
const previewWords = (many: boolean): OcrLine[] => [
  { words: [{ text: "sam@example.com", x: 60, y: 30, w: 12, h: 2.5 }] },
  {
    words: [
      { text: "SW1A", x: 70, y: 62, w: 3.5, h: 2.5 },
      { text: "1AA", x: 74, y: 62, w: 3, h: 2.5 },
    ],
  },
  ...(many
    ? Array.from({ length: 14 }, (_, index) => ({
        words: [{ text: `person${index}@example.com`, x: 30, y: 10 + index * 5, w: 14, h: 2.5 }],
      }))
    : []),
];

export function previewRecorder(
  options: { recorder?: ReturnType<typeof fakeRecorder>; manySuggestions?: boolean } = {},
): RecorderBridge {
  return {
    capabilities: desktopCapabilities("Windows NT 10.0"),
    ...(options.recorder ?? fakeRecorder()),
    ...fakeAppWindows(),
    ...fakeHotkeys(),
    // A copy that updates itself, with nothing new to install.
    ...fakeUpdates({ channel: "checks" }),
    ...fakeBrands(),
    ...fakeFonts(),
    ...fakeSupport(),
    // The link with Steps for Chrome and Edge: Chrome connected while it's on.
    ...fakeExtensionLink({ connected: ["chrome"] }),
    ...fakeSettingsFiles(),
    ...fakeHost({
      preferences: { displayName: "Sam Example", libraryFolder: "C:\\Guides" },
      machine: { pc: "EXAMPLE-PC", login: "sam" },
    }),
    // Every screenshot shows the same words, less any under its blur.
    ...fakeTextReader({}, previewWords(options.manySuggestions ?? false)),
    ...fakeExportFiles({ downloads: "C:\\Users\\Sam\\Downloads" }),
  };
}

/** The recording bar part-way through a recording (`/preview.html?recorder-bar&keys&paused`). */
export const previewBarRecorder = (options: { keys: boolean; paused: boolean }) =>
  previewRecorder({
    recorder: fakeRecorder({
      state: {
        ...IDLE,
        state: options.paused ? "paused" : "recording",
        reason: options.paused ? "User" : null,
        sessionId: "preview",
        stepCount: 14,
        keysRecorded: options.keys,
      },
    }),
  });
