import { siteName, type RecordingFact, type RecordingSettings } from "@amluto-steps/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import type { RecorderSnapshot, Recording } from "../bridge/recording";
import type { RecordingJournal } from "../bridge/recording-journal";
import type { Host } from "../bridge/host";
import { formatDate } from "../library/dates";
import {
  readChoices,
  readExcludedSites,
  readRecordingSettings,
  saveExcludedSites,
} from "../settings/preferences";
import { StepsLogo } from "../shell/StepsLogo";
import { recordingToDraft } from "./recording-to-draft";
import { useStepWording } from "./ShortcutPopup";

/**
 * The recorder in Chrome's side panel (docs/spec/02-capture.md#chrome-edition): start a
 * recording beside the page, see each step as it's recorded, pause and stop, then open the
 * recording in Steps to review. The desktop's equivalent is the recording bar.
 */
export function RecorderPanel({
  recorder,
  onOpenSteps,
}: {
  recorder: Recording & RecordingJournal & Host;
  /** Opens (or brings forward) the Steps tab, where recordings are reviewed and saved. */
  onOpenSteps: () => void;
}) {
  const { t, i18n } = useTranslation();
  const wording = useStepWording();
  const [snapshot, setSnapshot] = useState<RecorderSnapshot | null>(null);
  const [steps, setSteps] = useState<{ id: string; text: string }[]>([]);
  const [keys, setKeys] = useState(false);
  const [keysBlocked, setKeysBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The site of the last step, which the person can stop recording from here. */
  const [lastSite, setLastSite] = useState<string | null>(null);
  const [excludedNote, setExcludedNote] = useState<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const wordingRef = useRef(wording);
  /**
   * The recording's own settings, saved with it when it started; for one that saved none, today's,
   * read once for it rather than at every step.
   */
  const settingsRef = useRef<{ sessionId: string | null; settings: RecordingSettings } | null>(
    null,
  );

  useEffect(() => {
    wordingRef.current = wording;
  });

  /** The recording's facts so far, which its steps are made from. */
  const factsRef = useRef<RecordingFact[]>([]);
  /** Counts the times the steps were made, so an older answer never replaces a newer one. */
  const madeRef = useRef(0);

  useEffect(() => {
    let live = true;
    const stops: (() => void)[] = [];
    /**
     * The steps as the draft will open with them (docs/spec/02-capture.md#recording-to-draft),
     * made again from every fact so far: a step journalled late moves back to where it happened.
     */
    const settingsOf = (sessionId: string) => {
      const known = settingsRef.current;
      // A recording this panel is starting has no id yet: its settings are the ones it read.
      if (known && (known.sessionId === sessionId || known.sessionId === null))
        return known.settings;
      const settings = readRecordingSettings();
      settingsRef.current = { sessionId, settings };
      return settings;
    };
    const showSteps = (sessionId: string) => {
      const made = (madeRef.current += 1);
      void recordingToDraft({
        facts: factsRef.current,
        saved: [],
        live: [],
        restart: null,
        wording: wordingRef.current(sessionId),
        settings: settingsOf(sessionId),
        words: null,
      }).then(({ steps: shown }) => {
        if (live && made === madeRef.current)
          setSteps(shown.map((step) => ({ id: step.id, text: step.actionText })));
      });
    };
    void recorder.onState((next) => live && setSnapshot(next)).then((stop) => stops.push(stop));
    void recorder
      .onFact((fact) => {
        const others = factsRef.current.filter(
          (each) => each.sessionId === fact.sessionId && each.sequence !== fact.sequence,
        );
        factsRef.current = [...others, fact];
        showSteps(fact.sessionId);
        const site = siteOf(fact);
        if (live && site) setLastSite(site);
      })
      .then((stop) => stops.push(stop));
    void recorder.getState().then(async (current) => {
      if (!live) return;
      setSnapshot(current);
      // Steps recorded before the panel opened.
      if (current.sessionId && current.state !== "idle") {
        const [facts, settings] = await Promise.all([
          recorder.getRecoveryRecords(current.sessionId).catch(() => []),
          recorder.getRecordingSettings(current.sessionId).catch(() => null),
        ]);
        if (settings) settingsRef.current = { sessionId: current.sessionId, settings };
        if (settings?.wording) wordingRef.current.keep(current.sessionId, settings.wording);
        const known = new Set(facts.map((fact) => fact.sequence));
        factsRef.current = [
          ...facts,
          ...factsRef.current.filter(
            (fact) => fact.sessionId === current.sessionId && !known.has(fact.sequence),
          ),
        ];
        if (live) showSteps(current.sessionId);
      }
    });
    void recorder
      .getPolicy()
      .then((policy) => {
        if (!live) return;
        setKeysBlocked(policy.disableKeystrokeRecording);
        // Ticked to begin with when Settings (or IT) says so (30/09/2026).
        setKeys(
          !policy.disableKeystrokeRecording &&
            (policy.recordTypingByDefault ?? readChoices().typedByDefault),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stops.forEach((stop) => stop());
    };
  }, [recorder]);

  // The newest step stays in view.
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [steps.length]);

  const run = async (action: () => Promise<RecorderSnapshot>) => {
    setBusy(true);
    setProblem(null);
    try {
      setSnapshot(await action());
    } catch {
      setProblem(t("panel.failed"));
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    factsRef.current = [];
    madeRef.current += 1;
    setSteps([]);
    setLastSite(null);
    setExcludedNote(null);
    // Read once, here, and saved with the recording.
    const settings = readRecordingSettings(i18n.language);
    settingsRef.current = { sessionId: null, settings };
    void run(async () => {
      const started = await recorder.start(
        t("recorder.defaultTitle", { date: formatDate(new Date()) }),
        { keys: keys && !keysBlocked, output: false, settleMs: 0, settings },
      );
      if (started.sessionId) settingsRef.current = { sessionId: started.sessionId, settings };
      if (started.sessionId && settings.wording)
        wordingRef.current.keep(started.sessionId, settings.wording);
      return started;
    });
  };

  const excludeSite = (site: string) => {
    void run(() => recorder.excludeApp(site)).then(() => {
      // Kept for the next recordings too, as Settings would.
      const stored = readExcludedSites();
      if (!stored.includes(site)) saveExcludedSites([...stored, site]);
      setLastSite(null);
      setExcludedNote(t("panel.excluded", { site }));
    });
  };

  const state = snapshot?.state ?? "idle";
  const recording = state === "recording" || state === "paused";
  const waiting = !recording && Boolean(snapshot?.sessionId);

  return (
    <main className="flex h-screen flex-col bg-page text-body">
      <header className="flex items-center gap-3 bg-sidebar px-4 py-3">
        <StepsLogo />
        <button
          type="button"
          className="btn btn-quiet ml-auto text-white hover:bg-white/10"
          onClick={onOpenSteps}
        >
          {t("panel.openSteps")}
        </button>
      </header>

      {problem && (
        <p
          role="alert"
          className="mx-4 mt-3 rounded-lg bg-recording-soft px-3 py-2 text-sm text-recording"
        >
          {problem}
        </p>
      )}

      {!recording && (
        <section className="flex flex-col gap-4 p-4">
          {waiting && (
            <div role="status" className="card flex flex-col gap-2 p-4">
              <p className="font-semibold text-navy">{t("panel.ready")}</p>
              <button type="button" className="btn btn-primary self-start" onClick={onOpenSteps}>
                {t("panel.review")}
              </button>
            </div>
          )}
          <h1 className="font-heading text-xl text-navy">{t("recorder.startTitle")}</h1>
          <p className="text-sm text-secondary">{t("panel.intro")}</p>
          <div className="flex items-start gap-3 text-sm">
            <input
              id="panel-keys"
              type="checkbox"
              className="mt-0.5 size-4 accent-blue"
              checked={keys && !keysBlocked}
              disabled={keysBlocked}
              onChange={(event) => setKeys(event.currentTarget.checked)}
            />
            <label htmlFor="panel-keys" className="flex flex-col">
              <span className="font-semibold text-navy">{t("recorder.keysChoice")}</span>
              <span className="text-secondary">{t("recorder.keysChoiceHelp")}</span>
            </label>
          </div>
          <button
            type="button"
            className="btn btn-primary self-start"
            disabled={busy}
            onClick={start}
          >
            <span aria-hidden="true" className="size-2.5 rounded-full bg-white" />
            {t("recorder.startRecording")}
          </button>
        </section>
      )}

      {recording && (
        <section className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-panel px-4 py-3">
            <span
              aria-hidden="true"
              className={`size-2.5 rounded-full ${state === "paused" ? "border-2 border-bar-paused" : "bg-recording"}`}
            />
            <span role="status" className="flex-1 text-sm font-semibold text-navy">
              {state === "paused" ? t("recorder.paused") : t("recorder.recording")}
              {" · "}
              {t("recorder.stepCount", { count: snapshot?.stepCount ?? 0 })}
            </span>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(() => (state === "paused" ? recorder.resume() : recorder.pause()))
              }
            >
              <Icon name={state === "paused" ? "play" : "pause"} size={14} />
              {state === "paused" ? t("recorder.resume") : t("recorder.pause")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void run(() => recorder.stop())}
            >
              <Icon name="stop" size={14} />
              {t("recorder.stop")}
            </button>
          </div>
          {lastSite && (
            <button
              type="button"
              className="btn btn-quiet mx-4 mt-2 self-start"
              disabled={busy}
              onClick={() => excludeSite(lastSite)}
            >
              <Icon name="ban" size={14} />
              {t("panel.exclude", { site: lastSite })}
            </button>
          )}
          {excludedNote && (
            <p role="status" className="mx-4 mt-2 text-sm text-secondary">
              {excludedNote}
            </p>
          )}
          {steps.length === 0 ? (
            <p className="p-4 text-sm text-secondary">{t("panel.clickToRecord")}</p>
          ) : (
            <ol
              ref={list}
              className="flex min-h-0 flex-1 list-decimal flex-col gap-2 overflow-y-auto py-3 pr-4 pl-9 text-sm"
            >
              {steps.map((step) => (
                <li key={step.id}>{step.text}</li>
              ))}
            </ol>
          )}
        </section>
      )}
    </main>
  );
}

/** The site a recorded step happened on, as Settings keeps it. */
function siteOf(fact: RecordingFact): string | null {
  const record = fact.record;
  if (
    record.kind !== "pageClick" &&
    record.kind !== "pageInput" &&
    record.kind !== "pageNavigation"
  )
    return null;
  return record.page.origin ? siteName(record.page.origin) : null;
}
