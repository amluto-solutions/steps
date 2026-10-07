import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import { policy } from "../settings/policy";
import { ModalDialog } from "../ModalDialog";
import type { VersionInfo } from "../library-bridge";
import { formatDate } from "../library/dates";

/**
 * The dim layer behind a dialog. `top` holds a dialog's top edge still, for one that grows as
 * choices are made, rather than letting it jump about while centred.
 */
const Backdrop = ({ children, top = false }: { children: React.ReactNode; top?: boolean }) => (
  <div
    className={`fixed inset-0 z-[800] grid justify-items-center bg-scrim/50 p-4 ${top ? "items-start pt-[18vh]" : "items-center"}`}
  >
    {children}
  </div>
);

/** What the start dialog asks for, each time (docs/spec/02-capture.md#keys). */
export interface StartChoices {
  /** "Record what's typed". */
  keys: boolean;
  /** "Include command output"; only with `keys`. */
  output: boolean;
}

/**
 * Starting a recording: "Record what's typed" and "Include command output", ticked to begin with
 * only when Settings (or IT) says so, and unticked otherwise (docs/spec/02-capture.md#keys). Not
 * shown when IT policy has switched keys off.
 */
export function StartRecordingDialog(props: {
  /** How the two tick boxes start. */
  defaults: StartChoices;
  onCancel: () => void;
  onStart: (choices: StartChoices) => void;
}) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState(props.defaults.keys);
  const [output, setOutput] = useState(props.defaults.keys && props.defaults.output);
  const startRef = useRef<HTMLButtonElement>(null);
  return (
    <Backdrop top>
      <ModalDialog
        labelledBy="start-title"
        initialFocus={startRef}
        onEscape={props.onCancel}
        className="card flex w-full max-w-lg flex-col gap-4 p-6"
      >
        <h2 id="start-title" className="font-heading text-xl text-navy">
          {t("recorder.startTitle")}
        </h2>
        <div className="flex flex-col gap-3 rounded-lg border border-subtle bg-page p-4">
          <div className="flex items-start gap-3 text-sm">
            <input
              id="keys-choice"
              type="checkbox"
              className="mt-0.5 size-[18px] cursor-pointer"
              checked={keys}
              aria-describedby="keys-choice-help"
              onChange={(event) => {
                const on = event.currentTarget.checked;
                setKeys(on);
                // Ticking it ticks the output too, unless IT has it start unticked (04/10/2026);
                // it can still be unticked.
                setOutput(on && policy().includeOutputByDefault !== false);
              }}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="keys-choice" className="cursor-pointer font-bold text-navy">
                {t("recorder.keysChoice")}
              </label>
              <span id="keys-choice-help" className="leading-snug text-secondary">
                {t("recorder.keysChoiceHelp")}
              </span>
            </div>
          </div>
          <div className={`flex items-start gap-3 pl-[30px] text-sm ${keys ? "" : "opacity-60"}`}>
            <input
              id="output-choice"
              type="checkbox"
              className="mt-0.5 size-[18px] cursor-pointer disabled:cursor-default"
              checked={output}
              disabled={!keys}
              aria-describedby="output-choice-help"
              onChange={(event) => setOutput(event.currentTarget.checked)}
            />
            <div className="flex flex-col gap-1">
              <label htmlFor="output-choice" className="font-bold text-navy">
                {t("recorder.outputChoice")}
              </label>
              <span id="output-choice-help" className="leading-snug text-secondary">
                {t("recorder.outputChoiceHelp")}
              </span>
            </div>
          </div>
        </div>
        {keys && (
          <p
            role="note"
            className="flex items-center gap-2.5 rounded-lg bg-warning-soft px-3 py-2.5 text-[13px] text-warning"
          >
            <Icon name="keyboard" className="size-4 shrink-0" />
            {t("recorder.keysOnlyNow")}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            ref={startRef}
            type="button"
            className="btn btn-primary"
            onClick={() => props.onStart({ keys, output: keys && output })}
          >
            {t("recorder.startRecording")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

/**
 * "Take over editing" in a shared library (docs/spec/03-data-and-sharing.md): the other person's
 * latest changes may not have synced yet, so it starts on the safe choice.
 */
export function TakeOverDialog(props: {
  name: string;
  onCancel: () => void;
  onTakeOver: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Backdrop>
      <ModalDialog
        role="alertdialog"
        labelledBy="take-over-title"
        describedBy="take-over-body"
        initialFocus={cancelRef}
        onEscape={props.onCancel}
        className="card w-full max-w-lg p-6"
      >
        <h2 id="take-over-title" className="font-heading text-xl text-navy">
          {t("editor.lock.takeOverTitle", { name: props.name })}
        </h2>
        <p id="take-over-body" className="mt-3 text-secondary">
          {t("editor.lock.takeOverBody", { name: props.name })}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button ref={cancelRef} type="button" className="btn" onClick={props.onCancel}>
            {t("editor.lock.keepReading")}
          </button>
          <button type="button" className="btn btn-dark" onClick={props.onTakeOver}>
            {t("editor.lock.takeOver")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

/** Discarding a recording can't be undone, so it starts on the safe choice. */
export function DiscardDialog(props: { onKeep: () => void; onDiscard: () => void }) {
  const { t } = useTranslation();
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Backdrop>
      <ModalDialog
        role="alertdialog"
        labelledBy="discard-title"
        describedBy="discard-body"
        // Start on the safe choice, so a reflex Enter keeps the recording.
        initialFocus={keepRef}
        onEscape={props.onKeep}
        className="card w-full max-w-lg p-6"
      >
        <h2 id="discard-title" className="font-heading text-xl text-navy">
          {t("recorder.discardConfirmTitle")}
        </h2>
        <p id="discard-body" className="mt-3 text-secondary">
          {t("recorder.discardConfirmBody")}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button ref={keepRef} type="button" className="btn" onClick={props.onKeep}>
            {t("recorder.keepRecordingReview")}
          </button>
          <button type="button" className="btn btn-dark" onClick={props.onDiscard}>
            {t("recorder.discardConfirm")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

/** Something to know, with one OK: in the app's own style, never the browser's alert. */
export function NoticeDialog(props: { title: string; body: string; onClose: () => void }) {
  const { t } = useTranslation();
  const okRef = useRef<HTMLButtonElement>(null);
  return (
    <Backdrop>
      <ModalDialog
        role="alertdialog"
        labelledBy="notice-title"
        describedBy="notice-body"
        initialFocus={okRef}
        onEscape={props.onClose}
        className="card w-full max-w-lg p-6"
      >
        <h2 id="notice-title" className="font-heading text-xl text-navy">
          {props.title}
        </h2>
        <p id="notice-body" className="mt-3 text-secondary">
          {props.body}
        </p>
        <div className="mt-6 flex justify-end">
          <button ref={okRef} type="button" className="btn btn-dark" onClick={props.onClose}>
            {t("common.ok")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}

/** A guide's saved versions, newest first, each with Restore. */
export function VersionsDialog(props: {
  versions: VersionInfo[];
  onRestore: (version: VersionInfo) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Backdrop>
      <ModalDialog
        labelledBy="versions-title"
        onEscape={props.onClose}
        className="card flex max-h-[80vh] w-full max-w-lg flex-col p-6"
      >
        <h2 id="versions-title" className="font-heading text-xl text-navy">
          {t("versions.title")}
        </h2>
        <p className="mt-1 text-sm text-secondary">{t("versions.help")}</p>
        {props.versions.length === 0 ? (
          <p className="py-6 text-center text-secondary">{t("versions.none")}</p>
        ) : (
          <ul className="mt-4 flex min-h-0 flex-col overflow-y-auto">
            {props.versions.map((version, index) => (
              <li
                key={version.id}
                className={`flex items-center gap-3 py-2.5 ${index > 0 ? "border-t border-subtle" : ""}`}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-semibold text-navy">
                    {version.note || t("versions.noNote")}
                  </span>
                  <span className="text-xs text-secondary">
                    {formatDate(new Date(version.createdAt))} · {version.createdBy} ·{" "}
                    {t("library.steps", { count: version.stepCount })}
                  </span>
                </div>
                <button type="button" className="btn h-8" onClick={() => props.onRestore(version)}>
                  {t("versions.restore")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex justify-end">
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.close")}
          </button>
        </div>
      </ModalDialog>
    </Backdrop>
  );
}
