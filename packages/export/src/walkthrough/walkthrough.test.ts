// @vitest-environment jsdom
import { createHash } from "node:crypto";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import { buildRenderModel, type RenderedImage } from "../model";
import { exportWords } from "../words";
import { overlaySvg, renderWalkthrough } from "./render";

const guide: Guide = {
  id: "g1",
  title: "Add a supplier",
  description: "How to add a supplier in Xero.",
  intro: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "You need adviser access." }] }],
  },
  outro: {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "The supplier is saved." }] }],
  },
  brandProfileId: null,
  tags: [],
  owner: "Robin",
  reviewBy: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
};

const step = (id: string, patch: Partial<GuideStep> = {}): GuideStep => ({
  id,
  sortKey: id,
  kind: "interaction",
  action: "click",
  actionText: `Click "${id}"`,
  textParts: { verb: "click", target: id, kind: "button" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: null, windowTitle: "" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
  ...patch,
});

const image = (overlay: NonNullable<RenderedImage["overlay"]>): RenderedImage => ({
  dataUrl: "data:image/jpeg;base64,AAAA",
  width: 1000,
  height: 500,
  overlay,
});

const model = (title = guide.title, firstText = 'Click "a"') =>
  buildRenderModel(
    { ...guide, title },
    [
      step("a", { actionText: firstText }),
      step("h", { kind: "block", block: { type: "header", heading: "Part two", body: null } }),
      step("b", {
        notes: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Then wait." }] }],
        },
      }),
    ],
    new Map([
      [
        "a",
        image({
          highlight: { shape: "box", x: 10, y: 20, w: 10, h: 10 },
          click: { x: 15, y: 25 },
          annotations: [{ type: "label", x: 50, y: 50, text: "Here" }],
        }),
      ],
      ["b", image({ highlight: null, click: null, annotations: [] })],
    ]),
    { preparedBy: "Robin", now: new Date(2026, 8, 26) },
  );

const hashOf = (text: string) => createHash("sha256").update(text).digest("base64");
const between = (html: string, open: string, close: string) => {
  const start = html.indexOf(open);
  return html.slice(start + open.length, html.indexOf(close, start + open.length));
};

/** Loads an exported file into this test's document and runs its player, as a browser would. */
function open(html: string, hash = "") {
  document.head.innerHTML = "";
  document.body.innerHTML = between(html, "<body>", "</body>");
  window.history.replaceState(null, "", `/guide.html${hash}`);
  const script =
    [...document.body.querySelectorAll("script:not([type])")].at(-1)?.textContent ?? "";
  // Runs the exported player exactly as the file would.
  new Function(script)();
}

