import type { RecordedStep, RecordingFact, RecordingSettings } from "@amluto-steps/core";

import type { MediaInfo } from "../library-bridge";
import type { RecorderSnapshot } from "./recording";

export interface RecoverySession {
  sessionId: string;
  title: string;
  eventCount: number;
  stopped: boolean;
  savedGuideId: string | null;
}

/**
 * What a recording leaves behind until it's saved, part of the recorder bridge: its facts and
 * steps as journalled, its screenshots, and the draft made from it. Unsaved recordings are
 * listed for recovery; saving one publishes it to a library.
 */
export interface RecordingJournal {
  getRecoveries(): Promise<RecoverySession[]>;
  recoverSession(sessionId: string): Promise<RecorderSnapshot>;
  getRecoveryRecords(sessionId: string): Promise<RecordingFact[]>;
  getSessionSteps(sessionId: string): Promise<RecordedStep[]>;
  /** A step added outside the click pipeline (the Add shortcut popup). */
  appendStep(sessionId: string, step: RecordedStep): Promise<unknown>;
  getRestartPoint(sessionId: string): Promise<number | null>;
  /**
   * The settings a recording started with (`StartOptions.settings`), as saved with it; null for
   * one recorded before they were saved.
   */
  getRecordingSettings(sessionId: string): Promise<RecordingSettings | null>;
  loadImage(sessionId: string, name: string): Promise<string>;
  /** Retake in an unsaved recording, kept in the quality Settings chose (Balanced when left out). */
  retakeDraftImage(
    sessionId: string,
    delayMs: number,
    excluded: string[],
    quality?: "balanced" | "original",
  ): Promise<MediaInfo>;
  /** Publishes a stopped recording to the default library, or to `libraryId` (Save as). */
  finalize(sessionId: string, guide: Record<string, unknown>, libraryId?: string): Promise<unknown>;
  /** A stopped recording's draft, saved in its private journal until it is published. */
  saveDraft(sessionId: string, guide: unknown, steps: unknown[]): Promise<void>;
  saveDraftGuide(sessionId: string, guide: unknown): Promise<void>;
  saveDraftStep(sessionId: string, step: unknown): Promise<void>;
  deleteDraftStep(sessionId: string, stepId: string): Promise<void>;
  loadDraft(sessionId: string): Promise<{ guide: unknown; steps: unknown[] } | null>;
}
