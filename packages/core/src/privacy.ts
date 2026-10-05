/**
 * Suggested blurs (docs/spec/08-privacy-and-security.md#suggested-blurs): personal data found in
 * the words OCR read from a screenshot. Suggestions help; they are not a guarantee, and the app
 * says so.
 */

/** One word OCR found, with its box as percentages of the image. */
export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrLine {
  words: OcrWord[];
}

export type SensitiveKind =
  | "email"
  | "phone"
  | "postcode"
  | "card"
  | "niNumber"
  | "iban"
  | "name"
  | "address"
  | "id"
  | "username"
  | "dateOfBirth"
  | "term"
  | "account"
  | "file"
  | "path";

/**
 * How much the suggestions look for (Settings > Privacy, "Blur suggestions"; 01/10/2026).
 * Light: emails, phone, card and bank numbers, and the always-blur words. Standard, the default,
 * adds postcodes, National Insurance numbers, details found beside their labels, and the
 * person's own account names. Thorough adds file names (recent-file lists) and file paths.
 * Suggestions are never blurred by themselves: the person blurs them, one or all at once.
 */
export type BlurStrength = "light" | "standard" | "thorough";
export const BLUR_STRENGTHS: readonly BlurStrength[] = ["light", "standard", "thorough"];
export const isBlurStrength = (value: unknown): value is BlurStrength =>
  typeof value === "string" && (BLUR_STRENGTHS as readonly string[]).includes(value);

const KINDS: Record<BlurStrength, readonly SensitiveKind[]> = {
  light: ["email", "phone", "card", "iban", "term"],
  standard: [
    "email",
    "phone",
    "card",
    "iban",
    "term",
    "postcode",
    "niNumber",
    "name",
    "address",
    "id",
    "username",
    "dateOfBirth",
    "account",
  ],
  thorough: [
    "email",
    "phone",
    "card",
    "iban",
    "term",
    "postcode",
    "niNumber",
    "name",
    "address",
    "id",
    "username",
    "dateOfBirth",
    "account",
    "file",
    "path",
  ],
};

export interface SensitiveOptions {
  strength?: BlurStrength;
  /** The person's own names: their Windows or Linux account, display name, OneDrive accounts. */
  people?: string[];
  /**
   * Words never to suggest (Settings > Privacy > Never suggest, 04/10/2026): a suggestion whose
   * text holds one, ignoring case, spaces and punctuation, is left out. Not the organisation's
   * always-blur words, which IT sets.
   */
  safe?: string[];
}

export interface Finding {
  kind: SensitiveKind;
  text: string;
  /** The area to blur, as percentages of the image, padded a little. */
  rect: { x: number; y: number; w: number; h: number };
  /**
   * The label the value was found beside ("Account owner"), when that's why it's suggested: a
   * name or an ID can't be told from its own letters, but the form says what it is.
   */
  label?: string;
}

const digitsOf = (text: string) => text.replace(/\D/g, "");

/** The Luhn check card numbers carry. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return digits.length >= 13 && digits.length <= 19 && sum % 10 === 0;
}

/** The ISO 13616 mod-97 check IBANs carry. */
export function ibanValid(text: string): boolean {
  const compact = text.replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(compact)) return false;
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const value = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

interface Rule {
  kind: Exclude<SensitiveKind, "term" | "account">;
  pattern: RegExp;
  check?: (match: string) => boolean;
}

