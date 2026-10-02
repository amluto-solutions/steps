// Third-party licence notices for a release (docs/spec/10-distribution.md#release-checks): every
// Rust crate and npm package that ships, its licence and its licence files, and for MPL-2.0 code,
// where its source is.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([-._].*)?$/i;

function licenceTexts(folder) {
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((name) => LICENCE_FILE.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(folder, name), "utf8").trim() }));
}

/**
 * Crates the app links: normal dependencies reachable from the app package, for Windows. Build
 * and dev dependencies don't ship; the workspace's own crates are ours.
 * @param {string} tauriDir the Rust workspace
 * @param {string} rootPackage the app package name
 */
/** The platforms the app ships on: Windows, and the Linux beta. */
export const PLATFORMS = ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"];

export function rustPackages(tauriDir, rootPackage = "amluto-steps", platforms = PLATFORMS) {
  // Every crate built into the program on any platform it ships on: one list for all, so the
  // notices in each download and Settings > About cover what that download contains.
  const packages = new Map();
  const seen = new Set();
  for (const platform of platforms) {
    const result = spawnSync(
      "cargo",
      ["metadata", "--format-version", "1", "--locked", "--filter-platform", platform],
      { cwd: tauriDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    );
    if (result.status !== 0) throw new Error(`cargo metadata failed: ${result.stderr}`);
    const metadata = JSON.parse(result.stdout);
    for (const item of metadata.packages) packages.set(item.id, item);
    const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
    const root = metadata.packages.find(
      (item) => item.name === rootPackage && item.source === null,
    );
    if (!root) throw new Error(`package ${rootPackage} not found`);
    // Walked afresh for each platform: a crate reached on Windows can have Linux-only crates
    // under it (Tauri's GTK windows).
    const reached = new Set([root.id]);
    const queue = [root.id];
    while (queue.length > 0) {
      const node = nodes.get(queue.shift());
      for (const dep of node?.deps ?? []) {
        const normal = dep.dep_kinds.some((kind) => kind.kind === null);
        if (normal && !reached.has(dep.pkg)) {
          reached.add(dep.pkg);
          queue.push(dep.pkg);
        }
      }
    }
    for (const id of reached) seen.add(id);
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((item) => item && item.source !== null)
    .map((item) => ({
      ecosystem: "cargo",
      name: item.name,
      version: item.version,
      licence: item.license ?? "see licence files",
      source: item.repository ?? `https://crates.io/crates/${item.name}/${item.version}`,
      authors: item.authors ?? [],
      files: licenceTexts(dirname(item.manifest_path)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The app's own workspaces: what they depend on ships. The website's packages don't. */
const APP_WORKSPACES = ["apps/desktop", "packages/core", "packages/export", "packages/ui"];

/**
 * Lockfile paths of the packages the app's workspaces reach through their dependencies, found
 * the way Node resolves them (the nearest node_modules folder up the tree).
 */
function appReachable(packages) {
  const resolve = (from, name) => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const at = base.lastIndexOf("/node_modules/");
      base = at >= 0 ? base.slice(0, at) : "";
    }
  };
  const seen = new Set();
  const queue = [];
  const visit = (from, names) => {
    for (const name of names) {
      const path = resolve(from, name);
      if (path && !seen.has(path) && !packages[path].link) {
        seen.add(path);
        queue.push(path);
      }
    }
  };
  for (const workspace of APP_WORKSPACES)
    visit(workspace, Object.keys(packages[workspace]?.dependencies ?? {}));
  while (queue.length > 0) {
    const path = queue.pop();
    const item = packages[path];
    visit(path, [
      ...Object.keys(item.dependencies ?? {}),
      ...Object.keys(item.optionalDependencies ?? {}),
      ...Object.keys(item.peerDependencies ?? {}),
    ]);
  }
  return seen;
}

/**
 * npm packages that ship in the app's web bundle: those its workspaces depend on, directly or
 * not, leaving out dev dependencies, the workspace's own packages and the website's.
 * @param {string} root the repo root
 */
export function npmPackages(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const reachable = appReachable(lock.packages ?? {});
  return Object.entries(lock.packages ?? {})
    .filter(([path, item]) => reachable.has(path) && !item.dev && !item.link)
    .map(([path, item]) => {
      const folder = join(root, path);
      const manifestPath = join(folder, "package.json");
      const manifest = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, "utf8"))
        : {};
      const repository =
        typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      return {
        ecosystem: "npm",
        name,
        version: item.version ?? manifest.version ?? "",
        licence: item.license ?? manifest.license ?? "see licence files",
        source: repository ?? `https://www.npmjs.com/package/${name}/v/${item.version ?? ""}`,
        authors: [manifest.author]
          .flat()
          .map((author) => (typeof author === "string" ? author : author?.name))
          .filter(Boolean),
        files: licenceTexts(folder),
      };
    })
    .filter(
      (item, index, all) =>
        all.findIndex((other) => other.name === item.name && other.version === item.version) ===
        index,
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Where Settings > About reads the list from (packages/ui). */
export const ATTRIBUTIONS_PATH = "packages/ui/src/settings/attributions.json";

/** The list Settings > About shows: each component's name, version and licence, one per line. */
export function renderAttributions(components) {
  const lines = components.map(({ ecosystem, name, version, licence }) =>
    JSON.stringify({ ecosystem, name, version, licence }),
  );
  const body = lines.map((line) => `  ${line}`).join(",\n");
  return `[\n${body}\n]\n`;
}

/**
 * Standard licence texts, for components that ship without a licence file of their own. The short
 * ones are written out; Apache-2.0 and MPL-2.0 are taken from another component's own copy.
 */
const SHORT_TEXTS = {
  MIT: `Copyright (c) the component's authors, named with it above.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
  "BSD-3-Clause": `Copyright (c) the component's authors, named with it above. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
  Zlib: `Copyright (c) the component's authors, named with it above.

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not required.

2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.`,
};

/** Another component's own copy of a long licence, recognised by its wording. */
const LONG_TEXTS = {
  "Apache-2.0": (text) =>
    /Apache License\s+Version 2\.0/.test(text) && text.includes("END OF TERMS AND CONDITIONS"),
  "MPL-2.0": (text) => /Mozilla Public License Version 2\.0/.test(text),
};

/** The SPDX licence ids an expression names: "MIT OR Apache-2.0", "MIT/Apache-2.0". */
export const licenceIds = (expression) =>
  expression
    .split(/\s+(?:OR|AND)\s+|\/|[()]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** The notices file: a summary table, then each component with its licence texts. */
export function renderNotices(version, components) {
  const lines = [
    `Steps ${version}: third-party notices`,
    "",
    "Steps includes the open-source components below, used under their own licences.",
    "Components under the MPL-2.0 are used unmodified; their source is at the address given.",
    "",
  ];
  for (const item of components) {
    lines.push(`- ${item.name} ${item.version} (${item.ecosystem}): ${item.licence}`);
  }
  for (const item of components) {
    lines.push(
      "",
      "=".repeat(78),
      `${item.name} ${item.version} (${item.ecosystem})`,
      `Licence: ${item.licence}`,
    );
    lines.push(`Source: ${item.source}`);
    if (/MPL/i.test(item.licence)) {
      lines.push(
        "MPL-2.0: this component is used unmodified; its source code is available at the address above.",
      );
    }
    if (item.files.length === 0) {
      const authors = item.authors?.length ? item.authors.join(", ") : "its authors";
      lines.push(
        "",
        `This package has no licence file of its own. Copyright: ${authors}.`,
        `The standard text of ${item.licence} is under STANDARD LICENCE TEXTS at the end of this file.`,
      );
    }
    for (const file of item.files) lines.push("", `--- ${file.name} ---`, file.text);
  }

  // The texts the packages without a licence file refer to.
  const needed = [
    ...new Set(
      components
        .filter((item) => item.files.length === 0)
        .flatMap((item) => licenceIds(item.licence)),
    ),
  ].sort();
  if (needed.length > 0) lines.push("", "=".repeat(78), "STANDARD LICENCE TEXTS");
  for (const id of needed) {
    const text =
      SHORT_TEXTS[id] ??
      (LONG_TEXTS[id] &&
        components.flatMap((item) => item.files).find((file) => LONG_TEXTS[id](file.text))?.text);
    if (!text)
      throw new Error(`no standard text for ${id}, which a package without a licence file uses`);
    lines.push("", `--- ${id} ---`, text);
  }
  return `${lines.join("\n")}\n`;
}
