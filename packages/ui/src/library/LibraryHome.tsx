import { foldForSearch } from "@amluto-steps/core";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useLockedBy } from "./LockDialogs";

import { useAnnounce } from "../components/Announcer";
import { Icon } from "../components/icons";
import { Menu, type MenuEntry } from "../components/Menu";
import { useLatest } from "../useLatest";
import type { GuideSearchHit, LibraryGuideSummary, StorageUse } from "../library-bridge";
import { formatBytes, freeBytes } from "./storage";
import { formatUpdated } from "./dates";
import { needsReview } from "./views";

export interface PendingRecording {
  sessionId: string;
  title: string;
  stepCount: number | null;
  /** The guide was already saved and only its journal cleanup is left. */
  savedGuideId: string | null;
}

/**
 * Several guides at once (01/10/2026): what the selection bar can do with the guides ticked.
 */
export interface BulkActions {
  /** The other libraries, for Move to and Copy to; none hides both. */
  targets: { id: string; name: string }[];
  onMove: (guides: LibraryGuideSummary[], libraryId: string) => void;
  onCopy: (guides: LibraryGuideSummary[], libraryId: string) => void;
  onTrash: (guides: LibraryGuideSummary[]) => void;
  /** Merge (two or more); absent where it isn't offered. */
  onMerge?: ((guides: LibraryGuideSummary[]) => void) | undefined;
  /** The formats several guides can be exported in, one review each. */
  exportMenu: (guides: LibraryGuideSummary[]) => MenuEntry[];
  /** Password locks (04/10/2026): Lock… for any not locked, Remove lock… for any locked. */
  onLock?: ((guides: LibraryGuideSummary[]) => void) | undefined;
  onRemoveLock?: ((guides: LibraryGuideSummary[]) => void) | undefined;
}

interface LibraryHomeProps {
  heading: string;
  guides: LibraryGuideSummary[];
  loading: boolean;
  pending: PendingRecording[];
  busy: boolean;
  onOpen: (guide: LibraryGuideSummary) => void;
  onReviewPending: (pending: PendingRecording) => void;
  onDiscardPending: (pending: PendingRecording) => void;
  guideMenu: (guide: LibraryGuideSummary) => MenuEntry[];
  exportMenu: (guide: LibraryGuideSummary) => MenuEntry[];
  loadThumbnail: (guide: LibraryGuideSummary) => Promise<string>;
  onNewRecording: () => void;
  onImport: () => void;
  /** Searches what the guides say (steps, notes, blocks); without it only the cards are searched. */
  searchGuides?: ((query: string) => Promise<GuideSearchHit[]>) | undefined;
  /** Steps for Chrome: why browser storage needs a look, with what it takes and has left. */
  storage?: { warning: "lowSpace" | "large"; use: StorageUse } | null | undefined;
  onExportAndRemove?: (() => void) | undefined;
  /**
   * Steps for Chrome: the browser needs permission again to open this library's folder (after a
   * restart, say); the button asks, from the click.
   */
  access?: { folder: string; onAllow: () => void } | null | undefined;
  /** Multi-select: tick boxes on the cards, and a bar of actions for the guides ticked. */
  bulk?: BulkActions | undefined;
}

/** How long typing must pause before the guides' wording is searched. */
const SEARCH_DELAY_MS = 250;

/** Each order and its reverse (30/09/2026). */
const SORTS = [
  "updated",
  "updatedOldest",
  "title",
  "titleReverse",
  "steps",
  "stepsFewest",
] as const;
type Sort = (typeof SORTS)[number];

