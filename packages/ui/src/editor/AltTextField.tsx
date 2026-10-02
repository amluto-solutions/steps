import { useTranslation } from "react-i18next";
import { visibleStepText, type GuideStep } from "@amluto-steps/core";

/**
 * A screenshot's alt text (docs/spec/04-editor.md#editing-steps). Left empty, exports use the
 * text generated from the step, which shows as the placeholder; anything typed replaces it.
 */
export function AltTextField({
  step,
  onChange,
}: {
  step: GuideStep;
  onChange: (text: string | null) => void;
}) {
  const { t } = useTranslation();
  const id = `alt-${step.id}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold text-navy">
        {t("editor.altText")}
      </label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        value={step.altText ?? ""}
        placeholder={visibleStepText(step)}
        aria-describedby={`${id}-help`}
        onChange={(event) => {
          const text = event.currentTarget.value;
          onChange(text.trim() ? text : null);
        }}
        className="field resize-y text-sm"
      />
      <span id={`${id}-help`} className="text-xs text-secondary">
        {t("editor.altTextHelp")}
      </span>
    </div>
  );
}
