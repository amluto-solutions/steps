import { useTranslation } from "react-i18next";
import type { Finding } from "@amluto-steps/core";

import { Icon } from "../components/icons";
import { describeFinding, describeFindings } from "./suggestions";

const keyOf = (finding: Finding) => `${finding.kind}:${finding.rect.x}:${finding.rect.y}`;

/**
 * The possible personal details on the screenshot on screen (docs/spec/04-editor.md#image-tools),
 * each with what it is and its own Show, Blur and Not personal (30/09/2026: two found on
 * one screenshot could only be blurred together). Pointing at one makes its area stand out on the
 * screenshot, and Show zooms in on it.
 */
export function SuggestedBlurs(props: {
  findings: Finding[];
  onBlur: (findings: Finding[]) => void;
  onDismiss: (findings: Finding[]) => void;
  onShow: (finding: Finding) => void;
  /** The finding pointed at or focused in the list, by its place in `findings`; null for none. */
  onPoint: (index: number | null) => void;
}) {
  const { t } = useTranslation();
  const { findings, onPoint } = props;
  if (findings.length === 0) return null;
  const several = findings.length > 1;

  const actions = (finding: Finding, number: number) => {
    const what = describeFinding(finding, t);
    return (
      <>
        <button
          type="button"
          className="btn btn-quiet h-7 px-2"
          aria-label={several ? t("suggest.showOne", { what, number }) : undefined}
          onClick={() => props.onShow(finding)}
        >
          <Icon name="zoomIn" size={14} />
          {t("suggest.show")}
        </button>
        <button
          type="button"
          className="btn h-7 px-2.5"
          aria-label={several ? t("suggest.blurOne", { what, number }) : undefined}
          onClick={() => props.onBlur([finding])}
        >
          {t("suggest.blurAll")}
        </button>
        <button
          type="button"
          className="btn btn-quiet h-7 px-2"
          aria-label={several ? t("suggest.dismissOne", { what, number }) : undefined}
          onClick={() => props.onDismiss([finding])}
        >
          {t("suggest.dismiss")}
        </button>
      </>
    );
  };

  return (
    <section
      aria-label={t("suggest.title")}
      className="border-b border-panel bg-warning-soft px-3 py-2 text-sm text-warning"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="shield" size={16} />
        <span role="status" className="min-w-0 flex-1">
          {t("suggest.found", { count: findings.length, kinds: describeFindings(findings, t) })}
        </span>
        {several ? (
          <>
            <button type="button" className="btn h-8 px-3" onClick={() => props.onBlur(findings)}>
              {t("suggest.blurEvery", { count: findings.length })}
            </button>
            <button
              type="button"
              className="btn btn-quiet h-8 px-2"
              onClick={() => props.onDismiss(findings)}
            >
              {t("suggest.dismissEvery")}
            </button>
          </>
        ) : (
          // One finding: its buttons sit on the line itself, and pointing at them marks it.
          // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- only marks the area on the screenshot; the buttons do the work
          <span
            className="flex items-center gap-1"
            onMouseEnter={() => onPoint(0)}
            onMouseLeave={() => onPoint(null)}
            onFocus={() => onPoint(0)}
            onBlur={() => onPoint(null)}
          >
            {findings[0] && actions(findings[0], 1)}
          </span>
        )}
      </div>
      {several && (
        <ol className="mt-1.5 flex flex-col gap-0.5">
          {findings.map((finding, index) => (
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- only marks the area on the screenshot; the buttons do the work
            <li
              key={keyOf(finding)}
              className="flex flex-wrap items-center gap-1.5 rounded-md py-0.5 pr-0.5 pl-1 focus-within:bg-background/60 hover:bg-background/60"
              onMouseEnter={() => onPoint(index)}
              onMouseLeave={() => onPoint(null)}
              onFocus={() => onPoint(index)}
              onBlur={() => onPoint(null)}
            >
              <span
                aria-hidden="true"
                className="grid size-5 shrink-0 place-items-center rounded-full bg-bar-paused text-[11px] font-bold text-brand-navy"
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">{describeFinding(finding, t)}</span>
              {actions(finding, index + 1)}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
