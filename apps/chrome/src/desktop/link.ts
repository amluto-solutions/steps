import { siteExcluded, type StepTarget } from "@amluto-steps/core";
import type { LinkStatus } from "@amluto-steps/ui";

/**
 * Steps for Chrome and Edge helping Steps for Windows on the same PC
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). Switched on in Settings,
 * the background worker keeps a connection to the desktop app through the program the browser
 * starts for it (native messaging). While the app records, the capture script is in pages, and
 * each pointer going down in a page tells the app what the element was, so its step reads as
 * the page names it. The app keeps nothing from here unless it recorded the click itself.
 *
 * Never sent: anything on a site this browser doesn't record (the person's list and
 * `ExcludedSites`), page words, screenshots, typing, field values or addresses.
 */

/** The protocol the desktop app speaks (`src-tauri/src/browser_link/protocol.rs`). */
export const PROTOCOL = 1;

/** The native messaging host the desktop app registers for Chrome and Edge. */
export const HOST = "com.amluto.steps";

/**
 * The sites the person never records, copied into the extension's storage by the Steps pages as
 * they change (`setup.ts`): the background worker can't read the pages' own storage.
 */
export const EXCLUDED_SITES_KEY = "excludedSites";

/** The longest fact the app accepts, as in the guide format. */
const MAX_TEXT = 2_000;

/** What the link needs of a port Chrome opens to the host (`chrome.runtime.Port`). */
export interface LinkPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

/** Where a click happened, as the background knows it from the message's sender. */
export interface ClickPlace {
  title: string;
  url: string;
  frameUrl?: string | undefined;
}

export interface LinkDeps {
  /** Chrome or Edge; null where there's no link (Firefox). */
  browser: "chrome" | "edge" | null;
  version: string;
  /** Opens the host (`chrome.runtime.connectNative`); null without the permission. */
  connect(): LinkPort | null;
  /** Why the last port closed, as Chrome said (`chrome.runtime.lastError`). */
  lastError(): string | undefined;
  /** Puts the capture script into pages, or takes it out, for the desktop's recording. */
  capture(on: boolean): Promise<void>;
  /** The sites never recorded: the person's and the organisation's (`siteName` host names). */
  excluded(): Promise<string[]>;
  loadEnabled(): Promise<boolean>;
  saveEnabled(on: boolean): Promise<void>;
  /** Keeps (or stops) a check every minute that connects again if the connection is gone. */
  keepTrying(on: boolean): void;
  broadcast(status: LinkStatus): void;
  now(): number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The element's facts as the app accepts them: text only, each within the guide's limit. */
function limited(target: StepTarget): StepTarget {
  return Object.fromEntries(
    Object.entries(target)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, value]) => [key, value.slice(0, MAX_TEXT)]),
  );
}

export function createDesktopLink(deps: LinkDeps) {
  let status: LinkStatus = {
    available: deps.browser !== null,
    enabled: false,
    connected: [],
    problem: null,
  };
  let port: LinkPort | null = null;
  /** The app answered with the same protocol. */
  let answered = false;
  let recording = false;
  let excluded: string[] = [];

  const publish = (change: Partial<LinkStatus>) => {
    status = { ...status, ...change };
    deps.broadcast(status);
  };

  const setRecording = async (on: boolean) => {
    if (recording === on) return;
    recording = on;
    if (on) excluded = await deps.excluded().catch(() => excluded);
    await deps.capture(on).catch(() => undefined);
  };

  const heard = async (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === "hello") {
      if (message.protocol === PROTOCOL) {
        answered = true;
        publish({ connected: ["desktop"], problem: null });
      } else {
        // The app closes the connection; this says which side to update.
        publish({ problem: "protocol" });
      }
    } else if (message.type === "recording" && answered && typeof message.on === "boolean") {
      await setRecording(message.on);
    } else if (message.type === "unavailable") {
      publish({ problem: "notRunning" });
    }
  };

  const connect = () => {
    if (!status.available || !status.enabled || port) return;
    const opened = deps.connect();
    if (!opened) {
      publish({ problem: "permission" });
      return;
    }
    port = opened;
    answered = false;
    opened.onMessage.addListener((message) => void heard(message));
    opened.onDisconnect.addListener(() => {
      if (port !== opened) return;
      port = null;
      answered = false;
      void setRecording(false);
      // Chrome: "Specified native messaging host not found." when nothing is registered, and
      // "Access to the specified native messaging host is forbidden." for another extension.
      const error = deps.lastError() ?? "";
      const problem =
        status.problem === "notRunning" || status.problem === "protocol"
          ? status.problem
          : /not found|forbidden/i.test(error)
            ? "notInstalled"
            : "notRunning";
      publish({ connected: [], problem });
    });
    opened.postMessage({
      type: "hello",
      protocol: PROTOCOL,
      browser: deps.browser,
      version: deps.version,
    });
  };

  const disconnect = async () => {
    const was = port;
    port = null;
    answered = false;
    was?.disconnect();
    await setRecording(false);
  };

  return {
    status: () => status,

    /** As the background worker starts: connects again if it was switched on. */
    async start() {
      if (!status.available) return;
      status = { ...status, enabled: await deps.loadEnabled().catch(() => false) };
      deps.keepTrying(status.enabled);
      connect();
    },

    /** Switched on or off in Settings (the permission is asked for there, from the click). */
    async set(on: boolean) {
      if (!status.available) return status;
      await deps.saveEnabled(on);
      deps.keepTrying(on);
      if (on) {
        publish({ enabled: true, problem: null });
        connect();
      } else {
        await disconnect();
        publish({ enabled: false, connected: [], problem: null });
      }
      return status;
    },

    /** The minute's check: connects again if the connection is gone. */
    retry() {
      if (!port && status.enabled) {
        // Tried afresh: "not running" is only known once the relay says so again.
        status = { ...status, problem: status.problem === "protocol" ? "protocol" : null };
        connect();
      }
    },

    /** Whether the desktop app is recording, so pages report their clicks. */
    recording: () => recording,

    /**
     * A pointer went down in a page or a frame: the app hears what the element was, unless the
     * site (or the frame's) is one this browser doesn't record. `at` is when it happened.
     */
    click(place: ClickPlace, target: StepTarget | null, at: number | undefined) {
      if (!port || !answered || !recording) return;
      if (
        siteExcluded(place.url, excluded) ||
        (place.frameUrl !== undefined && siteExcluded(place.frameUrl, excluded))
      )
        return;
      const age = at === undefined ? 0 : Math.round(deps.now() - at);
      port.postMessage({
        type: "click",
        ageMs: Math.min(10_000, Math.max(0, Number.isFinite(age) ? age : 0)),
        title: place.title.slice(0, MAX_TEXT),
        target: target ? limited(target) : null,
      });
    },
  };
}

export type DesktopLink = ReturnType<typeof createDesktopLink>;
