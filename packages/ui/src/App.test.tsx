// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RECORDING_SETTINGS,
  hashPassword,
  newBrandProfile,
  parseGuideHistory,
  type GuideStep,
  type RecordedStep,
  type RecorderPreferences,
  type RecordingFact,
} from "@amluto-steps/core";
import { ENGLISH } from "@amluto-steps/core";

import { expectNoSeriousAxeViolations } from "../test/axe";
import { App } from "./App";
import { fakeCapabilities } from "./bridge/capabilities-fake";
import { initI18n } from "./i18n";
import type { LibraryBridge } from "./library-bridge";
import {
  fakeBin,
  fakeGuideCopies,
  fakeGuideFiles,
  fakeLibrary,
  type FakeLibrary,
} from "./library-fake";
import { factToStep } from "./recorded-step";
import type { RecorderBridge, RecorderSnapshot } from "./recorder-bridge";
import { fakeRecorder } from "./bridge/recorder-fake";
import { fakeRecorderBridge } from "./bridge/recorder-bridge-fake";

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

/**
 * Steps for Windows' recorder bridge, every part a fake and every method watched, with
 * `overrides` in their place. Its first recording is "session-9"; `unsaved` are recordings left
 * from before. `fire` sends the recorder's events, the way the native side does during a
 * recording.
 */
