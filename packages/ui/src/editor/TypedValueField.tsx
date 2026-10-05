import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * "What was typed" on a typing step (04/10/2026): the value can be corrected or replaced, for a
 * typo or a made-up example in place of real data. It's saved when the box is left or Enter is
 * pressed, so clearing it to retype doesn't remove the value on the way; Escape puts it back.
 */
export function TypedValueField(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(props.value);
  // Undo, or another step's value, replaces what's in the box (set while rendering, as React
  // advises, rather than in an effect).
  const [shown, setShown] = useState(props.value);
  if (shown !== props.value) {
    setShown(props.value);
    setDraft(props.value);
  }
  const commit = () => {
    if (draft !== props.value) props.onChange(draft);
  };
  return (
    <label className="flex min-w-0 flex-1 basis-64 items-center gap-2">
      <span className="shrink-0">{t("editor.typedValue")}</span>
      <input
        type="text"
        className="field h-8 min-w-0 flex-1 font-mono"
        value={draft}
        maxLength={2000}
        placeholder={t("editor.typedValuePlaceholder")}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(props.value);
          }
        }}
      />
    </label>
  );
}
