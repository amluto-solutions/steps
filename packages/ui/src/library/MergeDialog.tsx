import { foldForSearch } from "@amluto-steps/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import type { LibraryGuideSummary, LibraryInfo } from "../library-bridge";
import { ModalDialog } from "../ModalDialog";

/** A guide chosen for the merge, and the library it's in. */
export interface MergeChoice {
  libraryId: string;
  guide: LibraryGuideSummary;
}

export interface MergeRequest {
  parts: MergeChoice[];
  title: string;
  libraryId: string;
  headings: boolean;
  binOriginals: boolean;
}

/** The longest title a guide may have (as Rename). */
const MAX_TITLE = 300;

/**
 * Merge guides (docs/spec/04-editor.md#merge-guides): choose guides from any library, put them in
 * order, name the new guide and where it goes. The originals are only read, unless "Move the
 * originals to the Bin" is ticked.
 */
export function MergeDialog(props: {
  libraries: LibraryInfo[];
  /** The library on screen, whose guides are listed first. */
  libraryId: string;
  /** Already chosen: the guides selected, or the guide whose menu it came from. */
  initial: MergeChoice[];
  listGuides: (libraryId: string) => Promise<LibraryGuideSummary[]>;
  busy: boolean;
  onCancel: () => void;
  onMerge: (request: MergeRequest) => void;
}) {
  const { t } = useTranslation();
  const usable = props.libraries.filter((item) => !item.needsAccess);
  const [chosen, setChosen] = useState<MergeChoice[]>(props.initial);
  const [browsing, setBrowsing] = useState(props.libraryId);
  const [listed, setListed] = useState<{ libraryId: string; guides: LibraryGuideSummary[] } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  // The first guide's title alone gave two cards one title, and no telling which was new.
  const [title, setTitle] = useState(() => {
    const first = props.initial[0]?.guide.title;
    return first ? t("merge.defaultTitle", { title: first }) : "";
  });
  const [target, setTarget] = useState(props.initial[0]?.libraryId ?? props.libraryId);
  const [headings, setHeadings] = useState(true);
  const [binOriginals, setBinOriginals] = useState(false);

  const { listGuides } = props;
  useEffect(() => {
    let cancelled = false;
    listGuides(browsing)
      .then((guides) => {
        if (!cancelled) setListed({ libraryId: browsing, guides });
      })
      .catch(() => {
        if (!cancelled) setListed({ libraryId: browsing, guides: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [browsing, listGuides]);

  const isChosen = (libraryId: string, id: string) =>
    chosen.some((item) => item.libraryId === libraryId && item.guide.id === id);
  const toggle = (libraryId: string, guide: LibraryGuideSummary) =>
    setChosen((current) =>
      isChosen(libraryId, guide.id)
        ? current.filter((item) => !(item.libraryId === libraryId && item.guide.id === guide.id))
        : [...current, { libraryId, guide }],
    );
  const moveBy = (index: number, by: -1 | 1) =>
    setChosen((current) => {
      const next = [...current];
      const [item] = next.splice(index, 1);
      if (item) next.splice(index + by, 0, item);
      return next;
    });

  const words = foldForSearch(query.trim());
  const shown =
    listed?.libraryId === browsing
      ? listed.guides.filter((guide) => foldForSearch(guide.title).includes(words))
      : null;
  const libraryName = (id: string) => usable.find((item) => item.id === id)?.name ?? "";
  const severalLibraries = new Set(chosen.map((item) => item.libraryId)).size > 1;
  const steps = chosen.reduce((sum, item) => sum + item.guide.stepCount, 0);
  const cleanTitle = title.trim();
  const canMerge = chosen.length >= 2 && cleanTitle.length > 0 && !props.busy;

  return (
    <div className="fixed inset-0 z-[850] grid place-items-center bg-scrim/55 p-6">
      <ModalDialog
        labelledBy="merge-title"
        describedBy="merge-help"
        onEscape={props.onCancel}
        className="card flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto p-6"
      >
        <h2 id="merge-title" className="font-heading text-xl text-navy">
          {t("merge.title")}
        </h2>
        <p id="merge-help" className="text-sm text-secondary">
          {t("merge.help")}
        </p>

        <div className="grid min-h-0 gap-4 md:grid-cols-2">
          <section aria-labelledby="merge-add" className="flex min-w-0 flex-col gap-2">
            <h3 id="merge-add" className="text-sm font-semibold text-navy">
              {t("merge.add")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {usable.length > 1 && (
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-secondary">
                  {t("merge.fromLibrary")}
                  <select
                    className="field"
                    value={browsing}
                    onChange={(event) => setBrowsing(event.currentTarget.value)}
                  >
                    {usable.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-secondary">
                {t("merge.search")}
                <input
                  type="search"
                  className="field"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              </label>
            </div>
            <div
              role="group"
              aria-label={t("merge.guidesIn", { name: libraryName(browsing) })}
              className="max-h-64 min-h-24 overflow-y-auto rounded-lg border border-panel"
            >
              {shown === null ? (
                <p className="px-3 py-2.5 text-sm text-secondary">{t("library.loading")}</p>
              ) : shown.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-secondary">{t("library.noMatches")}</p>
              ) : (
                shown.map((guide) => (
                  <label
                    key={guide.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-panel px-3 py-2 text-sm last:border-b-0 hover:bg-subtle"
                  >
                    <input
                      type="checkbox"
                      checked={isChosen(browsing, guide.id)}
                      onChange={() => toggle(browsing, guide)}
                    />
                    <span className="min-w-0 flex-1 truncate font-semibold text-navy">
                      {guide.title}
                    </span>
                    <span className="shrink-0 text-xs text-secondary">
                      {t("library.steps", { count: guide.stepCount })}
                    </span>
                  </label>
                ))
              )}
            </div>
          </section>

          <section aria-labelledby="merge-order" className="flex min-w-0 flex-col gap-2">
            <h3 id="merge-order" className="text-sm font-semibold text-navy">
              {t("merge.order")}
            </h3>
            {chosen.length === 0 ? (
              <p className="rounded-lg border border-dashed border-panel px-3 py-4 text-sm text-secondary">
                {t("merge.noneChosen")}
              </p>
            ) : (
              <ol className="flex flex-col rounded-lg border border-panel">
                {chosen.map((item, index) => (
                  <li
                    key={`${item.libraryId}/${item.guide.id}`}
                    className="flex items-center gap-2 border-b border-panel px-3 py-2 text-sm last:border-b-0"
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-subtle text-xs font-semibold text-navy">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-navy">
                        {item.guide.title}
                      </span>
                      {severalLibraries && (
                        <span className="block truncate text-xs text-secondary">
                          {libraryName(item.libraryId)}
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="icon-btn size-7"
                      disabled={index === 0}
                      aria-label={t("merge.up", { title: item.guide.title })}
                      onClick={() => moveBy(index, -1)}
                    >
                      <Icon name="up" size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn size-7"
                      disabled={index === chosen.length - 1}
                      aria-label={t("merge.down", { title: item.guide.title })}
                      onClick={() => moveBy(index, 1)}
                    >
                      <Icon name="down" size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn size-7"
                      aria-label={t("merge.remove", { title: item.guide.title })}
                      onClick={() => toggle(item.libraryId, item.guide)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
            {t("merge.newTitle")}
            <input
              className="field font-normal"
              value={title}
              maxLength={MAX_TITLE}
              required
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          {usable.length > 1 && (
            <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
              {t("merge.saveTo")}
              <select
                className="field font-normal"
                value={target}
                onChange={(event) => setTarget(event.currentTarget.value)}
              >
                {usable.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="flex flex-col gap-2 text-sm">
          <label className="flex items-start gap-2 text-navy">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={headings}
              onChange={(event) => setHeadings(event.currentTarget.checked)}
            />
            <span className="flex flex-col gap-0.5">
              {t("merge.headings")}
              <span className="text-xs text-secondary">{t("merge.headingsHelp")}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-navy">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={binOriginals}
              onChange={(event) => setBinOriginals(event.currentTarget.checked)}
            />
            <span className="flex flex-col gap-0.5">
              {t("merge.binOriginals")}
              <span className="text-xs text-secondary">{t("merge.binOriginalsHelp")}</span>
            </span>
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-panel pt-4">
          <p role="status" className="min-w-0 flex-1 text-sm text-secondary">
            {chosen.length < 2
              ? t("merge.needTwo")
              : t("merge.summary", { count: chosen.length, steps })}
          </p>
          <button type="button" className="btn" onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canMerge}
            onClick={() =>
              props.onMerge({
                parts: chosen,
                title: cleanTitle,
                libraryId: target,
                headings,
                binOriginals,
              })
            }
          >
            {t("merge.button", { count: chosen.length })}
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}
