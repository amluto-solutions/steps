import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "./locales/en.json";

/**
 * All UI wording lives in message files, one per language (docs/spec/07-settings-and-policy.md#language).
 * English is built in; every other language is loaded when first needed, so the app doesn't carry
 * 38 languages' words into every window.
 */
const others = import.meta.glob<{ default: Record<string, unknown> }>([
  "./locales/*.json",
  "!./locales/en.json",
]);

export function initI18n(): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n.use(initReactI18next).init({
      resources: { en: { translation: en } },
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
      initAsync: false,
    });
  }
  return i18n;
}

/** The languages the app has words for (English and every `locales/<code>.json`). */
export const wordedLanguages = (): string[] => [
  "en",
  ...Object.keys(others).map((path) => path.replace(/^\.\/locales\/|\.json$/g, "")),
];

/** Loads a language's words if they aren't yet; false when the app has none for it. */
export async function loadLanguage(code: string): Promise<boolean> {
  initI18n();
  if (code === "en" || i18n.hasResourceBundle(code, "translation")) return true;
  const load = others[`./locales/${code}.json`];
  if (!load) return false;
  const { default: words } = await load();
  i18n.addResourceBundle(code, "translation", words, true, true);
  return true;
}

/**
 * Shows the app in `code` (English when it has no words for it), and marks the page with it so
 * screen readers pronounce it right. Answers the language now shown.
 */
export async function setAppLanguage(code: string): Promise<string> {
  const shown = (await loadLanguage(code)) ? code : "en";
  await i18n.changeLanguage(shown);
  if (typeof document !== "undefined") document.documentElement.lang = shown;
  return shown;
}
