import { siteName } from "@amluto-steps/core";

import { firefox } from "../browser";
import { managedPolicy } from "../policy";
import { captureFor } from "../recorder/chrome";
import { createDesktopLink, EXCLUDED_SITES_KEY, HOST, type LinkPort } from "./link";

/** Whether the person switched the link on (this browser's local storage). */
const ENABLED_KEY = "desktopLink";
/** The minute's check that connects again when the connection is gone. */
export const RETRY_ALARM = "desktop-link";

/** Chrome or Edge, as Steps for Windows tells them apart; null in Firefox, which has no link. */
function whichBrowser(): "chrome" | "edge" | null {
  if (firefox()) return null;
  const brands =
    (navigator as { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? [];
  return brands.some((each) => /edge/i.test(each.brand)) || / Edg\//.test(navigator.userAgent)
    ? "edge"
    : "chrome";
}

/** On only in builds made with the link (wxt.config.ts): Settings doesn't offer it otherwise. */
declare const __STEPS_LINK__: boolean;

/** The link wired to Chrome: native messaging, storage, alarms and the capture script. */
export const desktopLink = createDesktopLink({
  browser: __STEPS_LINK__ ? whichBrowser() : null,
  version: chrome.runtime.getManifest().version,
  // Without the permission there's no `connectNative` at all.
  connect: () =>
    typeof chrome.runtime.connectNative === "function"
      ? (chrome.runtime.connectNative(HOST) as LinkPort)
      : null,
  lastError: () => chrome.runtime.lastError?.message,
  capture: (on) => captureFor("desktop", on),
  excluded: async () => {
    const [local, managed] = await Promise.all([
      chrome.storage.local.get(EXCLUDED_SITES_KEY),
      chrome.storage.managed.get().catch(() => ({})),
    ]);
    const own: unknown = local[EXCLUDED_SITES_KEY];
    const sites = [
      ...(Array.isArray(own) ? own.filter((site) => typeof site === "string") : []),
      ...managedPolicy(managed).excludedApps,
    ]
      .map(siteName)
      .filter((site) => site !== null);
    return [...new Set(sites)];
  },
  loadEnabled: async () => (await chrome.storage.local.get(ENABLED_KEY))[ENABLED_KEY] === true,
  saveEnabled: (on) => chrome.storage.local.set({ [ENABLED_KEY]: on }),
  keepTrying: (on) => {
    if (on) void chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
    else void chrome.alarms.clear(RETRY_ALARM);
  },
  broadcast: (status) => {
    chrome.runtime.sendMessage({ type: "link:state", status }).catch(() => undefined);
  },
  now: () => Date.now(),
});
