/**
 * Keyboard keys as they're printed on keyboards in each language, so a step
 * says what's on the keyboard (01/10/2026), from Microsoft's Windows documentation and keyboard layouts.
 * A language or key not listed uses the English name.
 */
export const KEY_NAMES: Partial<Record<string, Partial<Record<string, string>>>> = {
  de: {
    Ctrl: "Strg",
    AltGr: "Alt Gr",
    Shift: "Umschalt",
    Enter: "Eingabetaste",
    Backspace: "Rücktaste",
    Delete: "Entf",
    Insert: "Einfg",
    Home: "Pos1",
    End: "Ende",
    "Page Up": "Bild auf",
    "Page Down": "Bild ab",
    Space: "Leertaste",
    "Caps Lock": "Feststelltaste",
    "Print Screen": "Druck",
  },
  fr: {
    AltGr: "Alt Gr",
    Shift: "Maj",
    Enter: "Entrée",
    Esc: "Échap",
    Backspace: "Retour arrière",
    Delete: "Suppr",
    Insert: "Inser",
    Home: "Origine",
    End: "Fin",
    "Page Up": "Page précédente",
    "Page Down": "Page suivante",
    Space: "Espace",
    "Caps Lock": "Verr. maj",
    "Print Screen": "Impr. écran",
  },
  es: {
    AltGr: "Alt Gr",
    Shift: "Mayús",
    Enter: "Intro",
    Backspace: "Retroceso",
    Delete: "Supr",
    Home: "Inicio",
    End: "Fin",
    "Page Up": "Re Pág",
    "Page Down": "Av Pág",
    Space: "Barra espaciadora",
    "Caps Lock": "Bloq Mayús",
    "Print Screen": "Impr Pant",
  },
  it: {
    AltGr: "Alt Gr",
    Shift: "Maiusc",
    Enter: "Invio",
    Delete: "Canc",
    Insert: "Ins",
    End: "Fine",
    "Page Up": "Pag su",
    "Page Down": "Pag giù",
    Space: "Barra spaziatrice",
    "Caps Lock": "Bloc Maiusc",
    "Print Screen": "Stamp",
  },
  "pt-BR": {
    AltGr: "Alt Gr",
    Space: "Barra de espaço",
  },
  "pt-PT": {
    AltGr: "Alt Gr",
    Backspace: "Retrocesso",
    Space: "Barra de espaços",
  },
  nl: {
    AltGr: "Alt Gr",
    Space: "Spatiebalk",
  },
  pl: {
    AltGr: "Alt Gr",
    Space: "Spacja",
  },
  ru: {
    Space: "Пробел",
  },
  tr: {
    AltGr: "Alt Gr",
    Space: "Boşluk",
  },
  uk: {
    Space: "Пробіл",
  },
  sv: {
    AltGr: "Alt Gr",
    Shift: "Skift",
    Enter: "Retur",
    Backspace: "Backsteg",
    Space: "Blanksteg",
  },
  cs: {
    Space: "Mezerník",
  },
  id: {
    Space: "Spasi",
  },
  da: {
    AltGr: "Alt Gr",
    Shift: "Skift",
    Space: "Mellemrum",
  },
  ro: {
    Space: "Bară de spațiu",
  },
  hu: {
    Space: "Szóköz",
  },
  fi: {
    AltGr: "Alt Gr",
    Shift: "Vaihto",
    Backspace: "Askelpalautin",
    Space: "Välilyönti",
  },
  nb: {
    AltGr: "Alt Gr",
    Shift: "Skift",
    Space: "Mellomrom",
  },
  sk: {
    Space: "Medzerník",
  },
  hr: {
    Space: "Razmaknica",
  },
};

/** A key's name in `language`, or the English name. */
export const keyCapName = (key: string, language: string): string =>
  KEY_NAMES[language]?.[key] ?? key;

/** What browsers and recordings call some keys, by the names the table uses. */
const ALIASES: Record<string, string> = {
  Control: "Ctrl",
  Escape: "Esc",
  Del: "Delete",
  Ins: "Insert",
  Meta: "Win",
  Windows: "Win",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  PageUp: "Page Up",
  PageDown: "Page Down",
  PgUp: "Page Up",
  PgDn: "Page Down",
  CapsLock: "Caps Lock",
  PrintScreen: "Print Screen",
  PrtSc: "Print Screen",
  Return: "Enter",
};

/** A combination such as "Ctrl + S" with each key named as `language`'s keyboards name it. */
export const localKeys = (keys: string, language: string): string =>
  keys
    .split(/(\s*\+\s*)/)
    .map((part, index) => (index % 2 ? part : keyCapName(ALIASES[part] ?? part, language)))
    .join("");
