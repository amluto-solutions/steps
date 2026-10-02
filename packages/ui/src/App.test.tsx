// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newBrandProfile, type RecordedStep, type RecordingFact } from "@amluto-steps/core";
import { ENGLISH } from "@amluto-steps/core";

import { expectNoSeriousAxeViolations } from "../test/axe";
import { App } from "./App";
import { initI18n } from "./i18n";
import type { LibraryBridge } from "./library-bridge";
import { factToStep } from "./recorded-step";
import type { RecorderBridge, RecorderSnapshot } from "./recorder-bridge";

initI18n();
beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const idle: RecorderSnapshot = {
  state: "idle",
  reason: null,
  sessionId: null,
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: false,
};

const noListener = () => Promise.resolve(() => undefined);

function makeRecorder(
  overrides: Partial<Record<keyof RecorderBridge, unknown>> = {},
): RecorderBridge {
  return {
    onState: noListener,
    onFact: noListener,
    onFinished: noListener,
    onError: noListener,
    onStepAdded: noListener,
    onRestarted: noListener,
    onStartRequested: noListener,
    onHeartbeatRequest: noListener,
    getState: vi.fn().mockResolvedValue(idle),
    getPreferences: vi
      .fn()
      .mockResolvedValue({ displayName: "Robin", libraryFolder: "C:\\Guides" }),
    setPreferences: vi.fn(async (preferences: unknown) => preferences),
    isAutoStartEnabled: vi.fn().mockResolvedValue(false),
    setAutoStartEnabled: vi.fn().mockResolvedValue(undefined),
    getMonitors: vi.fn().mockResolvedValue([]),
    getRecoveries: vi.fn().mockResolvedValue([]),
    getRecoveryRecords: vi.fn().mockResolvedValue([]),
    getSessionSteps: vi.fn().mockResolvedValue([]),
    getRestartPoint: vi.fn().mockResolvedValue(null),
    recoverSession: vi.fn(async (sessionId: string) => ({ ...idle, sessionId })),
    loadDraft: vi.fn().mockResolvedValue(null),
    saveDraft: vi.fn().mockResolvedValue(undefined),
    saveDraftGuide: vi.fn().mockResolvedValue(undefined),
    saveDraftStep: vi.fn().mockResolvedValue(undefined),
    deleteDraftStep: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue(undefined),
    discard: vi.fn().mockResolvedValue(idle),
    appendStep: vi.fn().mockResolvedValue(undefined),
    loadImage: vi.fn().mockResolvedValue("data:image/webp;base64,"),
    showMain: vi.fn().mockResolvedValue(undefined),
    minimizeMain: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(async () => ({ ...idle, state: "recording", sessionId: "session-9" })),
    setCaptureMode: vi.fn().mockResolvedValue(undefined),
    setBarHidden: vi.fn().mockResolvedValue(undefined),
    setTargetMonitor: vi.fn().mockResolvedValue(undefined),
    excludeApp: vi.fn().mockResolvedValue(idle),
    includeApp: vi.fn().mockResolvedValue(idle),
    getHotkeys: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RecorderBridge;
}

const guideFile = (id: string, title: string) => ({
  id,
  title,
  description: "",
  intro: null,
  outro: null,
  brandProfileId: null,
  tags: ["Finance"],
  owner: "Robin",
  reviewBy: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
});

const stepFile = (id: string, sortKey: string, actionText: string) => ({
  id,
  sortKey,
  kind: "interaction",
  action: "click",
  actionText,
  textParts: { verb: "click", target: actionText, kind: "button" },
  showValue: false,
  textEdited: false,
  notes: null,
  altText: null,
  context: { app: null, windowTitle: "" },
  target: null,
  media: null,
  highlight: null,
  crop: null,
  redactions: [],
  annotations: [],
  block: null,
  capturedAt: "2026-09-25T10:00:00.000Z",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
});

function makeLibrary(overrides: Partial<Record<keyof LibraryBridge, unknown>> = {}): LibraryBridge {
  return {
    listLibraries: vi.fn().mockResolvedValue([
      {
        id: "lib-1",
        name: "My guides",
        path: "C:\\Guides",
        isDefault: true,
        managed: false,
        synced: false,
        guideCount: 1,
      },
    ]),
    listGuides: vi.fn().mockResolvedValue([
      {
        id: "guide-1",
        title: "Add a supplier",
        updatedAt: "2026-09-25T10:00:00.000Z",
        stepCount: 2,
        tags: ["Finance"],
        owner: "Robin",
        reviewBy: null,
        thumbnailMediaId: null,
      },
    ]),
    listTrash: vi.fn().mockResolvedValue([]),
    loadGuide: vi.fn().mockResolvedValue({
      guide: guideFile("guide-1", "Add a supplier"),
      steps: [stepFile("s1", "a", "Click Contacts"), stepFile("s2", "b", "Click Save")],
    }),
    // Shared-library locks: nobody else is editing, and there are no drafts.
    openForEditing: vi.fn().mockResolvedValue({ kind: "editing" }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    fingerprint: vi.fn().mockResolvedValue("same"),
    guideFingerprint: vi.fn().mockResolvedValue("same"),
    listConflicts: vi.fn().mockResolvedValue([]),
    resolveConflict: vi.fn().mockResolvedValue(undefined),
    listComments: vi.fn().mockResolvedValue([]),
    addComment: vi.fn().mockResolvedValue("c9"),
    resolveComment: vi.fn().mockResolvedValue(undefined),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    onLockLost: vi.fn().mockResolvedValue(() => undefined),
    listDrafts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockResolvedValue(undefined),
    discardDraft: vi.fn().mockResolvedValue(undefined),
    saveGuide: vi.fn().mockResolvedValue(undefined),
    saveStep: vi.fn().mockResolvedValue(undefined),
    deleteStep: vi.fn().mockResolvedValue(undefined),
    loadImage: vi.fn().mockResolvedValue("data:image/webp;base64,"),
    importImage: vi.fn(),
    trashGuide: vi.fn().mockResolvedValue({
      trashId: "t1",
      guideId: "guide-1",
      title: "Add a supplier",
      deletedAt: "",
    }),
    restoreGuide: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as LibraryBridge;
}

const shortcutFact: RecordingFact = {
  sessionId: "session-1",
  recordedAt: 1_790_246_400_000,
  sequence: 1,
  record: {
    kind: "manual",
    id: 7,
    tickMs: 100,
    purpose: "shortcut",
    actionText: "Shortcut screenshot",
    window: {
      title: "Word",
      exe: "WINWORD.EXE",
      pid: 10,
      frame: { left: 0, top: 0, right: 100, bottom: 100 },
      elevation: "notElevated",
      remoteSession: false,
    },
    capture: {
      mode: "window",
      rect: { left: 0, top: 0, right: 100, bottom: 100 },
      monitor: { left: 0, top: 0, right: 100, bottom: 100 },
      scale: 1,
      width: 100,
      height: 100,
      image: "manual-7.webp",
    },
    clickPct: { x: 50, y: 50 },
  },
};

const wording = ENGLISH;

describe("App start-up", () => {
  it("sends the saved screenshot mode at start-up, so Retake captures the same way", async () => {
    window.localStorage.setItem("amluto-steps-capture-mode", "monitor");
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    await waitFor(() => expect(recorder.setCaptureMode).toHaveBeenCalledWith("monitor"));
  });

  it("retries recorder initialization while native setup finishes", async () => {
    const stop = vi.fn();
    const onState = vi
      .fn()
      .mockRejectedValueOnce(new Error("event bridge not ready"))
      .mockResolvedValue(stop);
    const getPreferences = vi
      .fn()
      .mockRejectedValueOnce({ code: "notReady", message: "Recorder is initializing" })
      .mockResolvedValue({ displayName: "Robin", libraryFolder: "C:\\Guides" });
    render(<App recorder={makeRecorder({ onState, getPreferences })} library={makeLibrary()} />);

    expect(await screen.findByText("Add a supplier", {}, { timeout: 3000 })).toBeDefined();
    expect(screen.getByRole("heading", { name: "All guides" })).toBeDefined();
    expect(onState).toHaveBeenCalledTimes(3);
    expect(getPreferences).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalled();
  });

  it("shows a restart message after bounded initialization retries fail", async () => {
    const onState = vi.fn().mockRejectedValue(new Error("event bridge unavailable"));
    render(<App recorder={makeRecorder({ onState })} library={makeLibrary()} />);
    expect(
      await screen.findByText(
        "The recorder could not finish starting. Restart Steps and try again.",
        {},
        { timeout: 3000 },
      ),
    ).toBeDefined();
    expect(onState).toHaveBeenCalledTimes(4);
    // Recording is refused while the recorder isn't set up.
    const record = screen.getByRole("button", { name: "New recording" }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
  });

  it("reports a library that can't be read without undoing the recorder's set-up", async () => {
    const onState = vi.fn().mockResolvedValue(() => undefined);
    const library = makeLibrary({
      listLibraries: vi.fn().mockRejectedValue({ code: "storageError", message: "offline" }),
    });
    render(<App recorder={makeRecorder({ onState })} library={library} />);
    expect(await screen.findByText(/couldn’t be saved or read|could not be loaded/)).toBeDefined();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText("The recorder could not finish starting. Restart Steps and try again."),
    ).toBeNull();
  });

  it("asks for a name on first run and saves it", async () => {
    const setPreferences = vi.fn(async (preferences: unknown) => preferences);
    render(
      <App
        recorder={makeRecorder({
          getPreferences: vi
            .fn()
            .mockResolvedValue({ displayName: "", libraryFolder: "C:\\Guides" }),
          setPreferences,
        })}
        library={makeLibrary()}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Your name"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Get started" }));
    await waitFor(() =>
      expect(setPreferences).toHaveBeenCalledWith({
        displayName: "Sam",
        libraryFolder: "C:\\Guides",
      }),
    );
    expect(await screen.findByRole("heading", { name: "All guides" })).toBeDefined();
    // Only someone just welcomed gets the product tour, greeted by name on the guides.
    expect(await screen.findByRole("heading", { name: "Welcome to Steps, Sam" })).toBeDefined();
  });

  it("doesn't offer the tour to someone who had the app before it existed", async () => {
    render(<App recorder={makeRecorder()} library={makeLibrary()} />);
    expect(await screen.findByRole("heading", { name: "All guides" })).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("tour-card")).toBeNull();
  });

  it("doesn't reload the guide thumbnails each time the recorder reports its state", async () => {
    let publish: ((state: RecorderSnapshot) => void) | null = null;
    const onState = vi.fn(async (handler: (state: RecorderSnapshot) => void) => {
      publish = handler;
      return () => undefined;
    });
    const library = makeLibrary({
      listGuides: vi.fn().mockResolvedValue([
        {
          id: "guide-1",
          title: "Add a supplier",
          updatedAt: "2026-09-25T10:00:00.000Z",
          stepCount: 2,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: "m1",
        },
      ]),
    });
    render(<App recorder={makeRecorder({ onState })} library={library} />);
    await screen.findByText("Add a supplier");
    await waitFor(() => expect(library.loadImage).toHaveBeenCalledTimes(1));
    // During a recording the state arrives after every click.
    for (const stepCount of [1, 2, 3]) await act(async () => publish?.({ ...idle, stepCount }));
    expect(library.loadImage).toHaveBeenCalledTimes(1);
  });

  it("has no serious or critical accessibility problems on the guides screen", async () => {
    const { container } = render(<App recorder={makeRecorder()} library={makeLibrary()} />);
    await screen.findByText("Add a supplier");
    await expectNoSeriousAxeViolations(container);
  });

  it("backs up settings, brands and libraries, and restores them on a clean setup", async () => {
    const client = { ...newBrandProfile("client", "Client", "#113355"), version: 2 };
    let saved = "";
    const writeBackupFile = vi.fn(async (_path: string, contents: string) => {
      saved = contents;
    });
    const library = makeLibrary({
      pickSaveLocation: vi.fn().mockResolvedValue("C:/Backups/all.amlbackup"),
    });
    render(
      <App
        recorder={makeRecorder({
          listBrands: vi.fn().mockResolvedValue([client]),
          writeBackupFile,
        })}
        library={library}
      />,
    );
    await screen.findByText("Add a supplier");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back up all…" }));
    await waitFor(() => expect(writeBackupFile).toHaveBeenCalled());
    expect(JSON.parse(saved)).toMatchObject({
      kind: "amluto-steps-backup",
      settings: { displayName: "Robin" },
      libraries: [{ name: "My guides", isDefault: true }],
    });
    cleanup();

    // A clean setup: no brands, and a library list without the backed-up one.
    const saveBrand = vi.fn().mockResolvedValue(undefined);
    const fresh = makeLibrary({
      pickFile: vi.fn().mockResolvedValue("C:/Backups/all.amlbackup"),
      listLibraries: vi.fn().mockResolvedValue([
        {
          id: "lib-0",
          name: "Guides",
          path: "C:\\Other",
          isDefault: true,
          managed: false,
          synced: false,
          guideCount: 0,
        },
      ]),
      addLibrary: vi.fn().mockResolvedValue({
        id: "lib-9",
        name: "My guides",
        path: "C:\\Guides",
        isDefault: false,
        managed: false,
        synced: false,
        guideCount: 1,
      }),
      setDefaultLibrary: vi.fn().mockResolvedValue(undefined),
    });
    render(
      <App
        recorder={makeRecorder({
          readBackupFile: vi.fn().mockResolvedValue(saved),
          checkFont: vi.fn().mockResolvedValue({ embeddable: true }),
          saveBrand,
        })}
        library={fresh}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore…" }));
    // A library it adds, and a new default, are agreed to first: nothing is set up before that.
    const asked = await screen.findByRole("alertdialog", { name: "Restore this backup?" });
    expect(asked.textContent).toContain("Save every new recording in “My guides” (C:\\Guides)");
    expect(fresh.addLibrary).not.toHaveBeenCalled();
    fireEvent.click(within(asked).getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(saveBrand).toHaveBeenCalledWith(expect.objectContaining({ id: "client" })),
    );
    expect(fresh.addLibrary).toHaveBeenCalledWith("My guides", "C:\\Guides");
    expect(fresh.setDefaultLibrary).toHaveBeenCalledWith("lib-9");
    expect(await screen.findByText(/^Restored./)).toBeTruthy();
  });

  it("names an imported guide as imported when one with its title is already here (F045)", async () => {
    const saveGuide = vi.fn().mockResolvedValue(undefined);
    const library = makeLibrary({
      pickFile: vi.fn().mockResolvedValue("C:/Downloads/supplier.amlsteps"),
      importAmlsteps: vi.fn().mockResolvedValue({ id: "guide-9", title: "Add a supplier" }),
      saveGuide,
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(saveGuide).toHaveBeenCalledWith(
        "lib-1",
        "guide-9",
        expect.objectContaining({ title: "Add a supplier (imported)" }),
      ),
    );
    expect(await screen.findByText("Imported “Add a supplier (imported)”.")).toBeTruthy();
  });

  it("applies blur permanently only after the user confirms, in the app's own dialog", async () => {
    const applyRedactions = vi.fn().mockResolvedValue(2);
    render(<App recorder={makeRecorder()} library={makeLibrary({ applyRedactions })} />);
    const openMenu = async () => {
      fireEvent.click(
        await screen.findByRole("button", { name: "More actions for Add a supplier" }),
      );
      fireEvent.click(await screen.findByRole("menuitem", { name: /Apply blur permanently/ }));
      return screen.findByRole("alertdialog");
    };

    let asked = await openMenu();
    expect(within(asked).getByText(/can’t be undone/)).toBeTruthy();
    fireEvent.click(within(asked).getByRole("button", { name: "Cancel" }));
    expect(applyRedactions).not.toHaveBeenCalled();

    asked = await openMenu();
    fireEvent.click(within(asked).getByRole("button", { name: "Apply blur" }));
    await waitFor(() => expect(applyRedactions).toHaveBeenCalledWith("lib-1", "guide-1"));
    expect(await screen.findByText("Blur applied permanently to 2 screenshots.")).toBeTruthy();
  });
});

describe("Unsaved recordings", () => {
  it("finishes cleanup and opens a guide saved before an interruption, without rebuilding the journal", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);
    const recorder = makeRecorder({
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-1",
          title: "Saved",
          eventCount: 0,
          stopped: true,
          savedGuideId: "guide-1",
        },
      ]),
      finalize,
    });
    const library = makeLibrary();
    render(<App recorder={recorder} library={library} />);

    fireEvent.click(await screen.findByRole("button", { name: "Finish tidying up" }));
    await waitFor(() => expect(finalize).toHaveBeenCalledWith("session-1", { id: "guide-1" }));
    await waitFor(() => expect(library.loadGuide).toHaveBeenCalledWith("lib-1", "guide-1"));
    expect(recorder.appendStep).not.toHaveBeenCalled();
    expect(recorder.saveDraft).not.toHaveBeenCalled();
    expect(await screen.findByDisplayValue("Add a supplier")).toBeDefined();
  });

  it("restores a popup shortcut step into the draft after the WebView reloads", async () => {
    const shortcutStep = factToStep(
      {
        ...shortcutFact,
        record: { ...shortcutFact.record, purpose: "captureNow" },
      } as RecordingFact,
      wording,
    ) as RecordedStep;
    shortcutStep.action = "keypress";
    shortcutStep.actionText = 'Press "Ctrl + Shift + 1"';
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const recorder = makeRecorder({
      getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-1" }),
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-1",
          title: "Recovered",
          eventCount: 1,
          stopped: true,
          savedGuideId: null,
        },
      ]),
      getRecoveryRecords: vi.fn().mockResolvedValue([shortcutFact]),
      getSessionSteps: vi.fn().mockResolvedValue([shortcutStep]),
      saveDraft,
    });
    render(<App recorder={recorder} library={makeLibrary()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = saveDraft.mock.calls[0] as [string, unknown, { actionText: string }[]];
    expect(steps.map((step) => step.actionText)).toEqual(['Press "Ctrl + Shift + 1"']);
    expect(await screen.findByDisplayValue('Press "Ctrl + Shift + 1"')).toBeDefined();
  });

  it("opens a recording even when one of its steps can't be read, and says so", async () => {
    const good = stepFile("capture-1", "0000000001", "Click Save");
    const tooLong = { ...stepFile("capture-2", "0000000002", "x".repeat(3_000)) };
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const recorder = makeRecorder({
      getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-1" }),
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-1",
          title: "Old",
          eventCount: 2,
          stopped: true,
          savedGuideId: null,
        },
      ]),
      getSessionSteps: vi.fn().mockResolvedValue([good, tooLong]),
      saveDraft,
    });
    render(<App recorder={recorder} library={makeLibrary()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = saveDraft.mock.calls[0] as [string, unknown, { id: string }[]];
    expect(steps.map((step) => step.id)).toEqual(["capture-1"]);
    expect(
      await screen.findByText("1 recorded step couldn't be read, so it was left out."),
    ).toBeDefined();
  });

  it("keeps the draft open when saving fails, and saves on a retry", async () => {
    const finalize = vi
      .fn()
      .mockRejectedValueOnce({ code: "storage", message: "The disk is full." })
      .mockResolvedValue(undefined);
    const recorder = makeRecorder({
      getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-1" }),
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-1",
          title: "Recovered",
          eventCount: 1,
          stopped: true,
          savedGuideId: null,
        },
      ]),
      loadDraft: vi.fn().mockResolvedValue({
        guide: guideFile("session-1", "Recovered"),
        steps: [stepFile("capture-1", "0000000001", "Click Save")],
      }),
      finalize,
    });
    render(<App recorder={recorder} library={makeLibrary()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    const save = await screen.findByRole("button", { name: "Save guide" });
    fireEvent.click(save);
    expect(
      await screen.findByText("That couldn’t be saved or read: The disk is full."),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Save guide" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save guide" }));
    await waitFor(() => expect(finalize).toHaveBeenCalledTimes(2));
  });

  it("reviews an interrupted recording before the user chooses to discard it", async () => {
    const discard = vi.fn().mockResolvedValue(idle);
    const recoverSession = vi.fn(async (sessionId: string) => ({ ...idle, sessionId }));
    const recorder = makeRecorder({
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-2",
          title: "Interrupted",
          eventCount: 3,
          stopped: false,
          savedGuideId: null,
        },
      ]),
      recoverSession,
      discard,
    });
    render(<App recorder={recorder} library={makeLibrary()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    await waitFor(() => expect(recoverSession).toHaveBeenCalledWith("session-2"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(document.activeElement?.textContent).toBe("Keep it");
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard recording" }));
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
  });
});

