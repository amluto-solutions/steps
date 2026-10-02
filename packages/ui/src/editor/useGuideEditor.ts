import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "../useLatest";
import type { Guide, GuideStep } from "@amluto-steps/core";

import type { MediaInfo } from "../library-bridge";
import {
  applyChanges,
  emptyHistory,
  recordEdit,
  redo as redoEdit,
  undo as undoEdit,
  type Change,
  type Edit,
  type EditorDoc,
  type History,
} from "./document";
import type { Stamp } from "./edits";

/**
 * Where an open guide is saved: a library guide folder, or the private draft of a stopped
 * recording. Either way each changed file is written on its own (docs/spec/03-data-and-sharing.md).
 */
export interface GuideStore {
  saveGuide(guide: Guide): Promise<void>;
  saveStep(step: GuideStep): Promise<void>;
  deleteStep(id: string): Promise<void>;
  loadImage(mediaId: string, thumbnail: boolean): Promise<string>;
  /** Pasted, dropped or chosen images; not available for an unsaved recording. */
  importImage?: (bytes: Uint8Array) => Promise<MediaInfo>;
  /** Retake: minimise, count down `delayMs`, capture the window in front as a new image. */
  retakeImage?: (delayMs: number) => Promise<MediaInfo>;
}

export type SaveState = "saved" | "saving" | "error";

/** How an open guide may change (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive). */
export interface EditorOptions {
  /** Someone else holds the guide's edit lock: every edit, undo and redo is refused. */
  readOnly?: boolean | undefined;
  /** An edit was refused because the guide is read-only. */
  onRefused?: (() => void) | undefined;
  /** A save was refused because someone took over editing; nothing more is written. */
  onLockLost?: (() => void) | undefined;
}

const isLockLost = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "lockLost";

/** Typing is written a moment after it stops, not on every key. */
const WRITE_DELAY_MS = 400;
const RETRY_MS = 3000;

const changeKey = (change: Change) => (change.kind === "guide" ? "guide" : `step:${change.id}`);

export interface GuideEditor {
  doc: EditorDoc;
  history: History;
  saveState: SaveState;
  /** Runs an edit builder on the current document; returns the edit, or null if nothing changed. */
  apply: (make: (doc: EditorDoc, stamp: Stamp) => Edit | null) => Edit | null;
  undo: () => string | null;
  redo: () => string | null;
  /**
   * Writes anything still waiting. Resolves once every change is on disk; rejects (with the
   * `unsavedEdits` code) if a write failed, so nothing goes ahead from stale files.
   */
  flush: () => Promise<void>;
}

/**
 * The open editor as a dialog on top of it sees it (the export review): its edits, its undo and
 * redo, and a way back to one of its steps.
 */
export interface EditorHooks extends Pick<GuideEditor, "apply" | "undo" | "redo"> {
  showStep: (stepId: string) => void;
}

/** A change waiting to be written, and which edit of its file it is. */
interface Queued {
  change: Change;
  generation: number;
}

export function useGuideEditor(
  initial: EditorDoc,
  store: GuideStore,
  author: string,
  options: EditorOptions = {},
): GuideEditor {
  const optionsRef = useLatest(options);
  /** Someone took over: writing stops for good in this editor. */
  const lockLost = useRef(false);
  const [doc, setDoc] = useState(initial);
  const [history, setHistory] = useState<History>(emptyHistory);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const docRef = useRef(initial);
  const historyRef = useRef<History>(emptyHistory());
  const pending = useRef(new Map<string, Queued>());
  /** The newest edit made to each file; an older one that fails is never written over it. */
  const latest = useRef(new Map<string, number>());
  const counter = useRef(0);
  /** Whether the last write attempt left a failed change waiting. */
  const failing = useRef(false);
  const mounted = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const storeRef = useLatest(store);
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const write = useCallback(
    async (change: Change) => {
      const target = storeRef.current;
      if (change.kind === "guide") await target.saveGuide(change.after);
      else if (change.after) await target.saveStep(change.after);
      else await target.deleteStep(change.id);
    },
    [storeRef],
  );

  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const writes = [...pending.current.entries()];
    pending.current.clear();
    if (writes.length > 0) {
      chain.current = chain.current
        .then(async () => {
          let failed = false;
          for (const [key, queued] of writes) {
            if (lockLost.current) break;
            try {
              await write(queued.change);
            } catch (error) {
              if (isLockLost(error)) {
                lockLost.current = true;
                optionsRef.current.onLockLost?.();
                break;
              }
              // Put it back only if it's still the newest edit of that file: a newer one
              // (waiting, or already written by a later flush) must never be overwritten.
              if (latest.current.get(key) === queued.generation && !pending.current.has(key)) {
                pending.current.set(key, queued);
                failed = true;
              }
            }
          }
          failing.current = failed;
          if (lockLost.current) {
            pending.current.clear();
            setSaveState("saved");
            return;
          }
          if (failed) {
            setSaveState("error");
            // Retry while the editor is open; once it has closed, one last attempt was made.
            if (mounted.current)
              timer.current = window.setTimeout(
                () => void flushRef.current().catch(() => undefined),
                RETRY_MS,
              );
            return;
          }
          setSaveState(pending.current.size > 0 ? "saving" : "saved");
        })
        .catch(() => {
          failing.current = true;
          setSaveState("error");
        });
    }
    return chain.current.then(() => {
      if (failing.current) throw new Error("unsavedEdits");
    });
  }, [write, optionsRef]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const schedule = useCallback(
    (changes: Change[]) => {
      for (const change of changes) {
        const key = changeKey(change);
        counter.current += 1;
        latest.current.set(key, counter.current);
        pending.current.set(key, { change, generation: counter.current });
      }
      setSaveState("saving");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush().catch(() => undefined), WRITE_DELAY_MS);
    },
    [flush],
  );

  // Anything still waiting is written when the editor closes, with no retries after that.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      void flush().catch(() => undefined);
    };
  }, [flush]);

  const commit = useCallback((next: EditorDoc, nextHistory: History) => {
    docRef.current = next;
    historyRef.current = nextHistory;
    setDoc(next);
    setHistory(nextHistory);
  }, []);

  const apply = useCallback(
    (make: (doc: EditorDoc, stamp: Stamp) => Edit | null) => {
      if (optionsRef.current.readOnly) {
        optionsRef.current.onRefused?.();
        return null;
      }
      const edit = make(docRef.current, { at: Date.now(), by: author });
      if (!edit || edit.changes.length === 0) return null;
      commit(
        applyChanges(docRef.current, edit.changes, "do"),
        recordEdit(historyRef.current, edit),
      );
      schedule(edit.changes);
      return edit;
    },
    [author, commit, schedule, optionsRef],
  );

  const undo = useCallback(() => {
    if (optionsRef.current.readOnly) return null;
    const stepped = undoEdit(docRef.current, historyRef.current);
    if (!stepped) return null;
    commit(stepped.doc, stepped.history);
    schedule(stepped.changes);
    return stepped.label;
  }, [commit, schedule, optionsRef]);

  const redo = useCallback(() => {
    if (optionsRef.current.readOnly) return null;
    const stepped = redoEdit(docRef.current, historyRef.current);
    if (!stepped) return null;
    commit(stepped.doc, stepped.history);
    schedule(stepped.changes);
    return stepped.label;
  }, [commit, schedule, optionsRef]);

  return { doc, history, saveState, apply, undo, redo, flush };
}
