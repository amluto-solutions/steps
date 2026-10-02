/**
 * Tagged PDF (docs/spec/05-export.md#tagged-pdf): what each line and picture is, for screen
 * readers and anything else that reads a PDF's structure rather than its look.
 *
 * pdfmake lays a guide out and has pdfkit draw it, but it never tells pdfkit what anything is.
 * So the tagging is done in two halves:
 *
 * - **Before layout**, `tagDefinition` reads hints the PDF definition puts on its nodes (`tag`,
 *   `tagGroup`, `tagAlt`…) and writes each text node's tag into its text items, which pdfmake
 *   copies onto every word of every line it lays out, and each picture's onto the picture.
 * - **While drawing**, a wrapper around the pdfkit document pdfmake draws on opens marked content
 *   for each item as it's drawn (the progress callback says when one ends) and builds the
 *   structure tree from the tags: a paragraph running over several lines or pages is one element.
 *   Headers, footers, lines and boxes are artifacts. A link is a `Link` element holding its words
 *   and its annotation.
 */

import type { Content } from "pdfmake/interfaces";

/** What a line, picture or piece of decoration is. */
export interface PdfTag {
  /** A structure type (`H1`, `P`, `Figure`, `TD`…), or null for decoration (an artifact). */
  type: string | null;
  /** Everything with one key is one element: a paragraph over several lines, a heading in two parts. */
  key: string;
  /** The elements around it, outermost first (a table and its row, a list and its item). */
  parents: TagParent[];
  alt?: string;
  /** A header cell's scope. */
  scope?: "Row" | "Column";
  /** For decoration: page furniture (headers and footers) or layout. */
  artifact?: "Pagination" | "Layout";
}

export interface TagParent {
  type: string;
  key: string;
}

/**
 * Hints on a PDF definition node, read by `tagDefinition`:
 * - `tag`: a text node's structure type (a paragraph, `P`, when left out);
 * - `tagKey`: text nodes that share one make one element;
 * - `tagGroup`: the node's children go inside an element of this type (`L`, `LI`, `LBody`…);
 * - `tagTable`: a table of data (a `Table`, `TR` for each row, `TH`/`TD` for each cell), unlike
 *   the tables used for layout, which add nothing;
 * - `tagScope`: a header cell's scope;
 * - `tagAlt`: a picture's alternative text; a picture without one is decoration;
 * - `tagArtifact`: everything inside is decoration.
 */
export interface TagHints {
  tag?: string;
  tagKey?: string;
  tagGroup?: string;
  tagTable?: boolean;
  tagScope?: "Row" | "Column";
  tagAlt?: string;
  tagArtifact?: "Pagination" | "Layout";
}

// The hints go on any pdfmake content node.
declare module "pdfmake/interfaces" {
  interface ContentBase {
    tag?: string;
    tagKey?: string;
    tagGroup?: string;
    tagTable?: boolean;
    tagScope?: "Row" | "Column";
    tagAlt?: string;
    tagArtifact?: "Pagination" | "Layout";
  }
}

type Node = Record<string, unknown> & TagHints;

export interface TagContext {
  parents: TagParent[];
  /** Inside a table cell: the cell's type and key, which its text takes. */
  cell?: { type: string; key: string; scope?: "Row" | "Column" };
  artifact?: "Pagination" | "Layout";
}

const HINTS = ["tag", "tagKey", "tagGroup", "tagTable", "tagScope", "tagAlt", "tagArtifact"];

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The text a node's text items hold, to tell text from an empty spacer. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isNode(value)) return textOf(value.text);
  return "";
}

/** A text node's items, each carrying the tag (pdfmake copies an item's own fields onto its words). */
function tagText(text: unknown, tag: PdfTag): unknown[] {
  // Each item keeps its own text: pdfmake flattens an item whose text is an array into the
  // array's items, dropping the item's bold, italics and link.
  const item = (value: unknown): unknown =>
    isNode(value)
      ? Array.isArray(value.text)
        ? { ...value, text: value.text.map(item), _tag: tag }
        : { ...value, _tag: tag }
      : { text: typeof value === "string" ? value : String(value ?? ""), _tag: tag };
  return (Array.isArray(text) ? text : [text]).map(item);
}

