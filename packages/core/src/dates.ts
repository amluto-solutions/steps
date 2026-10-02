const pad = (value: number) => String(value).padStart(2, "0");

/**
 * A date as `language` writes it: dd/mm/yyyy in English, and each other language's own
 * short form ("01.10.2026", "2026/10/01"), in the app and in exports (01/10/2026).
 */
export const formatDate = (date: Date, language = "en"): string => {
  if (language === "en")
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  try {
    return new Intl.DateTimeFormat(language, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    // An engine without this language: the English form.
    return formatDate(date);
  }
};

type DatePart = "day" | "month" | "year";

/** The order `language` writes a date's parts in: day, month, year for English. */
export const dateOrder = (language = "en"): DatePart[] => {
  if (language === "en") return ["day", "month", "year"];
  try {
    const order = new Intl.DateTimeFormat(language, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(2026, 11, 31))
      .map((part) => part.type)
      .filter((type): type is DatePart => type === "day" || type === "month" || type === "year");
    return order.length === 3 ? order : ["day", "month", "year"];
  } catch {
    return ["day", "month", "year"];
  }
};

/**
 * A date typed the way `language` writes it ("31/12/2026", "31.12.2026", "2026/12/31"), as
 * yyyy-mm-dd; null when it isn't a real date. Any separator will do, and a two-digit year is
 * this century.
 */
export const parseDate = (text: string, language = "en"): string | null => {
  const numbers = text.trim().split(/\D+/).filter(Boolean).map(Number);
  if (numbers.length !== 3) return null;
  const parts: Record<DatePart, number> = { day: 0, month: 0, year: 0 };
  dateOrder(language).forEach((part, index) => (parts[part] = numbers[index] ?? 0));
  const year = parts.year < 100 ? 2000 + parts.year : parts.year;
  const date = new Date(year, parts.month - 1, parts.day);
  if (
    year > 9999 ||
    date.getFullYear() !== year ||
    date.getMonth() !== parts.month - 1 ||
    date.getDate() !== parts.day
  )
    return null;
  return `${year}-${pad(parts.month)}-${pad(parts.day)}`;
};

/** A yyyy-mm-dd date as `language` writes it. */
export const formatIsoDate = (iso: string, language = "en"): string => {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return formatDate(new Date(year, month - 1, day), language);
};

/** 24-hour time, "10:32", as `language` writes it. */
export const formatTime = (date: Date, language = "en"): string => {
  try {
    return date.toLocaleTimeString(language === "en" ? "en-GB" : language, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
};