const serious = async (root: Element) =>
  (await axe.run(root, { rules: { "color-contrast": { enabled: false } } })).violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => `${violation.id}: ${violation.help}`);

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const click = (name: string) => {
  const target = [...document.querySelectorAll<HTMLButtonElement>("#player button")].find(
    (item) => item.textContent === name,
  );
  if (!target) throw new Error(`No button ${name}`);
  target.click();
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("walkthrough file", () => {
  it("allows only its own script and styles, by hash, and loads nothing from outside", async () => {
    const html = await renderWalkthrough(model());
    const css = between(html, "<style>", "</style>");
    const script = between(html, "<script>", "</script>");
    const csp = between(html, 'http-equiv="Content-Security-Policy" content="', '"');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src 'sha256-${hashOf(css)}'`);
    expect(csp).toContain(`script-src 'sha256-${hashOf(script)}'`);
    expect(csp).not.toContain("unsafe");
    // "Made with Steps" is a link to follow, not something the page loads; nothing else may point
    // outside the file.
    expect(html).toContain('href="https://steps.amluto.com/"');
    expect(html.replaceAll('href="https://steps.amluto.com/"', "")).not.toMatch(
      /(src|href)="https?:/,
    );
    expect(html).not.toMatch(/url\(["']?https?:/);
    expect(script).not.toMatch(/eval\(|new Function|innerHTML/);
  });

  it("escapes guide text everywhere, including inside the data block", async () => {
    const hostile = '</script><script>alert(1)</script><img src=x onerror="alert(2)">';
    const html = await renderWalkthrough(model(hostile, hostile));
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).not.toContain("<img src=x");
    expect(between(html, 'id="guide-data">', "</script>")).not.toContain("<");
    open(html);
    expect(q("#player .wt-card h1")?.textContent).toBe(hostile);
  });

  it("shows every step without JavaScript, with the marks drawn over each screenshot", async () => {
    const html = await renderWalkthrough(model());
    document.body.innerHTML = between(html, "<body>", "</body>");
    expect(q("#static")?.hasAttribute("hidden")).toBe(false);
    expect(q("#player")?.hasAttribute("hidden")).toBe(true);
    expect(document.querySelectorAll(".wt-static-step")).toHaveLength(2);
    expect(q("#step-1 img.wt-shot")?.getAttribute("alt")).toContain("step 1");
    expect(q("#step-1 svg.wt-overlay .wt-highlight")).not.toBeNull();
    expect(q("#step-2 svg.wt-overlay")).toBeNull();
    expect(q(".wt-static-outro")?.textContent).toContain("The supplier is saved.");
  });
});

describe("walkthrough player", () => {
  it("opens on the intro and steps through with buttons and keys, announcing each step", async () => {
    open(await renderWalkthrough(model()));
    expect(q("#static")?.hasAttribute("hidden")).toBe(true);
    expect(q("#player")?.hasAttribute("hidden")).toBe(false);
    expect(q("#player .wt-card")?.textContent).toContain("You need adviser access.");
    expect(q("#player .wt-card")?.textContent).toContain("2 steps");

    click("Start");
    expect(q("#player .wt-step-text")?.textContent).toBe('Click "a"');
    expect(q('[role="status"]')?.textContent).toMatch(
      /^Step 1 of 2: Click "a"\. Screenshot for step 1/,
    );
    expect(q("#player .wt-image")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(q("#player .wt-marks .wt-highlight")).not.toBeNull();
    expect(q("#player .wt-cursor")?.style.left).toBe("15%");
    expect(window.location.hash).toBe("#step-1");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(q("#player")?.classList.contains("wt-chapter")).toBe(true);
    expect(q("#player .wt-card-title")?.textContent).toBe("Part two");

    click("Next");
    expect(q("#player .wt-card .wt-notes")?.textContent).toBe("Then wait.");
    expect(q("#player .wt-marks")?.children).toHaveLength(0);
    expect(q("#player .wt-dot.wt-active")?.getAttribute("aria-label")).toBe("Go to step 2");

    click("Next");
    expect(q("#player .wt-card")?.textContent).toContain("The supplier is saved.");
    expect(q("#player .wt-nav.wt-primary")?.hasAttribute("disabled")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(q("#player .wt-step-text")?.textContent).toBe('Click "b"');
  });

  it("eases the camera into a smart-zoom crop, with the cursor where the click ends up", async () => {
    // The picture is the wider view; the camera rests on its middle half.
    const zoomed = {
      ...image({ highlight: null, click: { x: 50, y: 50 }, annotations: [] }),
      camera: { x: 25, y: 25, w: 50, h: 50 },
    };
    open(
      await renderWalkthrough(
        buildRenderModel(guide, [step("a")], new Map([["a", zoomed]]), {
          preparedBy: "Robin",
          now: new Date(2026, 8, 26),
        }),
      ),
    );
    click("Start");
    const camera = q("#player .wt-camera");
    expect(camera?.style.transform).toBe("scale(2) translate(-25%, -25%)");
    expect(camera?.classList.contains("wt-moving")).toBe(true);
    expect(camera?.querySelector(".wt-image")).not.toBeNull();
    // The frame has the crop's shape (the same as the wider view's, 2:1 here).
    expect(q("#player .wt-frame")?.style.aspectRatio).toBe("2 / 1");
    expect(q("#player .wt-cursor")?.style.left).toBe("50%");

    click("Reduce motion");
    click("Back");
    click("Start");
    expect(q("#player .wt-camera")?.classList.contains("wt-moving")).toBe(false);
    expect(q("#player .wt-camera")?.style.transform).toBe("scale(2) translate(-25%, -25%)");
  });

  it("opens at a deep link and switches to the list of all steps and back", async () => {
    open(await renderWalkthrough(model()), "#step-2");
    expect(q("#player .wt-step-text")?.textContent).toBe('Click "b"');
    click("View all steps");
    expect(q("#static")?.hasAttribute("hidden")).toBe(false);
    expect(q("#player")?.hasAttribute("hidden")).toBe(true);
    q("#static .wt-back-to-player")?.click();
    expect(q("#player")?.hasAttribute("hidden")).toBe(false);
  });

  it("only plays when asked, and Reduce motion is a toggle", async () => {
    open(await renderWalkthrough(model()));
    const play = [...document.querySelectorAll("#player button")].find(
      (item) => item.textContent === "Play",
    );
    expect(play?.getAttribute("aria-pressed")).toBe("false");
    click("Play");
    expect(play?.textContent).toBe("Pause");
    click("Pause");
    expect(play?.getAttribute("aria-pressed")).toBe("false");
    click("Reduce motion");
    expect(q("#player")?.classList.contains("wt-reduce")).toBe(true);
  });

  it("plays on through the steps, showing the time left on each and how far through it is", async () => {
    vi.useFakeTimers();
    try {
      open(await renderWalkthrough(model()));
      expect(q("#player .wt-percent")?.textContent).toBe("0% done");
      expect(q("#player .wt-countdown")?.hasAttribute("hidden")).toBe(true);
      click("Play");
      // Straight to the first step, with the countdown running.
      expect(q("#player .wt-step-text")?.textContent).toBe('Click "a"');
      expect(q("#player .wt-countdown")?.hasAttribute("hidden")).toBe(false);
      // Changing speed or moving focus doesn't stop it.
      const speed = document.querySelector<HTMLSelectElement>("#player .wt-select");
      speed?.focus();
      if (speed) speed.value = "1.5";
      speed?.dispatchEvent(new Event("change"));
      // Step 1's time, at 1.5× (at most a few seconds).
      vi.advanceTimersByTime(3_000);
      expect(q("#player .wt-card-title")?.textContent).toBe("Part two");
      expect(q("#player .wt-percent")?.textContent).toBe("50% done");
      click("Pause");
      expect(q("#player .wt-countdown")?.hasAttribute("hidden")).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(q("#player .wt-card-title")?.textContent).toBe("Part two");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("walkthrough accessibility", () => {
  // Three axe runs over the whole player take about 2 s alone, and passed 5 s with the full check
  // running beside them (30/09/2026), so this one has longer.
  it(
    "has no serious axe findings on the player or the list of all steps",
    {
      timeout: 20_000,
    },
    async () => {
      open(await renderWalkthrough(model()));
      expect(await serious(document.body)).toEqual([]);
      click("Start");
      expect(await serious(document.body)).toEqual([]);
      click("View all steps");
      expect(await serious(document.body)).toEqual([]);
    },
  );
});

describe("overlay", () => {
  it("draws the marks in the screenshot's own pixels", () => {
    const svg = overlaySvg(
      image({
        highlight: { shape: "circle", x: 10, y: 20, w: 10, h: 10 },
        click: { x: 15, y: 25 },
        annotations: [
          { type: "arrow", from: [0, 0], to: [50, 50] },
          { type: "box", x: 50, y: 50, w: 10, h: 10 },
          { type: "label", x: 5, y: 5, text: "<b>" },
        ],
      }),
    );
    expect(svg).toContain('viewBox="0 0 1000 500"');
    expect(svg).toContain('cx="150" cy="125" rx="50" ry="25"');
    expect(svg).toContain('<rect class="wt-box wt-later" x="500" y="250" width="100" height="50"');
    expect(svg).toContain("&#60;b&#62;");
    expect(overlaySvg(image({ highlight: null, click: null, annotations: [] }))).toBe("");
  });

  it("colours a mark with a class the page's stylesheet knows", async () => {
    const svg = overlaySvg(
      image({
        highlight: null,
        click: null,
        annotations: [
          { type: "arrow", from: [0, 0], to: [50, 50], colour: "red" },
          { type: "label", x: 5, y: 5, text: "Note", colour: "white" },
        ],
      }),
    );
    expect(svg).toContain('<g class="wt-arrow wt-later wt-c-red">');
    expect(svg).toContain('<g class="wt-label wt-later wt-c-white">');
    const html = await renderWalkthrough(model());
    expect(html).toContain(".wt-overlay .wt-c-red{--wt-mark:#D92D20}");
  });
});

describe("step motion", () => {
  const withSteps = (steps: GuideStep[]) =>
    buildRenderModel(guide, steps, new Map(), { preparedBy: "", now: new Date(2026, 8, 26) });

  it("types shown values, pops key caps in, and slides web addresses in, all as text", async () => {
    const html = await renderWalkthrough(
      withSteps([
        step("typed", {
          action: "input",
          showValue: true,
          textParts: { verb: "Type", target: "Name", kind: "field", value: "<b>Acme</b>" },
        }),
        step("hidden", {
          action: "input",
          showValue: false,
          textParts: { verb: "Type", target: "Name", kind: "field", value: "secret" },
        }),
        step("keys", { textParts: { verb: "Press", target: "Ctrl + S", kind: "shortcut" } }),
        step("url", {
          action: "navigation",
          textParts: { verb: "Go to", target: "https://example.com", kind: "website" },
        }),
      ]),
    );
    expect(html).not.toContain("secret");
    // Reduced motion: the typed value is there at once (and never parsed as HTML).
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      addEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    open(html, "#step-1");
    expect(q("#player .wt-field")?.textContent).toBe("<b>Acme</b>");
    expect(q("#player .wt-field b")).toBeNull();
    click("Next");
    expect(q("#player .wt-motion")).toBeNull();
    click("Next");
    expect([...document.querySelectorAll("#player .wt-key")].map((key) => key.textContent)).toEqual(
      ["Ctrl", "S"],
    );
    click("Next");
    expect(q("#player .wt-pill")?.textContent).toBe("https://example.com");
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("types into the field on the screenshot, beside a ring or in a box (04/10/2026)", async () => {
    const typing = (id: string) =>
      step(id, {
        action: "input",
        showValue: true,
        textParts: { verb: "Type", target: "Name", kind: "field", value: "<i>Acme</i>" },
      });
    const html = await renderWalkthrough(
      buildRenderModel(
        guide,
        [typing("ring"), typing("box")],
        new Map([
          [
            "ring",
            image({
              highlight: { shape: "circle", x: 40, y: 40, w: 4, h: 6 },
              click: { x: 42, y: 43 },
              annotations: [],
            }),
          ],
          [
            "box",
            image({
              highlight: { shape: "box", x: 10, y: 20, w: 30, h: 6 },
              click: { x: 25, y: 23 },
              annotations: [],
            }),
          ],
        ]),
        { preparedBy: "", now: new Date(2026, 9, 4) },
      ),
    );
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      addEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    open(html, "#step-1");
    const ring = q("#player .wt-marks .wt-typing");
    expect(ring?.classList.contains("wt-typing-at")).toBe(true);
    expect(ring?.style.left).toBe("44%");
    expect(q("#player .wt-typed")?.textContent).toBe("<i>Acme</i>");
    expect(q("#player .wt-typed i")).toBeNull();
    // Typed on the screenshot, so not again in the card.
    expect(q("#player .wt-card .wt-motion")).toBeNull();
    click("Next");
    const box = q("#player .wt-marks .wt-typing");
    expect(box?.classList.contains("wt-typing-field")).toBe(true);
    expect([box?.style.left, box?.style.top, box?.style.width]).toEqual(["10%", "20%", "30%"]);
    Reflect.deleteProperty(window, "matchMedia");
  });
});

describe("thumbnail strip", () => {
  it("opens from Steps and jumps to the step picked", async () => {
    open(await renderWalkthrough(model()));
    const toggle = [...document.querySelectorAll("#player button")].find(
      (item) => item.textContent === "Steps",
    );
    expect(q("#player .wt-strip")?.hidden).toBe(true);
    click("Steps");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    const thumbs = document.querySelectorAll<HTMLButtonElement>("#player .wt-thumb");
    expect(thumbs).toHaveLength(2);
    thumbs[1]?.click();
    expect(q("#player .wt-step-text")?.textContent).toBe('Click "b"');
    expect(thumbs[1]?.getAttribute("aria-current")).toBe("step");
    expect(await serious(document.body)).toEqual([]);
  });
});

describe("a walkthrough in several languages", () => {
  const german = () =>
    buildRenderModel(
      { ...guide, title: "Lieferant anlegen" },
      [
        step("a", { actionText: "Klicken Sie auf a" }),
        step("h", { kind: "block", block: { type: "header", heading: "Teil zwei", body: null } }),
        step("b"),
      ],
      new Map([
        ["a", image({ highlight: null, click: null, annotations: [] })],
        ["b", image({ highlight: null, click: null, annotations: [] })],
      ]),
      { preparedBy: "Robin", now: new Date(2026, 8, 26), language: "de" },
    );

  it("carries each language once, with the screenshots only in the page's own", async () => {
    const html = await renderWalkthrough(model(), {}, [german()]);
    expect(html).toContain('<template id="wt-lang-de" lang="de">');
    const layer = between(html, '<template id="wt-lang-de" lang="de">', "</template>");
    expect(layer).toContain("Klicken Sie auf a");
    expect(layer).not.toContain("data:image/jpeg");
    expect(layer).toContain('data-figure="0"');
    const data = JSON.parse(
      between(html, '<script type="application/json" id="guide-data">', "</script>"),
    ) as {
      languages: { code: string; name: string }[];
    };
    expect(data.languages).toEqual([
      { code: "en-GB", name: "English" },
      { code: "de", name: "Deutsch" },
    ]);
  });

  it("opens in the language asked for, moving the screenshots across, and offers the others", async () => {
    open(await renderWalkthrough(model(), {}, [german()]), "?lang=de#step-1");
    expect(document.documentElement.lang).toBe("de");
    expect(q("#static h1")?.textContent).toBe("Lieferant anlegen");
    expect(document.querySelectorAll("#static figure.wt-figure")).toHaveLength(2);
    expect(document.querySelector("#static [data-figure]")).toBeNull();
    expect(q(".wt-card")?.textContent).toContain("Klicken Sie auf a");
    const picker = document.querySelector<HTMLSelectElement>(
      // Labelled in the page's language, German here.
      `#player select[aria-label='${exportWords("de").player.language}']`,
    );
    expect([...(picker?.options ?? [])].map((option) => [option.value, option.selected])).toEqual([
      ["en-GB", false],
      ["de", true],
    ]);
    expect(await serious(document.body)).toEqual([]);
  });

  it("opens in the page's own language when the viewer's isn't there", async () => {
    open(await renderWalkthrough(model(), {}, [german()]), "?lang=fr");
    expect(q("#static h1")?.textContent).toBe(guide.title);
    expect(document.querySelectorAll("#player select")).toHaveLength(2);
  });
});