const RULES: Rule[] = [
  // A document's name, as recent-file lists show them (F068): only at Thorough.
  {
    kind: "file",
    pattern:
      /[\p{L}\p{N}][^\\/:*?"<>|\n]{1,120}?\.(?:docx?|xlsx?|xlsm|pptx?|pdf|csv|txt|msg|eml|vsdx?|one|zip|odt|ods)\b/giu,
  },
  // A file path: C:\Users\…, \\server\share\…, /home/…, /Users/…
  {
    kind: "path",
    pattern: /(?:\b[A-Z]:\\|\\\\[\w.-]+\\|\/(?:home|Users)\/)[^\s"<>|]*/gi,
  },
  // Any letter, not only A to Z: OCR reads a "ywe" in small text as "wæ" (04/10/2026,
  // "members@flintandholwællrotary.co.uk" went unsuggested).
  {
    kind: "email",
    pattern: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/giu,
  },
  // UK numbers: 0 or +44, then 9 or 10 more digits, spaces or dashes allowed between, and the
  // area code may be in brackets ("(020) 7946 0958").
  {
    kind: "phone",
    pattern: /(?:\+44[\s-]?(?:\(0\)[\s-]?)?|\(?\b0)\d(?:\)?[\s-]?\d){8,9}\b/g,
    check: (match) => {
      const digits = digitsOf(match);
      return digits.startsWith("44")
        ? digits.length === 12
        : digits.length >= 10 && digits.length <= 11;
    },
  },
  {
    kind: "postcode",
    pattern: /\b(?:GIR ?0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})\b/gi,
  },
  // OCR often reads 1 as I or L and 0 as O in postcodes ("SW1A 1AA" came back as "SWIA IAA"
  // in testing), so capitals are also tried with those letters where digits belong. Only with the
  // space between the halves, which OCR keeps, and not with O for both digits: SiteGround's
  // "SITE TOOLS" button read as the postcode "TO OLS", 13 times on one page (04/10/2026).
  {
    kind: "postcode",
    pattern: /\b[A-PR-UWYZ][A-HK-Y]?[0-9ILO][A-Z0-9]? [0-9ILO][ABD-HJLNP-UW-Z]{2}\b/g,
    check: (match) => {
      const digits = /^[A-Z]{1,2}([0-9ILO])[A-Z0-9]? ([0-9ILO])/.exec(match);
      return !(digits?.[1] === "O" && digits[2] === "O");
    },
  },
  {
    kind: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    check: (match) => luhnValid(digitsOf(match)),
  },
  {
    kind: "niNumber",
    pattern:
      /\b(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi,
  },
  { kind: "iban", pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g, check: ibanValid },
  // OCR reads 0 as O and 1 as I or l in numbers too, and "+44" as "+ 44"; a number read like
  // that still needs 8 real digits.
  {
    kind: "phone",
    pattern: /(?:\+ ?44[\s-]?|\b[0O])[\dOIl](?:[\s-]?[\dOIl]){8,10}(?![\p{L}\p{N}])/gu,
    check: (match) => {
      if (digitsOf(match).length < 8) return false;
      const digits = digitsOf(match.replace(/O/g, "0").replace(/[Il]/g, "1"));
      return digits.startsWith("44")
        ? digits.length === 12
        : digits.length >= 10 && digits.length <= 11;
    },
  },
];

/**
 * Labels that say what the value beside them is (docs/spec/08-privacy-and-security.md#suggested-blurs).
 * Tried in order, so "User name" is a username before it's a name, and "Phone number" a phone
 * before it's an ID. Matched against the whole label, lower case, without a trailing colon or *.
 */
const LABELS: { kind: SensitiveKind; pattern: RegExp }[] = [
  {
    kind: "username",
    pattern: /^(user ?name|user id|log-?in( name| id)?|sign[- ]in( name)?|log-?on( name)?)$/,
  },
  { kind: "dateOfBirth", pattern: /^(date of birth|dob|birth ?date|birthday)$/ },
  { kind: "email", pattern: /^((contact|work|personal|home) )?e-?mail( address)?$/ },
  {
    kind: "phone",
    pattern:
      /^((contact|mobile|home|work|daytime) )?(phone|telephone|tel\.?|mobile|mobile phone)( number| no\.?)?$/,
  },
  {
    kind: "address",
    pattern:
      /^((home|billing|postal|delivery|shipping|correspondence|street|registered|business|work) )?address( line ?\d)?$/,
  },
  {
    kind: "name",
    pattern:
      /^(((full|first|last|given|middle|family|contact|customer|client|employee|user|display|account|patient|staff|legal|your) )?name|surname|forename|account owner|owner|account holder|name on card|cardholder( name)?)$/,
  },
  { kind: "id", pattern: /^[a-z][a-z -]{0,40}\b(id|number|no\.?|ref|reference)$/ },
];

/** Values that are a form's own words, not someone's details. */
const NOT_A_VALUE =
  /^(none|not set|n\/a|-+|—|optional|required|edit|change|add|remove|show|hide|verify|enter\b.*|select\b.*|choose\b.*)$/i;

/** A form's other labels and buttons: never a value, even with nothing to say what they are. */
const FORM_WORDS =
  /^(password|confirm password|new password|remember me|keep me signed in|forgot( your)? password\??|sign in|log in|next|back|submit|cancel|save|continue)$/i;

const labelKind = (text: string): SensitiveKind | null => {
  const label = text
    .toLowerCase()
    .replace(/\s*\(optional\)$/, "")
    .replace(/[\s:*：]+$/, "")
    .trim();
  if (label.length === 0 || label.split(" ").length > 5) return null;
  return LABELS.find((rule) => rule.pattern.test(label))?.kind ?? null;
};

/** Whether a value suits what its label says it is. */
function fitsKind(kind: SensitiveKind, value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text.length > 160 || NOT_A_VALUE.test(text)) return false;
  switch (kind) {
    case "id":
      // IDs only where a label says so, and then only real numbers: at least 4 digits.
      return digitsOf(text).length >= 4;
    case "phone":
      return digitsOf(text).length >= 6;
    case "dateOfBirth":
      return /\d/.test(text);
    case "email":
      // An address, with someone before the @: not a domain on its own, nor a catch-all
      // "*@domain" (04/10/2026: a mail host's "Email Address" column suggested its domain).
      return /[\p{L}\p{N}._%+-]\s?@\s?\S/u.test(text);
    default:
      return /\p{L}/u.test(text);
  }
}

/**
 * The parts of a match that pass the rule: the whole match, or else its longest runs of space- or
 * dash-separated groups that do. The patterns are greedy, so a card number followed by more digits
 * ("4111 1111 1111 1111 12 28") or an IBAN followed by a word ("… 7654 32 GBP") matches too much
 * and fails its check as a whole.
 */
function checkedParts(match: string, rule: Rule): { from: number; to: number }[] {
  if (!rule.check || rule.check(match)) return [{ from: 0, to: match.length }];
  const whole = new RegExp(`^(?:${rule.pattern.source})$`, rule.pattern.flags.replace("g", ""));
  const groups = [...match.matchAll(/[^\s-]+/g)].map((group) => ({
    from: group.index,
    to: group.index + group[0].length,
  }));
  const parts: { from: number; to: number }[] = [];
  let start = 0;
  while (start < groups.length) {
    let found = -1;
    for (let end = groups.length - 1; end >= start && found < 0; end -= 1) {
      const text = match.slice(groups[start]?.from, groups[end]?.to);
      if (whole.test(text) && rule.check(text)) found = end;
    }
    if (found >= 0) {
      parts.push({ from: groups[start]?.from ?? 0, to: groups[found]?.to ?? 0 });
      start = found + 1;
    } else start += 1;
  }
  return parts;
}

const PADDING = 0.3;

/** The box around the words a match covers, padded so descenders and edges are covered too. */
function boxFor(line: OcrLine, starts: number[], from: number, to: number): Finding["rect"] | null {
  const covered = line.words.filter((word, index) => {
    const start = starts[index] ?? 0;
    return start < to && start + word.text.length > from;
  });
  if (covered.length === 0) return null;
  const left = Math.min(...covered.map((word) => word.x)) - PADDING;
  const top = Math.min(...covered.map((word) => word.y)) - PADDING;
  const right = Math.max(...covered.map((word) => word.x + word.w)) + PADDING;
  const bottom = Math.max(...covered.map((word) => word.y + word.h)) + PADDING;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    x: round(Math.max(0, left)),
    y: round(Math.max(0, top)),
    w: round(right - Math.max(0, left)),
    h: round(bottom - Math.max(0, top)),
  };
}

