/**
 * Fields whose values are never read, and masking of typed values
 * (docs/spec/08-privacy-and-security.md#input-rules). The Rust capture crate's `sensitive.rs` owns
 * these rules; this is its copy for the Chrome edition, and both are checked against
 * `test-vectors/sensitive.json`, so change them together.
 */

/** Whole words or phrases, matched case-insensitively after splitting camelCase and punctuation. */
const SENSITIVE_TERMS = [
  "password",
  "passcode",
  "passwd",
  "pwd",
  "pw",
  "pin",
  "secret",
  "token",
  "otp",
  "one time",
  "cvv",
  "cvc",
  "security code",
  "memorable",
  "sort code",
  "account number",
  "card number",
  "card no",
  "passphrase",
  "security key",
  "access key",
  "private key",
  "api key",
  "apikey",
  "verification code",
  "auth code",
  "recovery code",
  "backup code",
  // "Password" in Steps' other languages, as apps in them label their fields (01/10/2026).
  "passwort",
  "kennwort",
  "mot de passe",
  "contraseña",
  "contrasena",
  "contrasenya",
  "senha",
  "palavra passe",
  "wachtwoord",
  "hasło",
  "haslo",
  "heslo",
  "jelszó",
  "jelszo",
  "salasana",
  "lösenord",
  "losenord",
  "adgangskode",
  "passord",
  "parola",
  "пароль",
  "парола",
  "лозинка",
  "şifre",
  "sifre",
  "mật khẩu",
  "mat khau",
  "κωδικός",
  "κωδικος",
  "kata sandi",
  "geslo",
  "lozinka",
  "slaptažodis",
  "slaptazodis",
  "salasõna",
  "pasfhocal",
];

/** Words in scripts written without spaces: matched anywhere in the text, not as whole words. */
const SENSITIVE_SUBSTRINGS = ["密码", "密碼", "パスワード", "暗証", "비밀번호", "암호"];

const isAlphanumeric = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
const isUpper = (ch: string | undefined) => ch !== undefined && /\p{Lu}/u.test(ch);
const isLower = (ch: string | undefined) => ch !== undefined && /\p{Ll}/u.test(ch);

/**
 * Lower-cases, splits camelCase (`cardPin` → `card pin`) and an acronym from the word after it
 * (`OTPCode` → `otp code`), and turns punctuation into spaces, so matching works on whole words
 * ("pin" matches `PIN` and `user_pin`, not "spinner"). A plural acronym stays whole (`PINs`).
 */
function normalise(text: string): string {
  const chars = [...text];
  let out = "";
  chars.forEach((ch, index) => {
    if (isAlphanumeric(ch)) {
      const previous = chars[index - 1];
      const next = chars[index + 1];
      const camel = isUpper(ch) && isLower(previous);
      const plural = next === "s" && !isAlphanumeric(chars[index + 2]);
      const acronymEnds = isUpper(ch) && isUpper(previous) && isLower(next) && !plural;
      if (camel || acronymEnds) out += " ";
      out += ch.toLowerCase();
    } else {
      out += " ";
    }
  });
  return ` ${out.split(/\s+/).filter(Boolean).join(" ")} `;
}

/** Whether any of `texts` names a sensitive field. `extraTerms` come from IT policy. */
export function looksSensitive(texts: readonly string[], extraTerms: readonly string[] = []) {
  const haystacks = texts.filter((text) => text !== "").map(normalise);
  const matches = (term: string) => {
    const needle = normalise(term);
    return haystacks.some((haystack) => haystack.includes(needle));
  };
  return (
    SENSITIVE_TERMS.some(matches) ||
    extraTerms.some(matches) ||
    texts.some((text) => SENSITIVE_SUBSTRINGS.some((word) => text.includes(word)))
  );
}

// ---------- masking typed values ----------

/** The most words one card, phone, NI or IBAN value is spread over ("GB82 WEST 1234 …" is 6). */
const MAX_WORDS = 9;

function luhn(digits: number[]): boolean {
  const sum = [...digits].reverse().reduce((total, digit, index) => {
    if (index % 2 === 1) {
      const doubled = digit * 2;
      return total + (doubled > 9 ? doubled - 9 : doubled);
    }
    return total + digit;
  }, 0);
  return sum % 10 === 0;
}

