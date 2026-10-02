export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export type Side = "below" | "above" | "right" | "left" | "inside";
/** `arrow` is measured along the card's edge that faces the target, from its start. */
export interface Placement {
  left: number;
  top: number;
  side: Side;
  arrow: number;
}

const GAP = 14;
const MARGIN = 12;
const ARROW_INSET = 18;

/**
 * Where the tour card goes, next to the lit-up target: below, then above, right, left, whichever
 * fits first, slid along to stay on screen. A target taking up much of the window (the guide
 * list) gets the card inside its top-right corner instead, since there's nowhere beside it.
 * The same rules as the CRM's tour (alwayse-crm `src/lib/tour/placement.ts`).
 */
export function placeCard(
  target: Rect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, viewport.width - card.width - MARGIN));
  const clampY = (y: number) =>
    Math.max(MARGIN, Math.min(y, viewport.height - card.height - MARGIN));
  const centreX = target.left + target.width / 2;
  const centreY = target.top + target.height / 2;
  const arrowAlong = (centre: number, start: number, length: number) =>
    Math.max(ARROW_INSET, Math.min(centre - start, length - ARROW_INSET));

  if (target.width * target.height > viewport.width * viewport.height * 0.3) {
    const left = clampX(target.left + target.width - card.width - 24);
    const top = clampY(Math.max(target.top, 0) + 24);
    return { left, top, side: "inside", arrow: 0 };
  }

  const below = target.top + target.height + GAP;
  if (below + card.height + MARGIN <= viewport.height) {
    const left = clampX(centreX - card.width / 2);
    return { left, top: below, side: "below", arrow: arrowAlong(centreX, left, card.width) };
  }
  const above = target.top - GAP - card.height;
  if (above >= MARGIN) {
    const left = clampX(centreX - card.width / 2);
    return { left, top: above, side: "above", arrow: arrowAlong(centreX, left, card.width) };
  }
  const right = target.left + target.width + GAP;
  if (right + card.width + MARGIN <= viewport.width) {
    const top = clampY(centreY - card.height / 2);
    return { left: right, top, side: "right", arrow: arrowAlong(centreY, top, card.height) };
  }
  const left = Math.max(MARGIN, target.left - GAP - card.width);
  const top = clampY(centreY - card.height / 2);
  return { left, top, side: "left", arrow: arrowAlong(centreY, top, card.height) };
}
