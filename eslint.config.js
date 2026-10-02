import js from "@eslint/js";
import i18next from "eslint-plugin-i18next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/target/**",
      "apps/desktop/src-tauri/gen/**",
      "apps/chrome/.output/**",
      "apps/chrome/.wxt/**",
      "tools/parity/old-rules.js",
      // Agent worktrees are full copies of the repo; they are checked in their own folder.
      ".claude/**",
      // Built releases, and the data a portable Steps run from there keeps beside itself.
      "release-out/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    files: ["**/*.tsx"],
    ...jsxA11y.flatConfigs.strict,
  },
  {
    // All UI wording comes from i18next message files (docs/spec/01-architecture.md#ui-conventions).
    files: ["packages/ui/src/**/*.tsx", "apps/*/src/**/*.tsx"],
    // The website is marketing copy in English only, written in its components.
    ignores: ["**/*.test.tsx", "apps/website/**"],
    plugins: { i18next },
    rules: { "i18next/no-literal-string": ["error", { mode: "jsx-text-only" }] },
  },
  {
    files: [
      "scripts/**/*.mjs",
      "tools/**/*.mjs",
      "*.config.{js,ts}",
      "apps/*/vite.config.ts",
      "apps/website/scripts/**",
      "store/art/*.mjs",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
);
