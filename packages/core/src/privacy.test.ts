import { describe, expect, it } from "vitest";

import { findSensitive, ibanValid, luhnValid, type OcrLine } from "./privacy.ts";

/** A line of words laid out left to right, 1% apart, each 1% per character wide. */
const line = (text: string, y = 10): OcrLine => {
  let x = 5;
  return {
    words: text.split(" ").map((word) => {
      const box = { text: word, x, y, w: word.length, h: 2 };
      x += word.length + 1;
      return box;
    }),
  };
};

/** A line starting at `x`, for page layouts with columns. */
const at = (text: string, x: number, y: number): OcrLine => {
  const words = line(text, y).words;
  return { words: words.map((word) => ({ ...word, x: word.x - 5 + x })) };
};

const kinds = (text: string, terms: string[] = []) =>
  findSensitive([line(text)], terms).map((found) => found.kind);

describe("suggested blurs", () => {
  it("finds each kind of personal data", () => {
    expect(kinds("Email jane.doe@acme.co.uk today")).toEqual(["email"]);
    expect(kinds("Call 07700 900123 now")).toEqual(["phone"]);
    expect(kinds("Tel +44 20 7946 0958")).toEqual(["phone"]);
    expect(kinds("Office SW1A 1AA London")).toEqual(["postcode"]);
    // As Windows OCR actually read it.
    expect(kinds("Postcode SWIA IAA and MI IAE")).toEqual(["postcode", "postcode"]);
    expect(kinds("Card 4111 1111 1111 1111 exp")).toEqual(["card"]);
    expect(kinds("NI AB 12 34 56 C")).toEqual(["niNumber"]);
    expect(kinds("IBAN GB82 WEST 1234 5698 7654 32")).toEqual(["iban"]);
  });

  it("finds a phone number OCR misread", () => {
    expect(kinds("+447562265886 ✓")).toEqual(["phone"]);
    expect(kinds("+ 44 7562 265886")).toEqual(["phone"]);
    expect(kinds("O7700 9OO123")).toEqual(["phone"]);
    // Too few real digits to be a number at all.
    expect(kinds("OIlO OIlO OIlO")).toEqual([]);
  });

  it("finds names, addresses and IDs by the label beside them, and says which label", () => {
    // Laid out like an account page: labels on the left, values on the right.
    const page = [
      at("Developer account ID", 5, 10),
      at("7968074806044369000", 45, 10),
      at("Developer name", 5, 14),
      at("Amluto Solutions", 45, 14),
      at("Account owner", 5, 18),
      at("robin@amluto.com (Robin Hale)", 45, 18),
      at("Contact name", 5, 22),
      at("Robin Hale", 45, 22),
      at("Contact phone number", 5, 26),
      at("+447562265886", 45, 26),
      at("Home address", 5, 30),
      at("Truwood House", 45, 30),
      at("Queens Lane", 45, 33),
      at("Mold", 45, 36),
      at("Website", 5, 42),
      at("https://amluto.com/", 45, 42),
    ];
    const found = findSensitive(page).map((item) => [item.kind, item.text, item.label ?? ""]);
    expect(found).toEqual([
      ["id", "7968074806044369000", "Developer account ID"],
      ["name", "robin@amluto.com (Robin Hale)", "Account owner"],
      ["name", "Robin Hale", "Contact name"],
      ["phone", "+447562265886", "Contact phone number"],
      ["address", "Truwood House, Queens Lane, Mold", "Home address"],
    ]);
    // The account owner's email is one detail, blurred with the name beside it.
    const owner = findSensitive(page).find((item) => item.label === "Account owner");
    expect(owner?.rect.x).toBeLessThanOrEqual(45);
    expect((owner?.rect.x ?? 0) + (owner?.rect.w ?? 0)).toBeGreaterThanOrEqual(45 + 27);
  });

  it("finds a filled-in username under its label or after a colon, and skips empty ones", () => {
    const form = [
      at("Username", 10, 20),
      at("t.cook", 10, 23),
      at("Password", 10, 30),
      at("Remember me", 10, 40),
    ];
    expect(findSensitive(form).map((item) => [item.kind, item.text])).toEqual([
      ["username", "t.cook"],
    ]);
    // An empty field: the next label below isn't a value.
    expect(findSensitive([at("User name", 10, 20), at("Password", 10, 23)])).toEqual([]);
    expect(findSensitive([line("Name: Jane Smith")]).map((item) => item.text)).toEqual([
      "Jane Smith",
    ]);
    // Placeholder words aren't anyone's details, and an ID must be a real number.
    expect(findSensitive([line("Name: Enter your name")])).toEqual([]);
    expect(findSensitive([line("Reference: pending")])).toEqual([]);
    // A label in a sentence isn't a label.
    expect(findSensitive([line("Type your name in the box below")])).toEqual([]);
  });

  it("finds a number followed by more digits or words", () => {
    const texts = (text: string) => findSensitive([line(text)]).map((found) => found.text);
    expect(texts("Card 4111 1111 1111 1111 123")).toEqual(["4111 1111 1111 1111"]);
    expect(texts("4111 1111 1111 1111 12 28")).toEqual(["4111 1111 1111 1111"]);
    expect(texts("Pay GB82 WEST 1234 5698 7654 32 GBP")).toEqual(["GB82 WEST 1234 5698 7654 32"]);
    expect(kinds("Ring (020) 7946 0958 today")).toEqual(["phone"]);
    // The box covers only the number, not the digits after it.
    const [card] = findSensitive([line("4111 1111 1111 1111 123")]);
    expect(card?.rect.w).toBeCloseTo(19 + 0.6);
  });

  it("leaves near misses alone", () => {
    expect(kinds("Invoice total 1234.56 on 25/09/2026")).toEqual([]);
    expect(kinds("Order 4111 1111 1111 1112")).toEqual([]); // fails the Luhn check
    expect(kinds("Ref GB82 WEST 1234 5698 7654 33")).toEqual([]); // fails mod-97
    expect(kinds("Step 12345")).toEqual([]);
    expect(kinds("NI BG 12 34 56 C")).toEqual([]); // BG is never issued
  });

  it("finds always-blur terms as whole words only", () => {
    expect(kinds("Project Falcon launch", ["falcon"])).toEqual(["term"]);
    expect(kinds("Falconer report", ["falcon"])).toEqual([]);
  });

  it("covers exactly the matched words, padded", () => {
    const [finding] = findSensitive([line("Email jane@acme.com now", 20)]);
    // "jane@acme.com" starts after "Email " at x = 5 + 5 + 1 = 11 and is 13 wide.
    expect(finding?.rect).toEqual({ x: 10.7, y: 19.7, w: 13.6, h: 2.6 });
  });

  it("checks card and IBAN numbers properly", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(luhnValid("1234")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82WEST12345698765433")).toBe(false);
  });
});

