import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
  MARK_COLOUR_HEX,
  MARK_COLOURS,
  type Annotation,
  type GuideStep,
  type MarkColour,
} from "@amluto-steps/core";

import { useAnnounce } from "../components/Announcer";
import { Icon } from "../components/icons";
import { useLatest } from "../useLatest";

export type ImageTool = "select" | "arrow" | "box" | "text" | "blur" | "crop";

type Redaction = GuideStep["redactions"][number];
type Crop = NonNullable<GuideStep["crop"]>;
type Highlight = NonNullable<GuideStep["highlight"]>;

export interface Geometry {
  highlight: Highlight | null;
  annotations: Annotation[];
  redactions: Redaction[];
  crop: Crop | null;
}

type Selected =
  | { kind: "highlight" }
  | { kind: "annotation"; index: number }
  | { kind: "redaction"; index: number }
  | { kind: "crop" }
  | null;

type Gesture =
  | { mode: "move"; start: [number, number]; origin: Geometry }
  | { mode: "resize"; start: [number, number]; origin: Geometry }
  | { mode: "arrow-end"; end: "from" | "to"; origin: Geometry }
  | {
      mode: "draw";
      tool: "arrow" | "box" | "blur" | "crop";
      start: [number, number];
      origin: Geometry;
    };

interface ImageEditorProps {
  step: GuideStep;
  imageUrl: string | null;
  tool: ImageTool;
  onToolChange: (tool: ImageTool) => void;
  /** One call per finished gesture, so each is one undo step. */
  onCommit: (patch: Geometry, label: string) => void;
  /** Suggested blurs not yet accepted or dismissed, drawn dashed and numbered as they're listed. */
  suggestions?: Area[];
  /** The suggestion pointed at in the list: drawn stronger, and the others faded. */
  activeSuggestion?: number | null | undefined;
  /** An area to zoom in on and bring into view ("Show"); a new object each time it's asked for. */
  reveal?: Area | null | undefined;
}

type Area = { x: number; y: number; w: number; h: number };

const clamp = (value: number, low = -50, high = 150) => Math.max(low, Math.min(high, value));
const round = (value: number) => Math.round(value * 100) / 100;
const NUDGE = 0.5;
/** Zoom is a multiple of the fitted size: from 1 (the whole screenshot) to 8. */
const MAX_ZOOM = 8;
/** One press of + or −, or one notch of Ctrl+wheel. */
const ZOOM_STEP = 1.25;
const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(1, Math.round(value * 100) / 100));

const geometryOf = (step: GuideStep): Geometry => ({
  highlight: step.highlight,
  annotations: step.annotations,
  redactions: step.redactions,
  crop: step.crop,
});

/** A rectangle from two corners, in either drag direction. */
const rectFrom = (a: [number, number], b: [number, number]) => ({
  x: round(Math.min(a[0], b[0])),
  y: round(Math.min(a[1], b[1])),
  w: round(Math.abs(a[0] - b[0])),
  h: round(Math.abs(a[1] - b[1])),
});

type Field = "x" | "y" | "w" | "h" | "fromX" | "fromY" | "toX" | "toY";

/** The numbers the position panel shows for the selected mark, as percentages. */
export function fieldsOf(
  geometry: Geometry,
  selected: Selected,
): Partial<Record<Field, number>> | null {
  if (!selected) return null;
  const box = (item: { x: number; y: number; w: number; h: number } | null | undefined) =>
    item ? { x: item.x, y: item.y, w: item.w, h: item.h } : null;
  if (selected.kind === "highlight") return box(geometry.highlight);
  if (selected.kind === "crop") return box(geometry.crop);
  if (selected.kind === "redaction") return box(geometry.redactions[selected.index]);
  const item = geometry.annotations[selected.index];
  if (!item) return null;
  if (item.type === "arrow")
    return { fromX: item.from[0], fromY: item.from[1], toX: item.to[0], toY: item.to[1] };
  if (item.type === "label") return { x: item.x, y: item.y };
  return box(item);
}

/** The selected mark with one number set exactly (the keyboard alternative to dragging). */
export function placed(
  geometry: Geometry,
  selected: Selected,
  field: Field,
  value: number,
): Geometry {
  if (!selected) return geometry;
  const set = <T extends object>(item: T): T => ({ ...item, [field]: value });
  if (selected.kind === "highlight" && geometry.highlight)
    return { ...geometry, highlight: set(geometry.highlight) };
  if (selected.kind === "crop" && geometry.crop) return { ...geometry, crop: set(geometry.crop) };
  if (selected.kind === "redaction")
    return {
      ...geometry,
      redactions: geometry.redactions.map((item, index) =>
        index === selected.index ? set(item) : item,
      ),
    };
  if (selected.kind !== "annotation") return geometry;
  return {
    ...geometry,
    annotations: geometry.annotations.map((item, index) => {
      if (index !== selected.index) return item;
      if (item.type !== "arrow") return set(item);
      const from: [number, number] = [
        field === "fromX" ? value : item.from[0],
        field === "fromY" ? value : item.from[1],
      ];
      const to: [number, number] = [
        field === "toX" ? value : item.to[0],
        field === "toY" ? value : item.to[1],
      ];
      return { ...item, from, to };
    }),
  };
}

function moved(geometry: Geometry, selected: Selected, dx: number, dy: number): Geometry {
  if (!selected) return geometry;
  if (selected.kind === "highlight" && geometry.highlight) {
    const { x, y } = geometry.highlight;
    return {
      ...geometry,
      highlight: { ...geometry.highlight, x: round(clamp(x + dx)), y: round(clamp(y + dy)) },
    };
  }
  if (selected.kind === "crop" && geometry.crop) {
    return {
      ...geometry,
      crop: {
        ...geometry.crop,
        x: round(clamp(geometry.crop.x + dx, 0, 100 - geometry.crop.w)),
        y: round(clamp(geometry.crop.y + dy, 0, 100 - geometry.crop.h)),
      },
    };
  }
  if (selected.kind === "redaction") {
    return {
      ...geometry,
      redactions: geometry.redactions.map((item, index) =>
        index === selected.index
          ? { ...item, x: round(clamp(item.x + dx)), y: round(clamp(item.y + dy)) }
          : item,
      ),
    };
  }
  if (selected.kind === "annotation") {
    return {
      ...geometry,
      annotations: geometry.annotations.map((item, index) => {
        if (index !== selected.index) return item;
        if (item.type === "arrow") {
          return {
            ...item,
            from: [round(clamp(item.from[0] + dx)), round(clamp(item.from[1] + dy))],
            to: [round(clamp(item.to[0] + dx)), round(clamp(item.to[1] + dy))],
          };
        }
        return { ...item, x: round(clamp(item.x + dx)), y: round(clamp(item.y + dy)) };
      }),
    };
  }
  return geometry;
}

