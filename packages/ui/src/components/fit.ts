import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * How compact a row of buttons is drawn (#84): level 0 shows every label, and each level after
 * shows fewer, as icons with tooltips. `needed[n]` is the width level n took when it didn't fit,
 * so the labels come back once there's that much room again.
 */
export interface Fit {
  level: number;
  needed: readonly number[];
}

/**
 * The row's next level, from the room it has and the width its buttons take on one line. Steps
 * one level at a time, and only past the most compact level does the row wrap.
 */
export function nextFit(fit: Fit, room: number, used: number, most: number): Fit {
  // Widths come in fractions of a pixel; under one isn't a button cut off.
  if (used > room + 1) {
    if (fit.level >= most) return fit;
    const needed = [...fit.needed];
    needed[fit.level] = used;
    return { level: fit.level + 1, needed };
  }
  const wider = fit.level > 0 ? fit.needed[fit.level - 1] : undefined;
  if (wider !== undefined && wider <= room + 1) return { level: fit.level - 1, needed: fit.needed };
  return fit;
}

/**
 * The level a row of buttons fits its width at, measured before it's painted and again whenever
 * it's resized. The row must keep its buttons on one line (`flex-nowrap`) below `most`. A new
 * `content` (another language, another button) starts again from every label shown.
 */
export function useFit(row: RefObject<HTMLElement | null>, most: number, content: string): number {
  const [fit, setFit] = useState<Fit & { content: string }>({ level: 0, needed: [], content });
  const fresh = fit.content === content;

  useLayoutEffect(() => {
    const element = row.current;
    if (!element) return;
    // Measured at what's on screen, the level this render drew; never at a level set since,
    // which the row may not show yet.
    const shown: Fit = fresh ? fit : { level: 0, needed: [] };
    const check = () => {
      const next = nextFit(shown, element.clientWidth, element.scrollWidth, most);
      if (next !== shown || !fresh) setFit({ ...next, content });
    };
    check();
    // jsdom (tests) has no ResizeObserver; every desktop WebView does.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [row, most, content, fit, fresh]);

  return fresh ? fit.level : 0;
}