const isCard = (compact: string) => /^\d{13,19}$/.test(compact) && luhn([...compact].map(Number));

/** UK numbers: 0 and 9–10 more digits, or +44 / 0044 and 9–10 digits. */
function isUkPhone(compact: string): boolean {
  let rest: string | null = null;
  if (compact.startsWith("+44")) rest = compact.slice(3);
  else if (compact.startsWith("0044")) rest = compact.slice(4);
  if (rest !== null) rest = rest.startsWith("0") ? rest.slice(1) : rest;
  else if (compact.startsWith("0")) rest = compact.slice(1);
  return rest !== null && /^\d{9,10}$/.test(rest);
}

/** National Insurance: two letters, six digits, A–D. */
const isNi = (compact: string) => /^[A-Za-z]{2}\d{6}[A-Da-d]$/.test(compact);

/** IBAN: country, check digits, up to 30 more letters or digits, and the mod-97 check. */
function isIban(compact: string): boolean {
  const upper = compact.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(upper)) return false;
  let remainder = 0;
  for (const ch of upper.slice(4) + upper.slice(0, 4)) {
    const value = parseInt(ch, 36);
    remainder = value >= 10 ? (remainder * 100 + value) % 97 : (remainder * 10 + value) % 97;
  }
  return remainder === 1;
}

function isEmail(word: string): boolean {
  const trimmed = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  const at = trimmed.indexOf("@");
  if (at <= 0) return false;
  const domain = trimmed.slice(at + 1);
  return domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
}

const masked = (compact: string) => `••••${[...compact].slice(-4).join("")}`;

/**
 * Masks card numbers, National Insurance numbers, IBANs, email addresses and UK phone numbers in
 * a typed value, keeping the last four characters (`••••1234`), before the value is kept. A
 * safety net, not a guarantee: anything it doesn't recognise is kept as typed.
 */
export const maskValue = (value: string) =>
  maskMatching(
    value,
    true,
    (compact) => isCard(compact) || isUkPhone(compact) || isNi(compact) || isIban(compact),
  );

/** Masks card numbers and IBANs only, for commands, their output and code. */
export const maskCardNumbers = (value: string) =>
  maskMatching(value, false, (compact) => isCard(compact) || isIban(compact));

function maskMatching(value: string, emails: boolean, sensitive: (compact: string) => boolean) {
  // Words with their ranges, so the text between them is kept as it was. Punctuation that ends a
  // sentence or a list item isn't part of a word ("4111…1111, thanks").
  const words: [number, number][] = [];
  const push = (from: number, to: number) => {
    const word = value.slice(from, to).replace(/[,;:!?."']+$/, "");
    if (word) words.push([from, from + word.length]);
  };
  let start: number | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (/\s/.test(value[index] ?? "")) {
      if (start !== null) push(start, index);
      start = null;
    } else if (start === null) {
      start = index;
    }
  }
  if (start !== null) push(start, value.length);

  let out = "";
  let copied = 0;
  let index = 0;
  while (index < words.length) {
    const [from, to] = words[index] as [number, number];
    const word = value.slice(from, to);
    if (emails && isEmail(word)) {
      out += value.slice(copied, from) + masked(word.replace(/[^\p{L}\p{N}]+$/u, ""));
      copied = to;
      index += 1;
      continue;
    }
    // The longest run of words starting here that reads as one sensitive number.
    let best: [number, string] | null = null;
    let compact = "";
    for (let offset = 0; offset < MAX_WORDS && index + offset < words.length; offset += 1) {
      const [wordFrom, wordTo] = words[index + offset] as [number, number];
      const part = value.slice(wordFrom, wordTo);
      if (!/^[A-Za-z0-9+\-().]+$/.test(part)) break;
      compact += part.replace(/[^A-Za-z0-9+]/g, "");
      if (sensitive(compact)) best = [index + offset, compact];
    }
    if (best) {
      out += value.slice(copied, from) + masked(best[1]);
      copied = (words[best[0]] as [number, number])[1];
      index = best[0] + 1;
    } else {
      index += 1;
    }
  }
  return out + value.slice(copied);
}