function GuideThumbnail({
  guide,
  load,
}: {
  guide: LibraryGuideSummary;
  load: LibraryHomeProps["loadThumbnail"];
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!guide.thumbnailMediaId) return;
    let cancelled = false;
    load(guide)
      .then((data) => {
        if (!cancelled) setUrl(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [guide, load]);
  return url ? (
    <img src={url} alt="" className="size-full object-cover object-top" draggable={false} />
  ) : (
    <Icon name="image" size={28} className="text-secondary" />
  );
}

/** Where a search found its words, under the card title ("Step 4: …Save invoice…"). */
function FoundIn({ found }: { found: GuideSearchHit["foundIn"] }) {
  const { t } = useTranslation();
  if (!found) return null;
  return (
    <span className="line-clamp-2 px-3.5 pt-1 text-xs text-secondary">
      {found.stepNumber === null
        ? t("library.foundIn", { snippet: found.snippet })
        : t("library.foundInStep", { number: found.stepNumber, snippet: found.snippet })}
    </span>
  );
}

/**
 * Guides first (design review, 25/09/2026): the unsaved-recording banner, then a grid of
 * guide cards, each with a quick Export button. Settings live in their own screen.
 */
export function LibraryHome(props: LibraryHomeProps) {
  const { t } = useTranslation();
  const lockedBy = useLockedBy();
  const announce = useAnnounce();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("updated");
  /** Guides whose wording matched, for the query they were searched with. */
  const [wordingHits, setWordingHits] = useState<{
    query: string;
    hits: Map<string, GuideSearchHit["foundIn"]>;
  } | null>(null);
  const searchGuides = useRef(props.searchGuides);
  useEffect(() => {
    searchGuides.current = props.searchGuides;
  });

  // The cards are filtered at once; the guides' wording is searched once typing pauses, and a
  // late answer for an older query is ignored.
  const trimmed = query.trim();
  useEffect(() => {
    const search = searchGuides.current;
    if (!trimmed || !search) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(trimmed)
        .then((hits) => {
          if (!cancelled)
            setWordingHits({
              query: trimmed,
              hits: new Map(hits.map((hit) => [hit.guideId, hit.foundIn])),
            });
        })
        .catch(() => undefined);
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed, props.guides]);
  const hits = wordingHits?.query === trimmed ? wordingHits.hits : null;

  // ----- Selecting several guides -----
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  /** Select pressed: a click on a card ticks it instead of opening it. */
  const [selectMode, setSelectMode] = useState(false);
  /** Where a Shift-click's range starts: the last card ticked or unticked. */
  const anchor = useRef<string | null>(null);
  // Guides that have gone (moved, to the Bin, deleted elsewhere) simply drop out.
  const ticked = props.guides.filter((guide) => selected.has(guide.id));
  const selecting = Boolean(props.bulk) && (selectMode || ticked.length > 0);
  useEffect(() => {
    if (ticked.length > 0) announce(t("library.selection.count", { count: ticked.length }));
  }, [ticked.length, announce, t]);

  const shown = useMemo(() => {
    const words = foldForSearch(trimmed).split(/\s+/).filter(Boolean);
    const matching = props.guides.filter((guide) => {
      const haystack = foldForSearch(`${guide.title} ${guide.tags.join(" ")} ${guide.owner}`);
      return words.every((word) => haystack.includes(word)) || Boolean(hits?.has(guide.id));
    });
    const byTitle = (left: LibraryGuideSummary, right: LibraryGuideSummary) =>
      left.title.localeCompare(right.title, "en-GB");
    const compare: Record<Sort, (left: LibraryGuideSummary, right: LibraryGuideSummary) => number> =
      {
        updated: (left, right) => right.updatedAt.localeCompare(left.updatedAt),
        updatedOldest: (left, right) => left.updatedAt.localeCompare(right.updatedAt),
        title: byTitle,
        titleReverse: (left, right) => byTitle(right, left),
        // Guides with as many steps stay in title order either way.
        steps: (left, right) => right.stepCount - left.stepCount || byTitle(left, right),
        stepsFewest: (left, right) => left.stepCount - right.stepCount || byTitle(left, right),
      };
    return [...matching].sort(compare[sort]);
  }, [props.guides, trimmed, hits, sort]);

  const toggle = (id: string) => {
    anchor.current = id;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** Shift-click: everything shown from the last card ticked to this one. */
  const tickRange = (id: string) => {
    const ids = shown.map((guide) => guide.id);
    const from = anchor.current === null ? -1 : ids.indexOf(anchor.current);
    if (from === -1) {
      toggle(id);
      return;
    }
    const to = ids.indexOf(id);
    const [start, end] = from < to ? [from, to] : [to, from];
    setSelected((current) => new Set([...current, ...ids.slice(start, end + 1)]));
  };
  const selectAll = () => setSelected(new Set(shown.map((guide) => guide.id)));
  const clearSelection = () => {
    setSelected(new Set());
    setSelectMode(false);
    anchor.current = null;
  };
  /** A card's click: opens it, or with Ctrl, Shift or Select on, ticks it. */
  const clickCard = (event: MouseEvent, guide: LibraryGuideSummary) => {
    if (props.bulk && event.shiftKey) tickRange(guide.id);
    else if (props.bulk && (event.ctrlKey || event.metaKey || selecting)) toggle(guide.id);
    else props.onOpen(guide);
  };
  /**
   * Ctrl+A ticks every guide shown; Escape unticks them all. On the window, as on a desktop's file
   * list, except while typing in a box or with a menu or dialog open (they have their own keys).
   */
  const selectionKeys = useLatest((event: globalThis.KeyboardEvent) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("[role=menu], [role=dialog], [role=alertdialog]")) return;
    const typing =
      (target instanceof HTMLInputElement && target.type !== "checkbox") ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      Boolean(target?.isContentEditable);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !typing) {
      event.preventDefault();
      selectAll();
    } else if (event.key === "Escape" && selecting) {
      event.preventDefault();
      clearSelection();
    }
  });
  const hasBulk = Boolean(props.bulk);
  useEffect(() => {
    if (!hasBulk) return undefined;
    const listener = (event: globalThis.KeyboardEvent) => selectionKeys.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [hasBulk, selectionKeys]);
  /** Runs a bar action on the guides ticked, and starts afresh. */
  const runTicked = (action: (guides: LibraryGuideSummary[]) => void) => {
    const guides = ticked;
    clearSelection();
    action(guides);
  };

  // Once a search has its answer, say how many guides it found.
  const searched = Boolean(trimmed) && (hits !== null || !props.searchGuides);
  useEffect(() => {
    if (!searched) return;
    announce(
      shown.length === 0 ? t("library.noMatches") : t("library.found", { count: shown.length }),
    );
  }, [searched, shown.length, announce, t]);

  // A card that goes (to the Bin, moved, deleted) takes focus with it: give it to the card now in
  // its place, or the heading when none is left.
  const heading = useRef<HTMLHeadingElement>(null);
  const lastCard = useRef<number | null>(null);
  const grid = useRef<HTMLUListElement>(null);
  // The grid is only there while there are cards; its listeners go on when it appears.
  const hasCards = shown.length > 0;
  useEffect(() => {
    const list = grid.current;
    if (!list) return undefined;
    const cardOf = (node: EventTarget | null) =>
      node instanceof Element ? node.closest<HTMLElement>("[data-card-index]") : null;
    const focusIn = (event: FocusEvent) => {
      const card = cardOf(event.target);
      if (card) lastCard.current = Number(card.dataset.cardIndex);
    };
    // Focus leaving a card on purpose forgets it; a card removed while focused fires no
    // focusout, so the rescue below still knows where it was.
    const focusOut = (event: FocusEvent) => {
      if (cardOf(event.target) !== cardOf(event.relatedTarget)) lastCard.current = null;
    };
    list.addEventListener("focusin", focusIn);
    list.addEventListener("focusout", focusOut);
    return () => {
      list.removeEventListener("focusin", focusIn);
      list.removeEventListener("focusout", focusOut);
    };
  }, [hasCards]);
  useEffect(() => {
    const index = lastCard.current;
    if (index === null) return;
    const frame = window.requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const cards = grid.current?.querySelectorAll<HTMLElement>("[data-card-open]") ?? [];
      (cards[Math.min(index, cards.length - 1)] ?? heading.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [shown]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-4 px-7 pt-5 pb-4">
        <div className="flex flex-1 items-baseline gap-2.5">
          <h1 ref={heading} tabIndex={-1} className="font-heading text-2xl text-navy">
            {props.heading}
          </h1>
          <span className="text-[13px] text-secondary">
            {t("library.count", { count: props.guides.length })}
          </span>
        </div>
        <label
          data-tour="search"
          className="flex h-9 w-64 items-center gap-2 rounded-lg border border-control-line bg-background px-3 text-secondary focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus"
        >
          <Icon name="search" size={16} />
          <span className="sr-only">{t("library.search")}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("library.searchPlaceholder")}
            className="min-w-0 flex-1 bg-transparent text-sm text-body outline-none placeholder:text-secondary"
          />
        </label>
        <label className="flex items-center gap-2 text-[13px] text-secondary">
          {t("library.sort")}
          <select
            value={sort}
            onChange={(event) => setSort(event.currentTarget.value as Sort)}
            className="field"
          >
            {SORTS.map((option) => (
              <option key={option} value={option}>
                {t(`library.sorts.${option}`)}
              </option>
            ))}
          </select>
        </label>
        {props.bulk && props.guides.length > 0 && (
          <button
            type="button"
            className="btn aria-pressed:border-blue aria-pressed:bg-selected"
            aria-pressed={selecting}
            onClick={() => (selecting ? clearSelection() : setSelectMode(true))}
          >
            <Icon name="check" size={16} />
            {t("library.selection.select")}
          </button>
        )}
        <button type="button" className="btn" data-tour="import" onClick={props.onImport}>
          <Icon name="upload" size={16} />
          {t("library.import")}
        </button>
      </div>

      {props.bulk && selecting && (
        <section
          aria-label={t("library.selection.label")}
          className="card mx-7 mb-3 flex flex-wrap items-center gap-2 py-2 pr-2 pl-4"
        >
          <strong className="text-sm text-navy">
            {t("library.selection.count", { count: ticked.length })}
          </strong>
          <button type="button" className="btn btn-quiet h-8 px-2" onClick={selectAll}>
            {t("library.selection.all")}
          </button>
          <button type="button" className="btn btn-quiet h-8 px-2" onClick={clearSelection}>
            {t("library.selection.clear")}
          </button>
          <span className="flex-1" />
          {props.bulk.targets.length > 0 && (
            <>
              <Menu
                label={t("library.selection.moveTo")}
                entries={[
                  { heading: t("library.selection.moveHeading") },
                  ...props.bulk.targets.map((target) => ({
                    label: target.name,
                    icon: "folder" as const,
                    onSelect: () => runTicked((guides) => props.bulk?.onMove(guides, target.id)),
                  })),
                ]}
                trigger={(trigger) => (
                  <button
                    type="button"
                    {...trigger}
                    className="btn h-8"
                    disabled={props.busy || ticked.length === 0}
                  >
                    <Icon name="folder" size={16} />
                    {t("library.selection.moveTo")}
                  </button>
                )}
              />
              <Menu
                label={t("library.selection.copyTo")}
                entries={[
                  { heading: t("library.selection.copyHeading") },
                  ...props.bulk.targets.map((target) => ({
                    label: target.name,
                    icon: "copy" as const,
                    onSelect: () => runTicked((guides) => props.bulk?.onCopy(guides, target.id)),
                  })),
                ]}
                trigger={(trigger) => (
                  <button
                    type="button"
                    {...trigger}
                    className="btn h-8"
                    disabled={props.busy || ticked.length === 0}
                  >
                    <Icon name="copy" size={16} />
                    {t("library.selection.copyTo")}
                  </button>
                )}
              />
            </>
          )}
          {props.bulk.onMerge && (
            <button
              type="button"
              className="btn h-8"
              disabled={props.busy || ticked.length < 2}
              onClick={() => runTicked((guides) => props.bulk?.onMerge?.(guides))}
            >
              <Icon name="merge" size={16} />
              {t("library.selection.merge")}
            </button>
          )}
          <Menu
            label={t("library.selection.export")}
            entries={props.bulk.exportMenu(ticked)}
            width={300}
            trigger={(trigger) => (
              <button
                type="button"
                {...trigger}
                className="btn h-8"
                disabled={props.busy || ticked.length === 0}
              >
                <Icon name="download" size={16} />
                {t("library.selection.export")}
              </button>
            )}
          />
          {props.bulk.onLock && ticked.some((guide) => !guide.locked) && (
            <button
              type="button"
              className="btn h-8"
              disabled={props.busy}
              onClick={() => runTicked((guides) => props.bulk?.onLock?.(guides))}
            >
              <Icon name="lock" size={16} />
              {t("locks.lock")}
            </button>
          )}
          {props.bulk.onRemoveLock && ticked.some((guide) => guide.locked) && (
            <button
              type="button"
              className="btn h-8"
              disabled={props.busy}
              onClick={() => runTicked((guides) => props.bulk?.onRemoveLock?.(guides))}
            >
              <Icon name="lock" size={16} />
              {t("locks.removeLock")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-danger h-8"
            disabled={props.busy || ticked.length === 0}
            onClick={() => runTicked((guides) => props.bulk?.onTrash(guides))}
          >
            <Icon name="trash" size={16} />
            {t("library.toTrash")}
          </button>
        </section>
      )}

      {props.storage && props.onExportAndRemove && (
        <div role="status" className="card mx-7 mb-3 flex items-center gap-3.5 py-3 pr-3.5 pl-4">
          <Icon name="warning" size={20} className="shrink-0 text-warning" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-sm text-navy">
              {props.storage.warning === "lowSpace"
                ? t("storage.lowSpaceTitle", {
                    free: formatBytes(freeBytes(props.storage.use) ?? 0),
                  })
                : t("storage.largeTitle", {
                    size: formatBytes(props.storage.use.libraryBytes),
                  })}
            </strong>
            <span className="text-[13px] text-secondary">{t("storage.warningBody")}</span>
          </div>
          <button type="button" className="btn" onClick={props.onExportAndRemove}>
            {t("storage.open")}
          </button>
        </div>
      )}

      {props.pending.map((pending) => (
        <div
          key={pending.sessionId}
          role="status"
          className="card mx-7 mb-3 flex items-center gap-3.5 py-3 pr-3.5 pl-4"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-recording-soft">
            <span className="size-3 rounded-full bg-recording" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <strong className="text-sm text-navy">
              {pending.savedGuideId ? t("library.pendingCleanupTitle") : t("library.pendingTitle")}
            </strong>
            <span className="truncate text-[13px] text-secondary">
              {pending.savedGuideId
                ? t("library.pendingCleanupBody", { title: pending.title })
                : pending.stepCount === null
                  ? t("library.pendingBodyNoCount", { title: pending.title })
                  : t("library.pendingBody", { title: pending.title, count: pending.stepCount })}
            </span>
          </div>
          {!pending.savedGuideId && (
            <button
              type="button"
              className="btn"
              disabled={props.busy}
              onClick={() => props.onDiscardPending(pending)}
            >
              {t("library.discard")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={props.busy}
            onClick={() => props.onReviewPending(pending)}
          >
            {pending.savedGuideId ? t("library.finishCleanup") : t("library.reviewAndSave")}
          </button>
        </div>
      ))}

      <div className="min-h-0 flex-1 overflow-y-auto px-7 pt-1 pb-6" data-tour="guides">
        {props.loading ? (
          <p className="py-10 text-center text-secondary">{t("library.loading")}</p>
        ) : props.access ? (
          <div className="card mx-auto mt-6 flex max-w-lg flex-col items-center gap-3 px-8 py-10 text-center">
            <Icon name="folder" size={28} className="text-link" />
            <h2 className="font-heading text-lg text-navy">
              {t("library.access.title", { folder: props.access.folder })}
            </h2>
            <p className="text-secondary">{t("library.access.body")}</p>
            <button type="button" className="btn btn-primary mt-2" onClick={props.access.onAllow}>
              {t("library.access.button")}
            </button>
          </div>
        ) : props.guides.length === 0 ? (
          <div className="card mx-auto mt-6 flex max-w-lg flex-col items-center gap-3 px-8 py-10 text-center">
            <h2 className="font-heading text-lg text-navy">{t("library.empty.title")}</h2>
            <p className="text-secondary">{t("library.empty.body")}</p>
            <button type="button" className="btn btn-primary mt-2" onClick={props.onNewRecording}>
              <span className="size-2.5 rounded-full bg-white" />
              {t("nav.newRecording")}
            </button>
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-secondary">{t("library.noMatches")}</p>
        ) : (
          <ul ref={grid} className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
            {shown.map((guide, index) => {
              const isTicked = selected.has(guide.id);
              return (
                <li
                  key={guide.id}
                  className={`group card relative flex flex-col overflow-hidden ${isTicked ? "outline-2 outline-offset-2 outline-blue" : ""}`}
                  data-card-index={index}
                >
                  {props.bulk && (
                    <label
                      className={`absolute top-2 left-2 z-10 flex size-7 items-center justify-center rounded-md border border-line bg-background shadow-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--amluto-focus)] ${selecting ? "" : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"}`}
                    >
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={isTicked}
                        aria-label={t("library.selection.tick", { title: guide.title })}
                        onChange={(event) => {
                          if ((event.nativeEvent as globalThis.MouseEvent).shiftKey)
                            tickRange(guide.id);
                          else toggle(guide.id);
                        }}
                      />
                    </label>
                  )}
                  <button
                    type="button"
                    data-card-open
                    // Ringed inside: the card clips anything outside it, which left a thin line (F062).
                    className="flex flex-col rounded-[inherit] text-left focus-visible:outline-offset-[-3px]"
                    onClick={(event) => clickCard(event, guide)}
                    aria-label={
                      selecting
                        ? t("library.selection.tick", { title: guide.title })
                        : t("library.openGuide", { title: guide.title })
                    }
                    aria-pressed={selecting ? isTicked : undefined}
                  >
                    <span className="flex h-[120px] items-center justify-center overflow-hidden bg-subtle">
                      <GuideThumbnail guide={guide} load={props.loadThumbnail} />
                    </span>
                    <span className="line-clamp-2 h-[52px] px-3.5 pt-2.5 text-[15px] leading-snug font-semibold text-navy">
                      {guide.title}
                    </span>
                    <FoundIn found={hits?.get(guide.id) ?? null} />
                  </button>
                  <div className="flex items-center gap-1.5 py-2 pr-1.5 pl-3.5 text-xs text-secondary">
                    <span className="shrink-0 whitespace-nowrap">
                      {t("library.steps", { count: guide.stepCount })}
                      {guide.sizeBytes !== undefined && ` · ${formatBytes(guide.sizeBytes)}`}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 flex-1 truncate">
                      {formatUpdated(guide.updatedAt, t)}
                    </span>
                    {needsReview(guide) && (
                      <span className="chip bg-warning-soft text-warning">
                        {t("library.needsReview")}
                      </span>
                    )}
                    {(guide.openComments ?? 0) > 0 && (
                      <span
                        className="chip shrink-0 gap-1"
                        title={t("comments.openCount", { count: guide.openComments })}
                      >
                        <Icon name="comment" size={12} />
                        <span className="sr-only">
                          {t("comments.openCount", { count: guide.openComments })}
                        </span>
                        <span aria-hidden="true">{guide.openComments}</span>
                      </span>
                    )}
                    {guide.locked && (
                      <span className="chip shrink-0" title={lockedBy(guide.locked)}>
                        <Icon name="lock" size={12} />
                        <span className="sr-only">{lockedBy(guide.locked)}</span>
                      </span>
                    )}
                    {guide.tags[0] && (
                      <span className="chip max-w-20 truncate">{guide.tags[0]}</span>
                    )}
                    <Menu
                      label={t("export.menu")}
                      entries={props.exportMenu(guide)}
                      width={300}
                      trigger={(trigger) => (
                        <button
                          type="button"
                          {...trigger}
                          title={t("export.button")}
                          data-tour="export"
                          aria-label={t("export.guide", { title: guide.title })}
                          className="icon-btn size-8 border border-line text-link"
                        >
                          <Icon name="download" size={16} />
                        </button>
                      )}
                    />
                    <Menu
                      label={t("library.guideActions")}
                      entries={props.guideMenu(guide)}
                      trigger={(trigger) => (
                        <button
                          type="button"
                          {...trigger}
                          aria-label={t("library.guideActionsFor", { title: guide.title })}
                          className="icon-btn size-8"
                        >
                          <Icon name="more" size={18} strokeWidth={3} />
                        </button>
                      )}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
