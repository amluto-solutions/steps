import type { GuideStore } from "./useGuideEditor";

/**
 * Full screenshots are large data URLs (a long guide's would be hundreds of megabytes), so only
 * the most recently used are kept; thumbnails are small and more are kept.
 */
const MAX_CACHED = { full: 24, thumbnail: 400 };

function trimImageCache(cache: Map<string, string>) {
  for (const [kind, suffix] of [
    ["full", ":f"],
    ["thumbnail", ":t"],
  ] as const) {
    const keys = [...cache.keys()].filter((key) => key.endsWith(suffix));
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHED[kind]))) cache.delete(key);
  }
}

/**
 * A store's screenshots and thumbnails, the most recently used kept in memory: the 24 most
 * recently used screenshots and 400 thumbnails, counted apart. A load that fails isn't kept, so
 * the next ask tries again.
 */
export function cachedImages(store: Pick<GuideStore, "loadImage">) {
  const cache = new Map<string, string>();
  return async (mediaId: string, thumbnail: boolean) => {
    const key = `${mediaId}:${thumbnail ? "t" : "f"}`;
    const cached = cache.get(key);
    if (cached) {
      // Most recently used last, so the oldest go first when the cache is trimmed.
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    const data = await store.loadImage(mediaId, thumbnail);
    cache.set(key, data);
    trimImageCache(cache);
    return data;
  };
}
