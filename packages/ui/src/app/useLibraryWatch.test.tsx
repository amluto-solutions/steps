// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFingerprintWatch, WATCH_MS } from "./useLibraryWatch";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("live refresh", () => {
  it("reloads when a synced change arrives, and not before", async () => {
    const fingerprints = ["a", "a", "b", "b"];
    const check = vi.fn(() => Promise.resolve(fingerprints.shift() ?? "b"));
    const onChange = vi.fn();
    renderHook(() => useFingerprintWatch(check, true, onChange));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_MS)));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_MS)));
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_MS)));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("doesn't look while inactive", async () => {
    const check = vi.fn(() => Promise.resolve("a"));
    renderHook(() => useFingerprintWatch(check, false, vi.fn()));
    await act(async () => void (await vi.advanceTimersByTimeAsync(WATCH_MS * 3)));
    expect(check).not.toHaveBeenCalled();
  });
});
