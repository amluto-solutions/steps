import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CODE_LANGUAGES,
  MASK_TEXT,
  codeForClipboard,
  type CodeLanguage,
  type StepCode,
} from "@amluto-steps/core";

import { Icon } from "../components/icons";
import type { ToastMessage } from "../components/Toast";

/**
 * A step's code block (docs/spec/04-editor.md#code-steps, design canvas "Editor: Run in
 * PowerShell"): the language, a Copy button, the code as editable text, and the command's output,
 * collapsed, with Copy and Remove. Masked secrets are explained where they show.
 */
export function CodePanel(props: {
  stepId: string;
  code: StepCode;
  onChange: (patch: Partial<StepCode>, coalesceKey?: string) => void;
  onRemoveOutput: () => void;
  notify: (message: Omit<ToastMessage, "id">) => void;
}) {
  const { t } = useTranslation();
  const { code } = props;
  const [outputOpen, setOutputOpen] = useState(false);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(codeForClipboard(text));
      props.notify({ text: t("editor.code.copied") });
    } catch {
      props.notify({ kind: "error", text: t("editor.code.copyFailed") });
    }
  };
  const outputLines = code.output === null ? 0 : code.output.split("\n").length;
  const masked = code.text.includes(MASK_TEXT) || (code.output ?? "").includes(MASK_TEXT);
  const outputId = `output-${props.stepId}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col overflow-hidden rounded-[10px] border border-line bg-brand-navy">
        <div className="flex h-9 items-center gap-2.5 bg-white/10 pr-2 pl-3 text-xs text-bar-muted">
          <label className="sr-only" htmlFor={`language-${props.stepId}`}>
            {t("editor.code.language")}
          </label>
          <select
            id={`language-${props.stepId}`}
            value={code.language}
            onChange={(event) =>
              props.onChange({ language: event.currentTarget.value as CodeLanguage })
            }
            className="h-7 rounded-md border-0 bg-transparent pr-1 text-xs font-bold tracking-wide text-bar-muted uppercase hover:bg-white/10"
          >
            {CODE_LANGUAGES.map((language) => (
              <option key={language} value={language} className="text-body normal-case">
                {t(`editor.code.languages.${language}`)}
              </option>
            ))}
          </select>
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => void copy(code.text)}
            className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-white/15 px-2.5 text-xs font-semibold text-white hover:bg-white/25"
          >
            <Icon name="copy" size={13} />
            {t("editor.code.copy")}
          </button>
        </div>
        <label className="sr-only" htmlFor={`code-${props.stepId}`}>
          {t("editor.code.text")}
        </label>
        <textarea
          id={`code-${props.stepId}`}
          spellCheck={false}
          value={code.text}
          onChange={(event) =>
            props.onChange({ text: event.currentTarget.value }, `code:${props.stepId}`)
          }
          wrap="off"
          className="field-sizing-content min-h-12 w-full resize-none overflow-x-auto border-0 bg-transparent px-4 py-3 font-mono text-sm leading-relaxed whitespace-pre text-white outline-none focus-visible:ring-2 focus-visible:ring-cyan"
        />
      </div>

      {code.output !== null && (
        <div className="flex flex-col rounded-[10px] border border-panel bg-background">
          <div className="flex h-[38px] items-center gap-2.5 pr-2.5 pl-2 text-[13px]">
            <button
              type="button"
              aria-expanded={outputOpen}
              aria-controls={outputId}
              onClick={() => setOutputOpen((open) => !open)}
              className="inline-flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-subtle"
            >
              <Icon
                name="forward"
                size={14}
                className={`text-secondary transition-transform ${outputOpen ? "rotate-90" : ""}`}
              />
              <strong className="text-navy">{t("editor.code.output")}</strong>
              <span className="text-secondary">
                {t("editor.code.lines", { count: outputLines })}
                {code.outputShortened ? ` · ${t("editor.code.shortened")}` : ""}
              </span>
            </button>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => void copy(code.output ?? "")}
              className="h-[26px] rounded-md px-2.5 text-xs font-semibold text-link hover:bg-subtle"
            >
              {t("editor.code.copy")}
            </button>
            <button
              type="button"
              onClick={props.onRemoveOutput}
              className="h-[26px] rounded-md px-2.5 text-xs font-semibold text-recording hover:bg-subtle"
            >
              {t("editor.code.removeOutput")}
            </button>
          </div>
          {outputOpen && (
            <div id={outputId} className="border-t border-panel">
              <label className="sr-only" htmlFor={`output-text-${props.stepId}`}>
                {t("editor.code.output")}
              </label>
              <textarea
                id={`output-text-${props.stepId}`}
                spellCheck={false}
                value={code.output}
                onChange={(event) =>
                  props.onChange({ output: event.currentTarget.value }, `output:${props.stepId}`)
                }
                wrap="off"
                className="field-sizing-content max-h-80 min-h-12 w-full resize-none overflow-x-auto border-0 bg-transparent px-4 py-3 font-mono text-[13px] leading-relaxed whitespace-pre text-body focus-visible:-outline-offset-2"
              />
            </div>
          )}
        </div>
      )}

      {masked && (
        <p className="flex items-start gap-2.5 rounded-lg bg-selected px-3 py-2.5 text-[13px] text-navy">
          <Icon name="info" size={16} className="mt-px shrink-0 text-link" />
          {t("editor.code.maskedNote")}
        </p>
      )}
    </div>
  );
}
