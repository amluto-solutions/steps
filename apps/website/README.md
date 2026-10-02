# steps.amluto.com

The Steps website: what the app does, the download, and the IT guide (`/it/`). Vite, React, Tailwind and Motion,
built to plain files and published to SiteGround beside the app's own `/download` and `/update`
folders, which it never touches.

## What's live, and what isn't

- **The download section reads the current release live**: the version and date from
  `/update/release.json` (the file the app itself updates from) and the SHA-256s from
  `/download/SHA256SUMS.txt`. A new release needs no website upload.
- **Everything else is in the build**: the screenshots, and the live demo.

## The IT guide

`it/index.html` and `src/it/ItGuide.tsx`: installing with the MSI and its properties, Group Policy,
Intune, every registry value, updates, and what the app records. It restates
`docs/spec/07-settings-and-policy.md`, `docs/spec/10-distribution.md` and the ADMX, so change it with
them. The build publishes the ADMX and ADML from `apps/desktop/policy` beside it, singly and as a
zip laid out as `PolicyDefinitions` (`vite.config.ts`), so the download always matches the commit.

## Pictures

Every picture is the real app, never a mock-up:

- `scripts/capture.mjs` photographs the desktop app's browser preview (`npm run vite:dev -w
  @amluto-steps/desktop` first) in headless Edge, at 2x, in light and dark, into
  `src/assets/shots`. The page shows the one matching the visitor's theme.
- `scripts/demo.ts` makes `public/demo/index.html`: a real interactive web page, made by the
  app's own exporter (`packages/export`) from a guide whose screenshots are those captures. It is
  generated, so it is neither committed nor formatted (its CSP hashes its inline script and style).
  Run it with `npx jiti apps/website/scripts/demo.ts` before `npm run dev -w @amluto-steps/website`.

Re-run both after a visible change to the app.

## Commands (from the repo root)

| Command | What it does |
|---|---|
| `npm run dev -w @amluto-steps/website` | the site on http://localhost:4175, with /update and /download from the live site |
| `node apps/website/scripts/review.mjs [folder]` | full-page and per-section screenshots, desktop and phone, light and dark, and a note of any page error or sideways scroll |
| `node apps/website/scripts/deploy.mjs` | builds the demo and the site, uploads them over SSH, and checks the site, the demo and the update file from outside |

## Rules

- **Nothing loads from another site**: fonts are self-hosted, there are no analytics or cookies,
  and the built page carries a CSP (`vite.config.ts`) allowing only this site.
- **Only claims that are true in the version you can download.** "New in 1.0" describes 1.0, so
  deploy it with the release it describes. A listing says "Waiting for its listing" until its
  address is set in `LISTINGS` (`components/Download.tsx`).
- **Step wording on the page is the app's own:** `src/showcase.ts` holds one small guide in nine
  languages and three tones, and `showcase.test.ts` fails if the phrasebooks word it differently.
- **Copy:** UK English, plain words, no em dashes. Dates are dd/mm/yyyy.
- Design: the taste skill's rules (Jost for headings, Geist for text; one accent, cyan on dark and
  the brand blue on light; pills for buttons, 16px panels; motion only where it tells the story,
  and none with reduced motion).
