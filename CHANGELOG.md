# Changelog

What changes for people using Steps, newest first. The notes under each version are shown in the app when that version is offered as an update.

## 1.0.1 (23/10/2026)

- **Passwords stay out of guides in more places.** Typing keeps what was typed only when Steps is sure which box it went to. So a password is no longer kept when a notification takes focus as you type, after a click on a box's label, in an Excel add-in, or in a remote session (Remote Desktop and other remote-access apps). To be safe, typing on a web page that ends within about a second of a click on the page's text becomes "Type" with no value; you can add what was typed in the editor.
- **Typing goes to the right place:** straight after a click it's put down to the box you clicked, not the one before, and fast typing in Excel names the cell the keys went to, with no doubled characters in formulas.
- **Clicks are named from what was under the pointer when you clicked,** not from what the click changed, in every app, and File Explorer no longer waits on most clicks. Double-clicks say Double-click, Open steps name the app ("Paint", not "mspaint"), the file name typed in Save As and Open is kept, and field names lose a trailing colon.
- **Excel:** Go To and the Name Box give Go to cell "D11", a filter arrow gives Open the filter on "Item", and the fill handle is one Fill step at any display scale.
- **Screenshots show less of what they shouldn't:** notification toasts are greyed in window mode and flagged in monitor mode, a window closed with its X shows nothing behind it, Retake greys covering windows, and screenshots are no longer flat grey while a click-through overlay is on screen. Suggested blurs find UK numbers written +44 (0)20.
- **Editing is safer:** Undo works after saving; Move to Bin from the editor goes back to the library, and Move to another library reopens the guide from its new one; Steps asks before you leave the editor, or quit, while a save is failing; a locked guide looks read-only straight away; and a recording with no steps no longer makes an empty guide.
- **Exports:** PDFs no longer fail on code containing // or ==, emoji in notes print in PDFs, and a Steps file saves like the other exports.
- **Updating from a 0.2 version** now removes the old "Amluto Steps" copy that stayed installed beside Steps.
- **Security updates** to the parts Steps is built on.

## 1.0.0 (08/10/2026)

- **The first public release.** Steps records a task click by click and turns it into a step-by-step guide, with a screenshot for every step, ready to edit and export as a PDF, a Word document or an interactive web page.
- **For Windows 11** (the setup, a portable version and an `.msi` for IT), **Linux** (a beta), and **Chrome, Edge and Firefox**.
- **Lock a guide with a password,** so nobody can change, move or delete it in Steps without it. It still shows who locked it, and anyone can view, export, duplicate or merge it. Each guide also has **Properties**.
- **Recording picks up more:** right-clicks, cells selected by dragging in Excel, copy and paste, a screenshot for every typing step and every "Go to", and web addresses only when you typed or picked them, in Chrome, Edge, Firefox and more.
- **Clicks are named more reliably** in Chrome and Edge (including choices in drop-down lists and menus), on icons labelled underneath, and on Excel cells, and **keyboard shortcuts say what they do:** Press "Ctrl + C" (Copy).
- **Faster editing:** **Record steps here** adds newly recorded steps into the guide you're editing; pick several steps at once, as in File Explorer, to move, duplicate, delete or re-record them together; the arrow keys go through the steps, and every step menu item has a keyboard shortcut.
- **Excel's fill handle is recorded:** dragging or double-clicking it becomes a step such as Fill "H8" down to "H250".
- **The web page export types what was typed** into the field on the screenshot, and you can change what a step says was typed.
- **In 38 languages.**
- **Free and open source,** under the GNU GPL, version 3 or later. The code is at github.com/amluto-solutions/steps.
