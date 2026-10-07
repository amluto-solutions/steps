// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import { readDefaultBrand } from "./brands";
import { NO_POLICY, parsePolicy, setPolicy, type Policy } from "./policy";
import {
  readBlurStrength,
  isLocalFolder,
  readChoices,
  readExportChoices,
  readExportPreferences,
  saveBlurStrength,
  saveChoices,
  saveExportPreferences,
  saveMadeWith,
  saveSafeTerms,
} from "./preferences";
import type { Updates } from "../app/useUpdates";
import { SettingsView, type SettingsProps, type SettingsSection } from "./SettingsView";
import type { Capabilities } from "../capabilities";
import { fakeCapabilities } from "../bridge/capabilities-fake";
import { fakeHotkeys } from "../bridge/hotkeys-fake";
import { fakeRecorderBridge } from "../bridge/recorder-bridge-fake";
import { fakeLibrary } from "../library-fake";
import type { RecorderBridge } from "../recorder-bridge";

initI18n();
beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  setPolicy(NO_POLICY);
});

const managed: Policy = {
  ...NO_POLICY,
  excludedApps: ["KeePass.exe"],
  blurTerms: ["Project Falcon"],
  autoStart: true,
  locked: ["ScreenshotMode", "ExportFolder", "AskWhereToSave"],
  disableKeystrokeRecording: true,
  defaultPdfBrand: "client",
};

const settings = (section: SettingsSection, overrides: Partial<SettingsProps> = {}) =>
  render(
    <SettingsView
      recorder={undefined}
      capabilities={overrides.recorder?.capabilities ?? fakeCapabilities()}
      library={undefined}
      section={section}
      onSection={vi.fn()}
      onBack={vi.fn()}
      locked={false}
      displayName="Robin"
      onDisplayName={vi.fn()}
      autoStart={false}
      onAutoStart={vi.fn()}
      choices={readChoices()}
      onChoices={vi.fn()}
      monitors={[]}
      inputSource="rawInput"
      onInputSource={vi.fn()}
      libraries={[]}
      onLibrariesChanged={vi.fn()}
      theme="system"
      onTheme={vi.fn()}
      appColours="amluto"
      onAppColours={vi.fn()}
      managed={false}
      onImportSettings={vi.fn()}
      onExportSettings={vi.fn()}
      notify={vi.fn()}
      version="0.1.0"
      brands={[]}
      onBrandsChanged={vi.fn()}
      blurTerms={["Acme"]}
      onBlurTerms={vi.fn()}
      {...overrides}
    />,
  );

