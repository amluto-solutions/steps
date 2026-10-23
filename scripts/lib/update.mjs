// The files in steps.amluto.com/update (docs/spec/10-distribution.md#updates-for-the-exe).

/**
 * What the updater reads. The plugin looks for `<os>-x86_64-<installer>` first and then
 * `<os>-x86_64`, so only exact entries are written: the setup .exe (`windows-x86_64-nsis`), the
 * portable program (`windows-x86_64-portable`, which it asks for by name), and, for a release with
 * the Linux beta, the AppImage and the .deb (`linux-x86_64-appimage`, `linux-x86_64-deb`). An
 * .msi copy that ever asked would find nothing to install. The notes are shown as plain text; the
 * signatures are what the app trusts, the rest of this file isn't signed.
 */
export function latestJson({ version, notes, published, url, signature, portable, linux = [] }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  const entry = (download, signed) => {
    if (!download.startsWith("https://"))
      throw new Error(`the download must be HTTPS: ${download}`);
    if (!signed.trim()) throw new Error("no signature");
    return { signature: signed.trim(), url: download };
  };
  const platforms = { "windows-x86_64-nsis": entry(url, signature) };
  if (portable) platforms["windows-x86_64-portable"] = entry(portable.url, portable.signature);
  for (const item of linux) {
    if (!["appimage", "deb"].includes(item.bundle))
      throw new Error(`not a Linux package: ${item.bundle}`);
    platforms[`linux-x86_64-${item.bundle}`] = entry(item.url, item.signature);
  }
  return `${JSON.stringify(
    {
      version,
      ...(notes ? { notes } : {}),
      pub_date: published.toISOString(),
      platforms,
    },
    null,
    2,
  )}\n`;
}

/** The text under `## <version>` (or `## [v<version>] …`) in CHANGELOG.md, or null. */
export function changelogNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const escaped = version.replace(/\./g, "\\.");
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?v?${escaped}\\b`).test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const notes = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  return notes || null;
}

/**
 * The release date in the version's heading, `## 1.2.3 (dd/mm/yyyy)`, or null. CHANGELOG.md is the
 * one place a release's date is written: release.json's pub_date (which the website shows) and
 * winget's ReleaseDate are taken from it (docs/decisions.md, Distribution and IT). Midday UTC, so
 * the day is the same in every time zone people read it in, bar the date line's far edges.
 */
export function changelogDate(changelog, version) {
  const escaped = version.replace(/\./g, "\\.");
  const heading = new RegExp(`^##\\s+${escaped}\\s+\\((\\d{2})/(\\d{2})/(\\d{4})\\)\\s*$`, "m");
  const match = heading.exec(changelog.replace(/\r\n/g, "\n"));
  if (!match) return null;
  const [day, month, year] = [match[1], match[2], match[3]].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  // Date.UTC rolls 31/02 over into March; a date that doesn't exist is a typo, not a release date.
  return date.getUTCDate() === day && date.getUTCMonth() === month - 1 ? date : null;
}

/**
 * The update folder's .htaccess on SiteGround. The update manifest (a .json) must never be kept by a
 * cache (a stale copy hides a new version for as long as it lives), and the folder is never listed.
 */
export const UPDATE_HTACCESS = `# Steps updates (docs/spec/10-distribution.md#updates-for-the-exe in the amluto-steps repo).
Options -Indexes
<FilesMatch "\\.json$">
  <IfModule mod_headers.c>
    Header set Cache-Control "no-cache, no-store, must-revalidate, max-age=0"
    Header set Pragma "no-cache"
    Header set Expires "0"
  </IfModule>
</FilesMatch>
`;
