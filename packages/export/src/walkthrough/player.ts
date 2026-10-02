import type { StepMotion } from "../model";

/** What the player needs about each item; everything it shows is already in the static view. */
export interface PlayerItem {
  kind: "step" | "block";
  /** Index into the static view's `[data-index]` elements. */
  index: number;
  number?: number;
  text?: string;
  alt?: string;
  /** Words to read, for the pause when playing. */
  words: number;
  /** Output image size in pixels, 0 when there is no screenshot. */
  width: number;
  height: number;
  /** Where the cursor goes, as percentages of the image. */
  click: { x: number; y: number } | null;
  /**
   * A smart-zoom step: the image is a slightly wider view, and the camera eases into this box
   * (percentages of the image), where it rests.
   */
  camera?: { x: number; y: number; w: number; h: number } | null;
  type?: string;
  /** What to animate for this kind of step: typed text, key caps, a web address or an app. */
  motion?: StepMotion | null;
  heading?: string;
  /** A coloured-box block's kind, for its colours. */
  callout?: string;
}

export interface PlayerData {
  title: string;
  stepCount: number;
  labels: Record<string, string>;
  items: PlayerItem[];
  /** With more than one language: the page's own, every one it has, and the others' words. */
  language?: string;
  languages?: { code: string; name: string }[];
  translations?: Record<string, PlayerData>;
}

/**
 * The interactive walkthrough player (docs/spec/05-export.md#interactive-walkthrough-html).
 *
 * This function is copied into each exported file as source text (`playerMain.toString()`), so it
 * must stay self-contained: no imports and nothing from outside it, only DOM globals. It reads the
 * guide from the page's JSON block and reuses the static "All steps" view for screenshots, marks
 * and notes (so each is in the file once, and nothing is parsed as HTML here). Without JavaScript
 * the static view is all there is, and it is also what prints.
 */
