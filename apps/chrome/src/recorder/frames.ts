import { placePointer, type FrameHop, type FramePointer } from "../capture/frames";
import type { PageFacts, PagePointer } from "./engine";

/**
 * The background's half of a click inside a frame (`capture/frames.ts`): the frame's report, and
 * a hop from each frame around it saying where its child frame's view starts, arrive separately
 * and in any order, joined by their token. A hop counts only when it came from the parent of the
 * frame below it, and the message that reached it came from that frame's origin. Chrome and Edge
 * say which frame is whose parent through `webNavigation`; Firefox, which would ask people for
 * that permission, lets the capture script name the frame a message came from (`getFrameId`). So the page around a frame can't move a click's
 * place: each number is measured by a capture script, never passed through a page.
 */

/**
 * How long a frame's click waits to be placed. The hops take a few milliseconds; this is for a
 * page where they never arrive (a frame the capture script can't reach), whose click is kept
 * without a highlight.
 */
export const PLACE_WAIT_MS = 300;

/** Tokens waiting at once: a page posting made-up ones can't grow this. */
const MAX_WAITING = 50;
/** Hops kept per frame for one token, and frames deep: a page can't grow these either. */
const MAX_HOPS = 4;
const MAX_DEPTH = 32;

/** Which frame a capture script's message came from. */
export interface FrameSender {
  tabId: number;
  frameId: number;
  /** The frame's origin, as its capture script reports it (`globalThis.origin`). */
  origin: string;
}

/** Each frame's parent in a tab, by frame id; the top frame is 0. Null in Firefox. */
export type FrameTree = Map<number, number> | null;

interface Waiting {
  pointer?: { facts: PageFacts; sender: FrameSender; frame: FramePointer };
  hops: Map<number, { sender: FrameSender; hop: FrameHop }[]>;
  /** Undefined until the browser has said. */
  tree?: FrameTree;
  timer: ReturnType<typeof setTimeout>;
}

export function frameClicks(
  deliver: (facts: PageFacts, pointer: PagePointer) => void,
  frameTree: (tabId: number) => Promise<FrameTree>,
  timers: {
    set: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (timer: ReturnType<typeof setTimeout>) => void;
    // Called as themselves: a browser refuses `setTimeout` called on another object.
  } = { set: (run, ms) => setTimeout(run, ms), clear: (timer) => clearTimeout(timer) },
) {
  const waiting = new Map<string, Waiting>();

  const finish = (token: string, place: Parameters<typeof placePointer>[1]) => {
    const entry = waiting.get(token);
    if (!entry) return;
    timers.clear(entry.timer);
    waiting.delete(token);
    if (entry.pointer) deliver(entry.pointer.facts, placePointer(entry.pointer.frame, place));
  };

  /** Walks up from the clicked frame; places the click once every hop to the top is in. */
  const tryPlace = (token: string) => {
    const entry = waiting.get(token);
    if (!entry?.pointer || entry.tree === undefined) return;
    const { tree, hops } = entry;
    const { sender } = entry.pointer;
    let child = sender.frameId;
    let origin = sender.origin;
    const offset = { x: 0, y: 0 };
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const from = child;
      let parent: number | undefined;
      if (tree) {
        parent = tree.get(from);
        // Not in the tree (the frame has gone): kept without a highlight.
        if (parent === undefined || parent < 0) return finish(token, null);
      } else
        parent = [...hops.values()].flat().find((item) => item.hop.childFrameId === from)
          ?.sender.frameId;
      if (parent === undefined) return;
      const found = hops
        .get(parent)
        ?.find(
          (item) =>
            item.sender.tabId === sender.tabId &&
            item.hop.childOrigin === origin &&
            (tree ? true : item.hop.childFrameId === from),
        );
      if (!found) return;
      offset.x += found.hop.offset.x;
      offset.y += found.hop.offset.y;
      if (parent === 0) {
        if (!found.hop.top) return finish(token, null);
        return finish(token, { offset, ...found.hop.top });
      }
      child = parent;
      origin = found.sender.origin;
    }
    finish(token, null);
  };

  const entry = (token: string): Waiting | null => {
    const found = waiting.get(token);
    if (found) return found;
    if (waiting.size >= MAX_WAITING) return null;
    const made: Waiting = {
      hops: new Map(),
      timer: timers.set(() => finish(token, null), PLACE_WAIT_MS),
    };
    waiting.set(token, made);
    return made;
  };

  return {
    /** A frame's report of a click. */
    pointer(token: string, facts: PageFacts, sender: FrameSender, frame: FramePointer) {
      const found = entry(token);
      // Too many waiting (a page making tokens up): the click is still kept, unplaced.
      if (!found) return deliver(facts, placePointer(frame, null));
      if (found.pointer) return;
      found.pointer = { facts, sender, frame };
      frameTree(sender.tabId).then(
        (tree) => {
          if (waiting.get(token) !== found) return;
          found.tree = tree;
          tryPlace(token);
        },
        () => finish(token, null),
      );
    },
    /** A frame's hop: where the child frame the token came up from starts, in its own view. */
    hop(token: string, sender: FrameSender, hop: FrameHop) {
      const found = entry(token);
      if (!found) return;
      const list = found.hops.get(sender.frameId) ?? [];
      if (list.length >= MAX_HOPS) return;
      list.push({ sender, hop });
      found.hops.set(sender.frameId, list);
      tryPlace(token);
    },
  };
}
