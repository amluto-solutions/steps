import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import JSZip from "jszip";
import { defineConfig, type Plugin } from "vite";

/**
 * The page's content security policy, added to the built page only: the dev server injects inline
 * scripts for hot reload, which it would refuse. Nothing loads from another site; the live download
 * details come from this site's own /update and /download folders, and the demo is framed from /demo.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const csp = (): Plugin => ({
  name: "amluto-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace(
      "<head>",
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
    ),
});

/**
 * The Group Policy templates the app ships (apps/desktop/policy), published with the IT guide so
 * the download is always the version in this commit: each file on its own (Intune asks for them
 * one at a time) and a zip laid out as PolicyDefinitions.
 */
const POLICY = join(import.meta.dirname, "..", "desktop", "policy");
const policyFiles = () => ({
  "it/policy/AmlutoSteps.admx": readFileSync(join(POLICY, "AmlutoSteps.admx")),
  "it/policy/en-US/AmlutoSteps.adml": readFileSync(join(POLICY, "en-US", "AmlutoSteps.adml")),
});
const policyZip = async () => {
  const zip = new JSZip();
  const files = policyFiles();
  zip.file("PolicyDefinitions/AmlutoSteps.admx", files["it/policy/AmlutoSteps.admx"]);
  zip.file("PolicyDefinitions/en-US/AmlutoSteps.adml", files["it/policy/en-US/AmlutoSteps.adml"]);
  // A fixed date, so the same templates always make the same zip.
  const date = new Date(Date.UTC(2026, 0, 1));
  zip.forEach((_, entry) => (entry.date = date));
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
};
export const POLICY_ZIP = "it/amluto-steps-policy-templates.zip";

const policy = (): Plugin => ({
  name: "amluto-policy-templates",
  async generateBundle() {
    for (const [fileName, source] of Object.entries(policyFiles()))
      this.emitFile({ type: "asset", fileName, source });
    this.emitFile({ type: "asset", fileName: POLICY_ZIP, source: await policyZip() });
  },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split("?")[0]?.replace(/^\//, "") ?? "";
      const files: Record<string, Uint8Array> = policyFiles();
      if (path === POLICY_ZIP) {
        void policyZip().then((zip) => response.end(zip));
      } else if (files[path]) {
        response.end(files[path]);
      } else next();
    });
  },
});

/**
 * SiteGround serves plain files (not folder addresses) from its static server, which tells browsers
 * to keep them for 180 days whatever .htaccess says. The demo and the templates aren't hashed by the
 * build, so their links carry a version from their contents: a new file gets a new address.
 */
const version = (...files: (string | Uint8Array)[]) => {
  const hash = createHash("sha256");
  files.forEach((file) => hash.update(file));
  return hash.digest("hex").slice(0, 12);
};
const DEMO = join(import.meta.dirname, "public", "demo", "index.html");

export default defineConfig({
  define: {
    __DEMO_URL__: JSON.stringify(
      `/demo/index.html?v=${existsSync(DEMO) ? version(readFileSync(DEMO)) : "dev"}`,
    ),
    __POLICY_VERSION__: JSON.stringify(version(...Object.values(policyFiles()))),
  },
  // The React Compiler, as in the app (docs/engineering.md#typescript-and-react).
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss(), csp(), policy()],
  server: {
    port: 4175,
    strictPort: true,
    // In development the download details come from the live site, as they will in production.
    proxy: {
      "/update": { target: "https://steps.amluto.com", changeOrigin: true },
      "/download": { target: "https://steps.amluto.com", changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: join(import.meta.dirname, "index.html"),
        it: join(import.meta.dirname, "it", "index.html"),
        help: join(import.meta.dirname, "help", "index.html"),
      },
    },
    target: "es2023",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
