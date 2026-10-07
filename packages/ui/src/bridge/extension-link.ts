/**
 * The link between Steps for Windows and Steps for Chrome and Edge on the same PC
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together), as each side sees it.
 */
export interface LinkStatus {
  /** Whether this copy can link at all: not the Store edition, Linux or Firefox. */
  available: boolean;
  enabled: boolean;
  /**
   * Who's connected now: the browsers ("chrome", "edge") on the desktop; "desktop" in the
   * browser once Steps for Windows has answered.
   */
  connected: string[];
  /**
   * Why it isn't working, when it isn't. The desktop: "register" (Chrome and Edge couldn't be
   * told where Steps is), "pipeTaken" (another copy of Steps has the link) or "pipe". The
   * browser: "notInstalled", "notRunning", "protocol" (the two need the same version) or
   * "permission".
   */
  problem: string | null;
}

/**
 * The link with Steps for Chrome and Edge (the desktop) or with Steps for Windows (the browser),
 * part of the recorder bridge. Where an edition can't link, its status says it isn't available.
 */
export interface ExtensionLink {
  getLink(): Promise<LinkStatus>;
  /**
   * Switches the link on or off. The desktop passes null at each start for its default (on,
   * except in the portable program); the browser asks for Chrome's permission first, so this is
   * called straight from the click.
   */
  setLink(on: boolean | null): Promise<LinkStatus>;
  onLink(handler: (status: LinkStatus) => void): Promise<() => void>;
}