function resized(
  geometry: Geometry,
  selected: Selected,
  dw: number,
  dh: number,
  aspect: number,
): Geometry {
  if (!selected) return geometry;
  const grow = <T extends { w: number; h: number }>(item: T, keepRound: boolean): T => {
    const w = round(Math.max(1, item.w + dw));
    return { ...item, w, h: keepRound ? round(w * aspect) : round(Math.max(1, item.h + dh)) };
  };
  if (selected.kind === "highlight" && geometry.highlight) {
    return {
      ...geometry,
      highlight: grow(geometry.highlight, geometry.highlight.shape === "circle"),
    };
  }
  if (selected.kind === "crop" && geometry.crop) {
    return { ...geometry, crop: grow(geometry.crop, false) };
  }
  if (selected.kind === "redaction") {
    return {
      ...geometry,
      redactions: geometry.redactions.map((item, index) =>
        index === selected.index ? grow(item, false) : item,
      ),
    };
  }
  if (selected.kind === "annotation") {
    return {
      ...geometry,
      annotations: geometry.annotations.map((item, index) =>
        index === selected.index && item.type === "box" ? grow(item, false) : item,
      ),
    };
  }
  return geometry;
}

function removed(geometry: Geometry, selected: Selected): Geometry {
  if (!selected) return geometry;
  if (selected.kind === "highlight") return { ...geometry, highlight: null };
  if (selected.kind === "crop") return { ...geometry, crop: null };
  if (selected.kind === "redaction") {
    return {
      ...geometry,
      redactions: geometry.redactions.filter((_, index) => index !== selected.index),
    };
  }
  return {
    ...geometry,
    annotations: geometry.annotations.filter((_, index) => index !== selected.index),
  };
}

/** Every selectable thing, in the order PageDown moves through them. */
function selectable(geometry: Geometry): Exclude<Selected, null>[] {
  return [
    ...(geometry.highlight ? [{ kind: "highlight" as const }] : []),
    ...geometry.annotations.map((_, index) => ({ kind: "annotation" as const, index })),
    ...geometry.redactions.map((_, index) => ({ kind: "redaction" as const, index })),
    ...(geometry.crop ? [{ kind: "crop" as const }] : []),
  ];
}

const sameSelection = (a: Selected, b: Selected) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a screen reader hears about the selected mark: which one and where, in whole percentages
 * of the screenshot (WCAG 4.1.2), e.g. "Box 2 of 3: left 40%, top 44%, 20% wide, 12% high".
 */
export function describeSelected(
  geometry: Geometry,
  selected: Selected,
  t: TFunction,
): string | null {
  if (!selected) return null;
  const all = selectable(geometry);
  const number = all.findIndex((item) => sameSelection(item, selected)) + 1;
  if (number === 0) return null;
  const pc = (value: number) => Math.round(value);
  const rect = (area: { x: number; y: number; w: number; h: number }) =>
    t("editor.mark.rect", { x: pc(area.x), y: pc(area.y), w: pc(area.w), h: pc(area.h) });
  let kind: string;
  let where: string;
  if (selected.kind === "highlight" && geometry.highlight) {
    kind = t("editor.mark.highlight");
    where = rect(geometry.highlight);
  } else if (selected.kind === "crop" && geometry.crop) {
    kind = t("editor.mark.crop");
    where = rect(geometry.crop);
  } else if (selected.kind === "redaction" && geometry.redactions[selected.index]) {
    kind = t("editor.mark.blur");
    where = rect(geometry.redactions[selected.index] as Redaction);
  } else if (selected.kind === "annotation" && geometry.annotations[selected.index]) {
    const mark = geometry.annotations[selected.index] as Annotation;
    if (mark.type === "arrow") {
      kind = t("editor.mark.arrow");
      where = t("editor.mark.line", {
        x1: pc(mark.from[0]),
        y1: pc(mark.from[1]),
        x2: pc(mark.to[0]),
        y2: pc(mark.to[1]),
      });
    } else if (mark.type === "label") {
      kind = t("editor.mark.label", { text: mark.text });
      where = t("editor.mark.point", { x: pc(mark.x), y: pc(mark.y) });
    } else {
      kind = t("editor.mark.box");
      where = rect(mark);
    }
  } else {
    return null;
  }
  return t("editor.mark.selected", { kind, number, count: all.length, where });
}

/**
 * The screenshot with its highlight, arrows, boxes, labels, blur areas and crop drawn on top. All
 * positions are percentages of the image, so they survive any display size and export
 * (docs/spec/02-capture.md#coordinates). Every drag has a keyboard alternative: PageDown picks the
 * next item, arrow keys nudge, Shift+arrows resize, Delete removes (docs/spec/04-editor.md).
 */
