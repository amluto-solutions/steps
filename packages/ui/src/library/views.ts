import type { LibraryGuideSummary } from "../library-bridge";
import type { LibraryView } from "../shell/Sidebar";

const RECENT_KEY = "amluto-steps-recent";

/** Past its review-by date (docs/spec/04-editor.md#library-view). Dates are yyyy-mm-dd. */
export const needsReview = (guide: LibraryGuideSummary) =>
  guide.reviewBy !== null && guide.reviewBy < new Date().toISOString().slice(0, 10);

/** Recently opened guides, newest first, as `<library id>/<guide id>`. */
export const readRecent = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
};

/** Puts a guide at the top of Recently opened (20 kept) and returns the new list. */
export const rememberRecent = (recent: string[], libraryId: string, guideId: string) => {
  const key = `${libraryId}/${guideId}`;
  const next = [key, ...recent.filter((item) => item !== key)].slice(0, 20);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Recently opened is a convenience only.
  }
  return next;
};

/** Each tag in the library with how many guides carry it, A to Z. */
export const tagCounts = (guides: LibraryGuideSummary[]) => {
  const counts = new Map<string, number>();
  for (const guide of guides)
    for (const tag of guide.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-GB"));
};

/** The guides a sidebar view shows; Recently opened keeps its own order. */
export const guidesInView = (
  guides: LibraryGuideSummary[],
  view: LibraryView | null,
  recent: string[],
  libraryId: string | null,
): LibraryGuideSummary[] => {
  if (!view) return guides;
  if (view.kind === "tag") return guides.filter((guide) => guide.tags.includes(view.tag));
  if (view.kind === "review") return guides.filter(needsReview);
  if (view.kind === "recent") {
    return recent
      .filter((key) => key.startsWith(`${libraryId}/`))
      .map((key) => key.slice(key.indexOf("/") + 1))
      .map((id) => guides.find((guide) => guide.id === id))
      .filter((guide): guide is LibraryGuideSummary => guide !== undefined);
  }
  return guides;
};
