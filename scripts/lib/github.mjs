// Where Steps' code and release files are published (docs/spec/10-distribution.md#github-releases).
// From 1.0.0 the installers live on GitHub Releases; only the small update manifest stays on
// steps.amluto.com, at the address every installed copy checks (02/10/2026).

/** The public repository, `owner/name`. */
export const REPOSITORY = "amluto-solutions/steps";

/** The address of a file attached to a version's GitHub Release. */
export function releaseAsset(version, name) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version))
    throw new Error(`not a version: ${version}`);
  if (!/^[\w.-]+$/.test(name)) throw new Error(`not a release file name: ${name}`);
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`;
}

/** The page listing every file of a version. */
export function releasePage(version) {
  return `https://github.com/${REPOSITORY}/releases/tag/v${version}`;
}
