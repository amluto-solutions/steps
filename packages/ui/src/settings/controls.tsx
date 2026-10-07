import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/icons";

// The pieces every settings section is built from: rows, switches and the "set by your organisation" notes.

/** "Set by your organisation", for a setting IT policy controls (shown read-only). */
export function ManagedNote() {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1 text-[12px] text-secondary">
      <Icon name="lock" size={12} />
      {t("settings.managed")}
    </span>
  );
}

export function Row({
  label,
  help,
  children,
  id,
  managed,
}: {
  label: string;
  help?: string;
  children: ReactNode;
  id?: string;
  managed?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-panel py-3.5">
      <div className="flex min-w-60 flex-1 flex-col gap-0.5">
        <span id={id} className="text-sm font-semibold text-navy">
          {label}
        </span>
        {help && <span className="text-[13px] leading-snug text-secondary">{help}</span>}
        {managed && <ManagedNote />}
      </div>
      {children}
    </div>
  );
}

/** A read-only chip for a list entry that IT policy adds. */
export function ManagedChip({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <span
      title={t("settings.managed")}
      className="inline-flex h-[30px] items-center gap-1.5 rounded-full bg-subtle px-2.5 text-[13px] text-secondary"
    >
      <Icon name="lock" size={12} />
      {text}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  labelledBy,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-[26px] w-11 shrink-0 rounded-full p-[3px] disabled:opacity-50 ${checked ? "justify-end bg-blue" : "justify-start bg-control-line"}`}
    >
      <span className="size-5 rounded-full bg-white shadow" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  labelledBy,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className="flex shrink-0 rounded-[10px] bg-subtle p-[3px]"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`h-8 rounded-lg px-3 text-[13px] disabled:opacity-50 ${value === option.value ? "bg-background font-semibold text-navy shadow" : "text-secondary"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A setting that is a list of words or names, shown as chips: the organisation's first
 * (read-only), then the user's with a remove button each, then a box to add one. `onAdd` says
 * whether it took the text, which then leaves the box.
 */
export function ChipList(props: {
  label: string;
  help: string;
  managed: string[];
  items: string[];
  removeLabel: (item: string) => string;
  onRemove: (item: string) => void;
  inputLabel: string;
  placeholder: string;
  addLabel: string;
  canAdd: (text: string) => boolean;
  onAdd: (text: string) => boolean;
  disabled?: boolean;
  inputClassName: string;
}) {
  const [text, setText] = useState("");
  return (
    <div className="flex items-start gap-6 border-t border-panel py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold text-navy">{props.label}</span>
        <span className="text-[13px] text-secondary">{props.help}</span>
      </div>
      <div className="flex max-w-80 flex-wrap justify-end gap-1.5">
        {props.managed.map((item) => (
          <ManagedChip key={`policy-${item.toLowerCase()}`} text={item} />
        ))}
        {props.items.map((item) => (
          <span
            key={item.toLowerCase()}
            className="inline-flex h-[30px] items-center gap-1 rounded-full bg-subtle pr-1 pl-2.5 text-[13px]"
          >
            {item}
            <button
              type="button"
              disabled={props.disabled}
              aria-label={props.removeLabel(item)}
              onClick={() => props.onRemove(item)}
              className="inline-flex size-6 items-center justify-center rounded-full hover:bg-panel"
            >
              <Icon name="close" size={12} strokeWidth={2.6} />
            </button>
          </span>
        ))}
        <form
          className="flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.onAdd(text)) setText("");
          }}
        >
          <input
            value={text}
            disabled={props.disabled}
            aria-label={props.inputLabel}
            placeholder={props.placeholder}
            onChange={(event) => setText(event.currentTarget.value)}
            className={`field h-[30px] rounded-full text-[13px] ${props.inputClassName}`}
          />
          <button
            type="submit"
            disabled={props.disabled || !props.canAdd(text)}
            className="btn h-[30px] rounded-full border-dashed px-3 text-[13px] text-link"
          >
            {props.addLabel}
          </button>
        </form>
      </div>
    </div>
  );
}
