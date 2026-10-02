/**
 * Whether a typed value looks like it could be a password or key (A1, 01/10/2026): one word of
 * 6 to 64 characters mixing letters with digits or symbols, that isn't an email, a web address,
 * a date, a number or a cell. The export review warns about each one still shown, so a password
 * a box didn't say it was can be hidden before anything leaves. A warning, never a block: an
 * invoice number can look the same.
 */
export function looksLikeSecret(value: string): boolean {
  const text = value.trim();
  if (text.length < 6 || text.length > 64 || /\s/.test(text)) return false;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return false;
  if (/^(?:https?:\/\/|www\.)/i.test(text)) return false;
  if (/^[\d\s.,:/-]+$/.test(text)) return false;
  if (/^\$?[A-Z]{1,3}\$?\d{1,7}$/i.test(text)) return false;
  const letters = /\p{L}/u.test(text);
  const digits = /\d/.test(text);
  const symbols = /[^\p{L}\d]/u.test(text);
  const cases = /\p{Lu}/u.test(text) && /\p{Ll}/u.test(text);
  // Letters with digits or symbols, and mixed case or a symbol: "Qz7Test", "hunter2!", "a8f3k2m9".
  return (
    letters && (digits || symbols) && (cases || symbols || /\d.*\p{L}.*\d|\p{L}\d\p{L}/u.test(text))
  );
}
