import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The tests run the components as the apps build them: through the React Compiler. The preset
 * applies itself only to a browser build, and tests run in Vite's server environment.
 */
const compiler = reactCompilerPreset();
compiler.rolldown.applyToEnvironmentHook = () => true;

export default defineConfig({
  plugins: [babel({ presets: [compiler] })],
  test: {
    include: [
      "packages/*/src/**/*.test.{ts,tsx}",
      "apps/*/src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
    ],
    passWithNoTests: false,
    // The export tests draw PDFs, Word files and web pages: well inside 5 s on their own, but the
    // full run in parallel (or beside a release build) pushed two of them over (06/10/2026).
    testTimeout: 20_000,
  },
});