/**
 * Writes the tags into a PDF definition's content, following its hints (see `TagHints`), and
 * removes the hints. `newKey` numbers the elements.
 */
export function tagDefinition(
  content: Content,
  newKey: () => string,
  context: TagContext = { parents: [] },
): Content {
  const walk = (value: unknown, current: TagContext): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, current));
    if (typeof value === "string" || typeof value === "number")
      return walk({ text: String(value) }, current);
    if (!isNode(value)) return value;

    // The node without its hints, which pdfmake doesn't know.
    const node: Node = Object.fromEntries(
      Object.entries(value).filter(([field]) => !HINTS.includes(field)),
    );
    let inner: TagContext = current;
    if (value.tagArtifact) inner = { ...inner, artifact: value.tagArtifact };
    if (value.tagGroup && !inner.artifact)
      inner = { ...inner, parents: [...inner.parents, { type: value.tagGroup, key: newKey() }] };

    if ("text" in node) {
      const words = textOf(node.text);
      const tag: PdfTag =
        inner.artifact || !words.trim()
          ? { type: null, key: newKey(), parents: [], artifact: inner.artifact ?? "Layout" }
          : inner.cell
            ? {
                type: inner.cell.type,
                key: inner.cell.key,
                parents: inner.parents,
                ...(inner.cell.scope ? { scope: inner.cell.scope } : {}),
              }
            : {
                type: value.tag ?? "P",
                key: value.tagKey ?? newKey(),
                parents: inner.parents,
                ...(value.tagScope ? { scope: value.tagScope } : {}),
              };
      node.text = tagText(node.text, tag);
      return node;
    }
    if ("image" in node) {
      node._tag =
        value.tagAlt && !inner.artifact
          ? { type: "Figure", key: newKey(), parents: inner.parents, alt: value.tagAlt }
          : { type: null, key: newKey(), parents: [], artifact: inner.artifact ?? "Layout" };
      return node;
    }
    for (const list of ["stack", "columns", "ul", "ol"])
      if (Array.isArray(node[list])) node[list] = walk(node[list], inner);
    if (isNode(node.table) && Array.isArray(node.table.body)) {
      const table = node.table;
      const body = table.body as unknown[][];
      if (value.tagTable && !inner.artifact) {
        const tableParent: TagParent = { type: "Table", key: newKey() };
        const headerRows = typeof table.headerRows === "number" ? table.headerRows : 0;
        table.body = body.map((row, index) => {
          const rowParents = [...inner.parents, tableParent, { type: "TR", key: newKey() }];
          return row.map((cell) => {
            const hinted = isNode(cell) ? cell : {};
            const header = index < headerRows || hinted.tag === "TH";
            const scope: "Row" | "Column" | undefined =
              hinted.tagScope ?? (index < headerRows ? "Column" : undefined);
            return walk(cell, {
              parents: rowParents,
              cell: {
                type: header ? "TH" : "TD",
                key: newKey(),
                ...(header && scope ? { scope } : {}),
              },
            });
          });
        });
      } else table.body = body.map((row) => row.map((cell) => walk(cell, inner)));
    }
    return node;
  };
  return walk(content, context) as Content;
}

// ---------- drawing ----------

/** pdfkit's structure elements and contents, as far as this uses them. */
interface StructElement {
  add(child: unknown): StructElement;
}
interface TaggableDocument {
  _pdfMakePages?: { items: { type: string; item: Record<string, unknown> }[] }[];
  _currentStructureElement?: StructElement | null;
  __stepsTags?: Drawing;
  __stepsLink?: { element: StructElement; text: string } | null;
  struct(type: string, options?: Record<string, unknown>): StructElement;
  addStructure(element: StructElement): unknown;
  markContent(tag: string, options?: Record<string, unknown> | null): unknown;
  markStructureContent(tag: string, options?: Record<string, unknown>): unknown;
  endMarkedContent(): unknown;
}

