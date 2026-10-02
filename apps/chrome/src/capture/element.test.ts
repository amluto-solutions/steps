// @vitest-environment jsdom
import { wordStep } from "@amluto-steps/core";
import { beforeEach, describe, expect, it } from "vitest";

import {
  editedText,
  editingHost,
  inView,
  isSensitive,
  meantElement,
  stepTarget,
  typedPart,
} from "./element";

beforeEach(() => {
  document.body.innerHTML = "";
});

const page = (html: string) => {
  document.body.innerHTML = html;
  return (selector: string) => document.querySelector(selector) as Element;
};

/** What a click on `selector` would be worded as. */
const clickWords = (find: (selector: string) => Element, selector: string) =>
  wordStep("click", stepTarget(meantElement(find(selector))));

describe("the element a click meant", () => {
  it("is the button around an icon, and words it by the button's text", () => {
    const find = page('<button id="save"><svg id="icon"></svg> Save invoice</button>');
    expect(meantElement(find("#icon"))).toBe(find("#save"));
    expect(clickWords(find, "#icon")).toBe('Click "Save invoice"');
  });

  it("is the control a label belongs to, named by the label", () => {
    const find = page(
      '<label for="keep" id="l">Keep me signed in</label><input type="checkbox" id="keep">',
    );
    expect(clickWords(find, "#l")).toBe('Click "Keep me signed in"');
  });

  it("names fields by label, aria-labelledby or placeholder", () => {
    const find = page(`
      <label>Surname <input id="surname"></label>
      <span id="t">Find a customer</span><input id="search" aria-labelledby="t">
      <input id="phone" placeholder="Phone number">`);
    expect(clickWords(find, "#surname")).toBe('Click "Surname" field');
    expect(clickWords(find, "#search")).toBe('Click "Find a customer"');
    expect(clickWords(find, "#phone")).toBe('Click "Phone number" field');
  });

  it("words links, images, submit buttons and ARIA controls", () => {
    const find = page(`
      <a href="/pricing" id="a"><span id="inner">Pricing</span></a>
      <img id="logo" alt="Company logo">
      <input type="submit" id="pay" value="Pay now">
      <div role="switch" id="dark" aria-label="Dark mode"></div>`);
    expect(clickWords(find, "#inner")).toBe('Click "Pricing"');
    expect(clickWords(find, "#logo")).toBe('Click "Company logo"');
    expect(clickWords(find, "#pay")).toBe('Click "Pay now"');
    expect(clickWords(find, "#dark")).toBe('Click "Dark mode"');
  });

  it("never reads a typed value as part of the facts", () => {
    const find = page('<input id="name" value="Acme Ltd" aria-label="Customer">');
    expect(stepTarget(find("#name")).value).toBeUndefined();
  });
});

describe("secret fields", () => {
  it.each([
    '<input id="f" type="password">',
    '<input id="f" autocomplete="one-time-code">',
    '<input id="f" autocomplete="cc-number">',
    '<label>Card number <input id="f"></label>',
    '<input id="f" name="userPin">',
    '<input id="f" placeholder="Security code">',
  ])("treats %s as secret", (html) => {
    expect(isSensitive(page(html)("#f"))).toBe(true);
  });

  it("leaves an ordinary field alone, and takes policy terms", () => {
    const find = page('<input id="f" aria-label="Project Falcon code">');
    expect(isSensitive(find("#f"))).toBe(false);
    expect(isSensitive(find("#f"), ["falcon"])).toBe(true);
  });
});

it("gives positions as percentages of the visible page", () => {
  expect(
    inView({ left: 480, top: 270, width: 96, height: 54 }, { width: 1920, height: 1080 }),
  ).toEqual({
    x: 25,
    y: 25,
    w: 5,
    h: 5,
  });
});

describe("rich-text editors", () => {
  it("are the outermost editable element, and a click in one names it, not its words", () => {
    const find = page(`
      <div id="body" contenteditable="true" aria-label="Message body">
        <p id="line">Dear Sam, <b id="bold">thanks</b></p>
      </div>
      <div id="notes" contenteditable="plaintext-only" aria-placeholder="Add a note"></div>`);
    expect(editingHost(find("#bold"))).toBe(find("#body"));
    expect(editingHost(find("#notes"))).toBe(find("#notes"));
    expect(editingHost(document.body)).toBeNull();
    const target = stepTarget(meantElement(find("#bold")));
    expect(target).toMatchObject({ tagName: "DIV", ariaLabel: "Message body" });
    // What's written in an editor is typing: never part of a click's facts.
    expect(target.innerText).toBeUndefined();
    expect(stepTarget(find("#notes")).placeholder).toBe("Add a note");
  });

  it("are a whole document in design mode", () => {
    const find = page('<p id="p">Hello</p>');
    document.designMode = "on";
    try {
      expect(editingHost(find("#p"))).toBe(document.body);
      expect(stepTarget(find("#p")).innerText).toBeUndefined();
    } finally {
      document.designMode = "off";
    }
  });

  it("read their words, tidied, within the step format's limit", () => {
    const find = page('<div id="e" contenteditable="true">  Hello&nbsp;there  </div>');
    expect(editedText(find("#e") as HTMLElement)).toBe("Hello there");
  });

  it.each([
    ["", "Thanks, Sam", "Thanks, Sam"],
    // A reply: only what was typed above the quoted message.
    ["\n\nFrom: Jo\nOld message", "Thanks!\n\nFrom: Jo\nOld message", "Thanks!"],
    ["Dear Sam,\nRegards", "Dear Sam,\nSee you then.\nRegards", "See you then."],
    ["Draft one", "Draft two", "two"],
    // Only deleting isn't typing.
    ["Hello there", "Hello", ""],
    ["aaa", "aaaa", "a"],
  ])("take what changed as what was typed: %j to %j", (before, after, typed) => {
    expect(typedPart(before, after)).toBe(typed);
  });
});
