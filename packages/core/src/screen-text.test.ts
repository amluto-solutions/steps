import { describe, expect, it } from "vitest";

import type { OcrLine } from "./privacy.ts";
import { textAtPoint } from "./screen-text.ts";

/** A line of words at `y`, each 1% per character wide, `gap`% apart. */
const line = (text: string, x: number, y: number, gap = 0.6): OcrLine => {
  let at = x;
  return {
    words: text.split(" ").map((word) => {
      const box = { text: word, x: at, y, w: word.length, h: 2 };
      at += word.length + gap;
      return box;
    }),
  };
};

describe("naming a click from the screenshot's words", () => {
  const settings = [
    line("Bluetooth & devices", 8, 30),
    line("System", 8, 25),
    line("Network & internet", 8, 35),
    // A second column far to the right on the same row is a different thing.
    { words: [{ text: "Display", x: 60, y: 25, w: 7, h: 2 }] },
  ];

  it("takes the label under the click, not the whole row", () => {
    expect(textAtPoint(settings, 10, 26)).toBe("System");
    expect(textAtPoint(settings, 20, 31)).toBe("Bluetooth & devices");
  });

  it("takes the label beside or below an icon", () => {
    expect(textAtPoint(settings, 5, 26)).toBe("System");
    expect(textAtPoint([line("Paste", 40, 12)], 42, 8)).toBe("Paste");
  });

  it("takes a menu item's word just left of the click before the next item down", () => {
    // SiteGround's Email menu (05/10/2026): a click just past "Forwarders" was named
    // "Autoresponders", the item underneath.
    const menu = [
      { words: [{ text: "Forwarders", x: 7.6, y: 37.4, w: 5.5, h: 1.6 }] },
      { words: [{ text: "Autoresponders", x: 7.6, y: 43.4, w: 7.9, h: 1.6 }] },
    ];
    expect(textAtPoint(menu, 14.18, 38.84)).toBe("Forwarders");
  });

  it("takes a button's label just above the click before the next button's underneath", () => {
    // SiteGround's sign-in (05/10/2026): a click in "Continue with Google", below its words, was
    // named "Continue with Apple", the button underneath. Boxes as Windows OCR read them.
    const buttons = [
      {
        words: [
          { text: "Continue", x: 71.51, y: 70.16, w: 3.65, h: 1.16 },
          { text: "with", x: 75.36, y: 70.16, w: 1.72, h: 1.16 },
          { text: "Google", x: 77.34, y: 70.16, w: 2.81, h: 1.55 },
        ],
      },
      {
        words: [
          { text: "Continue", x: 71.77, y: 77.13, w: 3.65, h: 1.16 },
          { text: "with", x: 75.63, y: 77.13, w: 1.72, h: 1.16 },
          { text: "Apple", x: 77.6, y: 77.13, w: 2.34, h: 1.45 },
        ],
      },
    ];
    expect(textAtPoint(buttons, 73.698, 72.19)).toBe("Continue with Google");
  });

  it("takes the word nearest the click when the click is close to two, whatever their order", () => {
    // A tight list: the click is just under "Forwarders" and just over "Autoresponders".
    const forwarders = { words: [{ text: "Forwarders", x: 7.6, y: 38, w: 5.5, h: 1.6 }] };
    const autoresponders = { words: [{ text: "Autoresponders", x: 7.6, y: 40, w: 7.9, h: 1.6 }] };
    expect(textAtPoint([autoresponders, forwarders], 9, 39.7)).toBe("Forwarders");
    expect(textAtPoint([forwarders, autoresponders], 9, 39.95)).toBe("Autoresponders");
  });

  it("takes an icon button's own label under it before words beside it on its row", () => {
    // A web control panel's side rail (07/10/2026): icon buttons with no name, the label under
    // each icon. Words and boxes are the real reading and outlines from that recording.
    const forwarders = [
      { words: [{ text: "CREATE", x: 11.18, y: 73.89, w: 3.82, h: 2.22 }] },
      { words: [{ text: "Email", x: 2.24, y: 76.5, w: 2.21, h: 1.76 }] },
    ];
    const emailIcon = { x: 1.25, y: 70.725, w: 3.867, h: 4.348 };
    expect(textAtPoint(forwarders, 2.969, 73.551, emailIcon)).toBe("Email");
    const menuOpen = [
      { words: [{ text: "Email", x: 7.68, y: 21.96, w: 3.18, h: 1.76 }] },
      { words: [{ text: "Dashboard", x: 0.94, y: 25.12, w: 4.51, h: 1.3 }] },
    ];
    const dashboardIcon = { x: 1.25, y: 20.145, w: 3.867, h: 4.42 };
    expect(textAtPoint(menuOpen, 2.305, 23.551, dashboardIcon)).toBe("Dashboard");
  });

  it("takes the words inside the clicked element's outline first", () => {
    const menu = [
      { words: [{ text: "Forwarders", x: 7.6, y: 37.4, w: 5.5, h: 1.6 }] },
      { words: [{ text: "Autoresponders", x: 7.6, y: 43.4, w: 7.9, h: 1.6 }] },
    ];
    expect(textAtPoint(menu, 14.18, 38.84, { x: 7, y: 35.4, w: 22.3, h: 5.5 })).toBe("Forwarders");
  });

  it("says nothing when there's no word near, or only a number", () => {
    expect(textAtPoint(settings, 40, 80)).toBeNull();
    expect(textAtPoint([line("42", 10, 10)], 10.5, 10.5)).toBeNull();
  });
});
