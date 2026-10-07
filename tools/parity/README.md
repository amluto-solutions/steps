# Capture test harness (Phase 1)

These scripts drive the **real** mouse and keyboard, so keep your hands off while they run. Every driver stops by itself if the cursor moves or the target window isn't in front. It only ever types into the test page's field that has focus.

| Script | What it proves |
|---|---|
| `run.ps1 -Page fixture` | 21 steps (20 control types and 7 typed fields), scored against the Phase 1 targets |
| `run.ps1 -Page overlays` | Chrome's hit test on a page that changes as the button goes down: a tab that swaps the page, a menu row with an unnamed inside, a drop-down's choice over tiles, a button that shows a loading screen. Every step must be named for what was clicked |
| `run.ps1 -Page forms` | privacy: 10 realistic login, payment and settings forms; no secret value is ever recorded |
| `stress.ps1` | 50 clicks at 50 per second, and a stalled worker with a 16-slot queue; every click is accounted for (recorded, double or reported missed) |
| `desktop.ps1` | Calculator, Excel (a throwaway CSV) and File Explorer (dummy files) get sensible step names |
| `../msix/smoke.ps1` | the same parity run with the recorder inside an MSIX package (needs Developer Mode) |

**Before a run:** nothing may cover the main screen. Edge doesn't lay out a window that's behind another one, so its page never reaches UI Automation and the driver stops with "element #amluto-plan not found" (07/10/2026); a script can't bring the window forward itself.

**Common switches:**
- `-Release`: use optimised builds. Timings only mean something here.
- `-Source hook|raw`: the input source.
- `-Mode window|monitor`: what the screenshot covers.
- `-Monitor 2 -PlaceSize 1500,1000`: move the test page to the second monitor (Edge reopens app windows where they last were, so the driver moves it) and size it in physical pixels. Use this for the mixed-scaling test.

**Driver commands without a script** (`apps\desktop\src-tauri\target\release\drive.exe`):
- `probe --title T --out DIR [--x --y --w --h]`: what a normal process can learn about a window without clicking it: its elevation, a screenshot, and UIA lookups at five points. This is the admin-window test, since clicks can't be injected into an elevated window.
- `tap [--ids "a|b"]`: taps test-page controls with a synthetic finger. This is the touch test: run two recorders (`proto --source hook` and `--source raw`) alongside it.
- `place --title T --x --y [--w --h]`: move and resize a window.

**How a run is checked:**
- `fixture.html` and `forms.html` publish the steps to perform (what to click and type).
- `drive.exe` performs the steps and logs where it clicked.
- `proto.exe` records.
- `report.mjs` applies the real wording code in `packages/core` to the recorded facts and scores the Phase 1 targets.

The wording comparison with the old extension (Phase 1) ran a verbatim copy of that extension's code, which was third-party. It was removed on 30/09/2026, with the copy, so runs no longer score wording parity.

**Output:**
- Results go to `%TEMP%\amluto-proto\<run name>\`: screenshots, `events.jsonl`, `session.json` and `report.html`.
- To view reports in a browser, run `node tools/parity/serve.mjs` (serves that folder on http://localhost:4174).
