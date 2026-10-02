/**
 * The languages Steps speaks (01/10/2026): the app's own wording, the words recorded steps
 * are written in, and the fixed words in exports. Codes are BCP 47, as browsers and Windows give
 * them; each is named in its own language, as the language picker shows it.
 */
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt-BR", name: "Português (Brasil)" },
  { code: "ja", name: "日本語" },
  { code: "zh-Hans", name: "简体中文" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "ko", name: "한국어" },
  { code: "ru", name: "Русский" },
  { code: "tr", name: "Türkçe" },
  { code: "zh-Hant", name: "繁體中文" },
  { code: "uk", name: "Українська" },
  { code: "sv", name: "Svenska" },
  { code: "cs", name: "Čeština" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "da", name: "Dansk" },
  { code: "pt-PT", name: "Português (Portugal)" },
  { code: "ro", name: "Română" },
  { code: "hu", name: "Magyar" },
  { code: "el", name: "Ελληνικά" },
  { code: "fi", name: "Suomi" },
  { code: "nb", name: "Norsk bokmål" },
  { code: "sk", name: "Slovenčina" },
  { code: "bg", name: "Български" },
  { code: "hr", name: "Hrvatski" },
  { code: "sr-Latn", name: "Srpski (latinica)" },
  { code: "sr-Cyrl", name: "Српски (ћирилица)" },
  { code: "ca", name: "Català" },
  { code: "lt", name: "Lietuvių" },
  { code: "sl", name: "Slovenščina" },
  { code: "lv", name: "Latviešu" },
  { code: "et", name: "Eesti" },
  { code: "ga", name: "Gaeilge" },
  { code: "mt", name: "Malti" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export const LANGUAGE_CODES: readonly LanguageCode[] = LANGUAGES.map((item) => item.code);

/** The language guides were written in before they said: English. */
export const DEFAULT_LANGUAGE: LanguageCode = "en";

export const isLanguage = (code: unknown): code is LanguageCode =>
  typeof code === "string" && (LANGUAGE_CODES as readonly string[]).includes(code);

/** A language's name in its own words ("Deutsch"), or the code when it isn't one of Steps'. */
export const languageName = (code: string): string =>
  LANGUAGES.find((item) => item.code === code)?.name ?? code;

/**
 * The closest of Steps' languages to one Windows or a browser reports ("de-AT" is Deutsch,
 * "zh-CN" Simplified Chinese, "pt" Brazilian Portuguese, "sr" Serbian in Cyrillic, "no" Bokmål),
 * or null when there's none.
 */
export function matchLanguage(requested: string | null | undefined): LanguageCode | null {
  if (!requested) return null;
  const tag = requested.replace(/_/g, "-");
  const lower = tag.toLowerCase();
  const exact = LANGUAGE_CODES.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  const [base = "", ...rest] = lower.split("-");
  const subtags = new Set(rest);
  if (base === "zh")
    return subtags.has("hant") || subtags.has("tw") || subtags.has("hk") || subtags.has("mo")
      ? "zh-Hant"
      : "zh-Hans";
  if (base === "pt") return subtags.has("pt") ? "pt-PT" : "pt-BR";
  if (base === "sr") return subtags.has("latn") ? "sr-Latn" : "sr-Cyrl";
  if (base === "no" || base === "nn") return "nb";
  return LANGUAGE_CODES.find((code) => code.toLowerCase() === base) ?? null;
}
