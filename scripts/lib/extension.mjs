// Checks on the browser extension's store builds (docs/release-runbook.md#browser-extensions).

/** The Firefox add-on's id: fixed for good once listed on addons.mozilla.org. */
export const FIREFOX_ID = "steps@amluto.com";

/**
 * What's wrong with a store build's manifest, as a list (empty when it can be uploaded). The
 * end-to-end tests' build asks for native messaging from the start, as no test can answer the
 * browser's question; a store build must never be that build.
 */
export function manifestProblems(manifest, { browser, version }) {
  const problems = [];
  if (manifest.manifest_version !== 3) problems.push("it isn't Manifest V3");
  if (manifest.version !== version)
    problems.push(`its version is ${manifest.version}, not ${version}`);
  if ((manifest.permissions ?? []).includes("nativeMessaging"))
    problems.push("it asks for native messaging up front: it's the end-to-end tests' build");
  const gecko = manifest.browser_specific_settings?.gecko;
  if (browser === "firefox" && gecko?.id !== FIREFOX_ID)
    problems.push(`its Firefox id is ${gecko?.id}, not ${FIREFOX_ID}`);
  if (browser === "chrome" && gecko) problems.push("the Chrome build carries Firefox's settings");
  return problems;
}