describe("Recording", () => {
  it("asks what to record at every start, both unticked, then starts and gets out of the way", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    const dialog = await screen.findByRole("dialog");
    const keys = within(dialog).getByRole("checkbox", { name: /Record what.s typed/ });
    const output = within(dialog).getByRole("checkbox", { name: /Include command output/ });
    expect((keys as HTMLInputElement).checked).toBe(false);
    expect((output as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await waitFor(() =>
      expect(recorder.start).toHaveBeenCalledWith(expect.stringMatching(/^New guide /), {
        keys: false,
        output: false,
        settleMs: 1_500,
        appSwitchSteps: true,
        quality: "balanced",
      }),
    );
    await waitFor(() => expect(recorder.minimizeMain).toHaveBeenCalled());
  });

  it("records keys and output only when ticked for this recording", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Record what.s typed/ }));
    expect(within(dialog).getByText("Keys are read during this recording only.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Include command output/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await waitFor(() =>
      expect(recorder.start).toHaveBeenCalledWith(expect.any(String), {
        keys: true,
        output: true,
        settleMs: 1_500,
        appSwitchSteps: true,
        quality: "balanced",
      }),
    );
  });

  it("moves through the editor's steps with the arrow keys (F062)", async () => {
    render(<App recorder={makeRecorder()} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    await screen.findByDisplayValue("Click Contacts");
    const first = document.querySelector<HTMLButtonElement>('[data-step-button="s1"]');
    expect(first).not.toBeNull();
    first?.focus();
    fireEvent.keyDown(first as HTMLButtonElement, { key: "ArrowDown" });
    expect(await screen.findByDisplayValue("Click Save")).toBeTruthy();
    expect(document.activeElement?.getAttribute("data-step-button")).toBe("s2");
  });

  it("says Steps was already open when it's started a second time (F001)", async () => {
    let startedAgain: (() => void) | null = null;
    const recorder = makeRecorder({
      onAlreadyOpen: vi.fn(async (handler: () => void) => {
        startedAgain = handler;
        return () => undefined;
      }),
    });
    render(<App recorder={recorder} library={makeLibrary()} />);
    await screen.findByText("Add a supplier");
    await waitFor(() => expect(startedAgain).not.toBeNull());
    await act(async () => startedAgain?.());
    const notice = await screen.findByRole("alertdialog");
    expect(within(notice).getByText("Steps is already open")).toBeTruthy();
    fireEvent.click(within(notice).getByRole("button", { name: "OK" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("starts one recording when the start shortcut is pressed twice quickly", async () => {
    let pressed: (() => void) | null = null;
    let finishStart: (() => void) | null = null;
    const recorder = makeRecorder({
      onStartRequested: vi.fn(async (handler: () => void) => {
        pressed = handler;
        return () => undefined;
      }),
      start: vi.fn(
        () =>
          new Promise((resolve) => {
            finishStart = () => resolve({ ...idle, state: "recording", sessionId: "session-9" });
          }),
      ),
    });
    render(<App recorder={recorder} library={makeLibrary()} />);
    await screen.findByText("Add a supplier");
    await waitFor(() => expect(pressed).not.toBeNull());
    await act(async () => {
      pressed?.();
      pressed?.();
    });
    const start = within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Start recording",
    });
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(1));
    await act(async () => finishStart?.());
    expect(recorder.start).toHaveBeenCalledTimes(1);
  });

  it("keeps an app the recording bar excluded, when the next recording starts from here", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    await screen.findByRole("button", { name: "New recording" });

    // The bar, in its own window, saves "Never record outlook.exe".
    act(() => {
      window.localStorage.setItem("amluto-steps-excluded-apps", JSON.stringify(["outlook.exe"]));
      window.dispatchEvent(new StorageEvent("storage", { key: "amluto-steps-excluded-apps" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "New recording" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
    expect(recorder.excludeApp).toHaveBeenCalledWith("outlook.exe");
    expect(JSON.parse(window.localStorage.getItem("amluto-steps-excluded-apps") ?? "[]")).toEqual([
      "outlook.exe",
    ]);
  });

  /** A recorder whose events the test fires, the way the native side does during a recording. */
  function liveRecorder(overrides: Partial<Record<keyof RecorderBridge, unknown>> = {}) {
    const fire: {
      fact?: (fact: RecordingFact) => void;
      finished?: (finished: { snapshot: RecorderSnapshot; title: string }) => void;
      restarted?: (restarted: { sessionId: string; afterSequence: number | null }) => void;
    } = {};
    const listen =
      <T,>(key: keyof typeof fire) =>
      (handler: T) => {
        (fire as Record<string, unknown>)[key] = handler;
        return Promise.resolve(() => undefined);
      };
    const recorder = makeRecorder({
      onFact: listen("fact"),
      onFinished: listen("finished"),
      onRestarted: listen("restarted"),
      ...overrides,
    });
    return { recorder, fire };
  }

  const capture = (sequence: number, purpose: "captureNow" | "shortcut" = "captureNow") =>
    ({
      ...shortcutFact,
      sessionId: "session-9",
      sequence,
      record: { ...shortcutFact.record, id: 100 + sequence, purpose },
    }) as RecordingFact;

  const startFromTheSidebar = async (recorder: RecorderBridge, library = makeLibrary()) => {
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
  };

  it("says when clicks on a screen left out made no steps", async () => {
    const { recorder, fire } = liveRecorder();
    await startFromTheSidebar(recorder);
    act(() =>
      fire.finished?.({
        snapshot: { ...idle, sessionId: "session-9", otherScreenClicks: 3 },
        title: "Tuesday",
      }),
    );
    expect(
      await screen.findByText(
        "3 clicks were on a screen this recording leaves out, so they aren't in the guide. To record on every screen, choose All monitors in Settings, Recording.",
      ),
    ).toBeDefined();
  });

  it("journals steps as facts arrive, opens them as a draft when it stops, and saves the guide", async () => {
    const { recorder, fire } = liveRecorder();
    await startFromTheSidebar(recorder);

    act(() => {
      fire.fact?.(capture(1));
      fire.fact?.(capture(2, "shortcut")); // the popup's own step arrives separately
      fire.fact?.(capture(3));
      fire.fact?.(capture(3)); // a repeat is ignored
    });
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledTimes(2));
    const appended = vi.mocked(recorder.appendStep).mock.calls.map(([, step]) => step.id);
    expect(appended).toEqual(["capture-1", "capture-3"]);

    act(() => fire.finished?.({ snapshot: { ...idle, sessionId: "session-9" }, title: "Tuesday" }));
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    const [sessionId, guide, steps] = vi.mocked(recorder.saveDraft).mock.calls[0] as [
      string,
      { title: string; owner: string },
      { id: string }[],
    ];
    expect(sessionId).toBe("session-9");
    expect(guide).toMatchObject({ title: "Tuesday", owner: "Robin" });
    expect(steps.map((step) => step.id)).toEqual(["capture-1", "capture-3"]);

    fireEvent.click(await screen.findByRole("button", { name: "Save guide" }));
    await waitFor(() =>
      expect(recorder.finalize).toHaveBeenCalledWith(
        "session-9",
        expect.objectContaining({ id: "session-9", title: "Tuesday" }),
        undefined,
      ),
    );
  });

  it("saves a recording to another library with Save as, once, leaving the default alone", async () => {
    const { recorder, fire } = liveRecorder();
    const libraries = [
      { id: "lib-1", name: "My guides", path: "C:\\Guides", isDefault: true },
      { id: "lib-2", name: "Finance team", path: "S:\\Finance", isDefault: false },
    ].map((item) => ({ ...item, managed: false, synced: false, guideCount: 1 }));
    const library = makeLibrary({
      listLibraries: vi.fn().mockResolvedValue(libraries),
      setDefaultLibrary: vi.fn(),
    });
    await startFromTheSidebar(recorder, library);
    act(() => fire.fact?.(capture(1)));
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledOnce());
    act(() => fire.finished?.({ snapshot: { ...idle, sessionId: "session-9" }, title: "Tuesday" }));

    fireEvent.click(await screen.findByRole("button", { name: "Save to another library" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: /My guides/ }).textContent).toContain(
      "Your default library",
    );
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Finance team/ }));
    await waitFor(() =>
      expect(recorder.finalize).toHaveBeenCalledWith(
        "session-9",
        expect.objectContaining({ id: "session-9" }),
        "lib-2",
      ),
    );
    expect(await screen.findByText("Guide saved to “Finance team”.")).toBeDefined();
    expect(library.setDefaultLibrary).not.toHaveBeenCalled();
  });

  it("drops the steps recorded before Start again", async () => {
    const { recorder, fire } = liveRecorder({
      getRestartPoint: vi.fn().mockResolvedValue(2),
    });
    await startFromTheSidebar(recorder);

    act(() => {
      fire.fact?.(capture(1));
      fire.fact?.(capture(2));
      fire.restarted?.({ sessionId: "session-9", afterSequence: 2 });
      fire.fact?.(capture(2)); // late copies of dropped facts stay dropped
      fire.fact?.(capture(3));
      fire.restarted?.({ sessionId: "other-session", afterSequence: 3 }); // not this recording
    });
    act(() => fire.finished?.({ snapshot: { ...idle, sessionId: "session-9" }, title: "Again" }));
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = vi.mocked(recorder.saveDraft).mock.calls[0] as [
      string,
      unknown,
      { id: string }[],
    ];
    expect(steps.map((step) => step.id)).toEqual(["capture-3"]);
  });

  it("brings the dropped steps back when Start again is undone", async () => {
    // After the undo the journal still holds every fact and there is no restart point.
    const { recorder, fire } = liveRecorder({
      getRecoveryRecords: vi.fn().mockResolvedValue([capture(1), capture(2)]),
    });
    await startFromTheSidebar(recorder);

    act(() => {
      fire.fact?.(capture(1));
      fire.fact?.(capture(2));
      fire.restarted?.({ sessionId: "session-9", afterSequence: 2 });
      fire.restarted?.({ sessionId: "session-9", afterSequence: null });
    });
    await waitFor(() => expect(recorder.getRecoveryRecords).toHaveBeenCalledWith("session-9"));
    act(() => fire.fact?.(capture(3)));
    act(() => fire.finished?.({ snapshot: { ...idle, sessionId: "session-9" }, title: "Undone" }));
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = vi.mocked(recorder.saveDraft).mock.calls[0] as [
      string,
      unknown,
      { id: string }[],
    ];
    expect(steps.map((step) => step.id)).toEqual(["capture-1", "capture-2", "capture-3"]);
  });
});

