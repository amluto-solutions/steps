// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GuideStep } from "@amluto-steps/core";

import { newGuide } from "../app/documents";
import { blankStep, setStepText } from "./edits";
import { useGuideEditor, type GuideStore } from "./useGuideEditor";

const stamp = { at: 0, by: "Robin" };
const initial = {
  guide: newGuide("g1", "Guide", "Robin"),
  steps: [{ ...blankStep("s1", stamp), actionText: "Start" }],
};

/** A store whose step writes the test settles one by one. */
function controlledStore() {
  const calls: { text: string; settle: (ok: boolean) => void }[] = [];
  const saved: string[] = [];
  const store: GuideStore = {
    saveGuide: vi.fn().mockResolvedValue(undefined),
    deleteStep: vi.fn().mockResolvedValue(undefined),
    loadImage: vi.fn().mockResolvedValue(""),
    saveStep: vi.fn(
      (step: GuideStep) =>
        new Promise<void>((resolve, reject) => {
          calls.push({
            text: step.actionText,
            settle: (ok) => {
              if (ok) {
                saved.push(step.actionText);
                resolve();
              } else reject(new Error("locked"));
            },
          });
        }),
    ),
  };
  return { store, calls, saved };
}

const settle = async (calls: { settle: (ok: boolean) => void }[], index: number, ok: boolean) => {
  await act(async () => {
    calls[index]?.settle(ok);
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the editor's save queue", () => {
  it("never writes an older failed change over a newer one", async () => {
    const { store, calls, saved } = controlledStore();
    const { result } = renderHook(() => useGuideEditor(initial, store, "Robin"));

    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Older", at)));
    await act(async () => void vi.advanceTimersByTime(500));
    expect(calls.map((call) => call.text)).toEqual(["Older"]);

    // A newer edit is queued while the older write is still in flight.
    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Newer", at)));
    await act(async () => void vi.advanceTimersByTime(500));
    await settle(calls, 0, false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await settle(calls, 1, true);

    // Long after the retry delay, the older text has not come back.
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(calls.map((call) => call.text)).toEqual(["Older", "Newer"]);
    expect(saved).toEqual(["Newer"]);
    expect(result.current.saveState).toBe("saved");
  });

  it("rejects a flush while a write is failing, and resolves once it's saved", async () => {
    const { store, calls } = controlledStore();
    const { result } = renderHook(() => useGuideEditor(initial, store, "Robin"));

    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Edit", at)));
    let outcome: Promise<void> = Promise.resolve();
    act(() => {
      outcome = result.current.flush();
      outcome.catch(() => undefined); // checked below, after the write fails
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await settle(calls, 0, false);
    await expect(outcome).rejects.toThrow("unsavedEdits");
    expect(result.current.saveState).toBe("error");

    // The retry writes it; a flush now goes ahead.
    await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)));
    expect(calls).toHaveLength(2);
    await settle(calls, 1, true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await expect(result.current.flush()).resolves.toBeUndefined();
    expect(result.current.saveState).toBe("saved");
  });

  it("stops retrying once the editor has closed", async () => {
    const { store, calls } = controlledStore();
    const { result, unmount } = renderHook(() => useGuideEditor(initial, store, "Robin"));

    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Edit", at)));
    unmount(); // the close writes what's waiting, once
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(calls).toHaveLength(1);
    await settle(calls, 0, false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(calls).toHaveLength(1);
  });

  it("refuses every edit, undo and redo while read-only, and says so", () => {
    const { store } = controlledStore();
    const onRefused = vi.fn();
    const { result } = renderHook(() =>
      useGuideEditor(initial, store, "Robin", { readOnly: true, onRefused }),
    );
    let edit: unknown = "unset";
    act(() => {
      edit = result.current.apply((doc, at) => setStepText(doc, "s1", "Edit", at));
    });
    expect(edit).toBeNull();
    expect(onRefused).toHaveBeenCalledTimes(1);
    expect(result.current.doc.steps[0]?.actionText).toBe("Start");
    expect(result.current.undo()).toBeNull();
    expect(result.current.redo()).toBeNull();
  });

  it("stops writing and says so once a save is refused because someone took over", async () => {
    const onLockLost = vi.fn();
    const saveStep = vi.fn().mockRejectedValue({ code: "lockLost", message: "Sam is editing" });
    const store: GuideStore = {
      saveGuide: vi.fn().mockResolvedValue(undefined),
      deleteStep: vi.fn().mockResolvedValue(undefined),
      loadImage: vi.fn().mockResolvedValue(""),
      saveStep,
    };
    const { result } = renderHook(() => useGuideEditor(initial, store, "Robin", { onLockLost }));

    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Mine", at)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(onLockLost).toHaveBeenCalledTimes(1);
    // No retries: the edits go into a draft instead (LibraryGuideEditor).
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(saveStep).toHaveBeenCalledTimes(1);
    act(() => void result.current.apply((doc, at) => setStepText(doc, "s1", "Later", at)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(500)));
    expect(saveStep).toHaveBeenCalledTimes(1);
  });
});
