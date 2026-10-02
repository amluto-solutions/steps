# Changelog

What changes for people using Steps, newest first. The notes under each version are shown in the app when that version is offered as an update.

## 1.0.0 (02/10/2026)

- **Steps is open source.** It's free software under the GNU GPL, version 3 or later, and its code is at github.com/amluto-solutions/steps (Settings > About > Source code). Downloads now come from GitHub.
- **Steps in 38 languages.** It follows the language Windows uses, or choose one in Settings > General > Language. The translations were made automatically: spotted a mistake? Tell us at steps@amluto.com. The setup speaks your language too.
- **Language tone:** steps can read Casual (as before), Plain language or Formal. Choose the tone for new recordings in Settings > Recording, or change a guide's under Language and tone in its menu.
- **Guides in several languages.** Pick a language under Showing in the editor: recorded steps are worded in it for you, and anything you write yourself (the title, notes, blocks) can be written in it beside the original. Library search finds the words in any of a guide's languages.
- **Export in any language.** Choose the language in the export review; for PDF and Word, More languages makes a file for each. A web page export carries every language and opens in each reader's own, with a list to switch.
- **Select several guides** in the library to move, copy, merge, export or send to the Bin together, across libraries. **Merge** makes one guide from several, from any library. **Copy to** puts a copy in another library (its versions and comments stay with the original).
- **Save to any library:** the arrow beside Save on a new recording.
- **In the Bin:** Delete for good, and Empty Bin.
- The setup's message when Steps is open is clearer, and says your guides are already saved.
- **Keyboard shortcuts:** when another copy of Steps holds one, Settings says so. Fixed: changing one shortcut hid the warning on others that another app uses.
- Guides saved by a later version of Steps keep that version's extra details when you edit them in this one.
- **Better step names.** Clicks in Windows' own apps (File Explorer, Notepad, Settings) are named after what you clicked, and a click no app names is named from the words on screen at that spot.
- **Typing:** pastes are recorded, each spreadsheet cell is its own step (in LibreOffice too), and "Open" steps come once per app, with a screenshot.
- **Privacy:**
  - A password typed into a box that doesn't say it's one stays out of the guide when the window is titled for a password.
  - Typing into something Steps can't name keeps its text out unless you turn on "Show typing into unnamed boxes".
  - The export review warns about values that look like passwords.
  - Other apps' windows lying over the one you click in are greyed out of screenshots.
  - Hiding a typed value finds it however the wording was edited.
  - Restoring a backup, or importing a settings file, asks first when it would add a library, change where recordings are saved, or record more (an app taken off your excluded list, typing recorded from the start), and lists each change.
  - Text a password manager copies is never read as a paste, and an answer typed at a terminal prompt that asks for a token or password makes no step.
  - In Steps for Chrome, a click on a tab you switch away from at once is left out rather than shown on the other tab's screenshot, a site you exclude stays excluded in the blank frames its editors use, and a page can't move where a click inside one of its frames is shown.
- **Blur suggestions: Light, Standard or Thorough**, in Settings > Privacy. Standard now finds your own account names; Thorough also finds file names and paths. Always-blur words are found however they're split or punctuated.
- **One Steps at a time:** opening it again brings the open one forward.
- **Pause and Stop in the main window** while recording, and the recording bar opens at the top centre.
- Keys are named as your keyboard names them (Strg in German), search ignores accents, and questions appear in Steps' own dialogs.
- Fixed: the language tone chosen in Settings wasn't used for new recordings; extra export languages didn't warn about untranslated text; Chinese and emoji printed as boxes in PDFs; PDF pages were left half empty; moving a guide left a copy in the Bin; the tour could seem to vanish.
- Fixed: the Contents page box in the export review couldn't be ticked; it's now offered only when the guide has header blocks.
- **Screens are named as Windows names them** in Settings, Recording, Monitors ("Screen 1, main: DELL U2720Q"), and when clicks on a screen you left out made no steps, Steps says so.
- **Dates are typed and shown your language's way**, such as the Review by date (dd/mm/yyyy in English).
- The setup is in Steps' colours.
- Fixed: the last characters of a PIN typed just before clicking elsewhere could be recorded as typed into the next box; Pause, Resume and Stop in the main window didn't work; a guide's "Edited" time ignored changes to its steps; moving one guide to another library couldn't be undone; help texts named keys in English where your keyboard says Strg, Maj or Suppr.
- Fixed: opening a menu in Notepad and other Windows apps was recorded as "Click "Close""; a file name typed into Save As could make two steps; a window that only flashed up, or the one left in front when you stopped, made an "Open" step; a choice in a drop-down list now reads "Choose" rather than "Type".

## 0.5.1 (01/10/2026)

