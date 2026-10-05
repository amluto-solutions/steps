import type { NavigationCause } from "./engine";

/** Ways Chrome and Edge reach a page from the address bar: typed, a suggestion, a keyword search. */
const FROM_ADDRESS_BAR = new Set(["typed", "generated", "keyword", "keyword_generated"]);
/** A redirect this soon after an address-bar page belongs to it (a sign-in page, a link checker). */
const REDIRECT_MS = 10_000;

/**
 * Sorts a main-frame commit from `webNavigation.onCommitted` (04/10/2026): typed or picked in the
 * address bar, or reached from the page. A redirect straight after an address-bar page counts as
 * that page, so typing an address that forwards elsewhere still gives one "Go to", where it ended.
 */
export function navigationCause(now: () => number) {
  const fromBar = new Map<number, number>();
  return (tabId: number, type: string, qualifiers: readonly string[]): NavigationCause => {
    const redirect =
      qualifiers.includes("server_redirect") || qualifiers.includes("client_redirect");
    const typed = FROM_ADDRESS_BAR.has(type) || qualifiers.includes("from_address_bar");
    const after = fromBar.get(tabId);
    if (typed || (redirect && after !== undefined && now() - after < REDIRECT_MS)) {
      fromBar.set(tabId, now());
      return "addressBar";
    }
    fromBar.delete(tabId);
    return "page";
  };
}
