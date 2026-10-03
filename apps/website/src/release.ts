import { createContext, useContext, useEffect, useState } from "react";

/**
 * Steps' public repository. The release files are on its GitHub Releases from 1.0.0; the page reads
 * the version and the hashes from this site (/update/release.json, /download/SHA256SUMS.txt), as a
 * page may only fetch from its own site, and links to the files there (02/10/2026).
 */
export const REPOSITORY_URL = "https://github.com/amluto-solutions/steps";

/**
 * The repository's stars, as of the site's last deploy: deploy.mjs asks GitHub and writes
 * /github.json, so a visitor's browser never contacts GitHub (and the page may only fetch from its
 * own site). Undefined until it loads, or where there's no file (the dev server).
 */
export function useGitHub(): { stars: number } | undefined {
  const [github, setGitHub] = useState<{ stars: number }>();
  useEffect(() => {
    let live = true;
    fetch("/github.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { stars?: unknown } | null) => {
        if (live && typeof data?.stars === "number") setGitHub({ stars: data.stars });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return github;
}

/** A version's release page, or the newest release's when the version isn't known yet. */
export const releasePage = (version?: string) =>
  version ? `${REPOSITORY_URL}/releases/tag/v${version}` : `${REPOSITORY_URL}/releases/latest`;

/** One downloadable file and its SHA-256, as published in /download/SHA256SUMS.txt. */
export interface ReleaseFile {
  name: string;
  url: string;
  sha256: string | null;
}

export interface Release {
  version: string;
  /** dd/mm/yyyy, the app's own date format. */
  published: string | null;
  setup: ReleaseFile;
  /** The portable program: runs without installing, updates itself once that's switched on. */
  portable: ReleaseFile;
  msi: ReleaseFile;
  /** The Linux beta (X11): a .deb and an AppImage, when the release has them. */
  linux: { deb: ReleaseFile; appImage: ReleaseFile } | null;
}

export type ReleaseState =
  { kind: "loading" } | { kind: "ready"; release: Release } | { kind: "error" };

const day = (iso: unknown): string | null => {
  if (typeof iso !== "string") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
};

/** "hash  name" lines, as sha256sum writes them. */
export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[1] && match[2]) sums.set(match[2].trim(), match[1].toLowerCase());
  }
  return sums;
}

/** The release the app itself updates to, read live, so the page never needs a new upload. */
export async function loadRelease(): Promise<Release> {
  // The app's update file says which version is current; the checksums file has the hashes.
  const [manifest, sums] = await Promise.all([
    fetch("/update/release.json", { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`release.json ${response.status}`);
      return response.json() as Promise<{ version?: unknown; pub_date?: unknown }>;
    }),
    fetch("/download/SHA256SUMS.txt", { cache: "no-store" }).then((response) =>
      response.ok ? response.text() : "",
    ),
  ]);
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("No version in release.json");
  const checksums = parseChecksums(sums);
  const file = (name: string): ReleaseFile => ({
    name,
    url: `${REPOSITORY_URL}/releases/download/v${version}/${name}`,
    sha256: checksums.get(name) ?? null,
  });
  return {
    version,
    published: day(manifest.pub_date),
    setup: file(`amluto-steps-${version}-x64-setup.exe`),
    portable: file(`amluto-steps-${version}-x64-portable.exe`),
    msi: file(`amluto-steps-${version}-x64.msi`),
    // Shown only when both are in the checksums: a release without them has no Linux beta.
    linux: ((deb, appImage) => (deb.sha256 && appImage.sha256 ? { deb, appImage } : null))(
      file(`amluto-steps-${version}-amd64.deb`),
      file(`amluto-steps-${version}-x86_64.AppImage`),
    ),
  };
}

export function useRelease(): ReleaseState {
  const [state, setState] = useState<ReleaseState>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    loadRelease()
      .then((release) => live && setState({ kind: "ready", release }))
      .catch(() => live && setState({ kind: "error" }));
    return () => {
      live = false;
    };
  }, []);
  return state;
}

/** The release, loaded once for the whole page (the download section and the IT tile use it). */
export const ReleaseContext = createContext<ReleaseState>({ kind: "loading" });
export const useReleaseState = () => useContext(ReleaseContext);