- **Taps on a touch screen become steps**, where your finger landed, as clicks do; press and hold is a right-click. Scrolling, dragging and pinching make no steps.
- **PDF exports are tagged** for screen readers and other assistive technology: headings, steps, lists, tables and links in reading order, each screenshot with its alt text, and page headers and footers marked as such.
- **The portable Steps can update itself.** Switch on "Update automatically" in Settings > About (it starts off), or press Check for updates: a new version replaces the program where it is and keeps your Steps data folder.
- **For Steps for Chrome and Edge, once it's listed:** shared libraries. Add a OneDrive or SharePoint folder in Settings > Libraries and use the same guides as Steps on the desktop, with the same edit locks, conflict banners, drafts and comments. New recordings can be saved there too.
- Fixed: showing a step's notes saved them again, as if they'd been edited, when they had come from elsewhere. In a shared library that could turn a guide someone else was editing into an unsaved draft.

## 0.4.2 (30/09/2026)

- **Contents and document-control pages** in PDF and Word exports. Tick them under "Before the steps" in the export review: contents lists each section (from your header blocks) with its steps and, in a PDF, its page; document control lists the owner, dates, review date and saved versions.
- **"Original" screenshot quality**, in Settings > Recording: every pixel, at your screen's full size, in files several times larger. Balanced stays the default.
- **"Add a step when you switch apps"**, in Settings > Recording, is on unless you switch it off.
- **The web page's camera** eases into a zoomed-in click ("Zoom in on each click"), from a slightly wider view.
- **Not personal stays not personal.** A suggestion you mark that way isn't suggested again, even after you close the guide, and the export review no longer counts it.
- Fixed: typing a web address made several "Type" steps before the "Go to". Now it's just the "Go to", which keeps only the site, never the rest of the address.
- Fixed: in the export review, the Export button could be out of view below the checklist, and the checklist could scroll sideways.

## 0.4.1 (30/09/2026)

- **Steps for Linux, a beta.** A `.deb` and an AppImage for X11 desktops, from steps.amluto.com. They update themselves, as the Windows setup does.
- **Blur one suggestion at a time.** Each possible personal detail on a screenshot is listed with Show, Blur and Not personal, and its area pulses so it's easy to find. Show zooms in on it.
- **Zoom in on a screenshot** with the + and − buttons, Ctrl and the scroll wheel, or a pinch.
- **Undo in the export review.** Ctrl+Z, or the Undo button, takes back what you changed there, Blur all included.
- **Rename** a guide from its menu in the library, and sort the other way round: edited longest ago, Z to A, or fewest steps.
- After an export, **Open file location** sits beside Open.
- "Record what's typed" can start ticked: switch it on in Settings > Recording. You can still untick it for any recording, and your organisation can set it too.
- "Optimise web pages for sharing" is now in Settings > Export, and on unless you switch it off.
- **Update automatically**, in Settings > About, is on unless you switch it off. Switched off, Steps never contacts the update server unless you press Check for updates.
- A settings file is suggested with your name and the date.
- Fixed: the search box showed two focus outlines, and the picture picker said "Custom files".

## 0.3.1 (30/09/2026)

- The title bar says "Steps by Amluto", and so does the logo at the top left.
- Typing steps say "field" in lowercase, as click steps do: Type "Acme Ltd" in "Supplier" field.
- Settings > About: the Rust and JavaScript lists of open-source components fold away.

## 0.3.0 (29/09/2026)

- **Share a library with your team.** In a library that OneDrive or SharePoint syncs, a guide someone else has open shows who is editing, and you read along as their changes arrive. Take over editing is there if they've left it open. If two people change the same step anyway, both versions are kept and you choose which to keep; changes someone couldn't save are kept as a draft on the guide.
- **Review comments.** Comments in the editor opens threads on a step or on the whole guide, with replies, Resolve and Reopen. Anyone can comment, even while someone else is editing. Comments are never exported.
- **Easier to use without a mouse, and with a screen reader.** A clearer focus outline and field edges. A single click adds an arrow, box or blur, and the recording bar can be moved from its More menu, so nothing needs dragging. Ctrl + and Ctrl − zoom the window, and Ctrl 0 puts it back. Screen readers hear search results, the mark chosen on a screenshot and when Steps is working.
- Error messages stay until you close them.
- Settings > About lists the open-source components in two groups, Rust and JavaScript.

## 0.2.8 (29/09/2026)

- Steps has its own icon: three rising steps, in place of Amluto's "A", on the taskbar, in the Start menu and in the app.
- "Made with Steps" at the end of an export is now a link to steps.amluto.com. To leave the line off every export, switch off "Made with Steps" on exports in Settings > General.

