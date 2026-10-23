/**
 * Picking several of a list at once, as in File Explorer (#122): the editor's steps
 * (docs/spec/04-editor.md#guide-view) and the library's guides (#several-guides-at-once). Plain
 * state and pure operations over the list's ids in the order shown; each screen keeps its own keys
 * and clicks and calls these.
 *
 * A list has one on screen or doesn't, fixed when picking starts. The editor's steps have one, the
 * step shown: it always counts as picked, so fewer than two picked is it alone, and picking moves
 * it. The library's guides have none: one ticked is one picked.
 */

/** How a click picks: Ctrl adds or takes away one, Shift picks a range, Ctrl+Shift adds a range. */
export type PickHow = "toggle" | "range" | "addRange";

export interface Picking {
  /** What's picked, in the order it was picked (the last one left is shown when one goes). */
  readonly ids: readonly string[];
  /** Where a Shift range starts: the last one clicked. */
  readonly anchor: string | null;
  /** The one on screen, or null while none is (the guide's details); always null in a list without. */
  readonly current: string | null;
  /** Whether the list has one on screen (the editor's steps) or not (the library's guides). */
  readonly hasCurrent: boolean;
}

/**
 * Nothing picked yet. Give `onScreen` for a list with one on screen: the step shown first, or null
 * for none.
 */
export function startPicking(onScreen?: { current: string | null }): Picking {
  return {
    ids: [],
    anchor: null,
    current: onScreen?.current ?? null,
    hasCurrent: onScreen !== undefined,
  };
}

/**
 * Ctrl-click and Shift-click on `id`. A range runs from the anchor while the list still shows it,
 * else from the one on screen, which becomes the anchor; with neither, the click is a Ctrl-click.
 * With one on screen, the click shows `id` (unless it takes it away: then the last one picked of
 * those left is shown, if the one taken away was on screen).
 */
export function pick(picking: Picking, list: readonly string[], id: string, how: PickHow): Picking {
  const now = pickedNow(picking, list);
  const current = currentIn(picking, list);
  const anchor = picking.anchor !== null && list.includes(picking.anchor) ? picking.anchor : null;
  const start = anchor ?? current;
  const from = start === null ? -1 : list.indexOf(start);
  const to = list.indexOf(id);
  const shown = picking.hasCurrent ? id : null;
  if (how === "toggle" || from < 0 || to < 0) {
    if (!now.includes(id)) return { ...picking, ids: [...now, id], anchor: id, current: shown };
    const left = now.filter((item) => item !== id);
    const last = left.at(-1);
    return {
      ...picking,
      ids: left,
      anchor: id,
      current: current === id && last !== undefined ? last : picking.current,
    };
  }
  const range = list.slice(Math.min(from, to), Math.max(from, to) + 1);
  return {
    ...picking,
    ids: how === "range" ? range : [...new Set([...now, ...range])],
    anchor: start,
    current: shown,
  };
}

/** A plain click: `id` alone, anchored there; null lets everything go (the guide's details). */
export function pickOne(picking: Picking, id: string | null): Picking {
  if (picking.hasCurrent) return { ...picking, ids: [], anchor: id, current: id };
  return { ...picking, ids: id === null ? [] : [id], anchor: id };
}

/** Ctrl+A: the whole list given, and only it; the anchor and the one on screen stay. */
export function pickAll(picking: Picking, list: readonly string[]): Picking {
  return { ...picking, ids: [...list] };
}

/** Escape or Clear: nothing picked and no anchor; the one on screen stays. */
export function clearPicked(picking: Picking): Picking {
  return { ...picking, ids: [], anchor: null };
}

/**
 * Shows `id` without picking (the editor's Previous and Next, a comment's step): what's picked
 * and the anchor stay. A list with nothing on screen keeps none.
 */
export function show(picking: Picking, id: string | null): Picking {
  return { ...picking, current: picking.hasCurrent ? id : null };
}

/**
 * What's picked, in the list's order. Ids the list doesn't have don't count; a list with one on
 * screen gives none unless two or more are picked (one is just the one on screen).
 */
export function pickedIn(picking: Picking, list: readonly string[]): string[] {
  const picked = list.filter((id) => picking.ids.includes(id));
  return picking.hasCurrent && picked.length < 2 ? [] : picked;
}

/** The one on screen; when it has left the list, the list's first, if any. */
export function currentIn(picking: Picking, list: readonly string[]): string | null {
  if (picking.current === null || list.includes(picking.current)) return picking.current;
  return list[0] ?? null;
}

/**
 * What a Ctrl or Shift click adds to. With one on screen it counts as picked, and the list is the
 * whole list, so ids it no longer has are dropped. Without, the list may be a search's: what it
 * hides stays picked.
 */
function pickedNow(picking: Picking, list: readonly string[]): readonly string[] {
  if (!picking.hasCurrent) return picking.ids;
  const live = picking.ids.filter((id) => list.includes(id));
  if (live.length > 1) return live;
  const current = currentIn(picking, list);
  return current === null ? [] : [current];
}
