/**
 * Firefox's own extension APIs, where they differ from Chrome's (docs/spec/10-distribution.md#firefox).
 * The rest of the extension uses the `chrome.*` names, which Firefox also answers to. Firefox has
 * a sidebar instead of Chrome's side panel, no folder picker for web pages, and lets people take
 * back an extension's access to sites.
 */

interface SidebarAction {
  open(): Promise<void>;
  toggle(): Promise<void>;
}

interface FirefoxApis {
  sidebarAction?: SidebarAction;
  action?: { onClicked: { addListener(listener: () => void): void } };
}

/** Firefox's APIs, or null in Chrome and Edge (which have no `sidebarAction`). */
export function firefox(): (FirefoxApis & { sidebarAction: SidebarAction }) | null {
  const api = (globalThis as { browser?: FirefoxApis }).browser;
  return api?.sidebarAction ? (api as FirefoxApis & { sidebarAction: SidebarAction }) : null;
}

/** Every site, which recording needs: to see clicks and take screenshots. */
export const ALL_SITES = { origins: ["<all_urls>"] };
