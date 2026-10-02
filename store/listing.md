# Microsoft Store listing: Steps by Amluto

Everything Partner Center asks for, ready to paste, in the order its pages ask for it. Store ID `9P6K3W69FX1J`; package identity in `apps/desktop/msix/identity.json`. Listings in all 38 of Steps' languages, from [listings/](listings/). Screenshots are in [screenshots/](screenshots/), logos in [art/](art/).

Every claim here is true of the version being submitted; check it again against `CHANGELOG.md` before each submission.

---

## Packages

Upload `release-out/<version>/Steps <version> x64.msix` (built by `npm run release` from the tag). Device family: Windows 10/11 Desktop. The package requires Windows 11 (build 22000 or later).

## Properties

| Field | Value |
|---|---|
| Category | Productivity |
| Subcategory | (none) |
| Privacy policy URL | https://privacy.amluto.com/ |
| Website | https://steps.amluto.com/ |
| Support contact | steps@amluto.com |
| Does this product access, collect or transmit personal information? | **Yes**. It takes screenshots and, only when the person ticks "Record what's typed", reads what they type. All of it stays on their PC or in a folder they choose; nothing is sent to Amluto. The privacy policy says so. |
| Product declarations | Tick "This app has been tested to meet accessibility guidelines" only after the keyboard and screen-reader pass in `docs/test-matrix.md`; leave the others unticked (no Xbox, no pen-only, no dependency on Store-only features). |
| System requirements (minimum) | Windows 11, 64-bit. Keyboard and mouse. 4 GB of memory. |
| System requirements (recommended) | 8 GB of memory; a monitor of 1920 × 1080 or more. |

## Age ratings (IARC questionnaire)

Category: **Productivity / utility**. Answer No to violence, fear, sexual content, gambling, language, controlled substances and crude humour. Then:

- Does the app let users interact or exchange content with other users? **No.** (Guides are files people save and send themselves; the app has no sharing service.)
- Does the app share the user's current physical location with others? **No.**
- Does the app allow purchases of digital goods? **No.**
- Is the app a web browser or search engine? **No.**

Expected result: **3+ / Everyone** in every region.

## Pricing and availability

Free. All markets. Visibility: **Private audience or "Hide this product in the Store" (direct link only) for the pilot**, as `docs/spec/10-distribution.md` says; public at general availability. No free trial, no add-ons.

---

## Store listings (every language)

The package declares all 38 of Steps' languages (`apps/desktop/msix/AppxManifest.xml`), so Partner Center offers a listing in each. The texts customers read (description, what's new, product features, screenshot captions and search terms) are in [listings/](listings/): [listings/en.md](listings/en.md) for English (United Kingdom), the default, and one file per other language, translated automatically (01/10/2026). In Partner Center, add each language under Store listings and paste its file's blocks. The fields below are the same in every language.

### Product name

Steps by Amluto (in every language: it's the brand).

### Screenshots

(Desktop, PNG, 2880 × 1800, in this order, with the captions from the listing's language. The same screenshots for every language: they show the app in English.)

1. `screenshots/01-editor.png`
2. `screenshots/02-library.png`
3. `screenshots/03-export-review.png`
4. `screenshots/04-web-export.png`
5. `screenshots/05-brand-editor.png`
6. `screenshots/06-start-dialog.png`

Dark-theme versions of the same screens are in `screenshots/dark/`, if you'd rather show those.

### Store logos

| Partner Center field | File |
|---|---|
| 1:1 box art (2160 × 2160) | `art/box-art-2160.png` |
| 2:3 poster art (1440 × 2160) | `art/poster-art-1440x2160.png` |
| Store logo (300 × 300) | `art/store-logo-300.png` |

### Copyright and trademark info

© 2026 Amluto Solutions Ltd

### Developed by

Amluto Solutions Ltd

### Additional license terms

(Leave empty: the standard Store terms apply. The open-source notices are in the app, Settings > About, and at steps.amluto.com/download.)

---

## Submission options

### Restricted capabilities: why the package needs them

Partner Center asks for a reason for each restricted capability. Paste these.

**runFullTrust**

```
Steps is a desktop app that records how a task is done. It needs full trust to do that: it reads the mouse through Windows Raw Input, reads the names of the buttons and fields that were clicked through Windows UI Automation, and takes a screenshot of the window at each click. None of these work from an AppContainer. It only does this while the person is recording, with a recording bar on screen the whole time, and everything stays on their PC.
```

**unvirtualizedResources**

```
Steps excludes only its own three folders from AppData virtualisation: %APPDATA%\Amluto\Steps, %LOCALAPPDATA%\com.amluto.steps and %APPDATA%\com.amluto.steps (through the manifest's ExcludedDirectories, not the whole package). Three things need it. The interactive walkthrough preview is a file Steps writes and opens in the person's browser, which can't read a package's private copy. Settings > About opens the logs and the support file in File Explorer for the person to attach to an email, which likewise can't see the private copy. And uninstalling must not delete recordings the person hasn't saved yet. Everything else stays virtualised.
```

### Notes for certification

```
No account or sign-in is needed. The Store version makes no network requests: the Store updates it.

To test: open Steps. Press New recording, then Start recording. Click a few things in any app, such as Settings or File Explorer. Press Stop on the recording bar: the guide opens with a step and a screenshot for each click. Export it with Export > PDF or Web page.

"Record what's typed" on the start screen is off by default; when ticked, the bar shows "Keys recorded" and typing becomes steps. Password fields are never recorded.

Steps starts with Windows only if the person switches it on (Settings > General), through the manifest's startup task.
```
