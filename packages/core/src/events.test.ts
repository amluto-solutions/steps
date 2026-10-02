import { describe, expect, it } from "vitest";

import {
  recorderErrorSchema,
  recorderFinishedSchema,
  recorderRestartedSchema,
  recorderSnapshotSchema,
} from "./recording.ts";

// Shaped exactly as src-tauri/src/recorder.rs sends them.
const snapshot = {
  state: "paused",
  reason: "IndicatorLost",
  sessionId: "session-1",
  stepCount: 12,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: true,
};

describe("recorder events", () => {
  it("accept what the recorder sends", () => {
    expect(recorderSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      recorderFinishedSchema.parse({ sessionId: "session-1", title: "Guide", snapshot }).title,
    ).toBe("Guide");
    expect(recorderErrorSchema.parse({ code: "journalWriteFailed", message: "…" }).code).toBe(
      "journalWriteFailed",
    );
    expect(recorderRestartedSchema.parse({ sessionId: "s", afterSequence: null })).toEqual({
      sessionId: "s",
      afterSequence: null,
    });
  });

  it("refuse anything else", () => {
    expect(recorderSnapshotSchema.safeParse({ ...snapshot, state: "hacked" }).success).toBe(false);
    expect(recorderSnapshotSchema.safeParse({ ...snapshot, stepCount: -1 }).success).toBe(false);
    expect(recorderRestartedSchema.safeParse({ sessionId: "s" }).success).toBe(false);
  });
});
