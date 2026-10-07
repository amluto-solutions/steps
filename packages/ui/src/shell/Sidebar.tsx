import { useTranslation } from "react-i18next";

import { Icon, type IconName } from "../components/icons";
import { StepsLogo } from "./StepsLogo";
import type { LibraryInfo } from "../library-bridge";

export type LibraryView =
  | { kind: "all" }
  | { kind: "recent" }
  | { kind: "review" }
  | { kind: "locked" }
  | { kind: "tag"; tag: string }
  | { kind: "trash" };

interface SidebarProps {
  libraries: LibraryInfo[];
  libraryId: string | null;
  onLibrary: (id: string) => void;
  view: LibraryView | null;
  onView: (view: LibraryView) => void;
  tags: { name: string; count: number }[];
  guideCount: number;
  /** Guides past their review-by date. */
  reviewCount: number;
  /** Guides locked with a password (04/10/2026). */
  lockedCount?: number;
  canRecord: boolean;
  recordHint: string | null;
  /**
   * While a recording runs: Pause or Resume, and Stop, here as well as on the recording bar,
   * which may be hidden or out of reach (F002).
   */
  recordingControls?: { paused: boolean; onPause: () => void; onStop: () => void } | null;
  onRecord: () => void;
  onSettings: () => void;
  settingsActive: boolean;
}

function NavButton({
  icon,
  label,
  count,
  active,
  onClick,
  tour,
}: {
  icon: IconName;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  /** What the product tour points at here. */
  tour?: string;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      data-tour={tour}
      onClick={onClick}
      className={`flex h-[38px] items-center gap-2.5 rounded-lg px-2.5 text-left text-sm ${active ? "bg-sidebar-active font-semibold text-white" : "text-sidebar-text hover:bg-white/5"}`}
    >
      <Icon name={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="text-xs font-normal text-sidebar-muted">{count}</span>
      )}
    </button>
  );
}

/** The app's navy sidebar: New recording first, then the library, with Settings at the bottom. */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const isView = (kind: LibraryView["kind"], tag?: string) =>
    props.view?.kind === kind &&
    (kind !== "tag" || (props.view.kind === "tag" && props.view.tag === tag));

  return (
    <nav
      aria-label={t("nav.main")}
      className="flex w-[216px] shrink-0 flex-col gap-5 overflow-y-auto bg-sidebar px-3.5 py-5 text-white"
    >
      <span className="mx-1.5 self-start">
        <StepsLogo />
      </span>
      <div className="flex flex-col gap-1">
        <button
          type="button"
          data-tour="record"
          onClick={props.onRecord}
          disabled={!props.canRecord}
          className="flex h-[46px] items-center justify-center gap-2.5 rounded-xl bg-white text-[15px] font-bold text-brand-navy hover:bg-white/90 disabled:opacity-60"
        >
          <span className="size-3 rounded-full bg-highlight" aria-hidden="true" />
          {t("nav.newRecording")}
        </button>
        {props.recordHint && (
          <span className="px-1 text-center text-xs text-sidebar-muted">{props.recordHint}</span>
        )}
        {props.recordingControls && (
          <div className="flex gap-2">
            <button
              type="button"
              className="btn h-9 flex-1 justify-center px-2"
              onClick={props.recordingControls.onPause}
            >
              <Icon name={props.recordingControls.paused ? "play" : "pause"} size={15} />
              {props.recordingControls.paused ? t("recorder.resume") : t("recorder.pause")}
            </button>
            <button
              type="button"
              className="btn btn-dark h-9 flex-1 justify-center px-2"
              onClick={props.recordingControls.onStop}
            >
              <Icon name="stop" size={15} />
              {t("recorder.stop")}
            </button>
          </div>
        )}
      </div>

      {props.libraries.length > 1 && (
        <label className="flex flex-col gap-1 text-xs font-bold tracking-wider text-sidebar-muted">
          <span className="px-2.5">{t("nav.library").toUpperCase()}</span>
          <select
            value={props.libraryId ?? ""}
            onChange={(event) => props.onLibrary(event.currentTarget.value)}
            className="h-9 rounded-lg border border-white/15 bg-white/5 px-2 text-sm font-normal tracking-normal text-white"
          >
            {props.libraries.map((library) => (
              // The open list is drawn by the system: both colours from the theme, or dark-theme
              // text lands on a white list (06/10/2026: the other libraries were nearly invisible).
              <option key={library.id} value={library.id} className="bg-background text-body">
                {library.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* The views and the tags under them, together, for the product tour. */}
      <div className="flex flex-col gap-5" data-tour="views">
        <div className="flex flex-col gap-0.5">
          <NavButton
            icon="grid"
            label={t("nav.allGuides")}
            count={props.guideCount}
            active={isView("all")}
            onClick={() => props.onView({ kind: "all" })}
          />
          <NavButton
            icon="clock"
            label={t("nav.recent")}
            active={isView("recent")}
            onClick={() => props.onView({ kind: "recent" })}
          />
          {props.reviewCount > 0 && (
            <NavButton
              icon="warning"
              label={t("nav.needsReview")}
              count={props.reviewCount}
              active={isView("review")}
              onClick={() => props.onView({ kind: "review" })}
            />
          )}
          {(props.lockedCount ?? 0) > 0 && (
            <NavButton
              icon="lock"
              label={t("locks.filter")}
              count={props.lockedCount ?? 0}
              active={isView("locked")}
              onClick={() => props.onView({ kind: "locked" })}
            />
          )}
        </div>

        {props.tags.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 text-[11px] font-bold tracking-wider text-sidebar-muted">
              {t("nav.tags").toUpperCase()}
            </div>
            {props.tags.map((tag) => (
              <NavButton
                key={tag.name}
                icon="tag"
                label={tag.name}
                count={tag.count}
                active={isView("tag", tag.name)}
                onClick={() => props.onView({ kind: "tag", tag: tag.name })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex-1" />
      <div className="flex flex-col gap-0.5 border-t border-white/15 pt-3">
        <NavButton
          icon="trash"
          tour="bin"
          label={t("nav.trash")}
          active={isView("trash")}
          onClick={() => props.onView({ kind: "trash" })}
        />
        <NavButton
          icon="settings"
          tour="settings"
          label={t("nav.settings")}
          active={props.settingsActive}
          onClick={props.onSettings}
        />
      </div>
    </nav>
  );
}
