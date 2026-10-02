import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Finding, GuideStep, OcrLine } from "@amluto-steps/core";

import { Icon } from "../components/icons";
import { ModalDialog } from "../ModalDialog";
import { describeFindings, findOpenInGuide } from "./suggestions";

interface FindBlurDialogProps {
  steps: GuideStep[];
  numbers: Map<string, number>;
  terms: string[];
  /** OCR for one step's screenshot (cached, so a second search is quick). */
  linesFor: (step: GuideStep) => Promise<OcrLine[]>;
  onBlur: (found: { stepId: string; findings: Finding[] }[]) => void;
  /** Steps whose wording, notes or block text contain the term (searched alongside images). */
  textMatches: (term: string) => GuideStep[];
  /** Replaces the term in that text, as one undoable edit. */
  onReplace: (term: string, replacement: string) => void;
  onClose: () => void;
}

/**
 * Find & Blur (docs/spec/04-editor.md#image-tools): search every screenshot for a word or phrase,
 * or, with the box empty, for personal data, then blur everything found in one go (one undo).
 */
export function FindBlurDialog(props: FindBlurDialogProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<{ stepId: string; findings: Finding[] }[] | null>(null);
  /** Screenshots text recognition couldn't read: never reported as "nothing found". */
  const [unread, setUnread] = useState(0);
  /** The term searched for, and the steps whose text contains it. */
  const [searched, setSearched] = useState("");
  const [inText, setInText] = useState<GuideStep[]>([]);
  const [replacement, setReplacement] = useState("");

  const search = async () => {
    const term = query.trim();
    setResults(null);
    setSearching({ done: 0, total: 0 });
    // With a word, only that word; with the box empty, every open finding.
    const { found, unread: failed } = await findOpenInGuide(
      props.steps,
      props.linesFor,
      term ? [term] : props.terms,
      (done, total) => setSearching({ done, total }),
    );
    const results = term
      ? found
          .map((item) => ({
            ...item,
            findings: item.findings.filter((finding) => finding.kind === "term"),
          }))
          .filter((item) => item.findings.length > 0)
      : found;
    setSearching(null);
    setSearched(query.trim());
    setInText(props.textMatches(query.trim()));
    setUnread(failed);
    setResults(results);
  };

  const total = results?.reduce((sum, item) => sum + item.findings.length, 0) ?? 0;

  return (
    <div className="fixed inset-0 z-[800] grid place-items-center bg-scrim/50 p-4">
      <ModalDialog
        labelledBy="find-blur-title"
        describedBy="find-blur-help"
        onEscape={props.onClose}
        className="card flex max-h-[80vh] w-full max-w-xl flex-col p-6"
      >
        <h2 id="find-blur-title" className="font-heading text-xl text-navy">
          {t("findBlur.title")}
        </h2>
        <p id="find-blur-help" className="mt-1 text-sm text-secondary">
          {t("findBlur.help")}
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label className="flex-1">
            <span className="sr-only">{t("findBlur.term")}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder={t("findBlur.placeholder")}
              className="field w-full"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={searching !== null}>
            <Icon name="search" size={16} />
            {t("findBlur.search")}
          </button>
        </form>
        <div role="status" className="mt-4 min-h-6 text-sm text-secondary">
          {searching
            ? t("findBlur.searching", searching)
            : results
              ? results.length
                ? t("findBlur.found", { count: total, steps: results.length })
                : t("findBlur.nothing")
              : null}
          {!searching && results && unread > 0 && (
            <span className="block text-warning">{t("findBlur.unread", { count: unread })}</span>
          )}
        </div>
        {results && results.length > 0 && (
          <ul className="mt-2 flex min-h-0 flex-col gap-1 overflow-y-auto text-sm">
            {results.map((item) => (
              <li key={item.stepId} className="flex gap-2 rounded-lg bg-subtle px-3 py-2">
                <strong className="text-navy">
                  {t("export.stepNumber", { number: props.numbers.get(item.stepId) ?? "?" })}
                </strong>
                <span className="text-secondary">{describeFindings(item.findings, t)}</span>
              </li>
            ))}
          </ul>
        )}
        {!searching && searched && inText.length > 0 && (
          <form
            className="mt-3 flex flex-col gap-2 rounded-lg bg-subtle px-3 py-2.5 text-sm"
            onSubmit={(event) => {
              event.preventDefault();
              props.onReplace(searched, replacement);
              // Done: the editor confirms with a toast (and Undo).
              setInText([]);
            }}
          >
            <span>
              {t("findBlur.inText", {
                count: inText.length,
                steps: inText
                  .map((step) => props.numbers.get(step.id))
                  .filter((number) => number !== undefined)
                  .join(", "),
              })}
            </span>
            <span className="flex gap-2">
              <label className="flex flex-1 items-center gap-2">
                <span className="shrink-0 text-secondary">{t("findBlur.replaceWith")}</span>
                <input
                  value={replacement}
                  onChange={(event) => setReplacement(event.currentTarget.value)}
                  className="field h-8 min-w-0 flex-1"
                />
              </label>
              <button type="submit" className="btn h-8">
                {t("findBlur.replace")}
              </button>
            </span>
          </form>
        )}
        <p className="mt-3 text-xs text-secondary">{t("findBlur.notGuaranteed")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={props.onClose}>
            {t("common.close")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!results || total === 0}
            onClick={() => {
              if (results) props.onBlur(results);
              props.onClose();
            }}
          >
            {t("findBlur.blurAll", { count: total })}
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}
