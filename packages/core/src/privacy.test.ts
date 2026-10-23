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

/** A line OCR read as one word in one box, as copied from a real reading. */
const word = (text: string, x: number, y: number, w: number, h: number): OcrLine => ({
  words: [{ text, x, y, w, h }],
});

const kinds = (text: string, terms: string[] = []) =>
  findSensitive([line(text)], terms).map((found) => found.kind);

describe("suggested blurs", () => {
  it("finds every email in a list OCR spaced out", () => {
    // As Windows OCR read a comma-separated list in Notepad++ (04/10/2026).
    const found = findSensitive([
      line(
        "sam.testerl@gmail . com, jo . bloggs@btinternet . com,alex . jones@hotmail . com , chris42@yahoo . co . uk, lee.green7@gmai1. com",
      ),
    ]);
    expect(found.map((item) => item.kind)).toEqual(["email", "email", "email", "email", "email"]);
    expect(found[1]?.text).toBe("jo . bloggs@btinternet . com");
    expect(kinds("End of sentence . Next one")).toEqual([]);
    // OCR's misreading of small text, with a letter outside A to Z (04/10/2026).
    expect(kinds("members@flintandholwællrotary.co.uk")).toEqual(["email"]);
    // Underscores and apostrophes before the @, blurred whole (05/10/2026).
    const texts = (text: string) => findSensitive([line(text)]).map((found) => found.text);
    expect(texts("alan_smith@live.co.uk")).toEqual(["alan_smith@live.co.uk"]);
    expect(texts("j_wiltshire@live . co . uk")).toEqual(["j_wiltshire@live . co . uk"]);
    expect(texts("jo.o'brien@example.com")).toEqual(["jo.o'brien@example.com"]);
    // Every other character an address may have before the @, and hyphens in the domain.
    for (const address of [
      "jo-bloggs@my-firm.co.uk",
      "first.last+news@example.com",
      "100%sure@example.org",
      "a!b#c$d&e*f@example.com",
      "x/y=z?w^v@example.com",
      "{curly}|pipe~`tick@example.com",
    ])
      expect(texts(`Contact ${address} today`)).toEqual([address]);
    // A catch-all is blurred too (06/10/2026).
    expect(texts("*@flintandholywellrotary.co.uk DEFAULT")).toEqual([
      "*@flintandholywellrotary.co.uk",
    ]);
  });

  it("doesn't take a domain under an Email Address heading for an address (04/10/2026)", () => {
    const table = [
      at("Email Address", 10, 10),
      at("flintandholywellrotary.co.uk", 10, 14),
      at("members@flintandholywellrotary.co.uk", 10, 18),
    ];
    expect(findSensitive(table).map((found) => [found.kind, found.text])).toEqual([
      ["email", "members@flintandholywellrotary.co.uk"],
    ]);
  });

  it("never suggests a word on the person's own list, but keeps the always-blur words", () => {
    const text = "Mail steps@amluto.com or call 07700 900123 about Falcon";
    expect(
      findSensitive([line(text)], ["Falcon"], { safe: ["Amluto"] }).map((f) => f.kind),
    ).toEqual(["phone", "term"]);
    expect(
      findSensitive([line(text)], ["Falcon"], { safe: ["falcon", "07700 900 123"] }).map(
        (f) => f.kind,
      ),
    ).toEqual(["email", "term"]);
  });

  it("suggests each area once", () => {
    const found = findSensitive([line("Signed in as Robin Hale today")], [], {
      people: ["Robin", "Robin Hale"],
    });
    expect(found.map((item) => item.text)).toEqual(["Robin Hale"]);
  });

  it("finds each kind of personal data", () => {
    expect(kinds("Email jane.doe@acme.co.uk today")).toEqual(["email"]);
    expect(kinds("Call 07700 900123 now")).toEqual(["phone"]);
    expect(kinds("Tel +44 20 7946 0958")).toEqual(["phone"]);
    expect(kinds("Office SW1A 1AA London")).toEqual(["postcode"]);
    // As Windows OCR actually read it.
    expect(kinds("Postcode SWIA IAA and MI IAE")).toEqual(["postcode", "postcode"]);
    // Capital words OCR's misreads would otherwise make postcodes of (04/10/2026).
    expect(kinds("SITE TOOLS")).toEqual([]);
    expect(kinds("TOOLS")).toEqual([]);
    expect(kinds("TOO OLD")).toEqual([]);
    expect(kinds("Card 4111 1111 1111 1111 exp")).toEqual(["card"]);
    expect(kinds("NI AB 12 34 56 C")).toEqual(["niNumber"]);
    expect(kinds("IBAN GB82 WEST 1234 5698 7654 32")).toEqual(["iban"]);
  });

  it("doesn't take a row of colour swatches for a phone number (#51, P17)", () => {
    // Paint's palette as Windows OCR read it on 10/10/2026: each row of round swatches came back
    // as one word of circles, and the middle row as ten zeros.
    const palette = [
      word("Ooooooeoooo", 27.22, 45.15, 14.39, 3.02),
      word("0000000000", 29.53, 47.69, 12.07, 1.48),
      word("oooooooooo", 29.51, 49.88, 12.12, 1.54),
    ];
    expect(findSensitive(palette, [], { strength: "light" })).toEqual([]);
    // The same glyph however OCR spaces it, or reads some circles as O.
    expect(kinds("00000 00000")).toEqual([]);
    expect(kinds("00 00 00 00 00")).toEqual([]);
    expect(kinds("0O00000000")).toEqual([]);
    expect(kinds("+44 4444 444444")).toEqual([]);
    // Nor beside a phone label: a placeholder's zeros aren't anyone's number.
    expect(findSensitive([line("Phone: 0000 000000")])).toEqual([]);
    expect(findSensitive([at("Mobile", 5, 10), at("000000000", 30, 10)])).toEqual([]);
    expect(
      findSensitive([line("Mobile: 07700 900123")]).map((found) => [found.kind, found.label]),
    ).toEqual([["phone", "Mobile"]]);
  });

  it("still finds real phone numbers, however many digits repeat (#51)", () => {
    for (const number of [
      "07700900123",
      "07700 900123",
      "07777 777777",
      "+447777777777",
      "0800 000000",
      "01111 111111",
      "(020) 7946 0958",
      "+44 20 7946 0958",
      "+447700900456",
      "+ 44 7700 900456",
      "O7700 9OO123",
      "O1111 111111",
    ])
      expect(kinds(`Call ${number} today`), number).toEqual(["phone"]);
  });

  it("finds a UK number written with a bracketed trunk zero after +44 (#99)", () => {
    const texts = (text: string) =>
      findSensitive([line(text)]).map((found) => [found.kind, found.text]);
    // The "(0)" isn't counted, but is blurred with the number.
    expect(texts("Tel +44 (0)20 7946 0958 today")).toEqual([["phone", "+44 (0)20 7946 0958"]]);
    expect(texts("Mobile +44 (0) 7700 900123")).toEqual([["phone", "+44 (0) 7700 900123"]]);
    expect(texts("Office +44(0)1632 960123.")).toEqual([["phone", "+44(0)1632 960123"]]);
  });

  it("doesn't make a number of a (0) anywhere but after +44 (#99)", () => {
    const texts = (text: string) =>
      findSensitive([line(text)]).map((found) => [found.kind, found.text]);
    expect(texts("Option (0)")).toEqual([]);
    expect(texts("Option (0) 1632 960123")).toEqual([]);
    expect(texts("Option (0)20 7946 0958")).toEqual([]);
    // A count before a number isn't part of it.
    expect(texts("Drafts (0) 01632 960123")).toEqual([["phone", "01632 960123"]]);
    expect(texts("+44 20 (0) 7946 0958")).toEqual([]);
  });

  it("never takes one glyph repeated for a number with a bracketed trunk zero (#99, #51)", () => {
    // Read from abroad ("+44 4444 444444") or at home ("00000 000000"), it's one digit over and
    // over, by its digits or beside a phone label.
    expect(kinds("+44 (0) 4444 444444")).toEqual([]);
    expect(kinds("+44 (0)0000 000000")).toEqual([]);
    expect(findSensitive([line("Phone: +44 (0)0000 000000")])).toEqual([]);
    expect(findSensitive([at("Mobile", 5, 10), at("+44 (0)0000 000000", 30, 10)])).toEqual([]);
    // However many of its own digits repeat, a real number is still found.
    expect(kinds("Call +44 (0)7777 777777 today")).toEqual(["phone"]);
    expect(
      findSensitive([line("Mobile: +44 (0)7777 777777")]).map((found) => [found.kind, found.label]),
    ).toEqual([["phone", "Mobile"]]);
  });

  it("finds a phone number OCR misread", () => {
    expect(kinds("+447700900456 ✓")).toEqual(["phone"]);
    expect(kinds("+ 44 7700 900456")).toEqual(["phone"]);
    expect(kinds("O7700 9OO123")).toEqual(["phone"]);
    // Too few real digits to be a number at all.
    expect(kinds("OIlO OIlO OIlO")).toEqual([]);
    // With a bracketed trunk zero too (#99), and still never one glyph repeated.
    const texts = (text: string) => findSensitive([line(text)]).map((found) => found.text);
    expect(texts("Tel + 44 (0)20 7946 0958")).toEqual(["+ 44 (0)20 7946 0958"]);
    expect(texts("Tel +44 (O)20 7946 O958")).toEqual(["+44 (O)20 7946 O958"]);
    expect(kinds("+ 44 (O) OOOO OOOOOO")).toEqual([]);
    expect(kinds("+ 44 (0) 4444 444444")).toEqual([]);
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
      at("+447700900456", 45, 26),
      at("Home address", 5, 30),
      at("Elm House", 45, 30),
      at("Station Road", 45, 33),
      at("Anytown", 45, 36),
      at("Website", 5, 42),
      at("https://amluto.com/", 45, 42),
    ];
    const found = findSensitive(page).map((item) => [item.kind, item.text, item.label ?? ""]);
    expect(found).toEqual([
      ["id", "7968074806044369000", "Developer account ID"],
      ["name", "robin@amluto.com (Robin Hale)", "Account owner"],
      ["name", "Robin Hale", "Contact name"],
      ["phone", "+447700900456", "Contact phone number"],
      ["address", "Elm House, Station Road, Anytown", "Home address"],
    ]);
    // The account owner's email is one detail, blurred with the name beside it.
    const owner = findSensitive(page).find((item) => item.label === "Account owner");
    expect(owner?.rect.x).toBeLessThanOrEqual(45);
    expect((owner?.rect.x ?? 0) + (owner?.rect.w ?? 0)).toBeGreaterThanOrEqual(45 + 27);
  });

  it("doesn't take the next item of a menu or list for the value of a Name heading (#51, P37)", () => {
    // File Explorer's Sort menu as Windows OCR read it on 10/10/2026: "Date modified" had been
    // suggested as the name next to "Name".
    const menu = [
      word("Name", 21.55, 14.51, 1.89, 0.99),
      word("•", 20.21, 17.69, 0.31, 0.56),
      word("Date modified", 21.55, 17.47, 4.51, 0.99),
      word("Type", 21.49, 20.43, 1.53, 1.27),
      word("More", 21.51, 23.43, 1.67, 0.93),
      word("Ascending", 21.51, 26.57, 3.33, 1.3),
      word("Descending", 21.56, 29.54, 3.7, 1.3),
      word("Group by", 21.51, 32.87, 3.02, 1.2),
    ];
    expect(findSensitive(menu)).toEqual([]);
  });

  it("doesn't take the next column's heading for the value of a Name heading (#51, P37)", () => {
    // File Explorer's Details view, laid out as Windows OCR read one on 10/10/2026 (the files'
    // names made up): "Date modified" had been suggested as the name next to "Name".
    const explorer = [
      word("Name", 19.1, 13.49, 1.65, 0.9),
      word("Date modified", 47.5, 13.52, 3.86, 0.83),
      word("Type", 54.95, 13.52, 1.3, 1.11),
      word("Size", 61.2, 13.52, 1.04, 0.83),
      word("v Today", 16.91, 16.54, 2.9, 0.59),
      ...[18.98, 21.57, 24.17].flatMap((y, row) => [
        word(
          ["Club rota.xlsx", "Minutes October.docx", "Newsletter.pdf"][row] ?? "",
          19.43,
          y,
          9,
          1.11,
        ),
        word("10/10/2026 09:57", 47.45, y, 4.58, 0.83),
        word("Microsoft Word Document", 55, y, 5.31, 0.83),
        word("12 KB", 62.4, y, 1.25, 1.02),
      ]),
    ];
    expect(findSensitive(explorer)).toEqual([]);
    // With OneDrive's Status column next to Name, which shows icons, not words.
    const onedrive = [
      word("Name", 19.1, 13.49, 1.65, 0.9),
      word("Status", 31.09, 13.49, 2.28, 0.9),
      word("Date modified", 35.3, 13.49, 4.46, 0.9),
      word("Type", 42.74, 13.49, 1.3, 1.17),
      ...[16.45, 19.35, 22.22].flatMap((y, row) => [
        word(["Club rota.xlsx", "Minutes.docx", "Newsletter.pdf"][row] ?? "", 19.38, y, 9, 1.11),
        word("10/10/2026 09:57", 35.26, y, 4.58, 0.83),
        word("File folder", 42.81, y, 3.2, 0.83),
      ]),
    ];
    expect(findSensitive(onedrive)).toEqual([]);
    // A Teams files list, each file on two lines: "Opened" had been suggested as the name next to
    // "Name". ("Activity" beside "Owner" still is: with no heading after it, the two can't be told
    // from a label and its value with more labels under them.)
    const teams = [
      word("Name", 18.54, 61.92, 1.93, 0.97),
      word("Opened", 45.26, 61.92, 2.6, 1.26),
      word("Owner", 55.68, 61.92, 2.19, 0.97),
      word("Activity", 69.22, 61.92, 2.5, 1.26),
      ...[66.18, 71.61, 77.03].flatMap((y) => [
        word("Club rota", 20.94, y, 3.07, 0.97),
        word("In Files", 20.99, y + 1.84, 2.19, 1.16),
        word("3d ago", 45.21, y + 0.78, 2.24, 0.97),
        word("Robin Hale", 55.62, y + 0.78, 3.39, 1.26),
        word("Sam edited this", 70.78, y + 0.78, 5, 0.97),
      ]),
    ];
    expect(findSensitive(teams).filter((found) => found.label === "Name")).toEqual([]);
  });

  it("still finds a phone number under a Phone heading, which must look like one anyway (#51)", () => {
    // Not a UK number, so only its label finds it.
    const list = [
      at("Phone", 10, 10),
      at("+1 415 555 0100", 10, 13),
      at("+1 415 555 0101", 10, 16),
      at("+1 415 555 0102", 10, 19),
    ];
    expect(findSensitive(list).map((found) => [found.kind, found.text, found.label])).toEqual([
      ["phone", "+1 415 555 0100", "Phone"],
    ]);
  });

  it("still finds every email, phone and card number in a table's rows (#51)", () => {
    // The Name heading no longer labels anything, but what's in the rows is found by itself.
    const contacts = [
      at("Name", 5, 10),
      at("Email", 30, 10),
      at("Mobile", 60, 10),
      at("Card", 80, 10),
      ...[
        ["Robin Hale", "robin@example.com", "07700 900123", "4111 1111 1111 1111"],
        ["Jo Bloggs", "jo.bloggs@example.co.uk", "07700 900456", "5555 5555 5555 4444"],
        ["Sam Jones", "sam@example.org", "+44 20 7946 0958", "4000 0566 5566 5556"],
      ].flatMap(([name, email, mobile, card], row) => [
        at(name ?? "", 5, 14 + row * 3),
        at(email ?? "", 30, 14 + row * 3),
        at(mobile ?? "", 60, 14 + row * 3),
        at(card ?? "", 80, 14 + row * 3),
      ]),
    ];
    const found = findSensitive(contacts, [], { strength: "light" });
    expect(found.map((item) => item.kind).sort()).toEqual([
      ...Array<string>(3).fill("card"),
      ...Array<string>(3).fill("email"),
      ...Array<string>(3).fill("phone"),
    ]);
  });

  it("still finds a name labelled beside it on a page laid out like a table (#51)", () => {
    const found = (lines: OcrLine[]) =>
      findSensitive(lines).map((item) => [item.kind, item.text, item.label ?? ""]);
    // Labels on the left, values on the right, the name's followed by labels that aren't personal.
    const profile = [
      at("Name", 20, 10),
      at("Robin Hale", 50, 10),
      at("Company", 20, 14),
      at("Amluto Solutions", 50, 14),
      at("Job title", 20, 18),
      at("Director", 50, 18),
    ];
    expect(found(profile)).toEqual([["name", "Robin Hale", "Name"]]);
    // With an Edit button on every row, and a side menu whose items line up with the rows.
    expect(
      found([
        ...profile,
        at("Edit", 85, 10),
        at("Edit", 85, 14),
        at("Edit", 85, 18),
        at("Profile", 1, 10),
        at("Security", 1, 14),
        at("Billing", 1, 18),
      ]),
    ).toEqual([["name", "Robin Hale", "Name"]]);
    // Two pairs to a row.
    expect(
      found([
        at("First name", 5, 10),
        at("Robin", 25, 10),
        at("Last name", 50, 10),
        at("Hale", 70, 10),
        at("Email", 5, 14),
        at("robin@example.com", 25, 14),
        at("Phone", 50, 14),
        at("07700 900123", 70, 14),
      ]),
    ).toEqual([
      ["name", "Robin", "First name"],
      ["name", "Hale", "Last name"],
      ["email", "robin@example.com", "Email"],
      ["phone", "07700 900123", "Phone"],
    ]);
  });

  it("still finds a name or address labelled above its field in a form (#51)", () => {
    const found = (lines: OcrLine[]) =>
      findSensitive(lines).map((item) => [item.kind, item.text, item.label ?? ""]);
    // A profile form: each label close to its field, the next field further on, and the fields
    // after the name labelled with words that aren't personal.
    expect(
      found([
        at("Full name", 10, 20),
        at("Robin Hale", 10, 22.5),
        at("Company", 10, 27),
        at("Amluto Solutions", 10, 29.5),
        at("Job title", 10, 34),
        at("Director", 10, 36.5),
        at("Department", 10, 41),
        at("Sales", 10, 43.5),
      ]),
    ).toEqual([["name", "Robin Hale", "Full name"]]);
    // A settings page: the name's box, its help text, then the next setting.
    expect(
      found([
        at("Name", 10, 20),
        at("Robin Hale", 10.5, 22.6),
        at("Your name may appear where you share guides.", 10, 26),
        at("Bio", 10, 31),
        at("I write the club's guides", 10.5, 33.6),
        at("Company", 10, 38),
      ]),
    ).toEqual([["name", "Robin Hale", "Name"]]);
    // A form laid out evenly, where the next label is one the finder knows.
    expect(
      found([
        at("Name", 10, 20),
        at("Robin Hale", 10, 23),
        at("Email", 10, 26),
        at("robin@example.com", 10, 29),
        at("Phone", 10, 32),
        at("07700 900123", 10, 35),
      ]),
    ).toEqual([
      ["name", "Robin Hale", "Name"],
      ["email", "robin@example.com", "Email"],
      ["phone", "07700 900123", "Phone"],
    ]);
    // An address runs on over evenly spaced lines under its label: they're the address, not a list.
    expect(
      found([
        at("Home address", 10, 20),
        at("Flat 2", 10, 23),
        at("Elm House", 10, 26),
        at("Station Road", 10, 29),
        at("Anytown", 10, 32),
      ]),
    ).toEqual([["address", "Flat 2, Elm House, Station Road, Anytown", "Home address"]]);
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
