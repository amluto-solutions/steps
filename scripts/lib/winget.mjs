// Windows Package Manager manifests for a release (docs/spec/10-distribution.md#winget): the
// setup .exe for one person (winget's default) and the .msi for the whole PC
// (`winget install Amluto.Steps --scope machine`), both from the public download folder. They're
// submitted to microsoft/winget-pkgs once the downloads are live, so each version's files must
// stay there (winget checks them against the SHA-256 given here).

import { execFileSync } from "node:child_process";

import { releasePage, REPOSITORY } from "./github.mjs";

export const PACKAGE_ID = "Amluto.Steps";
/** The manifest schema, which `winget validate` checks them against. */
export const MANIFEST_VERSION = "1.10.0";
/** The setup's uninstall entry is named after the product (Tauri's NSIS template). */
const SETUP_PRODUCT_CODE = "Steps";
const PUBLISHER = "Amluto Solutions Ltd";

/** A YAML scalar: JSON's double-quoted strings are valid YAML, so nothing needs escaping by hand. */
const scalar = (value) => JSON.stringify(String(value));

/** One manifest file: the schema comment for editors, then its fields in order. */
function manifest(type, fields) {
  const schema = type === "defaultLocale" ? "defaultLocale" : type;
  const lines = [
    `# Created by npm run release (scripts/lib/winget.mjs) in the amluto-steps repo.`,
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${schema}.${MANIFEST_VERSION}.schema.json`,
    "",
  ];
  const write = (value, indent) => {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || item === null) continue;
      if (Array.isArray(item)) {
        lines.push(`${indent}${key}:`);
        for (const entry of item) {
          if (typeof entry === "object") {
            const [first, ...rest] = Object.entries(entry).filter(([, part]) => part != null);
            if (!first) continue;
            const inner = `${indent}  `;
            lines.push(`${indent}- ${first[0]}: ${render(first[1], inner)}`);
            write(Object.fromEntries(rest), `${inner}`);
          } else {
            lines.push(`${indent}- ${scalar(entry)}`);
          }
        }
      } else if (typeof item === "object") {
        lines.push(`${indent}${key}:`);
        write(item, `${indent}  `);
      } else {
        lines.push(`${indent}${key}: ${render(item, indent)}`);
      }
    }
  };
  const render = (item) => (typeof item === "number" ? String(item) : scalar(item));
  write({ ...fields, ManifestType: type, ManifestVersion: MANIFEST_VERSION }, "");
  return `${lines.join("\n")}\n`;
}

/**
 * The three manifest files for one version, by file name, as winget-pkgs lays them out under
 * `manifests/a/Amluto/Steps/<version>/`.
 */
export function wingetManifests({ version, released, setup, msi, notes }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a release version: ${version}`);
  for (const file of [setup, msi]) {
    if (!/^https:\/\//.test(file.url)) throw new Error(`${file.url} isn't an https address`);
    if (!/^[0-9a-f]{64}$/i.test(file.sha256)) throw new Error(`${file.url} has no SHA-256`);
  }
  const guid = /^\{[0-9A-F-]{36}\}$/;
  if (!guid.test(msi.productCode)) throw new Error(`the .msi's ProductCode ${msi.productCode}`);
  if (!guid.test(msi.upgradeCode)) throw new Error(`the .msi's UpgradeCode ${msi.upgradeCode}`);
  const identity = { PackageIdentifier: PACKAGE_ID, PackageVersion: version };
  const date = released.toISOString().slice(0, 10);
  return {
    [`${PACKAGE_ID}.yaml`]: manifest("version", { ...identity, DefaultLocale: "en-GB" }),
    [`${PACKAGE_ID}.installer.yaml`]: manifest("installer", {
      ...identity,
      Platform: ["Windows.Desktop"],
      // WebView2's own minimum. Windows 11 is what's supported; Windows 10 isn't blocked.
      MinimumOSVersion: "10.0.17763.0",
      ReleaseDate: date,
      UpgradeBehavior: "install",
      Installers: [
        {
          Architecture: "x64",
          InstallerType: "nullsoft",
          Scope: "user",
          InstallerUrl: setup.url,
          InstallerSha256: setup.sha256.toUpperCase(),
          ProductCode: SETUP_PRODUCT_CODE,
          AppsAndFeaturesEntries: [
            { DisplayName: "Steps", Publisher: PUBLISHER, ProductCode: SETUP_PRODUCT_CODE },
          ],
        },
        {
          Architecture: "x64",
          InstallerType: "wix",
          Scope: "machine",
          InstallerUrl: msi.url,
          InstallerSha256: msi.sha256.toUpperCase(),
          ProductCode: msi.productCode,
          AppsAndFeaturesEntries: [
            {
              DisplayName: "Steps",
              Publisher: PUBLISHER,
              ProductCode: msi.productCode,
              UpgradeCode: msi.upgradeCode,
            },
          ],
        },
      ],
    }),
    [`${PACKAGE_ID}.locale.en-GB.yaml`]: manifest("defaultLocale", {
      ...identity,
      PackageLocale: "en-GB",
      Publisher: PUBLISHER,
      // amluto.com itself redirected elsewhere (30/09/2026); the product site is what people need.
      PublisherUrl: "https://steps.amluto.com/",
      PublisherSupportUrl: "https://steps.amluto.com/it/",
      PrivacyUrl: "https://privacy.amluto.com/",
      Author: PUBLISHER,
      PackageName: "Steps by Amluto",
      PackageUrl: "https://steps.amluto.com/",
      License: "GPL-3.0-or-later",
      LicenseUrl: `https://github.com/${REPOSITORY}/blob/main/LICENSE`,
      Copyright: `© ${released.getUTCFullYear()} ${PUBLISHER}`,
      ReleaseNotesUrl: releasePage(version),
      ShortDescription:
        "Record a task click by click and turn it into a branded step-by-step guide.",
      Description:
        "Steps records clicks and screenshots while you work, then turns them into an editable step-by-step guide you can export as PDF, Word or an interactive walkthrough. Blur, crop and annotate the screenshots, keep guides in shared libraries, and deploy settings with Group Policy or the MSI. Nothing leaves your PC.",
      Moniker: "amluto-steps",
      Tags: [
        "documentation",
        "guides",
        "how-to",
        "screenshots",
        "step-recorder",
        "steps-recorder",
        "training",
      ],
      ReleaseNotes: notes ?? undefined,
    }),
  };
}

/**
 * The .msi's ProductCode and UpgradeCode, read from its Property table through Windows Installer
 * (winget matches an installed copy by them). The ProductCode is new with every build.
 */
export function msiCodes(path) {
  const script = [
    "$installer = New-Object -ComObject WindowsInstaller.Installer",
    "$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($env:MSI_PATH, 0))",
    "foreach ($name in 'ProductCode', 'UpgradeCode') {",
    "  $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @(\"SELECT Value FROM Property WHERE Property = '$name'\"))",
    "  [void]$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)",
    "  $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)",
    "  $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, 1)",
    "  [void]$view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)",
    "}",
  ].join("\n");
  const [productCode = "", upgradeCode = ""] = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", env: { ...process.env, MSI_PATH: path } },
  )
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim().toUpperCase());
  return { productCode, upgradeCode };
}