/** The bridge's methods, which the tests watch. */
type Method = {
  [K in keyof RecorderBridge]-?: RecorderBridge[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof RecorderBridge];

function makeRecorder(overrides: Partial<RecorderBridge> = {}, unsaved: string[] = []) {
  const live = fakeRecorder({ sessionIds: ["session-9"] });
  for (const sessionId of unsaved) live.addSession(sessionId);
  const recorder = fakeRecorderBridge({ ...live, ...overrides });
  for (const key of Object.keys(recorder) as Method[]) {
    const member = recorder[key];
    if (typeof member === "function" && !vi.isMockFunction(member)) vi.spyOn(recorder, key);
  }
  return Object.assign(recorder, { fire: live.fire, addMedia: live.addMedia });
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

/**
 * The UI package's fake library with one guide, "Add a supplier", every method spied on, and any
 * given changed for the test. Pictures aren't kept: every one loads blank.
 */
function makeLibrary(overrides: Partial<LibraryBridge> = {}): FakeLibrary {
  const library: FakeLibrary = {
    ...fakeLibrary({
      libraries: [
        {
          id: "lib-1",
          name: "My guides",
          path: "C:\\Guides",
          guides: [
            {
              guide: guideFile("guide-1", "Add a supplier"),
              steps: [stepFile("s1", "a", "Click Contacts"), stepFile("s2", "b", "Click Save")],
            },
          ],
        },
      ],
    }),
    loadImage: () => Promise.resolve("data:image/webp;base64,"),
    ...overrides,
  };
  for (const name of Object.keys(library) as (keyof LibraryBridge)[])
    if (typeof library[name] === "function") vi.spyOn(library, name);
  return library;
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

  it("asks on first run only what this copy has: a folder, and starting with the computer", async () => {
    const firstRun = (capabilities: Parameters<typeof fakeCapabilities>[0]) =>
      render(
        <App
          recorder={makeRecorder({
            capabilities: fakeCapabilities(capabilities),
            getPreferences: vi.fn().mockResolvedValue({ displayName: "", libraryFolder: "x" }),
          })}
          library={makeLibrary()}
        />,
      );
    firstRun({});
    expect(await screen.findByRole("button", { name: "Browse…" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Start when Windows starts" })).toBeDefined();
    cleanup();

    firstRun({ autoStart: "signIn" });
    expect(await screen.findByRole("checkbox", { name: "Start when you sign in" })).toBeDefined();
    cleanup();

    // Steps for Chrome: "My guides" is in the browser, which nothing starts.
    firstRun({ defaultLibrary: "browser", autoStart: null });
    expect(await screen.findByLabelText("Your name")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Browse…" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("asks for a name on first run and saves it", async () => {
    const setPreferences = vi.fn(async (preferences: RecorderPreferences) => preferences);
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
    const library = makeLibrary();
    library.data.picks.file = "C:/Downloads/supplier.amlsteps";
    library.data.files.set("C:/Downloads/supplier.amlsteps", {
      guide: guideFile("guide-9", "Add a supplier"),
      steps: [],
    });
    const saveGuide = vi.mocked(library.saveGuide);
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

  const openApplyBlur = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Add a supplier" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Apply blur permanently/ }));
  };
  const blurred = (step: ReturnType<typeof stepFile>) => ({
    ...step,
    redactions: [{ x: 10, y: 10, w: 20, h: 5, source: "manual" }],
  });

  it("says straight away that nothing is blurred, without asking, when nothing is (#52)", async () => {
    const applyRedactions = vi.fn().mockResolvedValue(0);
    render(<App recorder={makeRecorder()} library={makeLibrary({ applyRedactions })} />);
    await openApplyBlur();
    expect(
      await screen.findByText("Nothing is blurred in this guide, so nothing changed."),
    ).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(applyRedactions).not.toHaveBeenCalled();
  });

  it("asks before applying a blur that only a saved version still has (#52)", async () => {
    const library = makeLibrary();
    await library.saveStep("lib-1", "guide-1", blurred(stepFile("s1", "a", "Click Contacts")));
    await library.saveVersion("lib-1", "guide-1", "Blurred");
    await library.saveStep("lib-1", "guide-1", stepFile("s1", "a", "Click Contacts"));
    render(<App recorder={makeRecorder()} library={library} />);
    await openApplyBlur();
    expect(
      within(await screen.findByRole("alertdialog")).getByText(/can’t be undone/),
    ).toBeTruthy();
  });

  it("applies blur permanently only after the user confirms, in the app's own dialog", async () => {
    const applyRedactions = vi.fn().mockResolvedValue(2);
    const library = makeLibrary({ applyRedactions });
    await library.saveStep("lib-1", "guide-1", blurred(stepFile("s1", "a", "Click Contacts")));
    render(<App recorder={makeRecorder()} library={library} />);
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
      DEFAULT_RECORDING_SETTINGS,
    ) as RecordedStep;
    shortcutStep.action = "keypress";
    shortcutStep.actionText = 'Press "Ctrl + Shift + 1"';
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const recorder = makeRecorder(
      {
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
      },
      ["session-1"],
    );
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
    const recorder = makeRecorder(
      {
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
      },
      ["session-1"],
    );
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
    const recorder = makeRecorder(
      {
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
      },
      ["session-1"],
    );
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

  /**
   * An unsaved recording of two steps, its draft kept as the editor writes it, and a Save that
   * publishes it into "My guides" as the desktop does: the guide gets the recording's session id.
   */
  function unsavedRecording() {
    const library = makeLibrary({
      pickSaveLocation: vi.fn((_title: string, name: string) => Promise.resolve(`C:/Out/${name}`)),
    });
    const draft = new Map<string, unknown>([
      ["capture-1", stepFile("capture-1", "0000000001", "Click Save")],
      ["capture-2", stepFile("capture-2", "0000000002", "Click Close")],
    ]);
    const recorder = makeRecorder(
      {
        getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-1" }),
        getRecoveries: vi.fn().mockResolvedValue([
          {
            sessionId: "session-1",
            title: "Recovered",
            eventCount: 2,
            stopped: true,
            savedGuideId: null,
          },
        ]),
        loadDraft: vi.fn().mockResolvedValue({
          guide: guideFile("session-1", "Recovered"),
          steps: [...draft.values()],
        }),
        saveDraftStep: vi.fn((_session: string, step: unknown) => {
          draft.set((step as { id: string }).id, step);
          return Promise.resolve();
        }),
        deleteDraftStep: vi.fn((_session: string, id: string) => {
          draft.delete(id);
          return Promise.resolve();
        }),
        finalize: vi.fn(async (sessionId: string, guide: Record<string, unknown>) => {
          await library.createFromParts(
            "lib-1",
            { ...guide, recordingSessionId: sessionId },
            [...draft.values()],
            [],
          );
        }),
      },
      ["session-1"],
    );
    render(<App recorder={recorder} library={library} />);
    return { recorder, library };
  }

  /** Deletes the recording's first step in its editor, waiting for the draft to be written. */
  const deleteFirstStep = async (recorder: RecorderBridge) => {
    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete step" }));
    await waitFor(() =>
      expect(recorder.deleteDraftStep).toHaveBeenCalledWith("session-1", "capture-1"),
    );
  };

  /** The saved guide's editor still undoes the delete, and redoes it, writing each to it. */
  const undoAndRedoInTheSavedGuide = async (library: FakeLibrary) => {
    await waitFor(() => expect(library.loadGuide).toHaveBeenCalledWith("lib-1", "session-1"));
    expect(await screen.findByText("All changes saved")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: "Guide actions" }));
    const undo = await screen.findByRole("menuitem", { name: /Undo/ });
    expect((undo as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(undo);
    await waitFor(() =>
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "session-1",
        expect.objectContaining({ id: "capture-1", actionText: "Click Save" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Redo/ }));
    await waitFor(() =>
      expect(library.deleteStep).toHaveBeenCalledWith("lib-1", "session-1", "capture-1"),
    );
  };

  it("keeps Undo and Redo after Save guide, writing them to the saved guide (#82)", async () => {
    const { recorder, library } = unsavedRecording();
    await deleteFirstStep(recorder);
    fireEvent.click(screen.getByRole("button", { name: "Save guide" }));
    await undoAndRedoInTheSavedGuide(library);
  });

  it("keeps Undo and Redo after an export saves the recording (#82)", async () => {
    const { recorder, library } = unsavedRecording();
    await deleteFirstStep(recorder);
    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Word/ }));
    const review = await screen.findByRole("dialog");
    const exportIt = within(review).getByRole("button", { name: /^Export Word$/ });
    await waitFor(() => expect((exportIt as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(exportIt);
    await waitFor(() => expect(recorder.finalize).toHaveBeenCalled());
    await undoAndRedoInTheSavedGuide(library);
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
        settings: { showUnnamedTyping: false, wording: { language: "en", tone: "casual" } },
      }),
    );
    await waitFor(() => expect(recorder.minimizeMain).toHaveBeenCalled());
  });

  it("starts a new recording while a stopped one waits as a draft (07/10/2026)", async () => {
    // A stopped recording not yet saved is one draft among others: it doesn't hold the button.
    const recorder = makeRecorder({
      getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-1" }),
    });
    render(<App recorder={recorder} library={makeLibrary()} />);
    const record = (await screen.findByRole("button", {
      name: "New recording",
    })) as HTMLButtonElement;
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
  });

  it("records keys and output only when ticked for this recording", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Record what.s typed/ }));
    expect(within(dialog).getByText("Keys are read during this recording only.")).toBeTruthy();
    // Ticking what's typed ticks the output too (04/10/2026).
    expect(
      (within(dialog).getByRole("checkbox", { name: /Include command output/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await waitFor(() =>
      expect(recorder.start).toHaveBeenCalledWith(expect.any(String), {
        keys: true,
        output: true,
        settleMs: 1_500,
        appSwitchSteps: true,
        quality: "balanced",
        settings: { showUnnamedTyping: false, wording: { language: "en", tone: "casual" } },
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

  it("gives the window's title bar the theme chosen in Steps (P38)", async () => {
    // The light theme on a PC set to dark kept a dark title bar.
    window.localStorage.setItem("amluto-steps-theme", "light");
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    await screen.findByText("Add a supplier");
    expect(recorder.setWindowTheme).toHaveBeenLastCalledWith("light");
  });

  it("leaves the title bar to the device when the theme follows it", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    await screen.findByText("Add a supplier");
    expect(recorder.setWindowTheme).toHaveBeenLastCalledWith(null);
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
          new Promise<RecorderSnapshot>((resolve) => {
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
  function liveRecorder(overrides: Partial<RecorderBridge> = {}) {
    const recorder = makeRecorder(overrides);
    return { recorder, fire: recorder.fire };
  }

  const capture = (sequence: number, purpose: "captureNow" | "shortcut" = "captureNow") =>
    ({
      ...shortcutFact,
      sessionId: "session-9",
      sequence,
      record: { ...shortcutFact.record, id: 100 + sequence, purpose },
    }) as RecordingFact;

  // Typing into something unnamed, in Word's document.
  const typing = (sequence: number, text: string) =>
    ({
      sessionId: "session-9",
      recordedAt: 1_790_246_400_000 + sequence,
      sequence,
      record: {
        kind: "typing",
        id: 200 + sequence,
        tickMs: 100 * sequence,
        window: {
          title: "Letter - Word",
          exe: "WINWORD.EXE",
          pid: 10,
          frame: { left: 0, top: 0, right: 100, bottom: 100 },
          elevation: "notElevated",
          remoteSession: false,
        },
        capture: null,
        element: null,
        text,
        form: "text",
        language: "plain",
        cell: null,
        approximate: false,
        checkScreenshot: false,
      },
    }) as RecordingFact;

  const startFromTheSidebar = async (recorder: RecorderBridge, library = makeLibrary()) => {
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
  };

  it("asks before a stopped recording's draft takes the place of an editor whose save is failing (#80)", async () => {
    const { recorder, fire } = liveRecorder();
    const library = makeLibrary({
      saveStep: vi.fn().mockRejectedValue(new Error("The drive isn't there.")),
    });
    await startFromTheSidebar(recorder, library);
    // While it records, a guide is opened and edited, and its save fails.
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    expect(await screen.findByText("Couldn't save, retrying")).toBeDefined();

    // A recording with a step: one with none makes no draft at all (#52).
    act(() => fire.fact(capture(1)));
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Tuesday",
      }),
    );
    const ask = await screen.findByRole("alertdialog", {
      name: "Leave without your latest changes?",
    });
    fireEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    // The recording waits with the unsaved ones; the edit stays on screen.
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save guide" })).toBeNull();
  });

  it("says when clicks on a screen left out made no steps", async () => {
    const { recorder, fire } = liveRecorder();
    await startFromTheSidebar(recorder);
    act(() =>
      fire.finished({
        sessionId: "session-9",
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

  it("says nothing was recorded when a recording with no steps stops, and makes no guide (#52)", async () => {
    const { recorder, fire } = liveRecorder();
    const library = makeLibrary();
    await startFromTheSidebar(recorder, library);
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Tuesday",
      }),
    );
    expect(await screen.findByText("Nothing was recorded, so no guide was made.")).toBeDefined();
    await waitFor(() => expect(recorder.discard).toHaveBeenCalled());
    expect(recorder.saveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save guide" })).toBeNull();
    // Nothing waits as an unsaved recording either.
    expect(await recorder.getRecoveries()).toEqual([]);
    expect(library.createGuide).not.toHaveBeenCalled();
  });

  it("journals steps as facts arrive, opens them as a draft when it stops, and saves the guide", async () => {
    const { recorder, fire } = liveRecorder();
    await startFromTheSidebar(recorder);

    act(() => {
      fire.fact(capture(1));
      fire.fact(capture(2, "shortcut")); // the popup's own step arrives separately
      fire.fact(capture(3));
      fire.fact(capture(3)); // a repeat is ignored
    });
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledTimes(2));
    const appended = vi.mocked(recorder.appendStep).mock.calls.map(([, step]) => step.id);
    expect(appended).toEqual(["capture-1", "capture-3"]);

    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Tuesday",
      }),
    );
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
    const library = makeLibrary({ setDefaultLibrary: vi.fn() });
    const team = await library.addLibrary("Finance team", "S:\\Finance");
    // What the recorder's Save writes there, for the editor to open.
    await library.createFromParts(team.id, guideFile("session-9", "Tuesday"), [], []);
    await startFromTheSidebar(recorder, library);
    act(() => fire.fact(capture(1)));
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledOnce());
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Tuesday",
      }),
    );

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
        team.id,
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
      fire.fact(capture(1));
      fire.fact(capture(2));
      fire.restarted({ sessionId: "session-9", afterSequence: 2 });
      fire.fact(capture(2)); // late copies of dropped facts stay dropped
      fire.fact(capture(3));
      fire.restarted({ sessionId: "other-session", afterSequence: 3 }); // not this recording
    });
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Again",
      }),
    );
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
      fire.fact(capture(1));
      fire.fact(capture(2));
      fire.restarted({ sessionId: "session-9", afterSequence: 2 });
      fire.restarted({ sessionId: "session-9", afterSequence: null });
    });
    act(() => fire.fact(capture(3)));
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Undone",
      }),
    );
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = vi.mocked(recorder.saveDraft).mock.calls[0] as [
      string,
      unknown,
      { id: string }[],
    ];
    expect(steps.map((step) => step.id)).toEqual(["capture-1", "capture-2", "capture-3"]);
  });

  it("builds the live steps and a rebuild from the journal with the settings and wording it started with", async () => {
    const facts = [typing(1, "Dear Sam"), typing(2, "Kind regards")];

    // Recorded with "Show typing into unnamed boxes" off, switched on halfway through.
    const { recorder, fire } = liveRecorder();
    await startFromTheSidebar(recorder);
    const [, options] = vi.mocked(recorder.start).mock.calls[0] ?? [];
    expect(options?.settings).toEqual({
      showUnnamedTyping: false,
      wording: { language: "en", tone: "casual" },
    });
    act(() => fire.fact(facts[0] as RecordingFact));
    window.localStorage.setItem("amluto-steps-show-unnamed-typing", "true");
    act(() => fire.fact(facts[1] as RecordingFact));
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledTimes(2));
    const live = vi
      .mocked(recorder.appendStep)
      .mock.calls.map(([, step]) => [step.actionText, step.showValue]);
    expect(live).toEqual([
      ["Type", false],
      ["Type", false],
    ]);
    cleanup();

    // The app restarted before its steps were saved: the draft is rebuilt from the journal alone,
    // with the setting still on, and the tone changed since.
    window.localStorage.setItem("amluto-steps-step-tone", "formal");
    const saveDraft = vi.fn().mockResolvedValue(undefined);
    const rebuilt = makeRecorder(
      {
        getState: vi.fn().mockResolvedValue({ ...idle, sessionId: "session-9" }),
        getRecoveries: vi.fn().mockResolvedValue([
          {
            sessionId: "session-9",
            title: "Letter",
            eventCount: 2,
            stopped: true,
            savedGuideId: null,
          },
        ]),
        getRecoveryRecords: vi.fn().mockResolvedValue(facts),
        getRecordingSettings: vi.fn().mockResolvedValue(options?.settings),
        saveDraft,
      },
      ["session-9"],
    );
    render(<App recorder={rebuilt} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review and save" }));
    await waitFor(() => expect(saveDraft).toHaveBeenCalledOnce());
    expect(rebuilt.getRecordingSettings).toHaveBeenCalledWith("session-9");
    const [, guide, steps] = saveDraft.mock.calls[0] as [
      string,
      { language: string; tone: string },
      { actionText: string; showValue: boolean }[],
    ];
    expect(steps.map((step) => [step.actionText, step.showValue])).toEqual(live);
    expect(guide).toMatchObject({ language: "en", tone: "casual" });
  });

  it("opens the draft from every fact the window saw, as the steps shown live are made", async () => {
    // A field read twice: the draft keeps the last read, as the live steps do.
    const supplier = (sequence: number, value: string) =>
      ({
        sessionId: "session-9",
        recordedAt: 1_790_246_400_000 + sequence,
        sequence,
        record: {
          kind: "input",
          tickMs: 100 * sequence,
          element: {
            controlType: "Edit",
            localizedControlType: "edit",
            name: "Supplier",
            automationId: "supplier",
            helpText: "",
            ariaRole: "",
            ariaProperties: "",
            className: "",
            frameworkId: "Win32",
            isPassword: false,
            labeledBy: null,
            bounds: null,
            ancestors: [],
            sensitive: false,
          },
          value,
          withheld: null,
        },
      }) as RecordingFact;
    // The journal was read before the second read reached it.
    const { recorder, fire } = liveRecorder({
      getRecoveryRecords: vi.fn().mockResolvedValue([supplier(1, "Ac")]),
    });
    await startFromTheSidebar(recorder);
    act(() => {
      fire.fact(supplier(1, "Ac"));
      fire.fact(supplier(2, "Acme"));
    });
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledTimes(2));
    act(() =>
      fire.finished({
        sessionId: "session-9",
        snapshot: { ...idle, sessionId: "session-9" },
        title: "Supplier",
      }),
    );
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    const [, , steps] = vi.mocked(recorder.saveDraft).mock.calls[0] as [
      string,
      unknown,
      { id: string; actionText: string }[],
    ];
    expect(steps.map((step) => [step.id, step.actionText])).toEqual([
      ["capture-2", 'Type "Acme" in "Supplier" field'],
    ]);
  });

  /** The window opening while a recording runs (reloaded, or opened again): its facts go on. */
  const reopenedDuring = (overrides: Partial<RecorderBridge> = {}) => {
    const { recorder, fire } = liveRecorder({
      getState: vi.fn().mockResolvedValue({ ...idle, state: "recording", sessionId: "session-9" }),
      getRecoveries: vi.fn().mockResolvedValue([
        {
          sessionId: "session-9",
          title: "Letter",
          eventCount: 0,
          stopped: false,
          savedGuideId: null,
        },
      ]),
      getSessionSteps: vi.fn().mockResolvedValue([]),
      getRestartPoint: vi.fn().mockResolvedValue(null),
      ...overrides,
    });
    render(<App recorder={recorder} library={makeLibrary()} />);
    return { recorder, fire };
  };
  const journalled = (recorder: RecorderBridge) =>
    vi.mocked(recorder.appendStep).mock.calls.map(([, step]) => [step.actionText, step.showValue]);

  it("takes up a running recording's own settings when the window opens during it", async () => {
    // Recorded with "Show typing into unnamed boxes" on; it's off in Settings now.
    const { recorder, fire } = reopenedDuring({
      getRecordingSettings: vi.fn().mockResolvedValue({
        showUnnamedTyping: true,
        wording: { language: "en", tone: "casual" },
      }),
    });
    await waitFor(() => expect(recorder.getRecordingSettings).toHaveBeenCalledWith("session-9"));
    await waitFor(() => expect(recorder.getMonitors).toHaveBeenCalled());
    act(() => fire.fact(typing(1, "Dear Sam")));
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledOnce());
    expect(journalled(recorder)).toEqual([['Type "Dear Sam"', true]]);
  });

  it("reads today's settings once for a running recording that saved none, not at each step", async () => {
    const { recorder, fire } = reopenedDuring({
      getRecordingSettings: vi.fn().mockResolvedValue(null),
    });
    await waitFor(() => expect(recorder.getMonitors).toHaveBeenCalled());
    act(() => fire.fact(typing(1, "Dear Sam")));
    // Switched on in Settings mid-recording: this recording goes on as it began.
    window.localStorage.setItem("amluto-steps-show-unnamed-typing", "true");
    act(() => fire.fact(typing(2, "Kind regards")));
    await waitFor(() => expect(recorder.appendStep).toHaveBeenCalledTimes(2));
    expect(journalled(recorder)).toEqual([
      ["Type", false],
      ["Type", false],
    ]);
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
                kind: "readOnly" as const,
                lock: { name: "Sam Jones", pc: "SAMS-PC", session: "s", counter: 1, since: "" },
              }
            : { kind: "editing" as const },
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
    const first = await screen.findByRole("button", { name: "Open Add a supplier" });
    // Ctrl+A is heard on the window, by the list's effects, which React may run a moment after
    // the list shows: until then it ticks nothing. Pressing it again ticks the same guides.
    const moveTo = await waitFor(() => {
      fireEvent.keyDown(first, { key: "a", ctrlKey: true });
      return screen.getByRole("button", { name: "Move to…" });
    });
    fireEvent.click(moveTo);
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
      openForEditing: vi.fn().mockResolvedValue({ kind: "editing" }),
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

  it("waits for someone editing a guide before a card's Move or Move to Bin, and offers to take over to rename", async () => {
    const libraries = [
      { id: "lib-1", name: "My guides", path: "C:\\Guides", isDefault: true },
      { id: "lib-2", name: "Finance team", path: "S:\\Finance", isDefault: false },
    ].map((item) => ({ ...item, managed: false, synced: false, guideCount: 1 }));
    const sam = { name: "Sam Jones", pc: "SAMS-PC", session: "s", counter: 1, since: "" };
    const library = makeLibrary({
      listLibraries: vi.fn().mockResolvedValue(libraries),
      listGuides: vi.fn().mockResolvedValue([
        {
          id: "g1",
          title: "Add a supplier",
          updatedAt: "2026-09-25T10:00:00.000Z",
          stepCount: 2,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: null,
        },
      ]),
      loadGuide: vi.fn().mockResolvedValue({
        guide: guideFile("g1", "Add a supplier"),
        steps: [],
      }),
      openForEditing: vi.fn((_library: string, _guide: string, takeOver: boolean) =>
        Promise.resolve(
          takeOver ? { kind: "editing" as const } : { kind: "readOnly" as const, lock: sam },
        ),
      ),
      listTrash: vi.fn().mockResolvedValue([]),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    const menu = async () =>
      fireEvent.click(
        await screen.findByRole("button", { name: "More actions for Add a supplier" }),
      );

    await menu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));
    expect(
      await screen.findByText(
        "Sam Jones is editing this guide, so it can’t go to the Bin now. Try again once they’ve finished.",
      ),
    ).toBeDefined();
    await menu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Finance team" }));
    expect(
      await screen.findByText(
        "Sam Jones is editing this guide, so it can’t be moved now. Try again once they’ve finished.",
      ),
    ).toBeDefined();
    expect(library.trashGuide).not.toHaveBeenCalled();
    expect(library.moveGuide).not.toHaveBeenCalled();
    expect(library.openForEditing).not.toHaveBeenCalledWith("lib-1", "g1", true);

    await menu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Title" }), {
      target: { value: "Add a new supplier" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const ask = await screen.findByRole("alertdialog", {
      name: "Take over editing from Sam Jones?",
    });
    fireEvent.click(within(ask).getByRole("button", { name: "Take over editing" }));
    await waitFor(() =>
      expect(library.saveGuide).toHaveBeenCalledWith(
        "lib-1",
        "g1",
        expect.objectContaining({ title: "Add a new supplier" }),
      ),
    );
    expect(library.openForEditing).toHaveBeenCalledWith("lib-1", "g1", true);
    expect(library.releaseLock).toHaveBeenCalledWith("lib-1", "g1");
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

  it("saves a Steps file in the export folder, and offers its folder (12/10/2026, #88)", async () => {
    const downloads = String.raw`C:\Users\Robin\Downloads`;
    const library = makeLibrary({
      listGuides: vi.fn().mockResolvedValue([
        {
          id: "guide-1",
          title: "Add a supplier",
          updatedAt: "2026-09-25T10:00:00.000Z",
          stepCount: 1,
          tags: [],
          owner: "Robin",
          reviewBy: null,
          thumbnailMediaId: null,
        },
      ]),
      loadGuide: vi.fn(() =>
        Promise.resolve({
          guide: guideFile("guide-1", "Add a supplier"),
          steps: [stepFile("s1", "a", "Click Save")],
        }),
      ),
      pickSaveLocation: vi.fn(() => Promise.resolve(null)),
      exportAmlstepsTo: vi.fn((_library: string, _guide: string, folder: string, name: string) =>
        Promise.resolve(`${folder}\\${name}`),
      ),
      saveVersion: vi.fn().mockResolvedValue(undefined),
    });
    const recorder = makeRecorder({ defaultExportFolder: () => Promise.resolve(downloads) });
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Add a supplier" }));
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Steps file/ }));
    const review = await screen.findByRole("dialog");
    const exportIt = within(review).getByRole("button", { name: /^Export Steps file$/ });
    await waitFor(() => expect((exportIt as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(exportIt);

    await waitFor(() => expect(library.exportAmlstepsTo).toHaveBeenCalled());
    expect(library.pickSaveLocation).not.toHaveBeenCalled();
    expect(library.exportAmlstepsTo).toHaveBeenCalledWith(
      "lib-1",
      "guide-1",
      downloads,
      expect.stringMatching(/^Add a supplier - \d\d-\d\d-\d{4}\.amlsteps$/),
      false,
    );
    const toast = (await screen.findByText(/^Saved Add a supplier - .*\.amlsteps\./)).closest(
      "[role=status]",
    ) as HTMLElement;
    // Shown in its folder; no app opens a Steps file, so there's no Open.
    expect(within(toast).getByRole("button", { name: "Open file location" })).toBeTruthy();
    expect(within(toast).queryByRole("button", { name: "Open" })).toBeNull();
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

  it("keeps Undo and Redo after an export, which saves a version (#82)", async () => {
    const library = makeLibrary({
      pickSaveLocation: vi.fn((_title: string, name: string) => Promise.resolve(`C:/Out/${name}`)),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete step" }));
    await waitFor(() => expect(library.deleteStep).toHaveBeenCalledWith("lib-1", "guide-1", "s1"));

    fireEvent.click(screen.getByRole("button", { name: /^Export/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Word/ }));
    const review = await screen.findByRole("dialog");
    const exportIt = within(review).getByRole("button", { name: /^Export Word$/ });
    await waitFor(() => expect((exportIt as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(exportIt);
    await waitFor(() => expect(library.saveVersion).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Undo/ }));
    await waitFor(() =>
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({ id: "s1", actionText: "Click Contacts" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Redo/ }));
    await waitFor(() => expect(library.deleteStep).toHaveBeenCalledTimes(2));
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

  it("saves where a toast showed on a retaken picture with its step (#96)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const message = { x: 75, y: 50, w: 25, h: 40 };
      const retakeImage = vi
        .fn()
        .mockResolvedValue({ id: "new", width: 1280, height: 720, notifications: [message] });
      const library = makeLibrary({ retakeImage });
      render(<App recorder={makeRecorder()} library={library} />);
      fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
      fireEvent.click(await screen.findByRole("button", { name: "Retake" }));
      const dialog = await screen.findByRole("dialog", { name: "Retake this screenshot" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Retake" }));
      expect(await screen.findByText(/Screenshot retaken/)).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({
          id: "s1",
          media: expect.objectContaining({ id: "new", notifications: [message] }),
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

  it("goes back to the library after Move to Bin from the editor's menu, with Undo (#79)", async () => {
    const library = makeLibrary();
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    await screen.findByDisplayValue("Click Contacts");
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));

    expect(await screen.findByText("“Add a supplier” moved to the Bin.")).toBeDefined();
    expect(library.trashGuide).toHaveBeenCalledWith("lib-1", "guide-1");
    // The library, without the guide: the editor has closed.
    expect(await screen.findByRole("button", { name: /^Bin/ })).toBeDefined();
    expect(screen.queryByDisplayValue("Click Contacts")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Add a supplier" })).toBeNull();
    // The Bin leaves the edit lock behind, and the editor let go of its own.
    await waitFor(() => expect(library.releaseLock).toHaveBeenCalledWith("lib-1", "guide-1"));

    // Undo brings the guide back and opens it in the editor again, to edit.
    vi.mocked(library.openForEditing).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByDisplayValue("Click Contacts")).toBeDefined();
    expect(library.restoreGuide).toHaveBeenCalledWith("lib-1", expect.any(String));
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith("lib-1", "guide-1", false),
    );
  });

  it("writes the edits still waiting before the guide goes to the Bin from the editor", async () => {
    let finish: () => void = () => undefined;
    const library = makeLibrary({
      saveStep: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));

    // Nothing goes to the Bin while the edit is still being written…
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(library.trashGuide).not.toHaveBeenCalled();
    // …and once it's on disk, the guide goes.
    finish();
    await waitFor(() => expect(library.trashGuide).toHaveBeenCalledWith("lib-1", "guide-1"));
  });
});

describe("Leaving the editor while a save is failing (#80)", () => {
  const leaveTitle = "Leave without your latest changes?";

  /** "Add a supplier" open in the editor with an edit its library can't save. */
  const failingEditor = async (recorderParts: Partial<RecorderBridge> = {}) => {
    const library = makeLibrary({
      saveStep: vi.fn().mockRejectedValue(new Error("The drive isn't there.")),
    });
    const recorder = makeRecorder(recorderParts);
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    expect(await screen.findByText("Couldn't save, retrying")).toBeDefined();
    return { library, recorder };
  };

  it("asks before going back to the guides, and Stay keeps the editor open", async () => {
    await failingEditor();
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    const ask = await screen.findByRole("alertdialog", { name: leaveTitle });
    // Staying is where focus starts, and keeps the edit on screen.
    expect(document.activeElement?.textContent).toBe("Stay");
    fireEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    const again = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(again).getByRole("button", { name: "Leave anyway" }));
    expect(await screen.findByRole("button", { name: "Open Add a supplier" })).toBeDefined();
  });

  it("asks before opening another guide, and Stay leaves the draft where it was", async () => {
    const library = makeLibrary({
      saveStep: vi.fn().mockRejectedValue(new Error("The drive isn't there.")),
    });
    // Someone's unsaved changes, kept as a draft on the guide when they were taken over from.
    await library.saveDraft("lib-1", "guide-1", {
      guide: guideFile("guide-1", "Add a supplier"),
      steps: [stepFile("s1", "a", "Click Vendors")],
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    expect(await screen.findByText("Couldn't save, retrying")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Open as a copy" }));
    const ask = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();
    expect(library.draftToCopy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open as a copy" }));
    const again = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(again).getByRole("button", { name: "Leave anyway" }));
    expect(await screen.findByDisplayValue("Click Vendors")).toBeDefined();
  });

  it("asks before Move to Bin, which Stay leaves undone", async () => {
    const { library } = await failingEditor();
    const binIt = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));
      return screen.findByRole("alertdialog", { name: leaveTitle });
    };
    fireEvent.click(within(await binIt()).getByRole("button", { name: "Stay" }));
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();
    expect(library.trashGuide).not.toHaveBeenCalled();

    fireEvent.click(within(await binIt()).getByRole("button", { name: "Leave anyway" }));
    expect(await screen.findByText("“Add a supplier” moved to the Bin.")).toBeDefined();
    expect(library.trashGuide).toHaveBeenCalledWith("lib-1", "guide-1");
    expect(await screen.findByRole("button", { name: /^Bin/ })).toBeDefined();
  });

  /** The main window's close button, as the app hears of it while closing is held. */
  const closeButton = () => {
    let press: (() => void) | null = null;
    return {
      parts: {
        onCloseAsked: vi.fn(async (handler: () => void) => {
          press = handler;
          return () => undefined;
        }),
      },
      press: () => act(() => press?.()),
    };
  };

  it("holds the window's closing to ask first, and Stay keeps it open", async () => {
    const close = closeButton();
    const { recorder } = await failingEditor(close.parts);
    await waitFor(() => expect(recorder.askBeforeClose).toHaveBeenLastCalledWith(true));

    close.press();
    const ask = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(recorder.closeMain).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();

    close.press();
    const again = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(again).getByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(recorder.closeMain).toHaveBeenCalledOnce());
  });

  /** The tray's Quit, as the app hears of it while a save is failing (#95). */
  const trayQuit = () => {
    let choose: (() => void) | null = null;
    return {
      parts: {
        onQuitAsked: vi.fn(async (handler: () => void) => {
          choose = handler;
          return () => undefined;
        }),
      },
      choose: () => act(() => choose?.()),
    };
  };

  it("asks before the tray's Quit, and Stay keeps Steps running", async () => {
    const quit = trayQuit();
    const { recorder } = await failingEditor(quit.parts);

    quit.choose();
    const ask = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(recorder.quitApp).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Click Suppliers")).toBeDefined();

    quit.choose();
    const again = await screen.findByRole("alertdialog", { name: leaveTitle });
    fireEvent.click(within(again).getByRole("button", { name: "Quit anyway" }));
    await waitFor(() => expect(recorder.quitApp).toHaveBeenCalledOnce());
  });

  it("quits at once if the save has gone through by the time Quit is asked about", async () => {
    const quit = trayQuit();
    const library = makeLibrary();
    const recorder = makeRecorder(quit.parts);
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));

    quit.choose();
    await waitFor(() => expect(recorder.quitApp).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("doesn't ask while saves work", async () => {
    const library = makeLibrary();
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={library} />);
    // Closing the window isn't held: it closes as always.
    await waitFor(() => expect(recorder.askBeforeClose).toHaveBeenCalledWith(false));
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(await screen.findByRole("button", { name: "Open Add a supplier" })).toBeDefined();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(recorder.askBeforeClose).not.toHaveBeenCalledWith(true);
  });
});

describe("Move to from the editor (#94)", () => {
  /** "Add a supplier" in "My guides", with "Finance team" beside it. */
  const twoLibraries = async (overrides: Partial<LibraryBridge> = {}) => {
    const library = makeLibrary(overrides);
    const finance = await library.addLibrary("Finance team", "S:\\Finance");
    return { library, finance: finance.id };
  };

  /** "Add a supplier" open in the editor. */
  const openGuide = async (library: FakeLibrary) => {
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    return screen.findByDisplayValue("Click Contacts");
  };

  const moveToFinance = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Finance team" }));
  };

  /** The guides whose edit lock the app has taken and not let go of, by library and guide. */
  const locksHeld = (library: FakeLibrary) => {
    const opened = vi.mocked(library.openForEditing).mock;
    const released = vi.mocked(library.releaseLock).mock;
    const held = new Set<string>();
    [
      ...opened.calls.map(([id, guide], index) => ({
        order: opened.invocationCallOrder[index] ?? 0,
        key: `${id}/${guide}`,
        open: true,
      })),
      ...released.calls.map(([id, guide], index) => ({
        order: released.invocationCallOrder[index] ?? 0,
        key: `${id}/${guide}`,
        open: false,
      })),
    ]
      .sort((one, other) => one.order - other.order)
      .forEach(({ key, open }) => (open ? held.add(key) : held.delete(key)));
    return [...held];
  };

  it("opens the guide again from the library it went to, where its edits are saved", async () => {
    const { library, finance } = await twoLibraries();
    await openGuide(library);
    await moveToFinance();

    expect(await screen.findByText("Moved to Finance team.")).toBeDefined();
    expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "guide-1", finance);
    // The editor is on the guide where it is now: its edit lock taken there, the old one let go.
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
    );
    expect(library.releaseLock).toHaveBeenCalledWith("lib-1", "guide-1");
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    await waitFor(() =>
      expect(library.saveStep).toHaveBeenCalledWith(
        finance,
        "guide-1",
        expect.objectContaining({ actionText: "Click Suppliers" }),
      ),
    );
    expect(library.saveStep).not.toHaveBeenCalledWith(
      "lib-1",
      expect.anything(),
      expect.anything(),
    );

    // Back goes to the guides of the library it's in now, and no edit lock is left anywhere.
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(await screen.findByRole("heading", { name: "Finance team" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Open Add a supplier" })).toBeDefined();
    await waitFor(() => expect(locksHeld(library)).toEqual([]));
  });

  it("writes the edits still waiting before the guide moves", async () => {
    let finish: () => void = () => undefined;
    const { library, finance } = await twoLibraries({
      saveStep: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    fireEvent.change(await openGuide(library), { target: { value: "Click Suppliers" } });
    await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
    await moveToFinance();

    // Nothing moves while the edit is still being written…
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(library.moveGuide).not.toHaveBeenCalled();
    // …and once it's on disk, the guide goes.
    finish();
    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "guide-1", finance),
    );
  });

  it("asks first while a save is failing, and Stay leaves the guide where it is", async () => {
    const { library, finance } = await twoLibraries({
      saveStep: vi.fn().mockRejectedValue(new Error("The drive isn't there.")),
    });
    fireEvent.change(await openGuide(library), { target: { value: "Click Suppliers" } });
    expect(await screen.findByText("Couldn't save, retrying")).toBeDefined();
    const answer = async (button: string) => {
      await moveToFinance();
      const ask = await screen.findByRole("alertdialog", {
        name: "Leave without your latest changes?",
      });
      fireEvent.click(within(ask).getByRole("button", { name: button }));
    };

    await answer("Stay");
    await waitFor(() =>
      expect((screen.getByDisplayValue("Click Suppliers") as HTMLTextAreaElement).readOnly).toBe(
        false,
      ),
    );
    expect(library.moveGuide).not.toHaveBeenCalled();

    await answer("Leave anyway");
    expect(await screen.findByText("Moved to Finance team.")).toBeDefined();
    expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "guide-1", finance);
    // Open from where it went, as it was last saved.
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
    );
    expect(await screen.findByDisplayValue("Click Contacts")).toBeDefined();
  });

  it("takes no edits while the guide is moving, so none goes to where it has left", async () => {
    const { library, finance } = await twoLibraries();
    const { moveGuide } = fakeGuideCopies(library.data);
    let arrive: () => void = () => undefined;
    vi.mocked(library.moveGuide).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        arrive = resolve;
      });
      return moveGuide(...args);
    });
    const words = (await openGuide(library)) as HTMLTextAreaElement;
    await moveToFinance();
    await waitFor(() => expect(library.moveGuide).toHaveBeenCalled());

    await waitFor(() => expect(words.readOnly).toBe(true));
    fireEvent.change(words, { target: { value: "Click Suppliers" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(library.saveStep).not.toHaveBeenCalled();

    // Moved: the guide opens from where it went, to be edited there.
    arrive();
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
    );
    const there = (await screen.findByDisplayValue("Click Contacts")) as HTMLTextAreaElement;
    expect(there.readOnly).toBe(false);
  });

  it("takes no edits while the guide goes to the Bin either", async () => {
    const library = makeLibrary();
    const { trashGuide } = fakeBin(library.data);
    let binned: () => void = () => undefined;
    vi.mocked(library.trashGuide).mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => {
        binned = resolve;
      });
      return trashGuide(...args);
    });
    const words = (await openGuide(library)) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));
    await waitFor(() => expect(library.trashGuide).toHaveBeenCalled());

    await waitFor(() => expect(words.readOnly).toBe(true));
    fireEvent.change(words, { target: { value: "Click Suppliers" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    expect(library.saveStep).not.toHaveBeenCalled();
    binned();
    expect(await screen.findByText("“Add a supplier” moved to the Bin.")).toBeDefined();
  });

  /** The button on the toast saying `text`. */
  const onToast = async (text: string, label: string) => {
    const box = (await screen.findByText(text)).parentElement;
    if (!box) throw new Error(`no toast saying ${text}`);
    return within(box).getByRole("button", { name: label });
  };

  it("takes the guide back with Undo, edits made where it went included, and opens it there", async () => {
    let finish: () => void = () => undefined;
    const { library, finance } = await twoLibraries();
    await openGuide(library);
    await moveToFinance();
    const undo = await onToast("Moved to Finance team.", "Undo");
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
    );
    // An edit where it went, still being written when Undo is chosen.
    const { saveStep } = fakeGuideFiles(library.data);
    vi.mocked(library.saveStep).mockImplementation(
      (...args) =>
        new Promise<void>((resolve) => {
          finish = () => void saveStep(...args).then(resolve);
        }),
    );
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
    fireEvent.click(undo);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(library.moveGuide).not.toHaveBeenCalledWith(finance, "guide-1", "lib-1");
    finish();
    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith(finance, "guide-1", "lib-1"),
    );
    // Back in the editor, from "My guides", with the edit.
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenLastCalledWith("lib-1", "guide-1", false),
    );
    expect(await screen.findByDisplayValue("Click Suppliers")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(await screen.findByRole("heading", { name: "My guides" })).toBeDefined();
    await waitFor(() => expect(locksHeld(library)).toEqual([]));
  });

  it("opens the guide again with Undo after the editor was left, as Undo of Move to Bin does", async () => {
    const { library, finance } = await twoLibraries();
    await openGuide(library);
    await moveToFinance();
    const undo = await onToast("Moved to Finance team.", "Undo");
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(await screen.findByRole("heading", { name: "Finance team" })).toBeDefined();
    fireEvent.click(undo);

    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith(finance, "guide-1", "lib-1"),
    );
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenLastCalledWith("lib-1", "guide-1", false),
    );
    expect(await screen.findByDisplayValue("Click Contacts")).toBeDefined();
    // Behind it, the guides of the library it's back in.
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    expect(await screen.findByRole("heading", { name: "My guides" })).toBeDefined();
    expect(await screen.findByRole("button", { name: "Open Add a supplier" })).toBeDefined();
    await waitFor(() => expect(locksHeld(library)).toEqual([]));
  });

  it("stays on the guide, taking edits again, when the move fails", async () => {
    const { library } = await twoLibraries({
      moveGuide: vi
        .fn()
        .mockRejectedValue({ code: "storageError", message: "The folder isn't there." }),
    });
    await openGuide(library);
    await moveToFinance();

    expect(
      await screen.findByText("That couldn’t be saved or read: The folder isn't there."),
    ).toBeDefined();
    const words = screen.getByDisplayValue("Click Contacts") as HTMLTextAreaElement;
    await waitFor(() => expect(words.readOnly).toBe(false));
    fireEvent.change(words, { target: { value: "Click Suppliers" } });
    await waitFor(() =>
      expect(library.saveStep).toHaveBeenCalledWith(
        "lib-1",
        "guide-1",
        expect.objectContaining({ actionText: "Click Suppliers" }),
      ),
    );
  });

  it("opens a guide locked with a password locked again where it went", async () => {
    const { library, finance } = await twoLibraries();
    await library.writeGuideLock("lib-1", "guide-1", {
      formatVersion: 1,
      locked: { by: "Sam Jones", login: "", pc: "", at: "2026-10-04T10:00:00Z" },
      password: await hashPassword("secret1", 1_000),
    });
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.click(await screen.findByRole("button", { name: "Unlock to edit" }));
    const ask = await screen.findByRole("dialog", { name: "Password for “Add a supplier”" });
    fireEvent.change(within(ask).getByLabelText("Password"), { target: { value: "secret1" } });
    fireEvent.click(within(ask).getByRole("button", { name: "Unlock" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Unlock to edit" })).toBeNull(),
    );

    // Unlocked for this editing session, it moves without asking again…
    await moveToFinance();
    expect(await screen.findByText("Moved to Finance team.")).toBeDefined();
    expect(library.moveGuide).toHaveBeenCalledWith("lib-1", "guide-1", finance);
    // …and the session ended with it: where it went, the password is asked for again.
    expect(await screen.findByRole("button", { name: "Unlock to edit" })).toBeDefined();
    expect(library.loadGuide).toHaveBeenCalledWith(finance, "guide-1");
    expect(library.openForEditing).not.toHaveBeenCalledWith(finance, "guide-1", false);
    expect(locksHeld(library)).toEqual([]);
  });

  it("takes a guide moved from its card back from the editor opened on it since", async () => {
    const { library, finance } = await twoLibraries();
    render(<App recorder={makeRecorder()} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Add a supplier" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Finance team" }));
    const undo = await onToast("Moved to Finance team.", "Undo");
    // Opened where it went, and edited there, before Undo.
    fireEvent.change(screen.getByRole("combobox", { name: "LIBRARY" }), {
      target: { value: finance },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    fireEvent.change(await screen.findByDisplayValue("Click Contacts"), {
      target: { value: "Click Suppliers" },
    });
    fireEvent.click(undo);

    await waitFor(() =>
      expect(library.moveGuide).toHaveBeenCalledWith(finance, "guide-1", "lib-1"),
    );
    const saved = vi.mocked(library.saveStep).mock.invocationCallOrder[0] ?? Infinity;
    const movedBack = vi.mocked(library.moveGuide).mock.invocationCallOrder[1] ?? 0;
    expect(saved).toBeLessThan(movedBack);
    await waitFor(() =>
      expect(library.openForEditing).toHaveBeenLastCalledWith("lib-1", "guide-1", false),
    );
    expect(await screen.findByDisplayValue("Click Suppliers")).toBeDefined();
  });

  describe("the save its edits count as (#111)", () => {
    /** The save count of "Add a supplier" in a library, as its history says. */
    const savesIn = (library: FakeLibrary, libraryId: string) =>
      parseGuideHistory(library.data.libraries.get(libraryId)?.guides.get("guide-1")?.history)
        .saves;

    /** Back to the guides, once every edit lock is let go of. */
    const leaveEditor = async (library: FakeLibrary) => {
      fireEvent.click(screen.getByRole("button", { name: "Guides" }));
      await screen.findByRole("button", { name: "Open Add a supplier" });
      await waitFor(() => expect(locksHeld(library)).toEqual([]));
    };

    it("counts edits made before Move to as one save where the guide went, as Properties shows", async () => {
      const { library, finance } = await twoLibraries();
      fireEvent.change(await openGuide(library), { target: { value: "Click Suppliers" } });
      await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
      await moveToFinance();
      await waitFor(() =>
        expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
      );
      await screen.findByDisplayValue("Click Suppliers");

      fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Properties" }));
      const properties = await screen.findByRole("dialog", {
        name: "Properties of “Add a supplier”",
      });
      expect(await within(properties).findByText("1 save")).toBeDefined();
      fireEvent.click(within(properties).getByRole("button", { name: "Close" }));

      // Leaving the editor where it went, with nothing changed there, counts nothing more.
      await leaveEditor(library);
      expect(savesIn(library, finance)).toBe(1);
    });

    it("counts nothing when the guide moves with nothing changed", async () => {
      const { library, finance } = await twoLibraries();
      await openGuide(library);
      await moveToFinance();
      await waitFor(() =>
        expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
      );
      await screen.findByDisplayValue("Click Contacts");
      await leaveEditor(library);
      expect(savesIn(library, finance)).toBe(0);
    });

    it("counts edits made before Move to Bin as one save, which Undo brings back", async () => {
      const library = makeLibrary();
      fireEvent.change(await openGuide(library), { target: { value: "Click Suppliers" } });
      await waitFor(() => expect(library.saveStep).toHaveBeenCalled());
      fireEvent.click(screen.getByRole("button", { name: "Guide actions" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Move to Bin" }));
      fireEvent.click(await onToast("“Add a supplier” moved to the Bin.", "Undo"));

      await waitFor(() =>
        expect(library.openForEditing).toHaveBeenLastCalledWith("lib-1", "guide-1", false),
      );
      await screen.findByDisplayValue("Click Suppliers");
      await leaveEditor(library);
      expect(savesIn(library, "lib-1")).toBe(1);
    });

    it("follows the guide where it went when only its Bin entry can't be removed", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        // The editions move by copying and putting the original in the Bin, whose entry then
        // can't be removed (a file held open by OneDrive).
        const entry = { trashId: "t1", guideId: "guide-1", title: "Add a supplier", deletedAt: "" };
        const { library, finance } = await twoLibraries({
          listTrash: vi.fn((id: string) => Promise.resolve(id === "lib-1" ? [entry] : [])),
          deleteTrashed: vi
            .fn()
            .mockRejectedValue({ code: "storageError", message: "The Bin is held open." }),
        });
        await openGuide(library);
        await moveToFinance();

        expect(await screen.findByText("Moved to Finance team.")).toBeDefined();
        expect(library.deleteTrashed).toHaveBeenCalledWith("lib-1", "t1");
        await waitFor(() =>
          expect(library.openForEditing).toHaveBeenCalledWith(finance, "guide-1", false),
        );
        const words = (await screen.findByDisplayValue("Click Contacts")) as HTMLTextAreaElement;
        await waitFor(() => expect(words.readOnly).toBe(false));
        expect(screen.queryByText(/The Bin is held open/)).toBeNull();
        // Its edits are saved where it is now.
        fireEvent.change(words, { target: { value: "Click Suppliers" } });
        await waitFor(() =>
          expect(library.saveStep).toHaveBeenCalledWith(
            finance,
            "guide-1",
            expect.objectContaining({ actionText: "Click Suppliers" }),
          ),
        );
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("Record steps here (docs/spec/04-editor.md#record-steps-here)", () => {
  const INTO = "amluto-steps-recording-into";

  const manual = shortcutFact.record as Extract<RecordingFact["record"], { kind: "manual" }>;
  /** A Capture now in `sessionId`, with a screenshot of its own. */
  const shot = (sessionId: string, sequence: number) =>
    ({
      ...shortcutFact,
      sessionId,
      sequence,
      record: {
        ...manual,
        id: 300 + sequence,
        purpose: "captureNow",
        capture: { ...manual.capture, image: `manual-${sequence}.webp` },
      },
    }) as RecordingFact;

  const stop = (recorder: ReturnType<typeof makeRecorder>, sessionId: string, gone = false) =>
    act(() =>
      recorder.fire.finished({
        sessionId,
        snapshot: { ...idle, sessionId: gone ? null : sessionId },
        title: "New guide 08/10/2026",
      }),
    );

  /** Opens "Add a supplier", then Add > Record steps here and Start, with its first step chosen. */
  async function recordIntoTheGuide(
    recorder: ReturnType<typeof makeRecorder>,
    library: FakeLibrary,
  ) {
    render(<App recorder={recorder} library={library} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open Add a supplier" }));
    await screen.findByDisplayValue("Click Contacts");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Record steps here/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Recording into “Add a supplier”")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(recorder.start).toHaveBeenCalled());
  }

  it("puts the new steps after the chosen one as one undo step, their screenshots in the guide", async () => {
    const recorder = makeRecorder();
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    // The editor stays open, holding the guide's edit lock, and the bar is told where it goes.
    expect(screen.getByDisplayValue("Click Contacts")).toBeTruthy();
    expect(library.releaseLock).not.toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem(INTO) ?? "null")).toMatchObject({
      title: "Add a supplier",
      sessionId: "session-9",
    });

    recorder.addMedia("session-9", ["manual-1", "manual-2"]);
    act(() => {
      recorder.fire.fact(shot("session-9", 1));
      recorder.fire.fact(shot("session-9", 2));
    });
    stop(recorder, "session-9");
    expect(await screen.findByText("Added 2 recorded steps.")).toBeTruthy();
    await waitFor(() => expect(recorder.discard).toHaveBeenCalled());
    expect(recorder.saveDraft).not.toHaveBeenCalled();

    const [sessionId, into, media] = vi.mocked(recorder.copyMedia).mock.calls[0] ?? [];
    expect(sessionId).toBe("session-9");
    expect(into).toEqual({ kind: "guide", libraryId: "lib-1", guideId: "guide-1" });
    expect(media?.map((item) => item.mediaId)).toEqual(["manual-1", "manual-2"]);
    const saved = vi
      .mocked(library.saveStep)
      .mock.calls.map(([, guideId, step]) => ({ guideId, ...(step as GuideStep) }));
    expect(saved).toHaveLength(2);
    expect(saved.map((step) => step.guideId)).toEqual(["guide-1", "guide-1"]);
    // New ids, and the screenshots' new ids, so nothing clashes with the guide's own.
    expect(saved.map((step) => step.media?.id)).toEqual(media?.map((item) => item.newMediaId));
    expect(saved.some((step) => step.id.startsWith("capture-"))).toBe(false);
    // Between "Click Contacts" (a) and "Click Save" (b).
    expect(saved.every((step) => step.sortKey > "a" && step.sortKey < "b")).toBe(true);
    expect(window.localStorage.getItem(INTO)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(library.deleteStep).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(library.deleteStep)
        .mock.calls.map(([, , id]) => id)
        .sort(),
    ).toEqual(saved.map((step) => step.id).sort());
  });

  it("leaves the guide as it was when the recording has no steps, and says so (#52)", async () => {
    const recorder = makeRecorder();
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    stop(recorder, "session-9");
    expect(
      await screen.findByText("Nothing was recorded, so “Add a supplier” is as it was."),
    ).toBeTruthy();
    await waitFor(() => expect(recorder.discard).toHaveBeenCalled());
    expect(recorder.copyMedia).not.toHaveBeenCalled();
    expect(recorder.saveDraft).not.toHaveBeenCalled();
    expect(library.saveStep).not.toHaveBeenCalled();
    // The guide stays open in the editor, its steps as they were.
    expect(screen.getByDisplayValue("Click Contacts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save guide" })).toBeNull();
  });

  it("says nothing was recorded, not that the steps went elsewhere, when the guide closed meanwhile and there were none", async () => {
    const recorder = makeRecorder();
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    await waitFor(() => expect(library.releaseLock).toHaveBeenCalled());
    stop(recorder, "session-9");
    expect(await screen.findByText("Nothing was recorded, so no guide was made.")).toBeTruthy();
    expect(screen.queryByText(/couldn't go into/)).toBeNull();
    expect(recorder.saveDraft).not.toHaveBeenCalled();
  });

  it("inserts nothing when the recording is discarded", async () => {
    const recorder = makeRecorder();
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    recorder.addMedia("session-9", ["manual-1"]);
    act(() => recorder.fire.fact(shot("session-9", 1)));
    // Discarded from the bar: it finishes with no recording left.
    stop(recorder, "session-9", true);
    await waitFor(() => expect(window.localStorage.getItem(INTO)).toBeNull());
    expect(recorder.copyMedia).not.toHaveBeenCalled();
    expect(recorder.saveDraft).not.toHaveBeenCalled();
    expect(library.saveStep).not.toHaveBeenCalled();
  });

  it("keeps the steps as a recording of their own when the guide was closed meanwhile", async () => {
    const recorder = makeRecorder();
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    fireEvent.click(screen.getByRole("button", { name: "Guides" }));
    await waitFor(() => expect(library.releaseLock).toHaveBeenCalled());
    recorder.addMedia("session-9", ["manual-1"]);
    act(() => recorder.fire.fact(shot("session-9", 1)));
    stop(recorder, "session-9");
    expect(
      await screen.findByText(
        "The new steps couldn't go into “Add a supplier”: it was closed, or someone else is editing it. They're in a recording of their own instead.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    expect(vi.mocked(recorder.saveDraft).mock.calls[0]?.[0]).toBe("session-9");
    expect(recorder.copyMedia).not.toHaveBeenCalled();
    expect(recorder.discard).not.toHaveBeenCalled();
    expect(library.saveStep).not.toHaveBeenCalled();
  });

  it("keeps them as a recording of their own when the guide can't take the screenshots", async () => {
    const recorder = makeRecorder({
      copyMedia: vi.fn().mockRejectedValue({ code: "lockLost", message: "Sam is editing it." }),
    });
    const library = makeLibrary();
    await recordIntoTheGuide(recorder, library);
    recorder.addMedia("session-9", ["manual-1"]);
    act(() => recorder.fire.fact(shot("session-9", 1)));
    stop(recorder, "session-9");
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    expect(recorder.discard).not.toHaveBeenCalled();
    expect(library.saveStep).not.toHaveBeenCalled();
  });

  it("records into an unsaved recording being edited, its screenshots joining that recording's", async () => {
    const recorder = makeRecorder();
    render(<App recorder={recorder} library={makeLibrary()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recording" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() => expect(recorder.start).toHaveBeenCalledOnce());
    recorder.addMedia("session-9", ["manual-1"]);
    act(() => recorder.fire.fact(shot("session-9", 1)));
    stop(recorder, "session-9");
    await waitFor(() => expect(recorder.saveDraft).toHaveBeenCalledOnce());
    await screen.findByRole("button", { name: "Save guide" });

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Record steps here/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Start recording" }),
    );
    await waitFor(() => expect(recorder.start).toHaveBeenCalledTimes(2));
    recorder.addMedia("session-2", ["manual-1"]);
    act(() => recorder.fire.fact(shot("session-2", 1)));
    stop(recorder, "session-2");
    await waitFor(() => expect(recorder.discard).toHaveBeenCalled());
    expect(vi.mocked(recorder.copyMedia).mock.calls[0]?.slice(0, 2)).toEqual([
      "session-2",
      { kind: "draft", sessionId: "session-9" },
    ]);
    // The new step goes into the draft being edited, beside its own step; no second draft.
    expect(recorder.saveDraft).toHaveBeenCalledOnce();
    const added = vi
      .mocked(recorder.saveDraftStep)
      .mock.calls.map(([sessionId, step]) => [sessionId, (step as GuideStep).id]);
    expect(added).toHaveLength(1);
    expect(added[0]?.[0]).toBe("session-9");
    expect(added[0]?.[1]).not.toBe("capture-1");
  });
});