type Open =
  { artifact: true } | { artifact: false; element: StructElement; content: unknown; type: string };

interface Drawing {
  root: StructElement | null;
  elements: Map<string, StructElement>;
  /** The last tag drawn, for the few lines pdfmake makes without one (a page number reference). */
  previous: PdfTag | null;
  page: number;
  item: number;
  open: Open | null;
  keys: number;
}

/** A drawing waiting for its document; the document being drawn. One at a time (see `tagged`). */
let arming: Drawing | null = null;
let drawing: { doc: TaggableDocument; state: Drawing } | null = null;

function elementFor(doc: TaggableDocument, state: Drawing, tag: PdfTag): StructElement {
  if (!state.root) {
    state.root = doc.struct("Document");
    doc.addStructure(state.root);
  }
  let parent = state.root;
  for (const each of tag.parents) {
    let found = state.elements.get(each.key);
    if (!found) {
      found = doc.struct(each.type);
      parent.add(found);
      state.elements.set(each.key, found);
    }
    parent = found;
  }
  let element = state.elements.get(tag.key);
  if (!element) {
    element = doc.struct(tag.type ?? "P", {
      ...(tag.alt ? { alt: tag.alt } : {}),
      ...(tag.scope ? { scope: tag.scope } : {}),
    });
    parent.add(element);
    state.elements.set(tag.key, element);
  }
  return element;
}

/** A line pdfmake made itself, with no tag: a cell like the one before it, else a paragraph. */
function fallback(state: Drawing): PdfTag {
  state.keys += 1;
  const previous = state.previous;
  const key = `untagged-${state.keys}`;
  if (previous?.type === "TD" || previous?.type === "TH")
    return { type: "TD", key, parents: previous.parents };
  return { type: "P", key, parents: previous?.parents ?? [] };
}

/** Opens the marked content for the item about to be drawn. */
function open(doc: TaggableDocument, state: Drawing) {
  const item = doc._pdfMakePages?.[state.page]?.items[state.item];
  if (!item) return;
  let tag: PdfTag | null = null;
  if (item.type === "line") {
    const inlines = item.item.inlines as { _tag?: PdfTag }[] | undefined;
    tag = inlines?.find((inline) => inline._tag)?._tag ?? fallback(state);
  } else if (item.type === "image")
    tag = (item.item._tag as PdfTag | undefined) ?? {
      type: null,
      key: "",
      parents: [],
      artifact: "Layout",
    };
  else if (item.type === "vector" || item.type === "svg")
    tag = { type: null, key: "", parents: [], artifact: "Layout" };
  if (!tag) return;
  if (tag.type === null) {
    doc.markContent("Artifact", { type: tag.artifact ?? "Layout" });
    state.open = { artifact: true };
    return;
  }
  const element = elementFor(doc, state, tag);
  state.open = {
    artifact: false,
    element,
    content: doc.markStructureContent(tag.type),
    type: tag.type,
  };
  state.previous = tag;
}

function close(doc: TaggableDocument, state: Drawing) {
  const current = state.open;
  if (!current) return;
  doc.endMarkedContent();
  if (!current.artifact) current.element.add(current.content);
  state.open = null;
}

/** Called by pdfmake after each item it draws. */
function itemDone() {
  if (!drawing) return;
  const { doc, state } = drawing;
  close(doc, state);
  state.item += 1;
  open(doc, state);
}

type Method = (this: TaggableDocument, ...args: unknown[]) => unknown;

