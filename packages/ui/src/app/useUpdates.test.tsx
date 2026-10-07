// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UpdateChannel, UpdateInfo, Updates } from "../bridge/updates";
import { fakeUpdates } from "../bridge/updates-fake";
import { initI18n } from "../i18n";
import { useUpdates } from "./useUpdates";

initI18n();

const found: UpdateInfo = { version: "0.2.0", notes: "Faster exports.", published: 1_790_000_000 };

/** A copy on `channel` whose check answers `check`, with `pending` downloaded before. */
function recorderWith(
  channel: UpdateChannel,
  check: () => Promise<UpdateInfo | null>,
  pending: string | null = null,
) {
  const updates = fakeUpdates({ channel, newer: found, pending });
  return {
    ...updates,
    checkForUpdate: vi.fn(check),
    downloadUpdate: vi.spyOn(updates, "downloadUpdate"),
    installUpdate: vi.spyOn(updates, "installUpdate"),
  };
}

/** Lets the bridge's promises settle, then moves the clock on. */
const wait = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

/** Opens the app with this bridge, once it has said which channel it is on. */
async function start(recorder: Updates) {
  const notify = vi.fn();
  const showAbout = vi.fn();
  const hook = renderHook(() => useUpdates(recorder, notify, showAbout));
  await wait(0);
  return { hook, notify, showAbout };
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("updates for the downloadable .exe", () => {
  it("looks a little after opening, downloads a new version, and says once it installs next time", async () => {
    const recorder = recorderWith("checks", async () => found);
    const { hook, notify, showAbout } = await start(recorder);
    await wait(14_000);
    expect(recorder.checkForUpdate).not.toHaveBeenCalled();
    await wait(1_000);
    expect(recorder.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(recorder.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toEqual({ kind: "ready", info: found });
    expect(notify).toHaveBeenCalledTimes(1);
    const toast = notify.mock.calls[0]?.[0] as { text: string; action: { run: () => void } };
    expect(toast.text).toBe("Steps 0.2.0 is ready. It installs the next time Steps opens.");
    toast.action.run();
    expect(showAbout).toHaveBeenCalled();
    // Ready and waiting: the hourly look doesn't ask, download or announce again.
    await wait(25 * 60 * 60 * 1000);
    expect(recorder.checkForUpdate).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);

    await act(() => hook.result.current.install());
    expect(recorder.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("never asks by itself with automatic updates off, only on Check for updates (30/09/2026)", async () => {
    window.localStorage.setItem("amluto-steps-auto-updates", "false");
    const recorder = recorderWith("checks", async () => null);
    const { hook } = await start(recorder);
    expect(hook.result.current.automatic).toBe(false);
    await wait(3 * 24 * 60 * 60 * 1000);
    expect(recorder.checkForUpdate).not.toHaveBeenCalled();
    await act(() => hook.result.current.check());
    expect(recorder.checkForUpdate).toHaveBeenCalledTimes(1);

    // Switched back on, the daily look starts again.
    act(() => hook.result.current.setAutomatic(true));
    expect(window.localStorage.getItem("amluto-steps-auto-updates")).toBe("true");
    await wait(21 * 60 * 60 * 1000);
    expect(recorder.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("shows a version downloaded earlier as ready, without asking again", async () => {
    const recorder = recorderWith("checks", async () => found, "0.2.0");
    const { hook, notify } = await start(recorder);
    expect(hook.result.current.status).toMatchObject({ kind: "ready", info: { version: "0.2.0" } });
    await wait(2 * 24 * 60 * 60 * 1000);
    expect(recorder.checkForUpdate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("remembers a check that found nothing, and waits most of a day before the next", async () => {
    const recorder = recorderWith("checks", async () => null);
    const { hook } = await start(recorder);
    await wait(15_000);
    expect(hook.result.current.status.kind).toBe("newest");
    expect(recorder.downloadUpdate).not.toHaveBeenCalled();
    cleanup();
    const again = recorderWith("checks", async () => null);
    await start(again);
    await wait(60_000);
    expect(again.checkForUpdate).not.toHaveBeenCalled();
    await wait(20 * 60 * 60 * 1000);
    expect(again.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the daily look or download fails, and says so when the button was pressed", async () => {
    const recorder = recorderWith("checks", async () => {
      throw { code: "updateCheckFailed", message: "offline" };
    });
    const { hook, notify } = await start(recorder);
    await wait(15_000);
    expect(notify).not.toHaveBeenCalled();
    expect(hook.result.current.status.kind).toBe("idle");
    await act(() => hook.result.current.check());
    expect(notify).toHaveBeenCalledWith({
      kind: "error",
      text: "Couldn’t check for updates. Check the internet connection and try again.",
    });
    cleanup();

    const badDownload = recorderWith("checks", async () => found);
    badDownload.downloadUpdate.mockRejectedValue({ code: "updateDownloadFailed", message: "" });
    const second = await start(badDownload);
    await wait(15_000);
    expect(second.notify).not.toHaveBeenCalled();
    expect(second.hook.result.current.status.kind).toBe("idle");
  });

  it("stays ready and says why when restarting is refused during a recording", async () => {
    const recorder = recorderWith("checks", async () => found);
    recorder.installUpdate.mockRejectedValue({ code: "updateWhileRecording", message: "" });
    const { hook, notify } = await start(recorder);
    await wait(15_000);
    await act(() => hook.result.current.install());
    expect(hook.result.current.status).toEqual({ kind: "ready", info: found });
    expect(notify).toHaveBeenLastCalledWith({
      kind: "error",
      text: "Stop the recording before restarting to update.",
    });
  });

  it("never asks from the Store, the .msi, a policy-stopped or a development copy", async () => {
    for (const channel of ["store", "msi", "policy", "none"] as const) {
      const recorder = recorderWith(channel, async () => found, "0.2.0");
      const { hook } = await start(recorder);
      await wait(2 * 24 * 60 * 60 * 1000);
      expect(hook.result.current.channel).toBe(channel);
      expect(hook.result.current.status.kind).not.toBe("ready");
      expect(recorder.checkForUpdate).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("updates the portable program too, but only once automatic updates are switched on (30/09/2026)", async () => {
    const recorder = recorderWith("portable", async () => found);
    const { hook } = await start(recorder);
    // Off unless chosen: no look by itself, however long it runs.
    expect(hook.result.current.automatic).toBe(false);
    await wait(2 * 24 * 60 * 60 * 1000);
    expect(recorder.checkForUpdate).not.toHaveBeenCalled();
    // Check for updates works, and so does switching it on.
    await act(() => hook.result.current.check());
    expect(recorder.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(hook.result.current.status).toEqual({ kind: "ready", info: found });
    cleanup();

    window.localStorage.clear();
    const again = recorderWith("portable", async () => found);
    const second = await start(again);
    act(() => second.hook.result.current.setAutomatic(true));
    await wait(15_000);
    expect(again.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps a choice made for the setup's copy, and starts that copy on", async () => {
    const recorder = recorderWith("checks", async () => null);
    const { hook } = await start(recorder);
    expect(hook.result.current.automatic).toBe(true);
    act(() => hook.result.current.setAutomatic(false));
    cleanup();
    const later = await start(recorderWith("checks", async () => null));
    expect(later.hook.result.current.automatic).toBe(false);
  });

  it("treats a bridge that can't say as a copy that doesn't update", async () => {
    const silent = {
      ...fakeUpdates(),
      updatesChannel: () => Promise.reject(new Error("no answer")),
    };
    const { hook } = await start(silent);
    expect(hook.result.current.channel).toBe("none");
  });
});
