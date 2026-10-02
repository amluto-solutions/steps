import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

import { defineConfig } from "wxt";

/**
 * Steps for Chrome (docs/spec/02-capture.md#chrome-edition): a Manifest V3 extension built with
 * WXT. The full app opens in a tab and reuses packages/ui; nothing is fetched from the internet.
 * The same code builds for Firefox (`npm run build:firefox`; docs/spec/10-distribution.md#firefox),
 * where the side panel becomes Firefox's sidebar.
 */
export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-react"],
  // Explicit imports only, so `tsc -b` checks this package like the others without WXT's
  // generated globals.
  imports: false,
  manifest: ({ browser }) => {
    const firefox = browser === "firefox";
    const e2e = process.env.STEPS_E2E === "1";
    // The link with Steps for Windows ships once the desktop side can be reached (it needs this
    // extension's store id): until then the store build asks for neither of its permissions.
    const link = !firefox && (e2e || process.env.STEPS_LINK === "1");
    return {
      // In the browser's language (public/_locales; scripts/i18n/languages.mjs), English otherwise.
      name: "__MSG_extName__",
      description: firefox ? "__MSG_extDescriptionFirefox__" : "__MSG_extDescriptionChrome__",
      default_locale: "en",
      // Each permission is justified in the store listings (docs/spec/10-distribution.md):
      // storage for guides and settings; the side panel for the recorder (Firefox's sidebar needs
      // none); scripting to put the capture script into pages only while recording; every site,
      // as a recording follows the person from tab to tab and takes each screenshot; in Chrome and
      // Edge, webNavigation for the tab's frame tree, to check a click in a frame is placed by the
      // frames really around it (src/recorder/frames.ts; 02/10/2026; it adds no warning beside
      // every site's, while Firefox would ask, so there the capture script names frames). Firefox has
      // no folder picker, so "Export and remove" saves through its downloads instead.
      // Chrome and Edge only: alarms, for the minute's check that reconnects to Steps for
      // Windows, and native messaging to reach it, asked for only when the person switches that
      // on in Settings (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
      // The end-to-end tests' build has it from the start, as no test can answer the browser's
      // question (tools/chrome-e2e/desktop-link.mjs).
      permissions: [
        "storage",
        "unlimitedStorage",
        "scripting",
        ...(firefox ? ["downloads"] : ["sidePanel", "webNavigation"]),
        ...(link ? ["alarms"] : []),
        ...(link && e2e ? ["nativeMessaging"] : []),
      ],
      ...(link && !e2e ? { optional_permissions: ["nativeMessaging"] } : {}),
      host_permissions: ["<all_urls>"],
      // Made from the desktop app's icon (apps/desktop/src-tauri/icons/icon.png).
      icons: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 128: "icon/128.png" },
      action: {
        default_title: "Steps",
        default_icon: { 16: "icon/16.png", 32: "icon/32.png" },
      },
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                // Fixed for good once listed on addons.mozilla.org.
                id: "steps@amluto.com",
                strict_min_version: "128.0",
                // Nothing is sent to Amluto or anyone else (Firefox's data consent, 2025).
                data_collection_permissions: { required: ["none"] },
              },
            },
          }
        : // IT policy, set through Chrome's or Edge's browser policy (src/policy.ts). Firefox
          // takes it from its own enterprise policies, with no schema in the manifest.
          { storage: { managed_schema: "managed_schema.json" } }),
    };
  },
  // The files uploaded to the Chrome Web Store and Edge Add-ons (docs/chrome-web-store.md), and
  // to addons.mozilla.org with its sources.
  zip: {
    artifactTemplate: "steps-{{browser}}-{{version}}.zip",
    sourcesTemplate: "steps-{{browser}}-{{version}}-sources.zip",
    // addons.mozilla.org rebuilds the extension from its sources (docs/firefox-add-ons.md): the
    // workspace it's built in, with the shared packages, but not the desktop app's or the
    // website's own code, nor anything built.
    sourcesRoot: fileURLToPath(new URL("../..", import.meta.url)),
    excludeSources: [
      "apps/desktop/src/**",
      "apps/desktop/src-tauri/**",
      "apps/desktop/policy/**",
      "apps/desktop/msix/**",
      "apps/desktop/*.html",
      "apps/website/src/**",
      "apps/website/public/**",
      "apps/website/scripts/**",
      "apps/website/*.html",
      "docs/**",
      // What the public repository leaves out stays out of the sources Mozilla is sent too.
      ".claude/**",
      "AGENTS.md",
      "PLAN.md",
      "scripts/public-snapshot.mjs",
      "scripts/lib/public.mjs",
      "scripts/lib/public.test.mjs",
      "release-out/**",
      "releases/**",
      "site/**",
      "store/**",
      "tools/**",
      "**/.output/**",
      "**/.wxt/**",
      "**/dist/**",
      "**/target/**",
    ],
  },
  vite: () => ({
    // The React Compiler, as in the desktop app (docs/engineering.md#typescript-and-react).
    plugins: [babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
    build: { target: "es2023", sourcemap: false },
    // STEPS_E2E=1 builds for the end-to-end tests only (tools/firefox-e2e/run.mjs,
    // tools/chrome-e2e/shared-library.mjs and desktop-link.mjs):
    // releases are built without it, and the code it guards is left out of them.
    // STEPS_LINK=1 (or an end-to-end build) turns on the link with Steps for Windows.
    define: {
      __STEPS_E2E__: JSON.stringify(process.env.STEPS_E2E === "1"),
      __STEPS_LINK__: JSON.stringify(
        process.env.STEPS_E2E === "1" || process.env.STEPS_LINK === "1",
      ),
    },
  }),
});
