/**
 * Text as a search compares it: lower case, and each letter without its accents, so "ubersicht"
 * finds "Übersicht" and "cafe" finds "Café" (01/10/2026). One character in, one out, so a
 * match's place in the folded text is its place in the original. The desktop's library search
 * does the same (`fold` in crates/library/src/search.rs).
 */
export const foldForSearch = (text: string): string =>
  Array.from(text, (character) => {
    const lower = character.toLowerCase();
    const first = Array.from(lower)[0] ?? character;
    return Array.from(first.normalize("NFD"))[0] ?? first;
  }).join("");
