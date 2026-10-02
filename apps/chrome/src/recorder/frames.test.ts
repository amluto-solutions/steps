import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FrameHop, FramePointer } from "../capture/frames";
import type { PageFacts, PagePointer } from "./engine";
import { PLACE_WAIT_MS, frameClicks, type FrameSender, type FrameTree } from "./frames";

const facts: PageFacts = {
  tabId: 7,
  windowId: 1,
  title: "Mail",
  url: "https://mail.example.test/",
};
const frame: FramePointer = {
  target: { tagName: "BUTTON", innerText: "Send" },
  click: { x: 10, y: 10 },
  element: { left: 0, top: 0, width: 20, height: 20 },
  viewport: { width: 100, height: 100 },
  scale: 1,
  text: [],
};

// The tab: the top page (0) holds an editor frame (3), which holds the clicked frame (5).
const top: FrameSender = { tabId: 7, frameId: 0, origin: "https://mail.example.test" };
const editor: FrameSender = { tabId: 7, frameId: 3, origin: "https://editor.example.test" };
const clicked: FrameSender = { tabId: 7, frameId: 5, origin: "https://pay.example.test" };
const tree: FrameTree = new Map([
  [0, -1],
  [3, 0],
  [5, 3],
]);
const view = { viewport: { width: 1000, height: 1000 }, text: [] };
const fromEditor: FrameHop = { childOrigin: clicked.origin, offset: { x: 40, y: 40 } };
const fromTop: FrameHop = { childOrigin: editor.origin, offset: { x: 60, y: 60 }, top: view };

let delivered: PagePointer[];
let timers: Map<number, () => void>;
let clicks: ReturnType<typeof frameClicks>;

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  delivered = [];
  timers = new Map();
  let next = 0;
  clicks = frameClicks(
    (_facts, pointer) => delivered.push(pointer),
    (tabId) => Promise.resolve(tabId === 7 ? tree : new Map()),
    {
      set: (run, ms) => {
        expect(ms).toBe(PLACE_WAIT_MS);
        next += 1;
        timers.set(next, run);
        return next as unknown as ReturnType<typeof setTimeout>;
      },
      clear: (timer) => timers.delete(timer as unknown as number),
    },
  );
});
const runTimers = () => [...timers.values()].forEach((run) => run());

describe("joining a frame's click to its place", () => {
  it("adds up each frame's hop to the top, in any order", async () => {
    clicks.pointer("a", facts, clicked, frame);
    clicks.hop("a", top, fromTop);
    clicks.hop("a", editor, fromEditor);
    clicks.hop("b", editor, fromEditor);
    clicks.hop("b", top, fromTop);
    clicks.pointer("b", facts, clicked, frame);
    await settled();
    expect(delivered.map((pointer) => pointer.clickPct)).toEqual([
      { x: 11, y: 11 },
      { x: 11, y: 11 },
    ]);
    expect(timers.size).toBe(0);
  });

  it("keeps the click unplaced when the hops don't arrive in time", async () => {
    clicks.pointer("a", facts, clicked, frame);
    clicks.hop("a", editor, fromEditor);
    await settled();
    expect(delivered).toEqual([]);
    runTimers();
    expect(delivered).toMatchObject([{ clickPct: null, target: frame.target }]);
  });

  it("takes no hop from a frame that isn't around the clicked one", async () => {
    // The top page's own decoy frame (8), passing the token on with a place of its choosing.
    const decoy: FrameSender = { tabId: 7, frameId: 8, origin: top.origin };
    clicks.pointer("a", facts, clicked, frame);
    clicks.hop("a", decoy, { childOrigin: clicked.origin, offset: { x: 500, y: 500 } });
    clicks.hop("a", top, fromTop);
    await settled();
    expect(delivered).toEqual([]);
    runTimers();
    expect(delivered).toMatchObject([{ clickPct: null }]);
  });

  it("takes no hop measured from a message the page around made", async () => {
    // The editor's page posting the token from a frame of its own: the origin isn't the clicked one's.
    clicks.pointer("a", facts, clicked, frame);
    clicks.hop("a", editor, { childOrigin: editor.origin, offset: { x: 500, y: 500 } });
    clicks.hop("a", editor, fromEditor);
    clicks.hop("a", top, fromTop);
    await settled();
    expect(delivered.map((pointer) => pointer.clickPct)).toEqual([{ x: 11, y: 11 }]);
  });

  it("ignores hops from another tab, and hops with no click", async () => {
    clicks.pointer("a", facts, clicked, frame);
    clicks.hop("a", { ...editor, tabId: 8 }, fromEditor);
    clicks.hop("a", top, fromTop);
    clicks.hop("made-up", top, fromTop);
    await settled();
    runTimers();
    expect(delivered).toMatchObject([{ clickPct: null }]);
  });

  it("still keeps a click when a page floods it with made-up tokens", () => {
    for (let index = 0; index < 60; index += 1) clicks.hop(`fake-${index}`, top, fromTop);
    clicks.pointer("real", facts, clicked, frame);
    expect(delivered).toMatchObject([{ clickPct: null }]);
  });
});

describe("in Firefox, where the capture scripts name the frames", () => {
  let firefoxClicks: ReturnType<typeof frameClicks>;
  beforeEach(() => {
    firefoxClicks = frameClicks(
      (_facts, pointer) => delivered.push(pointer),
      () => Promise.resolve(null),
    );
  });

  it("follows each hop by the frame it names", async () => {
    firefoxClicks.pointer("a", facts, clicked, frame);
    firefoxClicks.hop("a", top, { ...fromTop, childFrameId: 3 });
    firefoxClicks.hop("a", editor, { ...fromEditor, childFrameId: 5 });
    await settled();
    expect(delivered.map((pointer) => pointer.clickPct)).toEqual([{ x: 11, y: 11 }]);
  });

  it("takes no hop for a frame other than the clicked one", async () => {
    vi.useFakeTimers();
    firefoxClicks.pointer("a", facts, clicked, frame);
    // The editor's page passing the token on from a frame of its own (9).
    firefoxClicks.hop("a", editor, { ...fromEditor, childFrameId: 9 });
    firefoxClicks.hop("a", top, { ...fromTop, childFrameId: 3 });
    await vi.advanceTimersByTimeAsync(PLACE_WAIT_MS);
    vi.useRealTimers();
    expect(delivered).toMatchObject([{ clickPct: null }]);
  });
});