/** Wraps the drawing methods pdfmake's renderer calls, for documents being tagged only. */
function wrap(prototype: Record<string, unknown>) {
  if (prototype.__stepsTagging) return;
  prototype.__stepsTagging = true;
  const addPage = prototype.addPage as Method;
  const text = prototype.text as Method;
  const goTo = prototype.goTo as Method;
  const link = prototype.link as Method;

  prototype.addPage = function (this: TaggableDocument, ...args: unknown[]) {
    if (!this.__stepsTags && arming && this._pdfMakePages) {
      this.__stepsTags = arming;
      drawing = { doc: this, state: arming };
      arming = null;
    }
    const state = this.__stepsTags;
    if (state) close(this, state);
    const result = addPage.apply(this, args);
    if (state) {
      state.page += 1;
      state.item = 0;
      open(this, state);
    }
    return result;
  };

  // A link: its own Link element inside the paragraph, holding its words and its annotation.
  prototype.text = function (this: TaggableDocument, ...args: unknown[]) {
    const state = this.__stepsTags;
    const current = state?.open;
    const options = args[3] as { link?: unknown; goTo?: unknown } | undefined;
    if (!current || current.artifact || (options?.link == null && options?.goTo == null))
      return text.apply(this, args);
    this.endMarkedContent();
    current.element.add(current.content);
    const element = this.struct("Link");
    current.element.add(element);
    const content = this.markStructureContent("Link");
    const outer = this._currentStructureElement ?? null;
    // pdfkit puts a web link's annotation in the Link element it's drawing in; goTo, below,
    // does the same for a link to a place in the guide.
    this._currentStructureElement = element;
    this.__stepsLink = { element, text: String(args[0] ?? "") };
    try {
      return text.apply(this, args);
    } finally {
      this._currentStructureElement = outer;
      this.__stepsLink = null;
      this.endMarkedContent();
      element.add(content);
      current.content = this.markStructureContent(current.type);
    }
  };

  const described = (doc: TaggableDocument, options: unknown) => {
    const found = doc.__stepsLink;
    const given = (options ?? {}) as Record<string, unknown>;
    // A link's annotation says what it is: its words.
    return found ? { ...given, Contents: new String(found.text) } : given;
  };
  prototype.goTo = function (this: TaggableDocument, ...args: unknown[]) {
    const found = this.__stepsLink;
    const options = described(this, args[5]);
    return goTo.apply(this, [
      ...args.slice(0, 5),
      found ? { ...options, structParent: found.element } : options,
    ]);
  };
  prototype.link = function (this: TaggableDocument, ...args: unknown[]) {
    return link.apply(this, [...args.slice(0, 5), described(this, args[5])]);
  };
}

export interface PdfMakeLike {
  createPdf(definition: Record<string, unknown>): {
    getStream(): Promise<unknown>;
    getBuffer(): Promise<unknown>;
  };
  /** Called after each item pdfmake draws (it ignores one passed to `createPdf`). */
  setProgressCallback(callback: (progress: number) => void): void;
}

let ready: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Builds a tagged PDF: `definition` (already through `tagDefinition`) drawn with its marked
 * content and structure tree. The drawing methods are wrapped once, on the class of the document
 * pdfmake draws on, reached through a tiny document; an untagged document is drawn as before.
 * One is drawn at a time, as the wrapper follows the document being drawn.
 */
export function tagged(
  pdfmake: PdfMakeLike,
  definition: Record<string, unknown>,
): Promise<unknown> {
  ready ??= pdfmake
    .createPdf({ content: [], defaultStyle: { font: "Body" } })
    .getStream()
    .then((doc) => {
      wrap(Object.getPrototypeOf(doc) as Record<string, unknown>);
      // Only does anything while a tagged document is being drawn.
      pdfmake.setProgressCallback(() => itemDone());
    });
  const run = async () => {
    await ready;
    arming = {
      root: null,
      elements: new Map(),
      previous: null,
      page: -1,
      item: 0,
      open: null,
      keys: 0,
    };
    try {
      const output = pdfmake.createPdf({ ...definition, tagged: true });
      await output.getStream();
      const current = drawing;
      if (current) close(current.doc, current.state);
      arming = null;
      drawing = null;
      return await output.getBuffer();
    } finally {
      arming = null;
      drawing = null;
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}
