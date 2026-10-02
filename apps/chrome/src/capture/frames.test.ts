// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { RELAY_KEY, frameFor, isRelay, placePointer, type FramePointer } from "./frames";

/** A click at 100,50 on a 200×100 button at the frame's top left, in a 400×200 frame. */
const frame: FramePointer = {
  target: { tagName: "BUTTON", innerText: "Send" },
  click: { x: 100, y: 50 },
  element: { left: 0, top: 0, width: 200, height: 100 },
  viewport: { width: 400, height: 200 },
  scale: 1.5,
  text: [{ words: [{ text: "Send", x: 25, y: 25, w: 10, h: 10 }] }],
};

describe("clicks in frames", () => {
  it("are placed on the tab's view by where the frame's view starts", () => {
    const placed = placePointer(frame, {
      offset: { x: 600, y: 300 },
      viewport: { width: 1000, height: 500 },
      text: [{ words: [{ text: "Inbox", x: 1, y: 1, w: 5, h: 4 }] }],
    });
    expect(placed.clickPct).toEqual({ x: 70, y: 70 });
    expect(placed.elementPct).toEqual({ x: 60, y: 60, w: 20, h: 20 });
    expect(placed.scale).toBe(1.5);
    // The top page's words, then the frame's, moved to where they show on the tab.
    expect(placed.text).toEqual([
      { words: [{ text: "Inbox", x: 1, y: 1, w: 5, h: 4 }] },
      { words: [{ text: "Send", x: 70, y: 70, w: 4, h: 4 }] },
    ]);
  });

  it("leave out a frame's words that are past the edge of the tab's view", () => {
    const placed = placePointer(frame, {
      offset: { x: 950, y: 0 },
      viewport: { width: 1000, height: 500 },
      text: [],
    });
    expect(placed.text).toEqual([]);
  });

  it("keep what was clicked, without a highlight, when the frame can't be placed", () => {
    expect(placePointer(frame, null)).toEqual({
      target: frame.target,
      clickPct: null,
      elementPct: null,
      scale: 1.5,
      text: [],
    });
  });

  it("find the frame a message came from, inside shadow roots too", () => {
    document.body.innerHTML = `<iframe id="plain"></iframe><div id="host"></div>`;
    const host = document.getElementById("host") as HTMLElement;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<iframe id="hidden"></iframe>`;
    const plain = document.getElementById("plain") as HTMLIFrameElement;
    const hidden = shadow.getElementById("hidden") as HTMLIFrameElement;
    expect(frameFor(document, plain.contentWindow)).toBe(plain);
    // A closed root is only found with the extension's way in.
    expect(frameFor(document, hidden.contentWindow)).toBeNull();
    const open = (element: Element) => (element === host ? shadow : null);
    expect(frameFor(document, hidden.contentWindow, open)).toBe(hidden);
    expect(frameFor(document, window)).toBeNull();
  });

  it("only pass on messages that look like theirs", () => {
    expect(isRelay({ [RELAY_KEY]: "token" })).toBe(true);
    expect(isRelay({ [RELAY_KEY]: 5 })).toBe(false);
    expect(isRelay("hello")).toBe(false);
    expect(isRelay(null)).toBe(false);
  });
});