export function ImageEditor({
  step,
  imageUrl,
  tool,
  onToolChange,
  onCommit,
  suggestions = [],
  activeSuggestion = null,
  reveal = null,
}: ImageEditorProps) {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  /** Scrolls the screenshot when it's zoomed in past the space it has. */
  const scroller = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useLatest(zoom);
  /** Where to scroll once a new zoom is drawn: a content point to keep under a viewport point. */
  const pendingScroll = useRef<{ x: number; y: number; atX: number; atY: number } | null>(null);
  /** The space the editor has, measured from its frame. */
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Geometry | null>(null);
  const geometry = draft ?? geometryOf(step);
  const [selected, setSelected] = useState<Selected>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const announce = useAnnounce();
  // Said once the mark comes to rest: after choosing it, and after a run of nudges or a drag.
  const description = gesture ? null : describeSelected(geometry, selected, t);
  useEffect(() => {
    if (!description) return undefined;
    const timer = window.setTimeout(() => announce(description), 400);
    return () => window.clearTimeout(timer);
  }, [description, announce]);
  const [labelDraft, setLabelDraft] = useState<{
    x: number;
    y: number;
    text: string;
    index: number | null;
  } | null>(null);

  const width = step.media?.width ?? 1600;
  const height = step.media?.height ?? 1000;
  const aspect = width / height;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => {
      const measured = element.getBoundingClientRect();
      setBox({ width: measured.width, height: measured.height });
    };
    fit();
    // jsdom (tests) has no ResizeObserver; every desktop WebView does.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const commit = (next: Geometry, label: string) => {
    setDraft(null);
    onCommit(next, label);
  };

  const pointAt = (event: { clientX: number; clientY: number }): [number, number] => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || box.width === 0) return [0, 0];
    return [
      round(((event.clientX - box.left) / box.width) * 100),
      round(((event.clientY - box.top) / box.height) * 100),
    ];
  };

  const begin = (event: PointerEvent, next: Gesture, pick: Selected) => {
    event.preventDefault();
    event.stopPropagation();
    surface.current?.setPointerCapture(event.pointerId);
    surface.current?.focus();
    setSelected(pick);
    setGesture(next);
  };

  const onSurfaceDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const point = pointAt(event);
    if (tool === "text") {
      event.preventDefault();
      setLabelDraft({ x: point[0], y: point[1], text: "", index: null });
      return;
    }
    if (tool === "select") {
      setSelected(null);
      return;
    }
    begin(event, { mode: "draw", tool, start: point, origin: geometry }, null);
  };

  const onMove = (event: PointerEvent) => {
    if (!gesture) return;
    const point = pointAt(event);
    if (gesture.mode === "draw") {
      const rect = rectFrom(gesture.start, point);
      const origin = gesture.origin;
      if (gesture.tool === "arrow") {
        setDraft({
          ...origin,
          annotations: [...origin.annotations, { type: "arrow", from: gesture.start, to: point }],
        });
      } else if (gesture.tool === "box") {
        setDraft({ ...origin, annotations: [...origin.annotations, { type: "box", ...rect }] });
      } else if (gesture.tool === "blur") {
        setDraft({
          ...origin,
          redactions: [...origin.redactions, { ...rect, source: "manual" }],
        });
      } else {
        setDraft({ ...origin, crop: { ...rect, source: "manual" } });
      }
      return;
    }
    if (gesture.mode === "arrow-end") {
      if (selected?.kind === "annotation") {
        setDraft({
          ...gesture.origin,
          annotations: gesture.origin.annotations.map((item, index) =>
            index === selected.index && item.type === "arrow"
              ? { ...item, [gesture.end]: point }
              : item,
          ),
        });
      }
      return;
    }
    const dx = point[0] - gesture.start[0];
    const dy = point[1] - gesture.start[1];
    setDraft(
      gesture.mode === "move"
        ? moved(gesture.origin, selected, dx, dy)
        : resized(gesture.origin, selected, dx, dy, aspect),
    );
  };

  const onUp = () => {
    if (!gesture) return;
    const finished = gesture;
    setGesture(null);
    if (finished.mode === "draw") {
      const origin = finished.origin;
      const tooSmall = (w: number, h: number) => w < 1 && h < 1;
      // A click without a drag: the standard mark, centred where it was clicked.
      const clicked = () => {
        setDraft(null);
        addStandard(origin, finished.start);
      };
      if (finished.tool === "arrow") {
        const arrow = geometry.annotations.at(-1);
        if (
          geometry.annotations.length === origin.annotations.length ||
          !arrow ||
          arrow.type !== "arrow" ||
          tooSmall(Math.abs(arrow.to[0] - arrow.from[0]), Math.abs(arrow.to[1] - arrow.from[1]))
        ) {
          clicked();
          return;
        }
        commit(geometry, t("editor.undo.arrow"));
        setSelected({ kind: "annotation", index: geometry.annotations.length - 1 });
      } else if (finished.tool === "box") {
        const box = geometry.annotations.at(-1);
        if (
          !box ||
          box.type !== "box" ||
          geometry.annotations.length === origin.annotations.length ||
          tooSmall(box.w, box.h)
        ) {
          clicked();
          return;
        }
        commit(geometry, t("editor.undo.box"));
        setSelected({ kind: "annotation", index: geometry.annotations.length - 1 });
      } else if (finished.tool === "blur") {
        const area = geometry.redactions.at(-1);
        if (
          !area ||
          geometry.redactions.length === origin.redactions.length ||
          tooSmall(area.w, area.h)
        ) {
          clicked();
          return;
        }
        commit(geometry, t("editor.undo.blur"));
        setSelected({ kind: "redaction", index: geometry.redactions.length - 1 });
      } else {
        if (!geometry.crop || tooSmall(geometry.crop.w, geometry.crop.h)) {
          clicked();
          return;
        }
        commit(geometry, t("editor.undo.crop"));
        setSelected({ kind: "crop" });
      }
      onToolChange("select");
      return;
    }
    if (JSON.stringify(finished.origin) !== JSON.stringify(geometry)) {
      commit(geometry, finished.mode === "move" ? t("editor.undo.move") : t("editor.undo.resize"));
    } else {
      setDraft(null);
    }
  };

  /**
   * The mark the tool makes, at a standard size, selected so the arrow keys (or the position
   * boxes) put it in place: in the middle for Enter with a drawing tool, centred on the click for
   * a click without a drag. Everything a drag can make, the keyboard and a single click can too
   * (WCAG 2.1.1 and 2.5.7).
   */
  const addStandard = (base: Geometry, at: [number, number] = [50, 50]) => {
    const w = 20;
    const h = 12;
    const middle = {
      x: round(clamp(at[0] - w / 2, 0, 100 - w)),
      y: round(clamp(at[1] - h / 2, 0, 100 - h)),
      w,
      h,
    };
    const row = round(clamp(at[1], 0, 100));
    if (tool === "blur") {
      commit(
        { ...base, redactions: [...base.redactions, { ...middle, source: "manual" }] },
        t("editor.undo.blur"),
      );
      setSelected({ kind: "redaction", index: base.redactions.length });
    } else if (tool === "box") {
      commit(
        { ...base, annotations: [...base.annotations, { type: "box", ...middle }] },
        t("editor.undo.box"),
      );
      setSelected({ kind: "annotation", index: base.annotations.length });
    } else if (tool === "arrow") {
      commit(
        {
          ...base,
          annotations: [
            ...base.annotations,
            { type: "arrow", from: [middle.x, row], to: [middle.x + w, row] },
          ],
        },
        t("editor.undo.arrow"),
      );
      setSelected({ kind: "annotation", index: base.annotations.length });
    } else if (tool === "crop") {
      // A crop is most of the screenshot to start with, wherever the click was.
      commit(
        { ...base, crop: { x: 10, y: 10, w: 80, h: 80, source: "manual" } },
        t("editor.undo.crop"),
      );
      setSelected({ kind: "crop" });
    }
    onToolChange("select");
  };

  const addWithKeyboard = () => {
    if (tool === "text") {
      setLabelDraft({ x: 40, y: 45, text: "", index: null });
      return;
    }
    addStandard(geometry);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // + and − zoom, 0 fits the screenshot again (the buttons in the corner do the same).
    if (!event.ctrlKey && !event.metaKey && !event.altKey) {
      const zoomKeys: Record<string, number> = {
        "+": zoom * ZOOM_STEP,
        "=": zoom * ZOOM_STEP,
        "-": zoom / ZOOM_STEP,
        "0": 1,
      };
      const next = zoomKeys[event.key];
      if (next !== undefined) {
        event.preventDefault();
        zoomToLatest.current(next);
        return;
      }
    }
    if (event.key === "Enter" && tool !== "select") {
      event.preventDefault();
      addWithKeyboard();
      return;
    }
    const items = selectable(geometry);
    if (event.key === "PageDown" || event.key === "PageUp") {
      if (items.length === 0) return;
      event.preventDefault();
      const index = items.findIndex((item) => sameSelection(item, selected));
      const next =
        event.key === "PageDown"
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
      setSelected(items[next] ?? null);
      return;
    }
    if (!selected) return;
    const chosen =
      selected.kind === "annotation" ? geometry.annotations[selected.index] : undefined;
    if (event.key === "Enter" && chosen?.type === "label" && selected.kind === "annotation") {
      event.preventDefault();
      setLabelDraft({ x: chosen.x, y: chosen.y, text: chosen.text, index: selected.index });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSelected(null);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
      commit(removed(geometry, selected), t("editor.undo.remove"));
      setSelected(null);
      return;
    }
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const delta = arrows[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    commit(
      event.shiftKey
        ? resized(geometry, selected, delta[0], delta[1], aspect)
        : moved(geometry, selected, delta[0], delta[1]),
      event.shiftKey ? t("editor.undo.resize") : t("editor.undo.move"),
    );
  };

  const saveLabel = () => {
    if (!labelDraft) return;
    const text = labelDraft.text.trim();
    setLabelDraft(null);
    onToolChange("select");
    if (labelDraft.index !== null) {
      const index = labelDraft.index;
      const next = text
        ? geometry.annotations.map((item, position) =>
            position === index && item.type === "label" ? { ...item, text } : item,
          )
        : geometry.annotations.filter((_, position) => position !== index);
      commit({ ...geometry, annotations: next }, t("editor.undo.label"));
      return;
    }
    if (!text) return;
    commit(
      {
        ...geometry,
        annotations: [
          ...geometry.annotations,
          { type: "label", x: labelDraft.x, y: labelDraft.y, text },
        ],
      },
      t("editor.undo.label"),
    );
  };

  const px = (value: number, axis: "x" | "y") => (value / 100) * (axis === "x" ? width : height);
  const isSelected = (candidate: Selected) => sameSelection(candidate, selected);
  const selectedRedaction =
    selected?.kind === "redaction" ? geometry.redactions[selected.index] : undefined;
  const selectedAnnotation =
    selected?.kind === "annotation" ? geometry.annotations[selected.index] : undefined;
  const resizeFrom = (event: PointerEvent) =>
    begin(event, { mode: "resize", start: pointAt(event), origin: geometry }, selected);
  const handleClass =
    "absolute z-20 size-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-[3px] border-2 border-brand-navy bg-white";
  const pct = (value: number) => `${value}%`;

  // An applied crop is what the editor shows (28/09/2026): the surface keeps its full size,
  // so every position and pointer sum is unchanged, and sits in a window the crop's shape. Drawing
  // or selecting the crop shows the whole screenshot again, with Apply.
  const crop = geometry.crop;
  const editingCrop = tool === "crop" || selected?.kind === "crop";
  const view = crop && !editingCrop && crop.w > 0 && crop.h > 0 ? crop : null;
  const viewAspect = view ? (view.w * width) / (view.h * height) : aspect;
  const windowWidth = Math.min(box.width, box.height * viewAspect);
  const windowHeight = viewAspect > 0 ? windowWidth / viewAspect : 0;
  const size = view
    ? { width: (windowWidth * 100) / view.w, height: (windowHeight * 100) / view.h }
    : { width: windowWidth, height: windowHeight };
  const offset = view
    ? { left: (-view.x / 100) * size.width, top: (-view.y / 100) * size.height }
    : { left: 0, top: 0 };

  // Zoom (30/09/2026: a small suggested blur was hard to see): the screenshot is drawn
  // `zoom` times its fitted size in a frame that scrolls. Positions stay percentages of the
  // surface and the pointer is read from where it's drawn, so every tool works zoomed in.
  const zoomTo = (next: number, at?: { clientX: number; clientY: number }) => {
    const element = scroller.current;
    const current = zoomRef.current;
    const target = clampZoom(next);
    if (!element || target === current) return;
    // The point under the pointer (or the middle) stays where it is.
    const rect = element.getBoundingClientRect();
    const atX = at ? at.clientX - rect.left : rect.width / 2;
    const atY = at ? at.clientY - rect.top : rect.height / 2;
    pendingScroll.current = {
      x: ((element.scrollLeft + atX) / current) * target,
      y: ((element.scrollTop + atY) / current) * target,
      atX,
      atY,
    };
    setZoom(target);
  };
  const zoomToLatest = useLatest(zoomTo);
  useLayoutEffect(() => {
    const element = scroller.current;
    const pending = pendingScroll.current;
    if (!element || !pending) return;
    pendingScroll.current = null;
    element.scrollLeft = pending.x - pending.atX;
    element.scrollTop = pending.y - pending.atY;
  }, [zoom]);

  // Ctrl+wheel zooms, and so does a touchpad pinch, which arrives as one. Registered by hand:
  // React's wheel listener is passive, so it couldn't stop the page zooming instead.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const notches = Math.max(-1, Math.min(1, -event.deltaY / 100));
      zoomToLatest.current(zoomRef.current * ZOOM_STEP ** notches, event);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [imageUrl, zoomRef, zoomToLatest]);

  // "Show" on a suggestion: zoom until it's big enough to see, and bring it to the middle.
  useEffect(() => {
    const element = scroller.current;
    if (!reveal || !element || size.width === 0) return;
    const areaWidth = Math.max((reveal.w / 100) * size.width, 1);
    const areaHeight = Math.max((reveal.h / 100) * size.height, 1);
    const target = clampZoom(
      Math.max(
        zoomRef.current,
        Math.min(box.width / (areaWidth * 6), box.height / (areaHeight * 6)),
      ),
    );
    const centreX = (offset.left + ((reveal.x + reveal.w / 2) / 100) * size.width) * target;
    const centreY = (offset.top + ((reveal.y + reveal.h / 2) / 100) * size.height) * target;
    const viewWidth = Math.min(box.width, windowWidth * target);
    const viewHeight = Math.min(box.height, windowHeight * target);
    if (target === zoomRef.current) {
      element.scrollLeft = centreX - viewWidth / 2;
      element.scrollTop = centreY - viewHeight / 2;
      return;
    }
    pendingScroll.current = { x: centreX, y: centreY, atX: viewWidth / 2, atY: viewHeight / 2 };
    setZoom(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when asked to show an area, not on every resize
  }, [reveal]);

  // Two fingers pinch to zoom and move together to pan; whatever the first finger began drawing
  // is dropped when the second lands.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number; midX: number; midY: number } | null>(null);
  const spread = () => {
    const [a, b] = [...touches.current.values()];
    return a && b
      ? { distance: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 }
      : null;
  };
  const onTouchDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch") return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = touches.current.size === 2 ? spread() : null;
    if (!now) return;
    event.stopPropagation();
    setGesture(null);
    setDraft(null);
    pinch.current = { zoom: zoomRef.current, ...now };
  };
  const onTouchMove = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !touches.current.has(event.pointerId)) return;
    touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = pinch.current;
    const now = spread();
    if (!start || !now || start.distance === 0) return;
    event.stopPropagation();
    const element = scroller.current;
    if (element) {
      element.scrollLeft -= now.midX - start.midX;
      element.scrollTop -= now.midY - start.midY;
    }
    pinch.current = { ...start, midX: now.midX, midY: now.midY };
    zoomTo(start.zoom * (now.distance / start.distance), { clientX: now.midX, clientY: now.midY });
  };
  const onTouchUp = (event: PointerEvent) => {
    touches.current.delete(event.pointerId);
    if (touches.current.size < 2) pinch.current = null;
  };

  const described = [
    geometry.highlight ? t("editor.image.hasHighlight") : null,
    geometry.annotations.length
      ? t("editor.image.annotationCount", { count: geometry.annotations.length })
      : null,
    geometry.redactions.length
      ? t("editor.image.blurCount", { count: geometry.redactions.length })
      : null,
    geometry.crop ? t("editor.image.cropped") : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={frame}
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"
    >
      {!imageUrl ? (
        <div className="flex size-full items-center justify-center rounded-md border border-dashed border-line text-sm text-secondary">
          {step.media?.id ? t("editor.image.loading") : t("editor.image.none")}
        </div>
      ) : (
        <div
          ref={scroller}
          onPointerDownCapture={onTouchDown}
          onPointerMoveCapture={onTouchMove}
          onPointerUpCapture={onTouchUp}
          onPointerCancelCapture={onTouchUp}
          className={`relative rounded-md ${zoom > 1 ? "overflow-auto" : "overflow-hidden"}`}
          style={{
            width: Math.min(box.width, windowWidth * zoom),
            height: Math.min(box.height, windowHeight * zoom),
          }}
        >
          <div
            className="relative overflow-hidden"
            style={{ width: windowWidth * zoom, height: windowHeight * zoom }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a canvas widget: every pointer action has a keyboard one */}
            <div
              ref={surface}
              role="application"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- focusable so the keyboard can move marks
              tabIndex={0}
              aria-roledescription={t("editor.image.roleDescription")}
              aria-label={t("editor.image.label")}
              aria-describedby={`image-help-${step.id}`}
              onPointerDown={onSurfaceDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
              onKeyDown={onKeyDown}
              className={`absolute touch-none overflow-hidden bg-subtle shadow-[0_1px_4px_var(--amluto-shadow)] select-none ${view ? "" : "rounded-md"} ${tool === "select" ? "cursor-default" : "cursor-crosshair"}`}
              style={{
                width: size.width * zoom,
                height: size.height * zoom,
                left: offset.left * zoom,
                top: offset.top * zoom,
              }}
            >
              <span id={`image-help-${step.id}`} className="sr-only">
                {`${described} ${t("editor.image.keys")}`}
              </span>
              <img
                src={imageUrl}
                alt={step.altText ?? step.actionText}
                draggable={false}
                className="pointer-events-none absolute inset-0 size-full"
              />

              {suggestions.map((area, index) => {
                const active = activeSuggestion === index;
                const faded = activeSuggestion !== null && !active;
                return (
                  <div
                    key={`suggestion-${index}`}
                    aria-hidden="true"
                    className={`pointer-events-none absolute z-10 rounded-sm border-2 border-bar-paused transition-opacity ${active ? "bg-bar-paused/35" : "border-dashed bg-bar-paused/15"} ${faded ? "opacity-35" : ""}`}
                    style={{
                      left: pct(area.x),
                      top: pct(area.y),
                      width: pct(area.w),
                      height: pct(area.h),
                    }}
                  >
                    {/* A halo bigger than the area, so even a few pixels of text are seen. */}
                    <span className="suggest-halo absolute -inset-2.5 min-h-7 min-w-7 rounded-md border-2 border-bar-paused" />
                    {suggestions.length > 1 && (
                      <span className="absolute -top-3 -left-3 grid size-5 place-items-center rounded-full bg-bar-paused text-[11px] font-bold text-brand-navy shadow">
                        {index + 1}
                      </span>
                    )}
                  </div>
                );
              })}
              {geometry.redactions.map((area, index) => (
                <div
                  key={`blur-${index}`}
                  onPointerDown={(event) =>
                    tool === "select" &&
                    begin(
                      event,
                      { mode: "move", start: pointAt(event), origin: geometry },
                      { kind: "redaction", index },
                    )
                  }
                  className={`blur-preview absolute ${isSelected({ kind: "redaction", index }) ? "outline-2 outline-cyan" : ""}`}
                  style={{
                    left: pct(area.x),
                    top: pct(area.y),
                    width: pct(area.w),
                    height: pct(area.h),
                  }}
                />
              ))}

              <svg
                viewBox={`0 0 ${width} ${height}`}
                preserveAspectRatio="none"
                className="pointer-events-none absolute inset-0 size-full"
                aria-hidden="true"
              >
                <defs>
                  {/* One arrowhead per colour: a marker doesn't take the colour of the line using it. */}
                  {(["accent", ...MARK_COLOURS] as const).map((colour) => (
                    <marker
                      key={colour}
                      id={`head-${step.id}-${colour}`}
                      viewBox="0 0 10 10"
                      refX="7"
                      refY="5"
                      markerWidth="4"
                      markerHeight="4"
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M0 0L10 5L0 10z"
                        className={colour === "accent" ? "fill-blue" : undefined}
                        fill={colour === "accent" ? undefined : MARK_COLOUR_HEX[colour]}
                      />
                    </marker>
                  ))}
                </defs>
                {geometry.crop && !view && (
                  <path
                    fillRule="evenodd"
                    className="fill-brand-navy/55"
                    d={`M0 0H${width}V${height}H0Z M${px(geometry.crop.x, "x")} ${px(geometry.crop.y, "y")}h${px(geometry.crop.w, "x")}v${px(geometry.crop.h, "y")}h${-px(geometry.crop.w, "x")}Z`}
                  />
                )}
                {geometry.annotations.map((item, index) => {
                  const chosen = isSelected({ kind: "annotation", index });
                  if (item.type === "arrow") {
                    return (
                      <g key={`a-${index}`} className="text-blue" style={tint(item.colour)}>
                        <line
                          x1={px(item.from[0], "x")}
                          y1={px(item.from[1], "y")}
                          x2={px(item.to[0], "x")}
                          y2={px(item.to[1], "y")}
                          stroke="currentColor"
                          strokeWidth={Math.max(4, width / 260)}
                          strokeLinecap="round"
                          markerEnd={`url(#head-${step.id}-${item.colour ?? "accent"})`}
                          className="pointer-events-auto cursor-move"
                          onPointerDown={(event) =>
                            tool === "select" &&
                            begin(
                              event,
                              { mode: "move", start: pointAt(event), origin: geometry },
                              { kind: "annotation", index },
                            )
                          }
                        />
                        {chosen && (
                          <line
                            x1={px(item.from[0], "x")}
                            y1={px(item.from[1], "y")}
                            x2={px(item.to[0], "x")}
                            y2={px(item.to[1], "y")}
                            stroke="var(--amluto-cyan)"
                            strokeWidth={2}
                            strokeDasharray="6 6"
                          />
                        )}
                      </g>
                    );
                  }
                  if (item.type === "box") {
                    return (
                      <rect
                        key={`b-${index}`}
                        x={px(item.x, "x")}
                        y={px(item.y, "y")}
                        width={px(item.w, "x")}
                        height={px(item.h, "y")}
                        rx={6}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={Math.max(4, width / 300)}
                        style={tint(item.colour)}
                        className={`pointer-events-auto cursor-move text-blue ${chosen ? "stroke-cyan" : ""}`}
                        onPointerDown={(event) =>
                          tool === "select" &&
                          begin(
                            event,
                            { mode: "move", start: pointAt(event), origin: geometry },
                            { kind: "annotation", index },
                          )
                        }
                      />
                    );
                  }
                  return null;
                })}
                {geometry.highlight &&
                  (geometry.highlight.shape === "circle" ? (
                    <ellipse
                      cx={px(geometry.highlight.x + geometry.highlight.w / 2, "x")}
                      cy={px(geometry.highlight.y + geometry.highlight.h / 2, "y")}
                      rx={px(geometry.highlight.w / 2, "x")}
                      ry={px(geometry.highlight.h / 2, "y")}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={Math.max(4, width / 240)}
                      className="cursor-move text-highlight"
                      // The whole highlight can be picked up, not only its thin ring: it is small, and the
                      // natural place to press is inside it.
                      style={{ pointerEvents: "all" }}
                      onPointerDown={(event) =>
                        tool === "select" &&
                        begin(
                          event,
                          { mode: "move", start: pointAt(event), origin: geometry },
                          { kind: "highlight" },
                        )
                      }
                    />
                  ) : (
                    <rect
                      x={px(geometry.highlight.x, "x")}
                      y={px(geometry.highlight.y, "y")}
                      width={px(geometry.highlight.w, "x")}
                      height={px(geometry.highlight.h, "y")}
                      rx={6}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={Math.max(4, width / 240)}
                      className="cursor-move text-highlight"
                      // The whole highlight can be picked up, not only its thin ring: it is small, and the
                      // natural place to press is inside it.
                      style={{ pointerEvents: "all" }}
                      onPointerDown={(event) =>
                        tool === "select" &&
                        begin(
                          event,
                          { mode: "move", start: pointAt(event), origin: geometry },
                          { kind: "highlight" },
                        )
                      }
                    />
                  ))}
                {geometry.crop && !view && (
                  <rect
                    x={px(geometry.crop.x, "x")}
                    y={px(geometry.crop.y, "y")}
                    width={px(geometry.crop.w, "x")}
                    height={px(geometry.crop.h, "y")}
                    fill="transparent"
                    stroke="white"
                    strokeWidth={2}
                    strokeDasharray="8 6"
                    className={`cursor-move ${isSelected({ kind: "crop" }) ? "stroke-cyan" : ""}`}
                    // Drawn on top of everything, so its inside only takes the pointer once the crop
                    // is selected; otherwise the highlight, arrows and blur inside it couldn't be
                    // picked up. The edge below is where it is taken hold of.
                    style={{ pointerEvents: isSelected({ kind: "crop" }) ? "all" : "none" }}
                    onPointerDown={(event) =>
                      tool === "select" &&
                      begin(
                        event,
                        { mode: "move", start: pointAt(event), origin: geometry },
                        { kind: "crop" },
                      )
                    }
                  />
                )}
                {geometry.crop && !view && (
                  <rect
                    aria-hidden="true"
                    x={px(geometry.crop.x, "x")}
                    y={px(geometry.crop.y, "y")}
                    width={px(geometry.crop.w, "x")}
                    height={px(geometry.crop.h, "y")}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={Math.max(12, width / 90)}
                    className="cursor-move"
                    style={{ pointerEvents: "stroke" }}
                    onPointerDown={(event) =>
                      tool === "select" &&
                      begin(
                        event,
                        { mode: "move", start: pointAt(event), origin: geometry },
                        { kind: "crop" },
                      )
                    }
                  />
                )}
              </svg>

              {geometry.annotations.map((item, index) =>
                item.type === "label" ? (
                  // Keyboard: PageDown selects it, Enter edits it.
                  // eslint-disable-next-line jsx-a11y/no-static-element-interactions
                  <div
                    key={`l-${index}`}
                    onPointerDown={(event) =>
                      tool === "select" &&
                      begin(
                        event,
                        { mode: "move", start: pointAt(event), origin: geometry },
                        { kind: "annotation", index },
                      )
                    }
                    onDoubleClick={() =>
                      setLabelDraft({ x: item.x, y: item.y, text: item.text, index })
                    }
                    className={`absolute max-w-[45%] cursor-move rounded-md border-2 px-2 py-1 text-xs font-semibold shadow ${item.colour === "white" ? "bg-brand-navy text-white" : "bg-white text-brand-navy"} ${isSelected({ kind: "annotation", index }) ? "border-cyan" : "border-blue"}`}
                    style={{
                      left: pct(item.x),
                      top: pct(item.y),
                      ...(item.colour && !isSelected({ kind: "annotation", index })
                        ? { borderColor: MARK_COLOUR_HEX[item.colour] }
                        : {}),
                    }}
                  >
                    {item.text}
                  </div>
                ) : null,
              )}

              {geometry.crop?.source === "auto" && !view && (
                <span
                  className="pointer-events-none absolute rounded bg-brand-navy px-1.5 py-0.5 text-[11px] font-bold text-white"
                  style={{ left: pct(geometry.crop.x + 0.5), top: pct(geometry.crop.y + 0.5) }}
                >
                  {t("zoom.auto")}
                </span>
              )}
              {/* Resize handles for whatever is selected. */}
              {selected?.kind === "highlight" && geometry.highlight && (
                <Handle
                  className={handleClass}
                  left={pct(geometry.highlight.x + geometry.highlight.w)}
                  top={pct(geometry.highlight.y + geometry.highlight.h)}
                  onPointerDown={resizeFrom}
                />
              )}
              {selected?.kind === "crop" && geometry.crop && (
                <Handle
                  className={handleClass}
                  left={pct(geometry.crop.x + geometry.crop.w)}
                  top={pct(geometry.crop.y + geometry.crop.h)}
                  onPointerDown={resizeFrom}
                />
              )}
              {selectedRedaction && (
                <Handle
                  className={handleClass}
                  left={pct(selectedRedaction.x + selectedRedaction.w)}
                  top={pct(selectedRedaction.y + selectedRedaction.h)}
                  onPointerDown={resizeFrom}
                />
              )}
              {selectedAnnotation?.type === "box" && (
                <Handle
                  className={handleClass}
                  left={pct(selectedAnnotation.x + selectedAnnotation.w)}
                  top={pct(selectedAnnotation.y + selectedAnnotation.h)}
                  onPointerDown={resizeFrom}
                />
              )}
              {selectedAnnotation?.type === "arrow" && (
                <>
                  <Handle
                    className={handleClass}
                    left={pct(selectedAnnotation.from[0])}
                    top={pct(selectedAnnotation.from[1])}
                    onPointerDown={(event) =>
                      begin(event, { mode: "arrow-end", end: "from", origin: geometry }, selected)
                    }
                  />
                  <Handle
                    className={handleClass}
                    left={pct(selectedAnnotation.to[0])}
                    top={pct(selectedAnnotation.to[1])}
                    onPointerDown={(event) =>
                      begin(event, { mode: "arrow-end", end: "to", origin: geometry }, selected)
                    }
                  />
                </>
              )}

              {labelDraft && (
                <input
                  ref={(element) => element?.focus()}
                  aria-label={t("editor.image.labelText")}
                  value={labelDraft.text}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    setLabelDraft({ ...labelDraft, text: event.currentTarget.value })
                  }
                  onBlur={saveLabel}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") saveLabel();
                    if (event.key === "Escape") {
                      setLabelDraft(null);
                      onToolChange("select");
                    }
                  }}
                  placeholder={t("editor.image.labelPlaceholder")}
                  className="absolute z-30 w-56 rounded-md border-2 border-blue bg-white px-2 py-1 text-xs font-semibold text-brand-navy"
                  style={{ left: pct(labelDraft.x), top: pct(labelDraft.y) }}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {imageUrl && (
        <div
          role="group"
          aria-label={t("editor.zoom.label")}
          className="absolute bottom-2 left-2 z-30 flex items-center gap-0.5 rounded-lg border border-panel bg-background/95 p-0.5 shadow"
        >
          <button
            type="button"
            aria-label={t("editor.zoom.out")}
            title={t("editor.zoom.out")}
            disabled={zoom <= 1}
            onClick={() => zoomTo(zoom / ZOOM_STEP)}
            className="grid size-7 place-items-center rounded-md text-secondary hover:bg-subtle disabled:opacity-40"
          >
            <Icon name="minus" size={15} />
          </button>
          <button
            type="button"
            aria-label={t("editor.zoom.fit", { percent: Math.round(zoom * 100) })}
            title={t("editor.zoom.fit", { percent: Math.round(zoom * 100) })}
            onClick={() => zoomTo(1)}
            className="h-7 min-w-12 rounded-md px-1.5 text-xs font-semibold text-secondary tabular-nums hover:bg-subtle"
          >
            {zoom === 1 ? t("editor.zoom.fitted") : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            aria-label={t("editor.zoom.in")}
            title={t("editor.zoom.in")}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => zoomTo(zoom * ZOOM_STEP)}
            className="grid size-7 place-items-center rounded-md text-secondary hover:bg-subtle disabled:opacity-40"
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
      )}
      {imageUrl && crop && (
        <div className="absolute top-2 left-2 z-30 flex items-center gap-2">
          {view ? (
            <>
              <button
                type="button"
                className="btn h-8 px-3 shadow"
                onClick={() => {
                  setSelected({ kind: "crop" });
                  surface.current?.focus();
                }}
              >
                <Icon name="crop" size={15} />
                {t("editor.image.editCrop")}
              </button>
              {crop.source === "auto" && (
                <span className="rounded bg-brand-navy px-1.5 py-0.5 text-[11px] font-bold text-white">
                  {t("zoom.auto")}
                </span>
              )}
            </>
          ) : (
            selected?.kind === "crop" && (
              <button
                type="button"
                className="btn btn-primary h-8 px-3 shadow"
                onClick={() => {
                  setSelected(null);
                  surface.current?.focus();
                }}
              >
                <Icon name="check" size={15} />
                {t("editor.image.applyCrop")}
              </button>
            )
          )}
        </div>
      )}
      {imageUrl && tool === "select" && selected && (
        <PositionPanel
          key={JSON.stringify(selected)}
          values={fieldsOf(geometry, selected)}
          onSet={(field, value) =>
            commit(placed(geometry, selected, field, value), t("editor.undo.move"))
          }
          colour={selectedAnnotation ? (selectedAnnotation.colour ?? "accent") : null}
          onColour={(colour) => {
            if (selected.kind !== "annotation") return;
            commit(
              {
                ...geometry,
                annotations: geometry.annotations.map((item, index) =>
                  index === selected.index ? withColour(item, colour) : item,
                ),
              },
              t("editor.undo.colour"),
            );
          }}
        />
      )}
    </div>
  );
}

/**
 * The numeric position panel (docs/spec/04-editor.md#image-tools): the selected mark's position
 * and size as percentages of the screenshot. A number is applied on Enter or when leaving the
 * box, as one undo step.
 */
function PositionPanel({
  values,
  onSet,
  colour,
  onColour,
}: {
  values: Partial<Record<Field, number>> | null;
  onSet: (field: Field, value: number) => void;
  /** The selected arrow, box or label's colour; null for other marks, which have none. */
  colour: MarkColour | "accent" | null;
  onColour: (colour: MarkColour | "accent") => void;
}) {
  const { t } = useTranslation();
  if (!values) return null;
  const fields = (Object.keys(values) as Field[]).filter((field) => values[field] !== undefined);
  return (
    <div className="absolute right-2 bottom-2 z-30 flex flex-col items-end gap-1.5">
      {colour !== null && (
        <fieldset className="flex items-center gap-1.5 rounded-lg border border-panel bg-background/95 px-2.5 py-1.5 shadow">
          <legend className="sr-only">{t("editor.image.colour")}</legend>
          {(["accent", ...MARK_COLOURS] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={colour === option}
              aria-label={t(`editor.image.colours.${option}`)}
              title={t(`editor.image.colours.${option}`)}
              onClick={() => onColour(option)}
              className={`size-6 rounded-full border-2 ${option === "accent" ? "bg-blue" : ""} ${colour === option ? "border-brand-navy ring-2 ring-cyan" : "border-line"}`}
              style={option === "accent" ? undefined : { backgroundColor: MARK_COLOUR_HEX[option] }}
            />
          ))}
        </fieldset>
      )}
      <fieldset className="flex flex-wrap gap-2 rounded-lg border border-panel bg-background/95 px-2.5 py-2 text-xs shadow">
        <legend className="sr-only">{t("editor.image.position")}</legend>
        {fields.map((field) => (
          <PositionField
            key={field}
            field={field}
            value={values[field] ?? 0}
            onSet={(value) => onSet(field, value)}
          />
        ))}
      </fieldset>
    </div>
  );
}