interface LaidOut {
  line: OcrLine;
  text: string;
  starts: number[];
  box: { left: number; top: number; right: number; bottom: number };
}

function laidOut(line: OcrLine): LaidOut {
  const starts: number[] = [];
  let text = "";
  for (const word of line.words) {
    starts.push(text.length);
    text += `${word.text} `;
  }
  return {
    line,
    text: text.trimEnd(),
    starts,
    box: {
      left: Math.min(...line.words.map((word) => word.x)),
      top: Math.min(...line.words.map((word) => word.y)),
      right: Math.max(...line.words.map((word) => word.x + word.w)),
      bottom: Math.max(...line.words.map((word) => word.y + word.h)),
    },
  };
}

const unionOf = (rects: Finding["rect"][]): Finding["rect"] => {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  const round = (value: number) => Math.round(value * 100) / 100;
  return { x: round(left), y: round(top), w: round(right - left), h: round(bottom - top) };
};

const stripLabelEnd = (text: string) => text.replace(/[\s:*：]+$/, "");

/**
 * Values a label names: "Account owner   Robin Hale", "Username: rhale", or a form field under
 * its label. The value is looked for after the label on its own line (after a colon or a wide
 * gap), then on the same row to the right, then just below. An empty field has no value, so
 * nothing is suggested for it.
 */