export function playerMain(): void {
  const dataElement = document.getElementById("guide-data");
  const root = document.getElementById("player");
  const staticView = document.getElementById("static");
  if (!dataElement || !root || !staticView) return;
  const pageData = JSON.parse(dataElement.textContent || "{}") as PlayerData;

  // ----- Language (docs/spec/05-export.md#languages) -----
  // Asked for in the address (?lang=de, which the picker below sets), else the viewer's browser
  // language when the page has it, else the page's own.
  const languages = pageData.languages ?? [];
  const has = (code: string) => languages.some((item) => item.code === code);
  const closest = (tag: string): string | null => {
    const lower = tag.toLowerCase();
    const exact = languages.find((item) => item.code.toLowerCase() === lower);
    if (exact) return exact.code;
    const [base = "", ...rest] = lower.split("-");
    const sub = new Set(rest);
    const named =
      base === "zh"
        ? sub.has("hant") || sub.has("tw") || sub.has("hk")
          ? "zh-Hant"
          : "zh-Hans"
        : base === "pt"
          ? sub.has("pt")
            ? "pt-PT"
            : "pt-BR"
          : base === "sr"
            ? sub.has("latn")
              ? "sr-Latn"
              : "sr-Cyrl"
            : base === "no" || base === "nn"
              ? "nb"
              : base === "en"
                ? "en-GB"
                : base;
    if (has(named)) return named;
    return languages.find((item) => item.code.toLowerCase().split("-")[0] === base)?.code ?? null;
  };
  const asked = new URLSearchParams(location.search).get("lang");
  const chosen =
    (asked && has(asked) ? asked : null) ??
    (navigator.languages ?? [navigator.language]).map(closest).find(Boolean) ??
    pageData.language ??
    "";
  let data = pageData;
  const layer = chosen !== pageData.language ? pageData.translations?.[chosen] : undefined;
  const template = document.getElementById(`wt-lang-${chosen}`);
  if (layer && template instanceof HTMLTemplateElement) {
    // The page's screenshots move into the other language's view: each is in the file once.
    const figures = new Map<string, Element>();
    staticView.querySelectorAll("figure.wt-figure").forEach((figure) => {
      const index = figure.closest("[data-index]")?.getAttribute("data-index");
      if (index) figures.set(index, figure);
    });
    staticView.replaceChildren(template.content.cloneNode(true));
    staticView.querySelectorAll("[data-figure]").forEach((slot) => {
      const figure = figures.get(slot.getAttribute("data-figure") ?? "");
      if (figure) slot.replaceWith(figure);
      else slot.remove();
    });
    data = layer;
    document.documentElement.lang = chosen;
    document.title = layer.title;
  }
  const label = (key: string, values: Record<string, string | number> = {}) =>
    (data.labels[key] || key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(values[name] ?? ""),
    );
  const staticItem = (index: number) =>
    staticView.querySelector<HTMLElement>(`[data-index="${index}"]`);

  type Screen = { kind: "intro" } | { kind: "finish" } | { kind: "item"; item: PlayerItem };
  const screens: Screen[] = [
    { kind: "intro" },
    ...data.items.map((item): Screen => ({ kind: "item", item })),
    { kind: "finish" },
  ];

  const reduceQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)")
      : null;
  let reduce = reduceQuery?.matches ?? false;
  let current = -1;
  let playing = false;
  let speed = 1;
  let timer: number | undefined;
  let lastClick: { x: number; y: number } | null = null;
  let typing: number | undefined;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text: string, className: string, onClick: () => void, aria?: string) => {
    const node = el("button", className, text);
    node.type = "button";
    if (aria) node.setAttribute("aria-label", aria);
    node.addEventListener("click", onClick);
    return node;
  };
  const cloneOf = (selector: string, from: ParentNode | null = staticView) => {
    const found = from?.querySelector(selector);
    return found ? (found.cloneNode(true) as HTMLElement) : null;
  };
  /** Restarts a CSS animation by taking the class off and putting it back. */
  const replay = (node: Element, className: string) => {
    node.classList.remove(className);
    void (node as HTMLElement).getBoundingClientRect();
    if (!reduce) node.classList.add(className);
  };

  // ----- Copy on code blocks -----
  // The buttons are in the static view (and copied into the player's cards), hidden until this
  // script runs. One listener serves them all.
  staticView.querySelectorAll<HTMLElement>(".wt-copy").forEach((copy) => {
    copy.hidden = false;
  });
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A page opened from disk may not have the clipboard API: select and copy instead.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
  };
  document.addEventListener("click", (event) => {
    const copy = event.target instanceof Element ? event.target.closest(".wt-copy") : null;
    if (!(copy instanceof HTMLElement)) return;
    // The output's Copy sits in its summary: copying mustn't fold it away.
    event.preventDefault();
    const text = copy.closest(".wt-code, .wt-output")?.querySelector("pre")?.textContent ?? "";
    void copyText(text).then(() => {
      copy.textContent = label("copied");
      window.setTimeout(() => {
        copy.textContent = label("copy");
      }, 1500);
    });
  });
  // Printing shows each command's output, folded or not.
  window.addEventListener("beforeprint", () => {
    document.querySelectorAll(".wt-output details").forEach((details) => {
      details.setAttribute("open", "");
    });
  });

  // ----- Layout -----
  const header = el("header", "wt-header");
  const logo = cloneOf(".wt-logo");
  if (logo) header.append(logo);
  header.append(el("p", "wt-title", data.title));
  const tools = el("div", "wt-tools");
  const playButton = button(label("play"), "wt-button", () => (playing ? stop() : play()));
  playButton.setAttribute("aria-pressed", "false");
  const speedSelect = el("select", "wt-select");
  speedSelect.setAttribute("aria-label", label("speed"));
  for (const value of [0.75, 1, 1.5]) {
    const option = el("option", undefined, `${value}×`);
    option.value = String(value);
    option.selected = value === 1;
    speedSelect.append(option);
  }
  speedSelect.addEventListener("change", () => {
    speed = Number(speedSelect.value) || 1;
    if (playing) schedule();
  });
  const motionButton = button(label("reduceMotion"), "wt-button", () => setReduce(!reduce));
  const allButton = button(label("allSteps"), "wt-button", () => showStatic(true));
  const fullButton = button(label("fullScreen"), "wt-button", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  });
  // The thumbnail strip: every step's screenshot, to jump straight to one.
  const strip = el("nav", "wt-strip");
  strip.setAttribute("aria-label", label("thumbnails"));
  strip.hidden = true;
  const stripButton = button(label("thumbnails"), "wt-button", () => {
    strip.hidden = !strip.hidden;
    stripButton.setAttribute("aria-expanded", String(!strip.hidden));
    strip
      .querySelector<HTMLElement>(".wt-thumb.wt-active")
      ?.scrollIntoView?.({ inline: "nearest" });
  });
  stripButton.setAttribute("aria-expanded", "false");
  tools.append(playButton, speedSelect, stripButton, motionButton, allButton, fullButton);
  if (languages.length > 1) {
    // Another language reloads the page in it, on the same step.
    const languageSelect = el("select", "wt-select");
    languageSelect.setAttribute("aria-label", label("language"));
    for (const item of languages) {
      const option = el("option", undefined, item.name);
      option.value = item.code;
      option.lang = item.code;
      option.selected = item.code === (layer ? chosen : pageData.language);
      languageSelect.append(option);
    }
    languageSelect.addEventListener("change", () => {
      const search = new URLSearchParams(location.search);
      search.set("lang", languageSelect.value);
      location.href = `${location.pathname}?${search.toString()}${location.hash}`;
    });
    tools.prepend(languageSelect);
  }
  header.append(tools);

  const main = el("main", "wt-main");
  const stage = el("div", "wt-stage");
  const frame = el("div", "wt-frame");
  // The picture and its marks move together with the camera; the cursor stays on top, where the
  // click is once the camera has arrived.
  const camera = el("div", "wt-camera");
  const image = el("img", "wt-image");
  image.alt = "";
  const marks = el("div", "wt-marks");
  camera.append(image, marks);
  const cursor = el("div", "wt-cursor");
  cursor.setAttribute("aria-hidden", "true");
  const ripple = el("div", "wt-ripple");
  ripple.setAttribute("aria-hidden", "true");
  frame.append(camera, ripple, cursor);
  stage.append(frame);
  const card = el("section", "wt-card");
  card.setAttribute("aria-label", label("stepCard"));
  main.append(stage, card);

  const footer = el("footer", "wt-footer");
  const back = button(label("back"), "wt-button wt-nav", () => go(current - 1));
  const next = button(label("next"), "wt-button wt-nav wt-primary", () => go(current + 1));
  const progress = el("div", "wt-progress");
  const bar = el("div", "wt-bar");
  const fill = el("div", "wt-fill");
  bar.append(fill);
  // While playing, a second, thinner bar fills over each screen's time, so it's clear when the
  // next one is coming.
  const countdown = el("div", "wt-countdown");
  const countdownFill = el("div", "wt-countdown-fill");
  countdown.append(countdownFill);
  countdown.setAttribute("aria-hidden", "true");
  countdown.hidden = true;
  const percent = el("span", "wt-percent");
  const barRow = el("div", "wt-bar-row");
  barRow.append(bar, percent);
  const dots = el("div", "wt-dots");
  screens.forEach((screen, index) => {
    if (screen.kind !== "item" || screen.item.kind !== "step") return;
    const dot = button(
      "",
      "wt-dot",
      () => go(index),
      label("goToStep", { number: screen.item.number ?? 0 }),
    );
    dot.dataset.screen = String(index);
    dots.append(dot);
  });
  progress.append(barRow, countdown, dots);
  footer.append(back, progress, next);
  const announcer = el("div", "wt-sr");
  announcer.setAttribute("role", "status");
  announcer.setAttribute("aria-live", "polite");
  screens.forEach((screen, index) => {
    if (screen.kind !== "item" || screen.item.kind !== "step") return;
    const thumb = button(
      "",
      "wt-thumb",
      () => go(index),
      label("goToStep", { number: screen.item.number ?? 0 }),
    );
    thumb.dataset.screen = String(index);
    const shot = staticItem(screen.item.index)?.querySelector<HTMLImageElement>("img.wt-shot");
    if (shot) {
      const picture = el("img");
      picture.src = shot.src;
      picture.alt = "";
      picture.loading = "lazy";
      thumb.append(picture);
    }
    thumb.append(el("span", "wt-thumb-number", String(screen.item.number ?? "")));
    strip.append(thumb);
  });
  root.append(header, main, strip, footer, announcer);

  function setReduce(value: boolean) {
    reduce = value;
    motionButton.setAttribute("aria-pressed", String(reduce));
    root?.classList.toggle("wt-reduce", reduce);
  }
  setReduce(reduce);

  // ----- Showing a screen -----
  function showImage(item: PlayerItem | null) {
    const source = item && item.width > 0 ? staticItem(item.index) : null;
    const sourceImage = source?.querySelector<HTMLImageElement>("img.wt-shot");
    root?.classList.toggle("wt-no-image", !sourceImage);
    marks.replaceChildren();
    if (!item || !sourceImage) {
      cursor.classList.remove("wt-visible");
      lastClick = null;
      return;
    }
    image.src = sourceImage.src;
    image.alt = item.alt ?? "";
    // With a camera the frame has the crop's shape, which the wider view shares.
    const view = item.camera ?? null;
    const ratio = view ? (item.width * view.w) / (item.height * view.h) : item.width / item.height;
    frame.style.aspectRatio = String(ratio);
    frame.style.setProperty("--wt-ratio", String(ratio));
    camera.classList.remove("wt-moving");
    camera.style.transform = "none";
    if (view) {
      const rest = `scale(${100 / view.w}) translate(${-view.x}%, ${-view.y}%)`;
      if (!reduce) {
        void camera.getBoundingClientRect();
        camera.classList.add("wt-moving");
      }
      camera.style.transform = rest;
    }
    replay(frame, "wt-fade");
    const overlay = cloneOf("svg.wt-overlay", source);
    if (overlay) {
      marks.append(overlay);
      replay(overlay, "wt-draw");
    }
    // The cursor goes where the click shows once the camera has arrived.
    const click =
      item.click && view
        ? {
            x: ((item.click.x - view.x) / view.w) * 100,
            y: ((item.click.y - view.y) / view.h) * 100,
          }
        : item.click;
    if (!click) {
      cursor.classList.remove("wt-visible");
      lastClick = null;
      return;
    }
    // The cursor glides from the last click; on the first step, or after one without a click, it
    // fades in at the target instead.
    cursor.classList.remove("wt-glide");
    if (lastClick && !reduce) {
      cursor.style.left = `${lastClick.x}%`;
      cursor.style.top = `${lastClick.y}%`;
      void cursor.getBoundingClientRect();
      cursor.classList.add("wt-glide");
    }
    cursor.style.left = `${click.x}%`;
    cursor.style.top = `${click.y}%`;
    cursor.classList.add("wt-visible");
    replay(cursor, "wt-press");
    ripple.style.left = `${click.x}%`;
    ripple.style.top = `${click.y}%`;
    replay(ripple, "wt-rippling");
    lastClick = click;
  }

  function renderCard(screen: Screen) {
    card.replaceChildren();
    card.className = "wt-card";
    if (screen.kind === "intro") {
      card.classList.add("wt-intro");
      card.append(el("h1", "wt-card-title", data.title));
      for (const selector of [".wt-desc", ".wt-meta"]) {
        const part = cloneOf(selector);
        if (part) card.append(part);
      }
      const intro = cloneOf(".wt-static-intro");
      if (intro) card.append(intro);
      card.append(button(label("start"), "wt-button wt-primary wt-start", () => go(1)));
    } else if (screen.kind === "finish") {
      card.classList.add("wt-finish");
      card.append(el("h2", "wt-card-title", label("finished")));
      const outro = cloneOf(".wt-static-outro .wt-notes");
      if (outro) card.append(outro);
      const row = el("div", "wt-row");
      row.append(
        button(label("startAgain"), "wt-button wt-primary", () => go(1)),
        button(label("allSteps"), "wt-button", () => showStatic(true)),
      );
      card.append(row);
    } else if (screen.item.kind === "block") {
      const item = screen.item;
      card.classList.add("wt-block", `wt-block-${item.type ?? "text"}`);
      if (item.callout) card.classList.add("wt-callout", `wt-callout-${item.callout}`);
      if (item.heading) card.append(el("h2", "wt-card-title", item.heading));
      const body = cloneOf(".wt-notes", staticItem(item.index));
      if (body) card.append(body);
    } else {
      const item = screen.item;
      const top = el("div", "wt-step-top");
      top.append(
        el("span", "wt-number", String(item.number ?? "")),
        el("h2", "wt-step-text", item.text ?? ""),
      );
      card.append(top);
      if (item.motion) card.append(motionFor(item.motion));
      const code = cloneOf(".wt-code", staticItem(item.index));
      if (code) card.append(code);
      const output = cloneOf(".wt-output", staticItem(item.index));
      if (output) card.append(output);
      const notes = cloneOf(".wt-notes", staticItem(item.index));
      if (notes) card.append(notes);
    }
    replay(card, "wt-enter");
  }

  /** Typed text appears letter by letter, key caps pop in one after another, and a web address or
   * app name slides in as a pill. With reduced motion they are simply there. */
  function motionFor(motion: StepMotion) {
    const box = el("div", `wt-motion wt-motion-${motion.type}`);
    box.setAttribute("aria-hidden", "true");
    if (motion.type === "typed") {
      const field = el("span", "wt-field");
      box.append(field);
      if (reduce) {
        field.textContent = motion.value;
      } else {
        const letters = [...motion.value];
        const step = Math.min(45, 1200 / Math.max(1, letters.length));
        let shown = 0;
        const next = () => {
          shown += 1;
          field.textContent = letters.slice(0, shown).join("");
          if (shown < letters.length) typing = window.setTimeout(next, step);
        };
        typing = window.setTimeout(next, 600);
      }
    } else if (motion.type === "keys") {
      motion.keys.forEach((key, index) => {
        if (index > 0) box.append(el("span", "wt-plus", "+"));
        const cap = el("kbd", "wt-key", key);
        cap.style.animationDelay = `${500 + index * 140}ms`;
        box.append(cap);
      });
    } else {
      box.append(el("span", "wt-pill", motion.type === "url" ? motion.url : motion.name));
    }
    return box;
  }

  function hashFor(screen: Screen) {
    if (screen.kind === "intro") return "";
    if (screen.kind === "finish") return "#finish";
    return screen.item.kind === "step"
      ? `#step-${screen.item.number}`
      : `#part-${screen.item.index}`;
  }

  function go(index: number) {
    const target = Math.max(0, Math.min(screens.length - 1, index));
    if (target === current) return;
    current = target;
    window.clearTimeout(typing);
    const screen = screens[current];
    if (!screen) return;
    const item = screen.kind === "item" ? screen.item : null;
    showImage(item?.kind === "step" ? item : null);
    root?.classList.toggle("wt-chapter", item?.kind === "block" && item.type === "header");
    renderCard(screen);
    back.disabled = current === 0;
    next.disabled = current === screens.length - 1;
    const done = Math.round((current / (screens.length - 1)) * 100);
    fill.style.width = `${done}%`;
    percent.textContent = label("percentDone", { percent: done });
    for (const thumb of strip.querySelectorAll<HTMLButtonElement>(".wt-thumb")) {
      const active = thumb.dataset.screen === String(current);
      thumb.classList.toggle("wt-active", active);
      if (active) thumb.setAttribute("aria-current", "step");
      else thumb.removeAttribute("aria-current");
    }
    for (const dot of dots.querySelectorAll<HTMLButtonElement>(".wt-dot")) {
      const active = dot.dataset.screen === String(current);
      dot.classList.toggle("wt-active", active);
      if (active) dot.setAttribute("aria-current", "step");
      else dot.removeAttribute("aria-current");
    }
    const hash = hashFor(screen);
    if (location.hash !== hash) {
      try {
        history.replaceState(null, "", hash || location.pathname + location.search);
      } catch {
        // Some browsers refuse history changes for files opened from disk; the link just won't update.
      }
    }
    announcer.textContent =
      item?.kind === "step"
        ? label("announce", {
            number: item.number ?? 0,
            total: data.stepCount,
            text: item.text ?? "",
            alt: item.alt ?? "",
          })
        : screen.kind === "finish"
          ? label("finished")
          : screen.kind === "intro"
            ? data.title
            : (item?.heading ?? "");
    if (playing) schedule();
  }

  // ----- Playing (manual by default; never starts by itself) -----
  function schedule() {
    window.clearTimeout(timer);
    if (!playing) return;
    if (current >= screens.length - 1) {
      stop();
      return;
    }
    const screen = screens[current];
    const words = screen?.kind === "item" ? screen.item.words : 20;
    // Reading time at 200 words a minute, plus time to look at the screenshot; at least 3 s.
    const seconds = Math.max(3, (words / 200) * 60 + 2) / speed;
    timer = window.setTimeout(() => go(current + 1), seconds * 1000);
    countdown.hidden = false;
    countdownFill.style.transition = "none";
    countdownFill.style.width = "0%";
    void countdownFill.getBoundingClientRect();
    countdownFill.style.transition = `width ${seconds}s linear`;
    countdownFill.style.width = "100%";
  }
  function play() {
    playing = true;
    playButton.textContent = label("pause");
    playButton.setAttribute("aria-pressed", "true");
    // Play starts on the first step at once, rather than sitting on the title for a while first.
    if (current === 0 || current >= screens.length - 1) go(1);
    else schedule();
  }
  function stop() {
    playing = false;
    window.clearTimeout(timer);
    playButton.textContent = label("play");
    playButton.setAttribute("aria-pressed", "false");
    countdown.hidden = true;
  }

  function showStatic(show: boolean) {
    stop();
    staticView?.toggleAttribute("hidden", !show);
    root?.toggleAttribute("hidden", show);
    if (show) backToPlayer.focus();
    else next.focus();
  }
  const backToPlayer = button(label("backToPlayer"), "wt-button wt-back-to-player", () =>
    showStatic(false),
  );
  staticView.prepend(backToPlayer);

  // ----- Input -----
  document.addEventListener("keydown", (event) => {
    if (root.hasAttribute("hidden") || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    const onControl = target instanceof Element ? target.closest("button, select, a, input") : null;
    if (event.key === "ArrowRight" || (event.key === " " && !onControl)) {
      event.preventDefault();
      go(current + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(current - 1);
    } else if (event.key === "Home" && !onControl) {
      go(0);
    } else if (event.key === "End" && !onControl) {
      go(screens.length - 1);
    }
  });
  // Playing carries on through Back, Next, a dot or a change of speed, each restarting the screen's
  // time; only Pause (or "View all steps") stops it. Pause is always there, which is what WCAG
  // 2.2.2 asks for. Stopping whenever focus moved made Play look broken: even the Speed box stopped it.
  let swipeStart: number | null = null;
  stage.addEventListener("pointerdown", (event) => {
    swipeStart = event.clientX;
  });
  stage.addEventListener("pointerup", (event) => {
    if (swipeStart === null) return;
    const distance = event.clientX - swipeStart;
    swipeStart = null;
    if (Math.abs(distance) > 50) go(current + (distance < 0 ? 1 : -1));
  });
  reduceQuery?.addEventListener("change", () => setReduce(reduceQuery.matches));
  window.addEventListener("hashchange", () => go(screenFor(location.hash)));

  function screenFor(hash: string) {
    const step = /^#step-(\d+)$/.exec(hash);
    if (step)
      return screens.findIndex(
        (screen) => screen.kind === "item" && screen.item.number === Number(step[1]),
      );
    const part = /^#part-(\d+)$/.exec(hash);
    if (part)
      return screens.findIndex(
        (screen) => screen.kind === "item" && screen.item.index === Number(part[1]),
      );
    return hash === "#finish" ? screens.length - 1 : 0;
  }

  // ----- Start -----
  staticView.setAttribute("hidden", "");
  root.removeAttribute("hidden");
  go(Math.max(0, screenFor(location.hash)));
}
