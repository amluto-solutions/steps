import type { OcrLine, StepTarget } from "@amluto-steps/core";

import { inView } from "./element";
import type { Box } from "./page-text";

/**
 * Clicks inside frames (docs/spec/02-capture.md#chrome-edition). The screenshot is of the whole
 * tab, but a frame knows only its own view, so a click there is placed in parts: the frame tells
 * the background what was clicked, in its own pixels, and passes a token up through the frames
 * around it. Each tells the background where the frame the token came from starts in its own
 * view (a hop); the top one adds the tab's view and words. The background checks each hop
 * against the browser's frame tree and puts them together (`recorder/frames.ts`). Nothing
 * measured passes through a page, so the page around a frame can't move the click.
 */

/** The window message a frame's capture script passes up to the page around it. */
export const RELAY_KEY = "__stepsFrameClick";

export interface FrameRelay {
  [RELAY_KEY]: string;
}

export const isRelay = (data: unknown): data is FrameRelay =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as Record<string, unknown>)[RELAY_KEY] === "string";

/** A click in a frame, as the frame saw it. */
export interface FramePointer {
  target: StepTarget | null;
  /** When the pointer went down (milliseconds since 1970), for Steps for Windows. */
  at?: number;
  /** In the frame's own CSS pixels. */
  click: { x: number; y: number };
  element: Box;
  viewport: { width: number; height: number };
  scale: number;
  /** The frame's words, as percentages of its own view (`pageText`). */
  text: OcrLine[];
}

/**
 * One frame's part in placing a click below it: where the child frame the token came from starts
 * in this frame's view, and the origin the browser gave that child's message.
 */
export interface FrameHop {
  childOrigin: string;
  /** Firefox only (`runtime.getFrameId`): the frame the message came from. */
  childFrameId?: number;
  offset: { x: number; y: number };
  /** The top frame's only: its view and its own words. */
  top?: { viewport: { width: number; height: number }; text: OcrLine[] };
}

/** Where the frame's view is on the tab, from the hops, with the top page's own words. */
export interface FramePlace {
  offset: { x: number; y: number };
  viewport: { width: number; height: number };
  text: OcrLine[];
}

/** What the recorder keeps of a click: `engine.ts`'s `PagePointer`. */
export interface PlacedPointer {
  target: StepTarget | null;
  clickPct: { x: number; y: number } | null;
  elementPct: { x: number; y: number; w: number; h: number } | null;
  scale: number;
  text: OcrLine[];
}

const pc = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;

/**
 * A frame's click as percentages of the tab's view, with the frame's words moved there too.
 * Without a place (the frames around it never answered) the step keeps what was clicked, and no
 * highlight.
 */
export function placePointer(frame: FramePointer, place: FramePlace | null): PlacedPointer {
  if (!place)
    return { target: frame.target, clickPct: null, elementPct: null, scale: frame.scale, text: [] };
  const { offset, viewport } = place;
  const inTab = (value: number, frameTotal: number, shift: number, tabTotal: number) =>
    ((value / 100) * frameTotal + shift) / tabTotal;
  const words = frame.text
    .map((line) => ({
      words: line.words
        .map((word) => {
          const x = inTab(word.x, frame.viewport.width, offset.x, viewport.width);
          const y = inTab(word.y, frame.viewport.height, offset.y, viewport.height);
          const w = ((word.w / 100) * frame.viewport.width) / viewport.width;
          const h = ((word.h / 100) * frame.viewport.height) / viewport.height;
          return { ...word, x, y, w, h };
        })
        // Only what the screenshot shows: a frame can reach past the edge of the tab's view.
        .filter(
          (word) => word.x >= 0 && word.y >= 0 && word.x + word.w <= 1 && word.y + word.h <= 1,
        )
        .map((word) => ({
          ...word,
          x: Math.round(word.x * 10_000) / 100,
          y: Math.round(word.y * 10_000) / 100,
          w: Math.round(word.w * 10_000) / 100,
          h: Math.round(word.h * 10_000) / 100,
        })),
    }))
    .filter((line) => line.words.length > 0);
  return {
    target: frame.target,
    clickPct: {
      x: pc(frame.click.x + offset.x, viewport.width),
      y: pc(frame.click.y + offset.y, viewport.height),
    },
    elementPct: inView(
      {
        left: frame.element.left + offset.x,
        top: frame.element.top + offset.y,
        width: frame.element.width,
        height: frame.element.height,
      },
      viewport,
    ),
    scale: frame.scale,
    text: [...place.text, ...words],
  };
}

/**
 * The frame element in this document whose window sent a message, looking inside shadow roots
 * too (editors and widgets often keep their frame in one). `openShadow` also opens closed roots,
 * which only an extension can.
 */
export function frameFor(
  document: Document,
  source: MessageEventSource | null,
  openShadow: (element: Element) => ShadowRoot | null = (element) => element.shadowRoot,
): HTMLIFrameElement | HTMLFrameElement | null {
  if (!source) return null;
  const search = (root: Document | ShadowRoot): HTMLIFrameElement | HTMLFrameElement | null => {
    for (const frame of root.querySelectorAll<HTMLIFrameElement | HTMLFrameElement>(
      "iframe, frame",
    ))
      if (frame.contentWindow === source) return frame;
    for (const element of root.querySelectorAll("*")) {
      const shadow = openShadow(element);
      const found = shadow ? search(shadow) : null;
      if (found) return found;
    }
    return null;
  };
  return search(document);
}

/** Where a frame's view starts in its page: inside its border and padding. */
export function frameViewStart(frame: HTMLIFrameElement | HTMLFrameElement): {
  x: number;
  y: number;
} {
  const box = frame.getBoundingClientRect();
  const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
  const padding = (value: string | undefined) => Number.parseFloat(value ?? "") || 0;
  return {
    x: box.left + frame.clientLeft + padding(style?.paddingLeft),
    y: box.top + frame.clientTop + padding(style?.paddingTop),
  };
}