describe("blur suggestions by strength (01/10/2026)", () => {
  const kinds = (text: string, options = {}, terms: string[] = []) =>
    findSensitive([line(text)], terms, options).map((finding) => finding.kind);

  it("finds an always-blur word however OCR splits or punctuates it (F023)", () => {
    const found = findSensitive([line("Invoice INV-TEST- 0042 Quinn")], ["INV-TEST-0042", "Quinn"]);
    expect(found.map((finding) => [finding.kind, finding.text])).toEqual([
      ["term", "INV-TEST- 0042"],
      ["term", "Quinn"],
    ]);
    // Whole words only.
    expect(kinds("Quinnell Ltd", {}, ["Quinn"])).toEqual([]);
  });

  it("finds the person's own account names at Standard, not at Light", () => {
    const text = "C: Robin - Amluto Solutions RobinHale";
    expect(kinds(text, { people: ["RobinHale", "Robin - Amluto Solutions"] })).toEqual([
      "account",
      "account",
    ]);
    expect(kinds(text, { strength: "light", people: ["RobinHale"] })).toEqual([]);
  });

  it("finds file names and paths only at Thorough (F068)", () => {
    const text = "Recent Waypoint North Proposal.docx C:\\Users\\sam\\Documents";
    expect(kinds(text)).toEqual([]);
    expect(kinds(text, { strength: "thorough" })).toEqual(["file", "path"]);
  });

  it("keeps postcodes for Standard and up", () => {
    expect(kinds("Office SW1A 1AA")).toEqual(["postcode"]);
    expect(kinds("Office SW1A 1AA", { strength: "light" })).toEqual([]);
  });
});
