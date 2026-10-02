import type { LanguagePhrases } from "../phrase.ts";
import { en } from "./en.ts";
import { de } from "./de.ts";
import { fr } from "./fr.ts";
import { es } from "./es.ts";
import { it } from "./it.ts";
import { ptBR } from "./pt-BR.ts";
import { ja } from "./ja.ts";
import { zhHans } from "./zh-Hans.ts";
import { nl } from "./nl.ts";
import { pl } from "./pl.ts";
import { ko } from "./ko.ts";
import { ru } from "./ru.ts";
import { tr } from "./tr.ts";
import { zhHant } from "./zh-Hant.ts";
import { uk } from "./uk.ts";
import { sv } from "./sv.ts";
import { cs } from "./cs.ts";
import { id } from "./id.ts";
import { vi } from "./vi.ts";
import { da } from "./da.ts";
import { ptPT } from "./pt-PT.ts";
import { ro } from "./ro.ts";
import { hu } from "./hu.ts";
import { el } from "./el.ts";
import { fi } from "./fi.ts";
import { nb } from "./nb.ts";
import { sk } from "./sk.ts";
import { bg } from "./bg.ts";
import { hr } from "./hr.ts";
import { srLatn } from "./sr-Latn.ts";
import { srCyrl } from "./sr-Cyrl.ts";
import { ca } from "./ca.ts";
import { lt } from "./lt.ts";
import { sl } from "./sl.ts";
import { lv } from "./lv.ts";
import { et } from "./et.ts";
import { ga } from "./ga.ts";
import { mt } from "./mt.ts";

/**
 * Every language's words for steps, by language code (packages/core/src/languages.ts): all 38
 * (01/10/2026), each held to English's phrases and slots by phrasebooks.test.ts.
 */
export const PHRASEBOOKS: Partial<Record<string, LanguagePhrases>> = {
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