## 0.2.7 (29/09/2026)

- Amluto Steps is now called Steps. Your guides, settings and brands carry over. If you installed an earlier version with the setup, it stays in Windows' Apps list as "Amluto Steps" next to the new Steps: uninstall it there, and your guides and settings aren't touched.
- One click on the taskbar is one step, such as Click "Microsoft Edge" on the taskbar. The taskbar, Start and the window that comes forward when a recording starts no longer add "Open" steps, and "Open" steps name the app instead of its window title.
- Settings > About says who makes Steps, with a link to amluto.com, and lists the open-source components it's built on, with their licences.
- A portable Steps: one program that runs without installing, from steps.amluto.com. It doesn't update itself.

## 0.2.6 (29/09/2026)

- Without "Record what's typed", clicking into a box such as the browser's address bar no longer adds a "Type in …" step. A step is only added when what's in the box has changed.
- The recording bar is left out of screenshots, so they show what's behind it. It stays on your screen, and screen sharing doesn't show it either. To have it back in screenshots, switch off "Hide the recording bar from screenshots" in Settings > Recording.
- Web page exports always fit the window, so Next is never pushed off the bottom. On a phone, the buttons sit in one row and the thumbnails are hidden.
- Fixed: the export screen's page options heading, the brand preview's contrast in dark mode, and the step count and date on library cards.

## 0.2.5 (29/09/2026)

- The tour's export step now mentions brands: exports can carry your own or a client's colours and logo.

## 0.2.4 (29/09/2026)

- Duplicate any brand, the built-in Amluto one included, to start a new brand from it.
- Settings > About says what time it last checked for updates, as well as the date.
- Get help: Write the email attaches the support file for you in Outlook (classic) and Thunderbird. With other email apps, the file is shown for you to attach, as before.

## 0.2.3 (29/09/2026)

- Coloured boxes now have an icon and a capital label, like documentation boxes: ℹ NOTE, ✔ TIP, ⚠ WARNING and ❗ IMPORTANT.
- Settings > About shows the right version number (it said 0.1.0 before).

## 0.2.2 (28/09/2026)

Fixes and improvements from the first round of testing.

- Clicking a link now gives one "Go to" step for where it ends up, not one for every page it passes through on the way.
- Personal details are found by the label beside them too: names, addresses, usernames, dates of birth and ID numbers. Each suggestion says why, such as "name next to Account owner". Phone numbers are found more reliably.
- Blur all: one click blurs every suggested personal detail in the guide, in the editor or on the export screen.
- Arrows, boxes and labels can be red, amber, green, black or white, as well as the brand colour.
- Crop has Apply: the editor then shows just the cropped picture, and Edit crop brings the rest back.
- Coloured boxes, as in code documentation: Note (blue), Tip (green), Warning (amber) and Important (red), between steps or inside a step's notes.
- Fix a step from the export screen: click it to open its wording, screenshot tools and alt text on top, without going back to the editor.
- Alt text can be edited, under each screenshot.
- PDF has a "One step per page" layout.
- After an export, the file's location is copied, ready to paste, and an unsaved recording is saved.
- The web page's Play keeps going until you press Pause, with a bar for each step's time and how far through you are.
- Start and Stop can share one keyboard shortcut, and setting a shortcut in Settings no longer starts a recording.
- "Add a shortcut step" is now "Show a keyboard shortcut", and works from the recording bar's menu.
- The brand editor opens in a large window.
- "Write the email" in Get help opens your email app, and the support file's folder only once.

## 0.2.1 (28/09/2026)

The first release, for testing and the pilot. (0.1.0 and 0.2.0 were never released.)

- Record a task click by click: each click becomes a step with a screenshot and wording like Click "Save". Pause, resume, Capture now, keyboard shortcut steps, and Start again.
- Record what you type, only when you tick "Record what's typed" as you start a recording. It's unticked every time, and the recording bar says "Keys recorded" while it's on.
- Commands run in PowerShell, Command Prompt or Windows Terminal become steps with the command in a code block you can copy, and, if you tick "Include command output", what it printed.
- Excel formulas become "Type the formula in cell B6" steps, and keyboard shortcuts become "Press" steps.
- Passwords and sensitive fields are never kept. In commands, anything after names like -Password or -Token is replaced with •••• and blurred in the screenshot.
- Apps you choose are never recorded, and are blacked out if they appear in a screenshot.
- Edit guides: reorder steps, add notes, highlight, arrows, boxes, labels, blur and crop.
- Suggested blurs for personal details, and Find & Blur across a guide.
- Export to PDF, Word or an interactive web page, with brand profiles.
- A short tour of the main window for new users.
- Updates download in the background and install the next time Amluto Steps opens.
