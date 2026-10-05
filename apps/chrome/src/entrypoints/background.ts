import { frameSite } from "../recorder/frame-site";
import { defineBackground } from "wxt/utils/define-background";

import type { FrameHop, FramePointer } from "../capture/frames";
import type { PageFacts, PageInput, PagePointer, StartChoices } from "../recorder/engine";
import { navigationCause } from "../recorder/navigation-cause";
import { desktopLink, RETRY_ALARM } from "../desktop/chrome";
import { engine } from "../recorder/chrome";
import { frameClicks, type FrameSender } from "../recorder/frames";
import { firefox } from "../browser";

/**
 * The extension's background worker. The toolbar button opens the side panel beside the page;
 * the recorder runs here (`recorder/chrome.ts`). Chrome's own `chrome.*` API throughout: this
 * edition is for Chrome and Edge only.
 */

/** Commands the Steps pages (the side panel and the app) send the recorder. */
type Command =
  | { type: "recorder:getState" }
  | { type: "recorder:start"; title: string; choices: StartChoices }
  | { type: "recorder:exclude"; site: string }
  | { type: "recorder:pause" }
  | { type: "recorder:resume" }
  | { type: "recorder:stop" }
  | { type: "recorder:discard" }
  | { type: "recorder:forget"; sessionId: string }
  | { type: "link:get" }
  | { type: "link:set"; on: boolean };

type PageMessage = (
  | { type: "page:pointer"; pointer: PagePointer }
  | { type: "page:input"; input: PageInput }
  | { type: "page:framePointer"; token: string; pointer: FramePointer }
  | { type: "page:frameHop"; token: string; hop: FrameHop }
) & { origin?: string };

const run = (command: Command) => {
  switch (command.type) {
    case "recorder:getState":
      return engine.getState();
    case "recorder:start":
      return engine.start(command.title, command.choices);
    case "recorder:exclude":
      return engine.exclude(command.site);
    case "recorder:pause":
      return engine.pause();
    case "recorder:resume":
      return engine.resume();
    case "recorder:stop":
      return engine.stop();
    case "recorder:discard":
      return engine.discard();
    case "recorder:forget":
      return engine.forgetSession(command.sessionId);
    case "link:get":
      return Promise.resolve(desktopLink.status());
    case "link:set":
      return desktopLink.set(command.on === true);
  }
};

/** A message from a page's capture script, with where it came from. */
function fromPage(message: PageMessage, sender: chrome.runtime.MessageSender) {
  const tab = sender.tab;
  // Only pages in tabs record; the Steps pages have no capture script.
  if (!tab?.id || tab.windowId === undefined) return;
  const top = sender.frameId === 0;
  const facts: PageFacts = {
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    frameUrl: top ? undefined : frameSite(message.origin, sender),
  };
  switch (message.type) {
    case "page:pointer":
      if (top) {
        void engine.pointer(facts, message.pointer);
        desktopLink.click(facts, message.pointer.target, message.pointer.at);
      }
      return;
    case "page:input":
      void engine.input(facts, message.input);
      return;
    case "page:framePointer":
      if (!top && sender.frameId !== undefined) {
        frames.pointer(message.token, facts, frameSender(tab.id, sender, message), message.pointer);
        // Steps for Windows needs only what was clicked, not where it is on the tab.
        desktopLink.click(facts, message.pointer.target, message.pointer.at);
      }
      return;
    case "page:frameHop":
      if (sender.frameId !== undefined)
        frames.hop(message.token, frameSender(tab.id, sender, message), message.hop);
      return;
  }
}

/** The frame a message came from; its origin as its capture script reports it, as a page posting it would see it. */
const frameSender = (
  tabId: number,
  sender: chrome.runtime.MessageSender,
  message: { origin?: string },
): FrameSender => ({
  tabId,
  frameId: sender.frameId ?? -1,
  origin: message.origin ?? sender.origin ?? "",
});

/** Clicks inside frames, waiting for the frames around them to say where they are. */
const frames = frameClicks(
  (facts, pointer) => void engine.pointer(facts, pointer),
  async (tabId) => {
    // Firefox: the capture scripts name each frame instead (no webNavigation permission there).
    if (firefox()) return null;
    const all = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
    return new Map(all.map((frame) => [frame.frameId, frame.parentFrameId]));
  },
);

/** True only in the end-to-end tests' builds (wxt.config.ts). */
declare const __STEPS_E2E__: boolean;

export default defineBackground(() => {
  // Firefox's test driver can't open an extension's own pages, but can drive one the extension
  // opens: the recorder's page, in a tab, as the test installs it.
  if (__STEPS_E2E__)
    chrome.runtime.onInstalled.addListener(
      () => void chrome.tabs.create({ url: chrome.runtime.getURL("/sidepanel.html") }),
    );

  // The toolbar button opens the recorder: Chrome's side panel, or Firefox's sidebar.
  const fox = firefox();
  if (fox) fox.action?.onClicked.addListener(() => void fox.sidebarAction.toggle());
  else void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  chrome.runtime.onMessage.addListener((message: Command | PageMessage, sender, reply) => {
    if (message.type.startsWith("page:")) {
      fromPage(message as PageMessage, sender);
      return false;
    }
    // Commands only from this extension's own pages, never a content script in some page.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL("")))
      return false;
    if (!message.type.startsWith("recorder:") && !message.type.startsWith("link:")) return false;
    run(message as Command).then(
      (result) => reply({ ok: true, result }),
      (error: unknown) => reply({ ok: false, error: String(error) }),
    );
    return true;
  });

  // Steps for Windows, if the person switched the link on
  // (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
  void desktopLink.start();
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === RETRY_ALARM) desktopLink.retry();
  });

  if (firefox()) {
    // No webNavigation here: the engine guesses from clicks and typing on the page.
    chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (!change.url || tab.windowId === undefined) return;
      void engine.navigated({
        tabId,
        windowId: tab.windowId,
        title: tab.title ?? "",
        url: change.url,
      });
    });
  } else {
    // Chrome and Edge say how each page was reached: typed or picked in the address bar, or not.
    const cause = navigationCause(() => Date.now());
    chrome.webNavigation.onCommitted.addListener((details) => {
      if (details.frameId !== 0) return;
      const how = cause(details.tabId, details.transitionType, details.transitionQualifiers);
      void chrome.tabs.get(details.tabId).then(
        (tab) =>
          engine.navigated(
            {
              tabId: details.tabId,
              windowId: tab.windowId,
              title: tab.title ?? "",
              url: details.url,
            },
            how,
          ),
        () => undefined,
      );
    });
  }
});
