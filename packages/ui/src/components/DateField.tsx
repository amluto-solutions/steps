import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatIsoDate, parseDate } from "@amluto-steps/core";

import { Icon } from "./icons";

/**
 * A date written and typed the way the app's language writes dates: dd/mm/yyyy in English,
 * 31.12.2026 in German, 2026/12/31 in Japanese (`formatDate`). The browser's own date box showed
 * yyyy-mm-dd, whatever the language. The calendar button opens the system's date picker.
 * `value` and `onChange` are yyyy-mm-dd, or null for no date.
 */
export function DateField({
  value,
  onChange,
  id,
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  id?: string;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language || "en";
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const example = formatIsoDate("2026-12-31", language);

  const commit = () => {
    if (draft === null) return;
    const text = draft.trim();
    if (!text) {
      setDraft(null);
      setInvalid(false);
      onChange(null);
      return;
    }
    const iso = parseDate(text, language);
    if (!iso) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    onChange(iso);
  };

  return (
    <span className="flex flex-col gap-1">
      <span className="relative flex items-center gap-2">
        <input
          id={id}
          value={draft ?? (value ? formatIsoDate(value, language) : "")}
          placeholder={example}
          inputMode="numeric"
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
          className="field min-w-0 flex-1 font-normal"
        />
        <button
          type="button"
          onClick={() => picker.current?.showPicker?.()}
          aria-label={t("common.chooseDate")}
          title={t("common.chooseDate")}
          className="btn h-9 w-9 shrink-0 p-0"
        >
          <Icon name="calendar" size={16} />
        </button>
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden="true"
          value={value ?? ""}
          onChange={(event) => {
            setDraft(null);
            setInvalid(false);
            onChange(event.currentTarget.value || null);
          }}
          className="pointer-events-none absolute right-0 bottom-0 h-0 w-0 opacity-0"
        />
      </span>
      {invalid && (
        <span role="alert" className="text-xs font-normal text-warning">
          {t("common.dateInvalid", { example })}
        </span>
      )}
    </span>
  );
}
