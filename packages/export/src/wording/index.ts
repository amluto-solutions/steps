import { en } from "./en";
import { de } from "./de";
import { fr } from "./fr";
import { es } from "./es";
import { it } from "./it";
import { ptBR } from "./pt-BR";
import { ja } from "./ja";
import { zhHans } from "./zh-Hans";
import { nl } from "./nl";
import { pl } from "./pl";
import { ko } from "./ko";
import { ru } from "./ru";
import { tr } from "./tr";
import { zhHant } from "./zh-Hant";
import { uk } from "./uk";
import { sv } from "./sv";
import { cs } from "./cs";
import { id } from "./id";
import { vi } from "./vi";
import { da } from "./da";
import { ptPT } from "./pt-PT";
import { ro } from "./ro";
import { hu } from "./hu";
import { el } from "./el";
import { fi } from "./fi";
import { nb } from "./nb";
import { sk } from "./sk";
import { bg } from "./bg";
import { hr } from "./hr";
import { srLatn } from "./sr-Latn";
import { srCyrl } from "./sr-Cyrl";
import { ca } from "./ca";
import { lt } from "./lt";
import { sl } from "./sl";
import { lv } from "./lv";
import { et } from "./et";
import { ga } from "./ga";
import { mt } from "./mt";
import type { ExportWordTemplates } from "./types";

/**
 * Every language's export words, by code (packages/core/src/languages.ts), each held to English's
 * words and slots by wording.test.ts.
 */
export const EXPORT_WORD_TEMPLATES: Partial<Record<string, ExportWordTemplates>> = {
  en,
  de,
  fr,
  es,
  it,
  "pt-BR": ptBR,
  ja,
  "zh-Hans": zhHans,
  nl,
  pl,
  ko,
  ru,
  tr,
  "zh-Hant": zhHant,
  uk,
  sv,
  cs,
  id,
  vi,
  da,
  "pt-PT": ptPT,
  ro,
  hu,
  el,
  fi,
  nb,
  sk,
  bg,
  hr,
  "sr-Latn": srLatn,
  "sr-Cyrl": srCyrl,
  ca,
  lt,
  sl,
  lv,
  et,
  ga,
  mt,
};

export type { ExportWordTemplates } from "./types";
