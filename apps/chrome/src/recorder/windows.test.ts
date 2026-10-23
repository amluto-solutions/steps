import { describe, expect, it } from "vitest";

import { pageWindows } from "./bridge";

describe("Steps for Chrome's page", () => {
  it("gets the browser's own question on closing only while a save is failing", async () => {
    const page = new EventTarget();
    const windows = pageWindows(page);
    /** Closing or reloading the page: whether the browser would ask first. */
    const closing = () => {
      const event = new Event("beforeunload", { cancelable: true });
      page.dispatchEvent(event);
      return event.defaultPrevented;
    };

    expect(closing()).toBe(false);
    await windows.askBeforeClose(true);
    expect(closing()).toBe(true);
    await windows.askBeforeClose(false);
    expect(closing()).toBe(false);
  });
});
