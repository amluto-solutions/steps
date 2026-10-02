import i18n, { type TFunction } from "i18next";

import { formatDate as formatDateIn, formatTime as formatTimeIn } from "@amluto-steps/core";

/** A date in the app's language: dd/mm/yyyy in English, each language's own form otherwise. */
export const formatDate = (date: Date) => formatDateIn(date, i18n.language || "en");

/** 24-hour time, "10:32", in the app's language. */
export const formatTime = (iso: string) => formatTimeIn(new Date(iso), i18n.language || "en");

/** "29/09/2026 10:32". */
export const formatDateTime = (iso: string) => `${formatDate(new Date(iso))} ${formatTime(iso)}`;

/** "Edited 2 hours ago", "Edited yesterday", or the date for anything older than a week. */
export function formatUpdated(iso: string, t: TFunction, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return t("dates.justNow");
  if (minutes < 60) return t("dates.minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24 && now.getDate() === date.getDate()) return t("dates.hoursAgo", { count: hours });
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 1) return t("dates.yesterday");
  if (days < 7) return t("dates.daysAgo", { count: days });
  return formatDate(date);
}
