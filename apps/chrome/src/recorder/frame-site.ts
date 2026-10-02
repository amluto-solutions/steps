/**
 * The site a frame belongs to, for excluded sites: its origin (Chrome's own, or the one the
 * capture script reports), never only its address, which for a blank, srcdoc or blob: frame names
 * no site. An excluded site's editor in a blank frame inside another page was recorded.
 */
export function frameSite(
  reported: string | undefined,
  sender: { origin?: string; url?: string },
): string | undefined {
  for (const origin of [sender.origin, reported])
    if (origin && origin !== "null" && /^https?:\/\//.test(origin)) return origin;
  const url = sender.url ?? "";
  return url.startsWith("blob:") ? url.slice("blob:".length) : url;
}
