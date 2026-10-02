/**
 * Sites never recorded in Steps for Chrome (docs/spec/02-capture.md#chrome-edition), the
 * browser's equivalent of excluded apps. A site is kept as its host name, and it covers the
 * pages under it: `bank.example` also stops `online.bank.example` being recorded.
 */

const HOST = /^(?=.{1,253}$)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/;

/**
 * The site a person typed or pasted, as it's kept: the host name, lowercase, without `www.`.
 * An address is cut to its host, so no path or query is ever kept. Null when it isn't a site.
 */
export function siteName(text: string): string | null {
  const typed = text.trim().toLowerCase();
  if (!typed) return null;
  let host: string;
  try {
    host = new URL(typed.includes("://") ? typed : `https://${typed}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "").replace(/^www\./, "");
  return HOST.test(host) ? host : null;
}

/** Whether a page's address is on one of the sites, or a site under one. */
export function siteExcluded(url: string, sites: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}