function findLabelled(lines: OcrLine[]): Finding[] {
  const all = lines.filter((line) => line.words.length > 0).map(laidOut);
  const isLabel = (item: LaidOut) =>
    labelKind(item.text) !== null || /[:：]$/.test(item.text) || FORM_WORDS.test(item.text);
  const findings: Finding[] = [];
  const found = (kind: SensitiveKind, label: string, parts: { item: LaidOut; from: number }[]) => {
    const text = parts.map(({ item, from }) => item.text.slice(from).trim()).join(", ");
    if (!fitsKind(kind, text)) return;
    const rects = parts
      .map(({ item, from }) => boxFor(item.line, item.starts, from, item.text.length + 1))
      .filter((rect): rect is Finding["rect"] => rect !== null);
    if (rects.length > 0) findings.push({ kind, text, rect: unionOf(rects), label });
  };

  for (const item of all) {
    const words = item.line.words;
    const height = Math.max(0.5, item.box.bottom - item.box.top);
    // The label and its value on one line: "Name: Robin", or a wide gap between them.
    let inline = false;
    for (let count = Math.min(5, words.length - 1); count >= 1; count -= 1) {
      const labelText = words
        .slice(0, count)
        .map((word) => word.text)
        .join(" ");
      const kind = labelKind(labelText);
      const last = words[count - 1];
      const next = words[count];
      if (!kind || !last || !next) continue;
      const gap = next.x - (last.x + last.w);
      if (/[:：]$/.test(last.text) || gap > height * 2) {
        found(kind, stripLabelEnd(labelText), [{ item, from: item.starts[count] ?? 0 }]);
        inline = true;
        break;
      }
    }
    if (inline) continue;

    const kind = labelKind(item.text);
    if (!kind) continue;
    const middle = (item.box.top + item.box.bottom) / 2;
    // On the same row, to the right: the nearest line that isn't another label.
    const right = all
      .filter(
        (other) =>
          other !== item &&
          !isLabel(other) &&
          other.box.left >= item.box.right &&
          other.box.top <= middle &&
          other.box.bottom >= middle,
      )
      .sort((a, b) => a.box.left - b.box.left)[0];
    // Or just below, lined up with the label (a form field's value).
    const below = all
      .filter(
        (other) =>
          other !== item &&
          !isLabel(other) &&
          other.box.top >= item.box.bottom - height * 0.3 &&
          other.box.top <= item.box.bottom + height * 2.5 &&
          Math.abs(other.box.left - item.box.left) <= Math.max(3, height * 2),
      )
      .sort((a, b) => a.box.top - b.box.top)[0];
    const value = right ?? below;
    if (!value) continue;
    const parts = [{ item: value, from: 0 }];
    // An address runs on over the lines under its first, lined up with it.
    if (kind === "address") {
      let last = value;
      while (parts.length < 6) {
        const lineHeight = Math.max(0.5, last.box.bottom - last.box.top);
        const more = all.find(
          (other) =>
            !parts.some((part) => part.item === other) &&
            !isLabel(other) &&
            other.box.top >= last.box.bottom - lineHeight * 0.3 &&
            other.box.top <= last.box.bottom + lineHeight * 1.2 &&
            Math.abs(other.box.left - value.box.left) <= Math.max(1.5, lineHeight),
        );
        if (!more) break;
        parts.push({ item: more, from: 0 });
        last = more;
      }
    }
    found(kind, stripLabelEnd(item.text), parts);
  }
  return findings;
}

const inside = (inner: Finding["rect"], outer: Finding["rect"]) =>
  inner.x >= outer.x - 0.01 &&
  inner.y >= outer.y - 0.01 &&
  inner.x + inner.w <= outer.x + outer.w + 0.01 &&
  inner.y + inner.h <= outer.y + outer.h + 0.01;

/** `text` without the spaces OCR puts round "." and "@", and where each character came from. */
function closeUp(text: string): { text: string; at: number[] } {
  let out = "";
  const at: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (/\s/.test(character)) {
      const before = out.at(-1) ?? "";
      const after = /\S/.exec(text.slice(index))?.[0] ?? "";
      if (before === "." || before === "@" || after === "." || after === "@") continue;
    }
    out += character;
    at.push(index);
  }
  return { text: out, at };
}

/**
 * `text` with only its letters and digits, lower case, and where each came from in `text`.
 */
function squash(text: string): { letters: string; at: number[] } {
  let letters = "";
  const at: number[] = [];
  let index = 0;
  for (const character of text) {
    if (/[\p{L}\p{N}]/u.test(character)) {
      const lower = character.toLowerCase();
      letters += lower;
      for (let extra = 0; extra < lower.length; extra += 1) at.push(index);
    }
    index += character.length;
  }
  return { letters, at };
}