/** A mark with a new colour; the accent is the default, so it's stored as no colour. */
function withColour(item: Annotation, colour: MarkColour | "accent"): Annotation {
  const rest = { ...item };
  delete rest.colour;
  return colour === "accent" ? rest : { ...rest, colour };
}

/** An arrow or box drawn in its colour (it strokes with `currentColor`); the accent needs nothing. */
const tint = (colour: MarkColour | undefined) =>
  colour ? { color: MARK_COLOUR_HEX[colour] } : undefined;

/**
 * One number in the position panel. It shows the mark's current value (so arrow-key nudges show
 * up) except while being typed in, and applies on Enter without leaving the box, or on leaving
 * it. A width or height is at least 1%, since a mark of no size would vanish from the export.
 */
function PositionField({
  field,
  value,
  onSet,
}: {
  field: Field;
  value: number;
  onSet: (value: number) => void;
}) {
  const { t } = useTranslation();
  const shown = String(Math.round(value * 100) / 100);
  const [typing, setTyping] = useState<string | null>(null);
  const size = field === "w" || field === "h";
  const apply = () => {
    if (typing === null) return;
    const typed = Number(typing);
    setTyping(null);
    if (typing.trim() === "" || !Number.isFinite(typed)) return;
    const next = Math.max(size ? 1 : -50, Math.min(150, typed));
    if (next !== value) onSet(next);
  };
  return (
    <label className="flex items-center gap-1 text-secondary">
      {t(`editor.image.fields.${field}`)}
      <input
        type="number"
        step={0.5}
        min={size ? 1 : -50}
        max={150}
        value={typing ?? shown}
        onChange={(event) => setTyping(event.currentTarget.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") apply();
          if (event.key === "Escape") setTyping(null);
        }}
        onBlur={apply}
        className="field h-7 w-16 px-1.5 text-xs"
      />
    </label>
  );
}

/** A square resize handle on the selected mark (keyboard users resize with Shift+arrows). */
function Handle({
  left,
  top,
  className,
  onPointerDown,
}: {
  left: string;
  top: string;
  className: string;
  onPointerDown: (event: PointerEvent) => void;
}) {
  return (
    <span
      aria-hidden="true"
      onPointerDown={onPointerDown}
      className={className}
      style={{ left, top }}
    />
  );
}