describe("Recording settings", () => {
  it("keeps screenshots Balanced unless Original is chosen", () => {
    expect(readChoices().screenshotQuality).toBe("balanced");
    const onChoices = vi.fn();
    settings("recording", { onChoices });
    const group = screen.getByRole("radiogroup", { name: "Screenshot quality" });
    expect(
      within(group).getByRole("radio", { name: "Balanced" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Original" }));
    expect(onChoices).toHaveBeenCalledWith(
      expect.objectContaining({ screenshotQuality: "original" }),
    );
    saveChoices({ ...readChoices(), screenshotQuality: "original" });
    expect(readChoices().screenshotQuality).toBe("original");
  });

  it("adds a step when switching apps unless switched off, and IT can lock it on", () => {
    expect(readChoices().appSwitchSteps).toBe(true);
    const onChoices = vi.fn();
    settings("recording", { onChoices });
    const toggle = screen.getByRole("switch", { name: "Add a step when you switch apps" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChoices).toHaveBeenCalledWith(expect.objectContaining({ appSwitchSteps: false }));
    saveChoices({ ...readChoices(), appSwitchSteps: false });
    expect(readChoices().appSwitchSteps).toBe(false);
    cleanup();
    setPolicy({ ...NO_POLICY, locked: ["AppSwitchSteps"] });
    try {
      settings("recording");
      const locked = screen.getByRole("switch", { name: "Add a step when you switch apps" });
      expect(locked.getAttribute("aria-checked")).toBe("true");
      expect(locked).toHaveProperty("disabled", true);
    } finally {
      setPolicy(NO_POLICY);
    }
  });

  it("names screens as people know them, the main one first, never Windows' device name", () => {
    const at = (left: number) => ({ left, top: 0, right: left + 1920, bottom: 1080 });
    settings("recording", {
      monitors: [
        { bounds: at(0), primary: true, name: "DELL AW2518HF" },
        { bounds: at(1920), primary: false, name: "BenQ GW2760HS" },
        { bounds: at(3840), primary: false, name: null },
      ],
    });
    const list = screen.getByRole("combobox", { name: "Monitors" });
    expect([...list.querySelectorAll("option")].map((option) => option.textContent)).toEqual([
      "All monitors",
      "Screen 1, main: DELL AW2518HF (1920 × 1080)",
      "Screen 2: BenQ GW2760HS (1920 × 1080)",
      "Screen 3 (1920 × 1080)",
    ]);
  });

  it("hides the recording bar from screenshots unless switched off", () => {
    expect(readChoices().hideRecorderBar).toBe(true);
    const onChoices = vi.fn();
    settings("recording", { onChoices });
    const toggle = screen.getByRole("switch", { name: "Hide the recording bar from screenshots" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(onChoices).toHaveBeenCalledWith(expect.objectContaining({ hideRecorderBar: false }));
    saveChoices({ ...readChoices(), hideRecorderBar: false });
    expect(readChoices().hideRecorderBar).toBe(false);
  });
});

describe("IT policy", () => {
  it("keeps locked settings at their defaults whatever was saved", () => {
    saveChoices({
      outputSettleMs: 3_000,
      captureMode: "monitor",
      screenshotQuality: "original",
      hideRecorderBar: true,
      targetMonitor: "all",
      excludedApps: [],
      typedByDefault: false,
      outputByDefault: false,
      appSwitchSteps: false,
      showUnnamedTyping: false,
    });
    saveExportPreferences({ folder: "D:\\Exports", askEveryTime: true, optimiseForSharing: true });
    window.localStorage.setItem("amluto-steps-default-brand", "amluto");
    setPolicy(managed);
    expect(readChoices()).toMatchObject({ outputSettleMs: 3_000, captureMode: "window" });
    expect(readChoices().appSwitchSteps).toBe(false);
    expect(readChoices().screenshotQuality).toBe("original");
    setPolicy({ ...managed, locked: [...managed.locked, "AppSwitchSteps", "ScreenshotQuality"] });
    expect(readChoices().appSwitchSteps).toBe(true);
    expect(readChoices().screenshotQuality).toBe("balanced");
    setPolicy(managed);
    expect(readExportPreferences()).toMatchObject({ folder: null, askEveryTime: false });
    expect(readDefaultBrand()).toBe("client");
    setPolicy(NO_POLICY);
    expect(readChoices()).toMatchObject({ captureMode: "monitor" });
  });

  it("shows settings the organisation sets as read-only", async () => {
    setPolicy(managed);
    const { container } = settings("recording");
    // Keystroke recording switched off: no output wait, and the reason is shown.
    expect(screen.queryByRole("spinbutton", { name: "Wait for command output" })).toBeNull();
    expect(screen.getByText(/Your organisation has switched this off/)).toBeTruthy();
    expect(screen.getAllByText("Set by your organisation").length).toBeGreaterThanOrEqual(2);
    // The organisation's excluded app has no remove button; the user's own apps would.
    expect(screen.getByText("KeePass.exe")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /KeePass/ })).toBeNull();
    await expectNoSeriousAxeViolations(container);
    cleanup();

    settings("general");
    expect(
      (screen.getByRole("switch", { name: "Start when Windows starts" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("switch", { name: "Start when Windows starts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    cleanup();

    settings("privacy");
    const terms = screen.getByText("Project Falcon").closest("div");
    expect(terms).not.toBeNull();
    expect(within(terms as HTMLElement).queryByRole("button", { name: /Falcon/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Acme/ })).toBeTruthy();
  });

  it("switches the settings file import off when the organisation manages settings", () => {
    settings("general", { managed: true });
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
  });
});

describe("changing a shortcut from the keyboard", () => {
  it("switches shortcuts off while reading keys, and lets Start and Stop share one", async () => {
    const bindings = [
      { action: "startRecording" as const, keys: "ctrl+alt+shift+n", registered: true },
      { action: "stop" as const, keys: "ctrl+alt+shift+x", registered: true },
      { action: "captureNow" as const, keys: "ctrl+alt+shift+s", registered: true },
    ];
    const shared = bindings.map((binding) =>
      binding.action === "stop" ? { ...binding, keys: "ctrl+alt+shift+n" } : binding,
    );
    const suspendHotkeys = vi.fn().mockResolvedValue(bindings);
    const setHotkey = vi.fn().mockResolvedValue(shared);
    const recorder = fakeRecorderBridge({
      // Read again once shortcuts are back on: by then, what was saved.
      getHotkeys: vi.fn().mockResolvedValueOnce(bindings).mockResolvedValue(shared),
      setHotkey,
      suspendHotkeys,
    });
    settings("shortcuts", { recorder });
    fireEvent.click(await screen.findByRole("button", { name: "Change the shortcut for Stop" }));
    expect(suspendHotkeys).toHaveBeenLastCalledWith(true);
    const box = screen.getByRole("button", { name: "Press the new keys…" });
    // Capture now's keys are refused…
    fireEvent.keyDown(box, { key: "s", code: "KeyS", ctrlKey: true, altKey: true, shiftKey: true });
    expect(screen.getByRole("alert").textContent).toBe("Already used for Capture now.");
    // …but Start's are fine: one shortcut then starts and stops.
    fireEvent.keyDown(box, { key: "n", code: "KeyN", ctrlKey: true, altKey: true, shiftKey: true });
    await waitFor(() => expect(setHotkey).toHaveBeenCalledWith("stop", "ctrl+alt+shift+n"));
    await waitFor(() => expect(suspendHotkeys).toHaveBeenLastCalledWith(false));
    expect(screen.getAllByText(/Start and Stop share this/)).toHaveLength(2);
  });

  it("lets Tab move on from the key box, and Escape hands focus back to Change", async () => {
    const bindings = [{ action: "stop" as const, keys: "ctrl+alt+shift+s", registered: true }];
    const recorder = fakeRecorderBridge(fakeHotkeys(bindings));
    settings("shortcuts", { recorder });
    const change = await screen.findByRole("button", { name: "Change the shortcut for Stop" });
    fireEvent.click(change);
    const box = screen.getByRole("button", { name: "Press the new keys…" });
    expect(document.activeElement).toBe(box);
    // Tab isn't swallowed (the browser moves focus to Turn off and Cancel)…
    expect(fireEvent.keyDown(box, { key: "Tab" })).toBe(true);
    // …and nothing pulls focus back to the box on the next render.
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(box, { key: "a" }); // no modifier: a message, so a re-render
    expect(document.activeElement).toBe(cancel);
    box.focus();
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Change the shortcut for Stop" }),
      ),
    );
  });
});

describe("the export folder", () => {
  it("is on this PC's drives: a network share is refused and the folder kept", async () => {
    expect(isLocalFolder(String.raw`C:\Users\me\Downloads`)).toBe(true);
    expect(isLocalFolder(String.raw`\\?\D:\Exports`)).toBe(true);
    expect(isLocalFolder(String.raw`\\server\share`)).toBe(false);
    expect(isLocalFolder(String.raw`\\?\UNC\server\share`)).toBe(false);

    saveExportPreferences({
      folder: String.raw`C:\Exports`,
      askEveryTime: false,
      optimiseForSharing: true,
    });
    const notify = vi.fn();
    const library = fakeLibrary({ picks: { folder: String.raw`\\server\share` } });
    settings("export", { notify, library });
    fireEvent.click(screen.getByRole("button", { name: /Change folder/ }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]?.[0]).toEqual({
      kind: "error",
      text: expect.stringContaining("this PC’s drives") as unknown,
    });
    expect(readExportPreferences().folder).toBe(String.raw`C:\Exports`);
  });
});

describe("an export's choices", () => {
  it("are the person's settings in one value, with IT's locks and choices on top", () => {
    saveExportPreferences({
      folder: String.raw`C:\Exports`,
      askEveryTime: true,
      optimiseForSharing: false,
    });
    saveMadeWith(false);
    saveBlurStrength("thorough");
    saveSafeTerms(["Acme"]);
    window.localStorage.setItem("amluto-steps-default-brand", "own");
    expect(readExportChoices()).toEqual({
      folder: String.raw`C:\Exports`,
      askEveryTime: true,
      optimiseForSharing: false,
      madeWith: false,
      originalsLocked: false,
      defaultBrand: "own",
      findings: { strength: "thorough", safe: ["Acme"] },
    });

    setPolicy({
      ...managed,
      locked: [...managed.locked, "IncludeOriginals"],
      blurStrength: "light",
    });
    expect(readExportChoices()).toEqual({
      folder: null,
      askEveryTime: false,
      optimiseForSharing: false,
      madeWith: false,
      originalsLocked: true,
      defaultBrand: "client",
      findings: { strength: "light", safe: ["Acme"] },
    });
  });
});

describe("brand profiles", () => {
  it("duplicates the built-in Amluto brand as a new brand to change", () => {
    settings("brands");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate Amluto as a new brand" }));
    const dialog = screen.getByRole("dialog", { name: "New brand" });
    expect((within(dialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
      "Amluto (copy)",
    );
  });
});

describe("Updates in About", () => {
  it("says when it last checked, with the time", () => {
    settings("about", {
      updates: {
        channel: "checks",
        status: { kind: "newest", at: new Date(2026, 8, 29, 10, 1).getTime() },
        check: vi.fn(async () => undefined),
        install: vi.fn(async () => undefined),
        automatic: true,
        setAutomatic: vi.fn(),
      },
    });
    expect(
      screen.getByText("Last checked 29/09/2026 at 10:01: you have the newest version."),
    ).toBeTruthy();
  });

  const updates = (overrides: Partial<Updates>): Updates => ({
    channel: "checks",
    status: { kind: "idle" },
    check: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    automatic: true,
    setAutomatic: vi.fn(),
    ...overrides,
  });

  it("switches automatic updates off, leaving Check for updates (30/09/2026)", () => {
    const setAutomatic = vi.fn();
    settings("about", { updates: updates({ setAutomatic }) });
    const automatic = screen.getByRole("switch", { name: "Update automatically" });
    expect(automatic.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(automatic);
    expect(setAutomatic).toHaveBeenCalledWith(false);
    cleanup();
    settings("about", { updates: updates({ automatic: false }) });
    expect(screen.getByText(/Automatic updates are off/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeTruthy();
  });

  it("says who updates every other copy, without a button", () => {
    const wording = {
      store: "The Microsoft Store keeps Steps up to date.",
      msi: "Your IT team installs new versions.",
      policy: "Your organisation has switched update checks off.",
      none: "This copy of Steps doesn’t check for updates.",
    } as const;
    for (const [channel, text] of Object.entries(wording)) {
      settings("about", { updates: updates({ channel: channel as keyof typeof wording }) });
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
      cleanup();
    }
  });

  it("checks on request, and offers a downloaded version with its notes as plain text", async () => {
    const check = vi.fn(async () => undefined);
    settings("about", { updates: updates({ check }) });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(check).toHaveBeenCalled();
    cleanup();

    const install = vi.fn(async () => undefined);
    const info = { version: "0.2.0", notes: "<b>Faster</b> exports.", published: null };
    const { container } = settings("about", {
      updates: updates({ status: { kind: "ready", info }, install }),
    });
    expect(screen.getByText("Steps 0.2.0 is ready")).toBeTruthy();
    expect(screen.getByText("<b>Faster</b> exports.")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(install).toHaveBeenCalled();
    await expectNoSeriousAxeViolations(container);
  });
});

describe("Get help", () => {
  it("shows what the support file holds before anything else happens", async () => {
    const createSupportBundle = vi.fn().mockResolvedValue({
      path: "C:/AppData/support/bundle.zip",
      files: ["about.json", "settings.json", "logs/amluto-steps.log"],
    });
    const showSupportBundle = vi.fn().mockResolvedValue(undefined);
    const openSupportEmail = vi.fn().mockResolvedValue(undefined);
    const recorder = fakeRecorderBridge({
      createSupportBundle,
      showSupportBundle,
      openSupportEmail,
    });
    const { container } = settings("about", {
      recorder,
      libraries: [
        {
          id: "l1",
          name: "Payroll",
          path: "C:/Guides/Payroll",
          isDefault: true,
          managed: false,
          synced: false,
          guideCount: 3,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Make a support file" }));
    const ready = await screen.findByRole("region", { name: "Your support file is ready" });
    expect(within(ready).getByText("logs/amluto-steps.log")).toBeTruthy();
    const [settingsJson, libraries, name] = createSupportBundle.mock.calls[0] as [
      string,
      unknown,
      string,
    ];
    // Settings go as counts and choices; the library list only so it can be taken out.
    expect(JSON.parse(settingsJson)).toMatchObject({ privacy: { blurTerms: 1 } });
    expect(settingsJson).not.toContain("Acme");
    expect(libraries).toEqual([{ name: "Payroll", path: "C:/Guides/Payroll" }]);
    expect(name).toBe("Robin");
    expect(openSupportEmail).not.toHaveBeenCalled();
    await expectNoSeriousAxeViolations(container);

    // The email is for this support file, which goes with it where the mail app allows.
    fireEvent.click(within(ready).getByRole("button", { name: "Write the email" }));
    await waitFor(() =>
      expect(openSupportEmail).toHaveBeenCalledWith("C:/AppData/support/bundle.zip", false),
    );
    expect(showSupportBundle).not.toHaveBeenCalled();

    // Once the folder has been shown, it isn't shown again.
    fireEvent.click(within(ready).getByRole("button", { name: "Write the email" }));
    await waitFor(() =>
      expect(openSupportEmail).toHaveBeenLastCalledWith("C:/AppData/support/bundle.zip", true),
    );
  });
});

describe("the policy the recorder reports", () => {
  it("keeps the locks even when another field is odd, and drops unknown lock names", () => {
    const read = parsePolicy({
      ...NO_POLICY,
      excludedApps: "KeePass.exe",
      locked: ["ScreenshotMode", "RecordTypedValues", "Everything"],
      disableKeystrokeRecording: "yes",
    });
    expect(read.locked).toEqual(["ScreenshotMode"]);
    expect(read.disableKeystrokeRecording).toBe(false);
    expect(read.excludedApps).toEqual([]);
    expect(parsePolicy("nonsense")).toEqual(NO_POLICY);
  });
});

describe("Wait for command output", () => {
  const field = () => screen.getByRole("spinbutton", { name: "Wait for command output" });
  const enter = (value: string) => {
    fireEvent.change(field(), { target: { value } });
    fireEvent.blur(field());
  };

  it("keeps the old value for a blank or a word, and rounds to the half second", () => {
    const onChoices = vi.fn();
    settings("recording", { onChoices });
    enter("");
    enter("soon");
    expect(onChoices).not.toHaveBeenCalled();
    expect((field() as HTMLInputElement).value).toBe("1.5");
    enter("2.2");
    expect(onChoices).toHaveBeenLastCalledWith(expect.objectContaining({ outputSettleMs: 2_000 }));
    enter("25");
    expect(onChoices).toHaveBeenLastCalledWith(expect.objectContaining({ outputSettleMs: 10_000 }));
  });

  it("comes after the setting it belongs to", () => {
    settings("recording");
    const typed = screen.getByText("Start with “Include command output” ticked");
    expect(typed.compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

/** A recorder bridge that states these capabilities, with `more` of its parts in place. */
const withCapabilities = (changes: Partial<Capabilities>, more: Partial<RecorderBridge> = {}) =>
  fakeRecorderBridge({ capabilities: fakeCapabilities(changes), ...more });

/** What the desktop app on Linux states. */
const LINUX: Partial<Capabilities> = {
  autoStart: "signIn",
  programNames: "plain",
  hideBar: false,
  inputSources: false,
  screenWords: "tesseract",
};

/** What Steps for Chrome states (in Chrome and Edge, which can open folders). */
const BROWSER: Partial<Capabilities> = {
  records: "pages",
  autoStart: null,
  defaultLibrary: "browser",
  hotkeys: false,
  updates: false,
  support: false,
  exportFolder: false,
  openExports: false,
  commandOutput: false,
  screenWords: "page",
  savesLinkChoice: false,
};

describe("Settings on Linux", () => {
  const linux = withCapabilities(LINUX);

  it("starts at sign-in, not with Windows", () => {
    settings("general", { recorder: linux });
    expect(screen.getByText("Start when you sign in")).toBeTruthy();
    expect(screen.queryByText("Start when Windows starts")).toBeNull();
  });

  it("names programs without .exe, and leaves out what only Windows can do", () => {
    window.localStorage.removeItem("amluto-steps-excluded-apps");
    const onChoices = vi.fn();
    settings("recording", { recorder: linux, onChoices });
    expect(screen.queryByText("Hide the recording bar from screenshots")).toBeNull();
    expect(screen.queryByText("Troubleshooting options")).toBeNull();
    const field = screen.getByLabelText("App to exclude, for example keepassxc");
    fireEvent.change(field, { target: { value: "keepassxc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add app" }));
    expect(onChoices).toHaveBeenCalledWith(
      expect.objectContaining({ excludedApps: ["keepassxc"] }),
    );
  });

  it("says text is read with Tesseract", () => {
    settings("privacy", { recorder: linux });
    expect(screen.getByText(/with Tesseract, if it’s installed/)).toBeTruthy();
  });

  it("keeps Windows' own on Windows", () => {
    settings("recording");
    expect(screen.getByText("Hide the recording bar from screenshots")).toBeTruthy();
    expect(screen.getByText("Troubleshooting options")).toBeTruthy();
  });
});

const EXPORT_FOLDER = "Save exports to";
const EXPORT_ASK = "Ask where to save every time";

describe("Settings in Steps for Chrome", () => {
  it("leaves out what only the desktop has", () => {
    const browser = withCapabilities({ ...BROWSER, libraryFolders: false });
    settings("general", { recorder: browser });
    const sections = screen
      .getAllByRole("button")
      .map((button) => button.textContent?.trim())
      .filter(Boolean);
    expect(sections).toContain("General");
    expect(sections).toContain("Privacy");
    for (const hidden of ["Libraries", "Keyboard shortcuts"])
      expect(sections).not.toContain(hidden);
    expect(screen.queryByText("Start when Windows starts")).toBeNull();
  });

  it("saves exports to Chrome's downloads, with no folder to choose", async () => {
    const browser = withCapabilities(BROWSER, {
      defaultExportFolder: () => Promise.resolve("downloads"),
    });
    settings("export", { recorder: browser });
    expect(await screen.findByText(EXPORT_ASK)).toBeTruthy();
    expect(screen.queryByText(EXPORT_FOLDER)).toBeNull();
  });

  it("says the words to blur come from the pages themselves, not Windows' text recognition", () => {
    settings("privacy", { recorder: withCapabilities(BROWSER) });
    expect(screen.getByText(/the text on the pages you record/)).toBeTruthy();
    expect(screen.queryByText(/Windows’ own offline text recognition/)).toBeNull();
  });

  it("lists sites never recorded in place of apps", () => {
    window.localStorage.removeItem("amluto-steps-excluded-sites");
    const browser = withCapabilities(BROWSER);
    settings("recording", { recorder: browser });
    expect(screen.queryByText("Apps never recorded")).toBeNull();
    const field = screen.getByLabelText("Site to exclude, for example bank.example");
    fireEvent.change(field, { target: { value: "https://www.Bank.example/login?next=1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add site" }));
    expect(screen.getByText("bank.example")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("amluto-steps-excluded-sites") ?? "[]")).toEqual([
      "bank.example",
    ]);
  });

  it("has Libraries where the browser can open folders (Chrome and Edge, not Firefox)", () => {
    settings("libraries", { recorder: withCapabilities({ ...BROWSER, libraryFolders: true }) });
    expect(screen.getByRole("button", { name: /Libraries/ })).toBeTruthy();
    expect(screen.getByText(/“My guides” is kept in this browser/)).toBeTruthy();
  });

  it("leaves updates, logs and support files to the browser's store", () => {
    settings("about", {
      recorder: withCapabilities(BROWSER),
      updates: {
        channel: "store",
        status: { kind: "idle" },
        check: vi.fn(async () => undefined),
        install: vi.fn(async () => undefined),
        automatic: true,
        setAutomatic: vi.fn(),
      },
    });
    expect(screen.queryByText("The Microsoft Store keeps Steps up to date.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Make a support file" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Open logs folder/ })).toBeNull();
  });

  it("keeps them on the desktop", () => {
    settings("general");
    expect(screen.getByText("Start when Windows starts")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Keyboard shortcuts/ })).toBeTruthy();
  });
});

describe("Where Record what's typed starts (30/09/2026)", () => {
  const typed = () =>
    screen.getByRole("switch", { name: "Start with “Record what's typed” ticked" });
  const output = () =>
    screen.getByRole("switch", { name: "Start with “Include command output” ticked" });

  it("offers output only once what's typed starts ticked", () => {
    const onChoices = vi.fn();
    settings("recording", { onChoices });
    expect(typed().getAttribute("aria-checked")).toBe("false");
    expect((output() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(typed());
    expect(onChoices).toHaveBeenCalledWith(expect.objectContaining({ typedByDefault: true }));
  });

  it("shows what IT set, read-only", () => {
    setPolicy({ ...NO_POLICY, recordTypingByDefault: true, includeOutputByDefault: false });
    settings("recording");
    expect(typed().getAttribute("aria-checked")).toBe("true");
    expect((typed() as HTMLButtonElement).disabled).toBe(true);
    expect(output().getAttribute("aria-checked")).toBe("false");
    expect((output() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Set by your organisation").length).toBeGreaterThanOrEqual(2);
  });

  it("gives way to IT switching keys off", () => {
    setPolicy({ ...NO_POLICY, disableKeystrokeRecording: true, recordTypingByDefault: true });
    settings("recording");
    expect(screen.queryByRole("switch", { name: /Record what's typed/ })).toBeNull();
    expect(screen.getByText(/switched this off/)).toBeTruthy();
  });
});

describe("blur suggestions (01/10/2026)", () => {
  it("is Standard to start with, can be set, and is IT's when policy sets it", async () => {
    settings("privacy");
    const select = screen.getByRole("combobox", { name: "Blur suggestions" }) as HTMLSelectElement;
    expect(select.value).toBe("standard");
    fireEvent.change(select, { target: { value: "thorough" } });
    expect(readBlurStrength()).toBe("thorough");
    expect(screen.getByText(/Also file names/)).toBeTruthy();
    cleanup();
    setPolicy(parsePolicy({ ...NO_POLICY, blurStrength: "light" }));
    settings("privacy");
    const managed = screen.getByRole("combobox", { name: "Blur suggestions" }) as HTMLSelectElement;
    expect(managed.value).toBe("light");
    expect(managed.disabled).toBe(true);
    setPolicy(NO_POLICY);
  });
});
