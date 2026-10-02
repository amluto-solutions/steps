import { defineContentScript } from "wxt/utils/define-content-script";

import {
  editedText,
  editingHost,
  inView,
  isSensitive,
  meantElement,
  stepTarget,
  typedPart,
} from "../capture/element";
import {
  RELAY_KEY,
  frameFor,
  frameViewStart,
  isRelay,
  type FrameHop,
  type FramePointer,
} from "../capture/frames";
import { browserMeasure, pageText } from "../capture/page-text";

/**
 * The capture script (docs/spec/02-capture.md#chrome-edition). It's only put into pages while a
 * recording runs, in every frame, and takes itself out when told the recording has stopped. It
 * reports what was clicked, as the pointer goes down and before the page reacts, and fields and
 * editors left after typing; the background does the rest. It never reads a secret field's
 * value, and the words it sends for blur suggestions are the page's text only, never what's in
 * a field or an editor.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  registration: "runtime",
  runAt: "document_start",
  allFrames: true,
  matchOriginAsFallback: true,
  main() {
    const flag = "__stepsCapture";
    const page = globalThis as unknown as Record<string, unknown>;
    // Put in by registration and by injection into open tabs: only one copy listens.
    if (page[flag]) return;
    page[flag] = true;

    const isTop = window === window.top;
    // With the frame's own origin: a blank, srcdoc or blob: frame has no site in its address, but
    // inherits the origin of the site that made it, and excluded sites are checked against it.
    const send = (message: object) => {
      chrome.runtime.sendMessage({ ...message, origin: globalThis.origin }).catch(() => undefined);
    };
    const percent = (value: number, total: number) => Math.round((value / total) * 10_000) / 100;
    const viewport = () => ({ width: innerWidth, height: innerHeight });
    // Read before the page reacts, so the words match the screenshot.
    const words = () => pageText(document, viewport(), browserMeasure(document));

    const onPointer = (event: PointerEvent) => {
      if (!event.isTrusted || event.button !== 0 || !(event.target instanceof Element)) return;
      const element = meantElement(event.target);
      const view = viewport();
      // When it happened, for Steps for Windows to tell which of its own clicks it was.
      const at = performance.timeOrigin + event.timeStamp;
      if (isTop) {
        send({
          type: "page:pointer",
          pointer: {
            at,
            target: stepTarget(element),
            clickPct: {
              x: percent(event.clientX, view.width),
              y: percent(event.clientY, view.height),
            },
            elementPct: inView(element.getBoundingClientRect(), view),
            scale: devicePixelRatio,
            text: words(),
          },
        });
        return;
      }
      // In a frame: what was clicked goes to the background now, and a token goes up through
      // the frames around this one so each can say where it is (capture/frames.ts).
      const token = crypto.randomUUID();
      const box = element.getBoundingClientRect();
      const pointer: FramePointer = {
        at,
        target: stepTarget(element),
        click: { x: event.clientX, y: event.clientY },
        element: { left: box.left, top: box.top, width: box.width, height: box.height },
        viewport: view,
        scale: devicePixelRatio,
        text: words(),
      };
      send({ type: "page:framePointer", token, pointer });
      window.parent.postMessage({ [RELAY_KEY]: token }, "*");
    };

    /**
     * A token from a frame in this page: say where that frame starts, measured here, and pass the
     * token on. The origin is the browser's, so the background can check the message came from
     * the frame the click was in, not one the page made to pass it on.
     */
    const onRelay = (event: MessageEvent) => {
      if (!isRelay(event.data)) return;
      const frame = frameFor(document, event.source, openShadow);
      if (!frame) return;
      const token = event.data[RELAY_KEY];
      const childFrameId = frameIdOf?.(event.source);
      const hop: FrameHop = {
        childOrigin: event.origin,
        ...(childFrameId === undefined ? {} : { childFrameId }),
        offset: frameViewStart(frame),
        ...(isTop ? { top: { viewport: viewport(), text: words() } } : {}),
      };
      send({ type: "page:frameHop", token, hop });
      if (!isTop) window.parent.postMessage({ [RELAY_KEY]: token }, "*");
    };

    /** Firefox's way to name the frame a message came from; Chrome has none (`recorder/frames.ts`). */
    const getFrameId = (chrome.runtime as { getFrameId?: (target: unknown) => number }).getFrameId;
    const frameIdOf = getFrameId
      ? (source: MessageEventSource | null) => {
          try {
            return getFrameId(source);
          } catch {
            return undefined;
          }
        }
      : undefined;

    /** A shadow root, closed ones too: Chrome's `dom` API, or Firefox's own method. */
    const openShadow = (element: Element): ShadowRoot | null => {
      const firefoxShadow = (element as { openOrClosedShadowRoot?: () => ShadowRoot | null })
        .openOrClosedShadowRoot;
      if (firefoxShadow) return firefoxShadow.call(element);
      return chrome.dom?.openOrClosedShadowRoot(element as HTMLElement) ?? element.shadowRoot;
    };

    const reportInput = (field: Element, value: string) => {
      const sensitive = isSensitive(field);
      send({
        type: "page:input",
        input: { target: stepTarget(field), value: sensitive ? null : value, sensitive },
      });
    };

    const onChange = (event: Event) => {
      const field = event.target;
      if (
        !event.isTrusted ||
        !(
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        )
      )
        return;
      if (
        field instanceof HTMLInputElement &&
        ["checkbox", "radio", "submit", "button", "file"].includes(field.type)
      )
        return;
      reportInput(
        field,
        field instanceof HTMLSelectElement
          ? (field.selectedOptions[0]?.text ?? field.value)
          : field.value,
      );
    };

    // Rich-text editors have no `change` event: what they hold is compared as focus arrives and
    // leaves. Only the person's own typing or pasting counts (the browser marks it trusted), so
    // a page filling in a signature or a saved draft isn't taken for typing.
    let editing: { host: HTMLElement; before: string; typed: boolean } | null = null;
    const leaveEditor = () => {
      const was = editing;
      editing = null;
      if (!was?.typed) return;
      const typed = typedPart(was.before, editedText(was.host));
      if (typed) reportInput(was.host, typed);
    };
    const onFocusIn = (event: FocusEvent) => {
      const host = event.target instanceof Element ? editingHost(event.target) : null;
      if (host === editing?.host) return;
      leaveEditor();
      if (host) editing = { host, before: editedText(host), typed: false };
    };
    const onEdit = (event: Event) => {
      if (event.isTrusted && editing && event.target instanceof Node)
        if (editing.host.contains(event.target)) editing.typed = true;
    };
    const onFocusOut = (event: FocusEvent) => {
      // Moving between the editor's own parts (a table cell, a list) isn't leaving it.
      const next = event.relatedTarget;
      if (editing && next instanceof Node && editing.host.contains(next)) return;
      leaveEditor();
    };

    addEventListener("pointerdown", onPointer, { capture: true });
    addEventListener("change", onChange, { capture: true });
    addEventListener("focusin", onFocusIn, { capture: true });
    addEventListener("focusout", onFocusOut, { capture: true });
    addEventListener("input", onEdit, { capture: true });
    addEventListener("message", onRelay);
    chrome.runtime.onMessage.addListener((message: { type?: string }) => {
      if (message.type !== "capture:off") return;
      removeEventListener("pointerdown", onPointer, { capture: true });
      removeEventListener("change", onChange, { capture: true });
      removeEventListener("focusin", onFocusIn, { capture: true });
      removeEventListener("focusout", onFocusOut, { capture: true });
      removeEventListener("input", onEdit, { capture: true });
      removeEventListener("message", onRelay);
      editing = null;
      page[flag] = false;
    });
  },
});
