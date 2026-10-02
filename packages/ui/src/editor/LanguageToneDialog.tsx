import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  LANGUAGES,
  TONES,
  mainLanguage,
  renderPhrase,
  toneOf,
  type Tone,
} from "@amluto-steps/core";

import { ModalDialog } from "../ModalDialog";
import type { EditorDoc } from "./document";
import { rewordings } from "./languages";

/**
 * Language and tone (docs/spec/04-editor.md#language-and-tone; 01/10/2026): the guide's main
 * language and how its recorded steps are worded, with every step's words before and after. Steps
 * that would change are ticked; any changed by hand are left alone unless ticked; one Undo takes
 * it all back.
 */
export function LanguageToneDialog(props: {
  doc: EditorDoc;
  busy: boolean;
  onCancel: () => void;
  onApply: (language: string, tone: Tone, reword: ReadonlySet<string>) => void;
}) {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(mainLanguage(props.doc.guide));
  const [tone, setTone] = useState<Tone>(toneOf(props.doc.guide));
  /** Steps unticked (or, for steps changed by hand, ticked) by the person. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const preview = useMemo(() => rewordings(props.doc, language, tone), [props.doc, language, tone]);
  const chosen = new Set(
    preview
      .filter((item) => (item.status === "change") !== flipped.has(item.step.id))
      .filter((item) => item.status === "change" || item.status === "edited")
      .map((item) => item.step.id),
  );
  const flip = (id: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const changes = language !== mainLanguage(props.doc.guide) || tone !== toneOf(props.doc.guide);
  const counts = {
    reword: chosen.size,
    edited: preview.filter((item) => item.status === "edited" && !chosen.has(item.step.id)).length,
  };
  const sample = (option: Tone) =>
    renderPhrase(
      { key: "click", kind: "button", name: t("editor.languages.sampleName") },
      language,
      option,
    );

  return (
    <div className="fixed inset-0 z-[850] grid place-items-center bg-scrim/55 p-6">
      <ModalDialog
        labelledBy="language-tone-title"
        describedBy="language-tone-help"
        onEscape={props.onCancel}
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-hidden p-6"
      >
        <h2 id="language-tone-title" className="font-heading text-xl text-navy">
          {t("editor.languages.dialogTitle")}
        </h2>
        <p id="language-tone-help" className="text-sm text-secondary">
          {t("editor.languages.dialogHelp")}
        </p>

        <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
          {t("editor.languages.mainLanguage")}
          <select
            className="field max-w-xs font-normal"
            value={language}
            onChange={(event) => {
              setLanguage(event.currentTarget.value);
              setFlipped(new Set());
            }}
          >
            {LANGUAGES.map((item) => (
              <option key={item.code} value={item.code} lang={item.code}>
                {item.name}
              </option>
            ))}
          </select>
          <span className="text-xs font-normal text-secondary">
            {t("editor.languages.mainLanguageHelp")}
          </span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold text-navy">
            {t("editor.languages.tone")}
          </legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {TONES.map((option) => (
              <label
                key={option}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${tone === option ? "border-2 border-blue bg-selected" : "border-line"}`}
              >
                <span className="flex items-center gap-2 font-semibold text-navy">
                  <input
                    type="radio"
                    name="tone"
                    value={option}
                    checked={tone === option}
                    onChange={() => {
                      setTone(option);
                      setFlipped(new Set());
                    }}
                  />
                  {t(`editor.languages.tones.${option}`)}
                </span>
                <span className="text-xs text-secondary">
                  {t(`editor.languages.toneHelp.${option}`)}
                </span>
                <span lang={language} className="rounded bg-subtle px-2 py-1 font-mono text-xs">
                  {sample(option)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <section
          aria-labelledby="language-tone-preview"
          className="flex min-h-0 flex-1 flex-col gap-2"
        >
          <h3 id="language-tone-preview" className="text-sm font-semibold text-navy">
            {t("editor.languages.preview", { count: preview.length })}
          </h3>
          <ol className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-panel">
            {preview.map((item, index) => {
              const choosable = item.status === "change" || item.status === "edited";
              return (
                <li
                  key={item.step.id}
                  className="flex items-start gap-3 border-b border-panel px-3 py-2 text-sm last:border-b-0"
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    disabled={!choosable}
                    checked={chosen.has(item.step.id)}
                    aria-label={t("editor.languages.rewordStep", { number: index + 1 })}
                    onChange={() => flip(item.step.id)}
                  />
                  <span className="w-6 shrink-0 pt-0.5 text-xs text-secondary tabular-nums">
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    {item.status === "none" ? (
                      <span className="text-secondary">
                        {item.step.block?.heading || t("editor.languages.nothingToReword")}
                      </span>
                    ) : (
                      <>
                        {item.status !== "same" && (
                          <span className="block font-mono text-xs text-secondary">
                            {item.before}
                          </span>
                        )}
                        <span lang={language} className="block font-mono text-[13px] text-navy">
                          {item.after}
                        </span>
                      </>
                    )}
                  </span>
                  {item.status !== "change" && (
                    <span className="chip shrink-0">
                      {t(`editor.languages.status.${item.status}`)}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-panel pt-4">
          <p role="status" className="min-w-0 flex-1 text-sm text-secondary">
            {t("editor.languages.summary", { count: counts.reword })}
            {counts.edited > 0 && ` ${t("editor.languages.keptEdited", { count: counts.edited })}`}
          </p>
          <button type="button" className="btn" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={props.busy || (!changes && chosen.size === 0)}
            onClick={() => props.onApply(language, tone, chosen)}
          >
            {chosen.size > 0
              ? t("editor.languages.apply", { count: chosen.size })
              : t("editor.languages.applyNone")}
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}
