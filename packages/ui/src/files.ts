/** Characters Windows forbids in file names become spaces (docs/spec/05-export.md#saving). */
const FORBIDDEN = new Set([...'\\/:*?"<>|']);
export const safeFileName = (title: string, fallback = "Guide") =>
  [...title]
    .map((character) =>
      character.charCodeAt(0) < 32 || FORBIDDEN.has(character) ? " " : character,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || fallback;
