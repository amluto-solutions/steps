// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hero } from "./Hero";

/** Where every step of the feed sits, as a browser would lay it out (jsdom lays out nothing). */
const BOX = { top: 44, left: 0, width: 330, height: 40 };

/** The hero is always in view, so the feed runs. */
class InView {
  constructor(private readonly report: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.report(
      [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", InView);
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    return new Proxy(style, {
      get(target, key) {
        if (key === "width") return `${BOX.width}px`;
        if (key === "height") return `${BOX.height}px`;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(BOX.top);
  vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockReturnValue(BOX.left);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the hero's step feed", () => {
  it("takes a leaving step out of the layout without adding a style element (#126)", () => {
    const { container } = render(<Hero />);
    const styles = document.querySelectorAll("style").length;
    // Three steps show at once: the fourth arriving sends the first away.
    for (let tick = 0; tick < 3; tick += 1) {
      act(() => {
        vi.advanceTimersByTime(1700);
      });
    }
    const feed = container.querySelector('[aria-hidden="true"].pointer-events-none');
    const leaving = [...(feed?.querySelectorAll("[lang]") ?? [])].find(
      (step) => step.querySelector("span")?.textContent === "1",
    );
    // The site's CSP blocks any style element added after load.
    expect(document.querySelectorAll("style")).toHaveLength(styles);
    expect(leaving).toBeInstanceOf(HTMLElement);
    expect((leaving as HTMLElement).style).toMatchObject({
      position: "absolute",
      top: `${BOX.top}px`,
      left: `${BOX.left}px`,
      width: `${BOX.width}px`,
      height: `${BOX.height}px`,
    });
  });
});
