/**
 * The name people know an app by, worked out from the facts the recorder read about its window
 * (12/10/2026, #50; docs/spec/02-capture.md#open-steps): what "Open" steps call it.
 */

import type { WindowFacts } from "./recording.ts";

/**
 * The facts about a window that name its app: its title, its program's file (`WINWORD.EXE`), the
 * program's own name (`appName`) and, for a store app's frame, the app it shows (`hostedApp`).
 */
export type AppWindow = Pick<WindowFacts, "title" | "exe" | "appName" | "hostedApp">;

/**
 * The app a window belongs to, by the name people know it by; null when nothing names it.
 *
 * - A store app's window (Calculator, Settings) belongs to `ApplicationFrameHost.exe`, which draws
 *   it for the app: it's named by the app the frame shows, or else the app part of its title,
 *   never after the host.
 * - Any other program by its own description ("Microsoft Word", "Windows Explorer"); without
 *   one (Paint describes itself only as "mspaint.exe"), by the app part of its window's title
 *   ("Untitled - Paint" is "Paint"); and only when neither names it, by its file ("mspaint").
 */
export function appNameOf(window: AppWindow): string | null {
  if (window.exe?.toLowerCase() === FRAME_HOST) {
    return named(window.hostedApp) ?? titleApp(window.title);
  }
  return (
    named(window.appName) ?? titleApp(window.title) ?? named(window.exe?.replace(/\.exe$/i, ""))
  );
}

/** The program that draws store apps' windows for them. */
const FRAME_HOST = "applicationframehost.exe";

const named = (text: string | null | undefined): string | null => text?.trim() || null;

/**
 * The app part of a window's title: Windows' own apps put it last ("Untitled - Paint"), after a
 * hyphen or a dash with spaces round it, and store apps put a left-to-right mark before that. A
 * title with none is all the app's name ("Calculator").
 */
const titleApp = (title: string): string | null =>
  named(
    title
      .replace(/[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/gu, "")
      .split(/\s+[-\u{2013}\u{2014}](?=\s|$)/u)
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1),
  );