describe("Editing a saved guide", () => {
  it("says blur doesn't hide the originals from people who share a synced library", async () => {
    const blurred = {
      ...stepFile("s1", "a", "Click Contacts"),
      media: { id: "m1", width: 100, height: 100, scale: 1, captureRect: null },
      redactions: [{ x: 1, y: 1, w: 10, h: 10, source: "manual" }],
    };
    const synced = (value: boolean) =>
      makeLibrary({
        listLibraries: vi.fn().mockResolvedValue([
          {
            id: "lib-1",
            name: "Team guides",
            path: "C:\\Users\\sam\\Contoso\\Guides - Documents",
            isDefault: true,
            managed: false,
            synced: value,
            guideCount: 1,
          },
        ]),
        loadGuide: vi.fn().mockResolvedValue({
          guide: guideFile("guide-1", "Add a supplier"),
          steps: [blurred],
        }),
      });
    const notice = /People with access to this library can still open the original screenshot/;

    render(<App recorder={makeRecorder()} library={synced(true)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    expect(await screen.findByText(notice)).toBeTruthy();
    cleanup();

    render(<App recorder={makeRecorder()} library={synced(false)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    await screen.findByDisplayValue("Click Contacts");
    expect(screen.queryByText(notice)).toBeNull();
  });

  it("moves several guides to another library, leaves one someone is editing, and undoes it", async () => {
    const summary = (id: string, title: string) => ({
      id,
      title,
      updatedAt: "2026-09-25T10:00:00.000Z",
      stepCount: 2,
      tags: [],
      owner: "Robin",
      reviewBy: null,
      thumbnailMediaId: null,
    });
    const libraries = [
      { id: "lib-1", name: "My guides", path: "C:\\Guides", isDefault: true },
      { id: "lib-2", name: "Finance team", path: "S:\\Finance", isDefault: false },
    ].map((item) => ({ ...item, managed: false, synced: false, guideCount: 3 }));
    const library = makeLibrary({
      listLibraries: vi.fn().mockResolvedValue(libraries),
      listGuides: vi
        .fn()
        .mockResolvedValue([
          summary("g1", "Add a supplier"),
          summary("g2", "Book a room"),
          summary("g3", "Claim expenses"),
        ]),
      openForEditing: vi.fn((_library: string, guideId: string) =>
        Promise.resolve(
          guideId === "g2"
            ? {
                kind: "readOnly",
                lock: { name: "Sam Jones", pc: "SAMS-PC", session: "s", counter: 1, since: "" },
              }
            : { kind: "editing" },
        ),
      ),
      moveGuide: vi.fn((_from: string, guideId: string) =>
        Promise.resolve(summary(`moved-${guideId}`, guideId)),
      ),
      listTrash: vi.fn().mockResolvedValue([
        { trashId: "t1", guideId: "g1", title: "Add a supplier", deletedAt: "" },
        { trashId: "t3", guideId: "g3", title: "Claim expenses", deletedAt: "" },
      ]),
      trashGuide: vi.fn((_library: string, guideId: string) =>
        Promise.resolve({ trashId: `bin-${guideId}`, guideId, title: "", deletedAt: "" }),
      ),
      deleteTrashed: vi.fn().mockResolvedValue(undefined),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.keyDown(await screen.findByRole("button", { name: "Open Add a supplier" }), {
      key: "a",
      ctrlKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Move to…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Finance team" }));

    await waitFor(() => expect(library.moveGuide).toHaveBeenCalledTimes(2));
    expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "g1", "lib-2");
    expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "g3", "lib-2");
    // The one Sam is editing is left alone, and named; the lock checked for the others is let go.
    expect(library.moveGuide).not.toHaveBeenCalledWith("lib-1", "g2", "lib-2");
    expect(library.releaseLock).toHaveBeenCalledWith("lib-1", "g1");
    expect(
      await screen.findByText(
        "2 guides moved to “Finance team”. “Book a room” was left alone: Sam Jones is editing it.",
      ),
    ).toBeDefined();

    // The originals aren't left in this library's Bin, looking deleted (F053).
    expect(library.deleteTrashed).toHaveBeenCalledWith("lib-1", "t1");
    expect(library.deleteTrashed).toHaveBeenCalledWith("lib-1", "t3");

    // Undo: each guide moves back.
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith("lib-2", "moved-g3", "lib-1"),
    );
    expect(library.moveGuide).toHaveBeenCalledWith("lib-2", "moved-g1", "lib-1");
  });

  it("moves one guide from its menu, and Undo moves it back (F053)", async () => {
    const summary = (id: string, title: string) => ({
      id,
      title,
      updatedAt: "2026-09-25T10:00:00.000Z",
      stepCount: 2,
      tags: [],
      owner: "Robin",
      reviewBy: null,
      thumbnailMediaId: null,
    });
    const libraries = [
      { id: "lib-1", name: "My guides", path: "C:\\Guides", isDefault: true },
      { id: "lib-2", name: "Finance team", path: "S:\\Finance", isDefault: false },
    ].map((item) => ({ ...item, managed: false, synced: false, guideCount: 1 }));
    const library = makeLibrary({
      listLibraries: vi.fn().mockResolvedValue(libraries),
      listGuides: vi.fn().mockResolvedValue([summary("g1", "Add a supplier")]),
      moveGuide: vi.fn((_from: string, guideId: string) =>
        Promise.resolve(summary(`moved-${guideId}`, guideId)),
      ),
      listTrash: vi.fn().mockResolvedValue([]),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Add a supplier" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Finance team" }));
    await waitFor(() => expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "g1", "lib-2"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith("lib-2", "moved-g1", "lib-1"),
    );
  });

  it("merges two guides into a new one with a first version, and Undo puts it in the Bin", async () => {
    const titles: Record<string, string> = {
      "guide-1": "Add a supplier",
      "guide-2": "Book a room",
    };
    const library = makeLibrary({
      listGuides: vi.fn().mockResolvedValue(
        Object.entries(titles).map(([id, title]) => ({
          id,
          title,
          updatedAt: "2026-09-25T10:00:00.000Z",
          stepCount: 1,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: null,
        })),
      ),
      loadGuide: vi.fn((_library: string, id: string) =>
        Promise.resolve({
          guide: guideFile(id, titles[id] ?? ""),
          steps: [
            {
              ...stepFile("capture-1", "a", `Click ${id}`),
              media: { id: "click-1", width: 800, height: 600, scale: 1, captureRect: null },
            },
          ],
        }),
      ),
      createFromParts: vi.fn((_library: string, guide: { id: string; title: string }) =>
        Promise.resolve({
          id: guide.id,
          title: guide.title,
          updatedAt: "",
          stepCount: 4,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: null,
        }),
      ),
      saveVersion: vi.fn().mockResolvedValue(undefined),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Add a supplier" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Book a room" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge guides" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title of the new guide" }), {
      target: { value: "Office basics" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Merge 2 guides" }));

    await waitFor(() => expect(library.createFromParts).toHaveBeenCalledOnce());
    const [target, guide, steps, media] = vi.mocked(library.createFromParts).mock.calls[0] as [
      string,
      { id: string; title: string },
      { block: { heading: string } | null; actionText: string; media: { id: string } | null }[],
      { fromGuideId: string; mediaId: string; newMediaId: string }[],
    ];
    expect(target).toBe("lib-1");
    expect(guide.title).toBe("Office basics");
    expect(steps.map((step) => step.block?.heading ?? step.actionText)).toEqual([
      "Add a supplier",
      "Click guide-1",
      "Book a room",
      "Click guide-2",
    ]);
    // Both guides' screenshots are called click-1: each gets its own new id.
    expect(media.map((item) => item.fromGuideId)).toEqual(["guide-1", "guide-2"]);
    expect(new Set(media.map((item) => item.newMediaId)).size).toBe(2);
    expect(library.saveVersion).toHaveBeenCalledWith(
      "lib-1",
      guide.id,
      "Merged from “Add a supplier”, “Book a room”",
    );
    expect(await screen.findByText("Merged 2 guides into “Office basics”.")).toBeDefined();
    // Nothing was asked to go to the Bin, so the originals stay.
    expect(library.trashGuide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(library.trashGuide).toHaveBeenCalledWith("lib-1", guide.id));
  });

  it("exports several guides, each through its own review, one after another", async () => {
    const titles: Record<string, string> = {
      "guide-1": "Add a supplier",
      "guide-2": "Book a room",
    };
    const library = makeLibrary({
      listGuides: vi.fn().mockResolvedValue(
        Object.entries(titles).map(([id, title]) => ({
          id,
          title,
          updatedAt: "2026-09-25T10:00:00.000Z",
          stepCount: 1,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: null,
        })),
      ),
      loadGuide: vi.fn((_library: string, id: string) =>
        Promise.resolve({
          guide: guideFile(id, titles[id] ?? ""),
          steps: [stepFile("s1", "a", "Click Save")],
        }),
      ),
      pickSaveLocation: vi.fn((_title: string, name: string) => Promise.resolve(`C:/Out/${name}`)),
      exportAmlsteps: vi.fn().mockResolvedValue(undefined),
      saveVersion: vi.fn().mockResolvedValue(undefined),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Add a supplier" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Book a room" }));
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Steps file/ }));

    for (const [index, title] of ["Add a supplier", "Book a room"].entries()) {
      const review = await screen.findByRole("dialog", {
        name: new RegExp(`Guide ${index + 1} of 2: ${title}`),
      });
      const exportIt = within(review).getByRole("button", { name: /^Export Steps file$/ });
      await waitFor(() => expect((exportIt as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(exportIt);
      await waitFor(() => expect(library.exportAmlsteps).toHaveBeenCalledTimes(index + 1));
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(library.exportAmlsteps).toHaveBeenCalledWith(
      "lib-1",
      "guide-2",
      expect.stringContaining("Book a room"),
      false,
    );
  });

  it("deletes a guide in the Bin for good, and empties the Bin, each only once confirmed", async () => {
    const entry = {
      trashId: "t1",
      guideId: "guide-9",
      title: "Old payroll",
      deletedAt: "2026-09-30T10:00:00.000Z",
    };
    const library = makeLibrary({
      listTrash: vi.fn().mockResolvedValue([entry]),
      deleteTrashed: vi.fn().mockResolvedValue(undefined),
      emptyTrash: vi.fn().mockResolvedValue(1),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Bin/ }));

    fireEvent.click(await screen.findByRole("button", { name: "Delete “Old payroll” for good" }));
    const ask = await screen.findByRole("alertdialog", { name: "Delete “Old payroll” for good?" });
    // Cancel is where focus starts, and does nothing.
    expect(document.activeElement?.textContent).toBe("Cancel");
    fireEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(library.deleteTrashed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete “Old payroll” for good" }));
    const again = await screen.findByRole("alertdialog");
    fireEvent.click(within(again).getByRole("button", { name: "Delete for good" }));
    await waitFor(() => expect(library.deleteTrashed).toHaveBeenCalledWith("lib-1", "t1"));
    expect(await screen.findByText("“Old payroll” deleted for good.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Empty Bin" }));
    const empty = await screen.findByRole("alertdialog", { name: "Empty the Bin?" });
    fireEvent.click(within(empty).getByRole("button", { name: "Empty Bin" }));
    await waitFor(() => expect(library.emptyTrash).toHaveBeenCalledWith("lib-1"));
  });

  it("rewords a guide in another tone with Language and tone, saving a version first", async () => {
    const button = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
      ...stepFile(id, id, `Click "${name}"`),
      textParts: { verb: "click", target: name, kind: "button" },
      target: { tagName: "BUTTON", innerText: name },
      ...extra,
    });
    const library = makeLibrary({
      loadGuide: vi.fn().mockResolvedValue({
        guide: guideFile("guide-1", "Add a supplier"),
        steps: [
          button("a", "Save"),
          button("b", "Send", { textEdited: true, actionText: "Send it to finance" }),
        ],
      }),
      saveVersion: vi.fn().mockResolvedValue(undefined),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.click(await screen.findByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Language and tone…" }));
    const dialog = await screen.findByRole("dialog", { name: "Language and tone" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Plain language/ }));
    const preview = within(dialog).getByRole("list");
    expect(within(preview).getByText('Select the "Save" button')).toBeDefined();
    expect(within(preview).getByText('Select the "Send" button')).toBeDefined();
    // Changed by hand: shown, but left alone unless ticked.
    expect(
      (within(dialog).getByRole("checkbox", { name: "Reword step 2" }) as HTMLInputElement).checked,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reword 1 step" }));

    await waitFor(() =>
      expect(library.saveVersion).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        "Before changing the language or tone",
      ),
    );
    await waitFor(() =>
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({ id: "a", actionText: 'Select the "Save" button' }),
      ),
    );
    await waitFor(() =>
      expect(library.saveGuide).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({ language: "en", tone: "plain" }),
      ),
    );
    expect(library.saveStep).not.toHaveBeenCalledWith(
      "lib-1",
      "guide-1",
      expect.objectContaining({ id: "b" }),
    );
  });

  it("writes a step's words in another language beside the main language's", async () => {
    const library = makeLibrary({
      loadGuide: vi.fn().mockResolvedValue({
        guide: guideFile("guide-1", "Add a supplier"),
        steps: [{ ...stepFile("s1", "a", "Check the supplier"), textEdited: true }],
      }),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "Showing" }), {
      target: { value: "de" },
    });
    // Changed by hand and not written in German yet: the English shows, and says so.
    expect(await screen.findByText(/Not written in Deutsch yet/)).toBeDefined();
    expect(screen.getByRole("button", { name: /not in Deutsch yet/ })).toBeDefined();
    fireEvent.change(screen.getByDisplayValue("Check the supplier"), {
      target: { value: "Lieferanten prüfen" },
    });
    await waitFor(
      () =>
        expect(library.saveStep).toHaveBeenCalledWith(
          "lib-1",
          "guide-1",
          expect.objectContaining({
            actionText: "Check the supplier",
            translations: { de: { actionText: "Lieferanten prüfen" } },
          }),
        ),
      { timeout: 3000 },
    );
  });

  it("deletes a step, offers Undo, and saves only the files that changed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const library = makeLibrary();
      render(<App recorder={makeRecorder()} library={library} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete step" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(library.deleteStep).toHaveBeenCalledWith("lib-1", "guide-1", "s1");
      expect(library.saveGuide).not.toHaveBeenCalled();

      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({ id: "s1", actionText: "Click Contacts" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retakes a screenshot: the new picture replaces the old one and the blur stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const shot = {
        ...stepFile("s1", "a", "Click Contacts"),
        media: { id: "old", width: 800, height: 600, scale: 1, captureRect: null },
        redactions: [{ x: 10, y: 10, w: 20, h: 5, source: "manual" }],
      };
      const retakeImage = vi.fn().mockResolvedValue({ id: "new", width: 1280, height: 720 });
      const library = makeLibrary({
        retakeImage,
        loadGuide: vi.fn().mockResolvedValue({
          guide: guideFile("guide-1", "Add a supplier"),
          steps: [shot],
        }),
      });
      render(<App recorder={makeRecorder()} library={library} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
      fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
      const dialog = await screen.findByRole("dialog", { name: "Retake this screenshot" });
      await expectNoSeriousAxeViolations(dialog);
      fireEvent.change(within(dialog).getByRole("combobox", { name: "Countdown" }), {
        target: { value: "3" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
      expect(await screen.findByText(/Screenshot retaken/)).toBeTruthy();
      expect(retakeImage).toHaveBeenCalledWith("lib-1", "guide-1", 3000, [], "balanced");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({
          id: "s1",
          media: expect.objectContaining({ id: "new", width: 1280 }),
          redactions: [expect.objectContaining({ x: 10, source: "manual" })],
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("says why a retake failed, in the app's own words", async () => {
    const library = makeLibrary({
      retakeImage: vi
        .fn()
        .mockRejectedValue({ code: "retakeOwnWindow", message: "Steps was in front." }),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
    const dialog = await screen.findByRole("dialog", { name: "Retake this screenshot" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
    expect(
      await screen.findByText(/bring the window you want to the front during the countdown/),
    ).toBeTruthy();
    expect(library.saveStep).not.toHaveBeenCalled();
  });

  it("has no serious or critical accessibility problems in the editor", async () => {
    const { container } = render(<App recorder={makeRecorder()} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    await screen.findByDisplayValue("Click Contacts");
    await expectNoSeriousAxeViolations(container);
  });
});
