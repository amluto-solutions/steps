import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * Which guide a recording is going into (Record steps here, docs/spec/04-editor.md#record-steps-here),
 * as the window that asked tells the recording bar (desktop) and the side panel (Steps for Chrome).
 * They are pages of one origin, so they share local storage, as they do the excluded apps.
 */
export const RECORDING_INTO_KEY = "amluto-steps-recording-into";

export interface RecordingInto {
  /** Made by the window that asked, so a cancelled or replaced request is never taken for it. */
  token: string;
  /** The guide's title. */
  title: string;
  /** The recording going into it; null while the next one to start will. */
  sessionId: string | null;
}

const schema = z
  .object({
    token: z.string().max(200),
    title: z.string().max(2_000),
    sessionId: z.string().max(200).nullable(),
  })
  .strip();

const stored = (): string | null => {
  try {
    return window.localStorage.getItem(RECORDING_INTO_KEY);
  } catch {
    return null;
  }
};

const parse = (value: string | null): RecordingInto | null => {
  if (!value) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** What local storage says, if anything readable. */
export const readRecordingInto = (): RecordingInto | null => parse(stored());

/** Says which guide the next or running recording goes into; null for none. */
export function writeRecordingInto(into: RecordingInto | null): void {
  try {
    if (into) window.localStorage.setItem(RECORDING_INTO_KEY, JSON.stringify(into));
    else window.localStorage.removeItem(RECORDING_INTO_KEY);
    // Other windows hear of it from the browser; this one is told too.
    window.dispatchEvent(new StorageEvent("storage", { key: RECORDING_INTO_KEY }));
  } catch {
    // Only the words on the bar or panel go missing; the window that asked still inserts.
  }
}

const subscribe = (changed: () => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === RECORDING_INTO_KEY || event.key === null) changed();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
};

/**
 * The guide the recording `sessionId` is going into, or with null, the one the next recording
 * will; kept up to date as any window changes it.
 */
export function useRecordingInto(sessionId: string | null): RecordingInto | null {
  const into = parse(useSyncExternalStore(subscribe, stored, () => null));
  return into && into.sessionId === sessionId ? into : null;
}