/**
 * Emails, UK phone numbers, postcodes, card numbers (Luhn-checked), National Insurance numbers,
 * IBANs (mod-97-checked) and the organisation's always-blur terms, found in OCR lines; and names,
 * addresses, IDs, usernames, dates of birth, phone numbers and emails found by their label.
 */
export function findSensitive(
  lines: OcrLine[],
  terms: string[] = [],
  options: SensitiveOptions = {},
): Finding[] {
  const kinds = KINDS[options.strength ?? "standard"];
  const findings: Finding[] = [];
  const squashedTerms = terms
    .map((term) => squash(term).letters)
    .filter((term) => term.length >= 2);
  const people = kinds.includes("account")
    ? (options.people ?? []).map((name) => squash(name).letters).filter((name) => name.length >= 3)
    : [];
  for (const line of lines) {
    const starts: number[] = [];
    let text = "";
    for (const word of line.words) {
      starts.push(text.length);
      text += `${word.text} `;
    }
    const add = (kind: SensitiveKind, from: number, found: string) => {
      const rect = boxFor(line, starts, from, from + found.length);
      if (rect) findings.push({ kind, text: found.trim(), rect });
    };
    for (const rule of RULES) {
      if (!kinds.includes(rule.kind)) continue;
      // Windows OCR puts spaces round the dots and @ of small text ("jo . bloggs@btinternet . com",
      // 04/10/2026: a comma-separated list gave one email of eight), so an email is looked for with
      // those spaces closed up, and its box drawn over the words it came from.
      if (rule.kind === "email") {
        const closed = closeUp(text);
        for (const match of closed.text.matchAll(rule.pattern)) {
          const from = closed.at[match.index] ?? 0;
          const to = (closed.at[match.index + match[0].length - 1] ?? from) + 1;
          add(rule.kind, from, text.slice(from, to));
        }
        continue;
      }
      for (const match of text.matchAll(rule.pattern)) {
        for (const part of checkedParts(match[0], rule)) {
          add(rule.kind, match.index + part.from, match[0].slice(part.from, part.to));
        }
      }
    }
    // Always-blur words and the person's own names, matched ignoring case, spaces and
    // punctuation: OCR reads "INV-TEST-0042" as "INV-TEST- 0042" or "INV TEST 0042" (F023).
    const line_ = squash(text);
    const matchSquashed = (wanted: string[], kind: SensitiveKind) => {
      for (const term of wanted) {
        let from = line_.letters.indexOf(term);
        while (from >= 0) {
          const start = line_.at[from] ?? 0;
          const end = (line_.at[from + term.length - 1] ?? start) + 1;
          // Whole words only: not "Quinn" inside "Quinnell".
          const before = text[start - 1] ?? " ";
          const after = text[end] ?? " ";
          if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after))
            add(kind, start, text.slice(start, end));
          from = line_.letters.indexOf(term, from + 1);
        }
      }
    };
    matchSquashed(squashedTerms, "term");
    matchSquashed(people, "account");
  }
  // A labelled value says why it's suggested, so it replaces a pattern match inside it (the
  // email in "Account owner   robin@example.com (Robin)" is one detail, not two). Always-blur words
  // are kept: they're the organisation's own list.
  const labelled = findLabelled(lines).filter((finding) => kinds.includes(finding.kind));
  const kept = findings.filter(
    (finding) =>
      finding.kind === "term" ||
      finding.kind === "account" ||
      !labelled.some((other) => inside(finding.rect, other.rect)),
  );
  // One suggestion for one area (04/10/2026: "Robin" and "Robin Hale" both listed, or the strict
  // and OCR-tolerant rules matching the same text, showed twice and blurred twice). A finding
  // inside a bigger one of the same kind goes; of two the same size, the first stays.
  const safe = (options.safe ?? [])
    .map((word) => squash(word).letters)
    .filter((word) => word.length >= 2);
  const all = [...kept, ...labelled].filter(
    (finding) =>
      finding.kind === "term" || !safe.some((word) => squash(finding.text).letters.includes(word)),
  );
  return all.filter(
    (finding, index) =>
      !all.some(
        (other, at) =>
          at !== index &&
          other.kind === finding.kind &&
          inside(finding.rect, other.rect) &&
          (!inside(other.rect, finding.rect) || at < index),
      ),
  );
}
