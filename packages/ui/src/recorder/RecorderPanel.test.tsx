// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingFactSchema, type RecordingFact } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import { fakeHost } from "../bridge/host-fake";
import { fakeRecorder } from "../bridge/recorder-fake";
import type { RecorderSnapshot } from "../bridge/recording";
import { RecorderPanel } from "./RecorderPanel";

initI18n();
afterEach(cleanup);
// jsdom lays nothing out, so it has no scrolling; the panel keeps its newest step in view.
Element.prototype.scrollIntoView = () => undefined;

const recording: RecorderSnapshot = {
  state: "recording",
  reason: null,
  sessionId: "s1",
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: true,
};

const page = { tabId: 7, title: "Invoices - Finance portal", origin: "https://finance.example" };
const fact = (sequence: number, record: unknown): RecordingFact =>
  recordingFactSchema.parse({ sessionId: "s1", recordedAt: 1_790_000_000_000, sequence, record });
const click = (sequence: number, tickMs: number, target: Record<string, string>) =>
  fact(sequence, {
    kind: "pageClick",
    id: sequence,
    tickMs,
    page,
    capture: { image: `shot-${sequence}.webp`, width: 1920, height: 1080, scale: 1 },
    target,
    clickPct: { x: 50, y: 25 },
    elementPct: { x: 45, y: 22, w: 10, h: 6 },
  });

/** Steps for Chrome's recorder, with its facts fired by the test as the extension sends them. */
function panelRecorder(
  settings: { showUnnamedTyping: boolean } | null = { showUnnamedTyping: false },
) {
  const live = fakeRecorder({ state: recording });
  live.addSession("s1", { stopped: false, settings });
  const getRecordingSettings = vi.spyOn(live, "getRecordingSettings");
  return {
    recorder: { ...live, ...fakeHost() },
    getRecordingSettings,
    send: (each: RecordingFact) => act(() => live.fire.fact(each)),
  };
}

describe("the side panel's steps while recording", () => {
  it("are the steps the draft opens with: typing before the click that ended it", async () => {
    const { recorder, getRecordingSettings, send } = panelRecorder();
    render(<RecorderPanel recorder={recorder} onOpenSteps={() => undefined} />);
    await waitFor(() => expect(getRecordingSettings).toHaveBeenCalled());

    const field = { tagName: "INPUT", labelText: "Supplier" };
    send(click(1, 100, field));
    send(click(2, 900, { tagName: "BUTTON", innerText: "Save" }));
    send(
      fact(3, {
        kind: "pageInput",
        tickMs: 1000,
        page,
        target: field,
        value: "Acme",
        withheld: null,
      }),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
        'Click "Supplier" field',
        'Type "Acme" in "Supplier" field',
        'Click "Save"',
      ]),
    );
  });

  it("reads today's settings once for a recording that saved none, not at each step", async () => {
    const { recorder, getRecordingSettings, send } = panelRecorder(null);
    const reads = vi.spyOn(Storage.prototype, "getItem");
    const settingReads = () =>
      reads.mock.calls.filter(([key]) => key === "amluto-steps-show-unnamed-typing").length;
    render(<RecorderPanel recorder={recorder} onOpenSteps={() => undefined} />);
    await waitFor(() => expect(getRecordingSettings).toHaveBeenCalled());
    // What the panel reads as it opens (whether to record keys) isn't a step's.
    await act(async () => undefined);
    reads.mockClear();

    send(click(1, 100, { tagName: "BUTTON", innerText: "New" }));
    send(click(2, 200, { tagName: "BUTTON", innerText: "Save" }));
    send(click(3, 300, { tagName: "BUTTON", innerText: "Close" }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(3));
    expect(settingReads()).toBeLessThanOrEqual(1);
    reads.mockRestore();
  });
});
