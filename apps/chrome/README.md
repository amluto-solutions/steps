# Steps for Chrome

The Chrome edition (Phase 9): a Manifest V3 extension built with [WXT](https://wxt.dev) that reuses `packages/core`, `packages/ui` and `packages/export`.

| Command | What it does |
|---|---|
| `npm run dev -w @amluto-steps/chrome` | opens Chrome with the extension loaded, reloading on change |
| `npm run build -w @amluto-steps/chrome` | builds it into `.output/chrome-mv3/`, to load unpacked from `chrome://extensions` |
| `npm run zip -w @amluto-steps/chrome` | the zip for the Chrome Web Store |
