import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LibraryGuideSummary } from "../library-bridge";
import { ModalDialog } from "../ModalDialog";
import { formatDate } from "./dates";
import { formatBytes } from "./storage";

/**
 * "Export and remove" (Steps for Chrome, docs/spec/03-data-and-sharing.md#chrome-edition-storage):
 * guides chosen here are saved as `.amlsteps` files in one folder, each checked before it leaves
 * the browser. Least recently edited first, since those are the likeliest to go.
 */
export function ExportAndRemoveDialog(props: {
  guides: LibraryGuideSummary[];
  /** "Exporting 2 of 5…" while it runs; null otherwise. */
  progress: { done: number; total: number } | null;
  onCancel: () => void;
  onExport: (guideIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const guides = useMemo(
    () => [...props.guides].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
    [props.guides],
  );
  const freed = guides
    .filter((guide) => chosen.has(guide.id))
    .reduce((sum, guide) => sum + (guide.sizeBytes ?? 0), 0);
  const working = props.progress !== null;
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-[850] grid place-items-center bg-scrim/55 p-6">
      <ModalDialog
        labelledBy="export-remove-title"
        describedBy="export-remove-help"
        onEscape={() => {
          // Halfway through, closing would hide which guides have gone.
          if (!working) props.onCancel();
        }}
        className="card flex max-h-[85vh] w-full max-w-xl flex-col gap-4 p-6"
      >
        <h2 id="export-remove-title" className="font-heading text-xl text-navy">
          {t("storage.dialogTitle")}
        </h2>
        <p id="export-remove-help" className="text-sm text-secondary">
          {t("storage.dialogHelp")}
        </p>
        {/* A div, not a fieldset: Chrome won't clip a fieldset that shrinks in a flex column. */}
        <div
          role="group"
          aria-label={t("storage.choose")}
          className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-panel"
        >
          {guides.map((guide) => (
            <label
              key={guide.id}
              className="flex cursor-pointer items-center gap-3 border-b border-panel px-3 py-2.5 text-sm last:border-b-0 hover:bg-subtle"
            >
              <input
                type="checkbox"
                checked={chosen.has(guide.id)}
                disabled={working}
                onChange={() => toggle(guide.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-navy">{guide.title}</span>
                <span className="text-xs text-secondary">
                  {t("storage.edited", { date: formatDate(new Date(guide.updatedAt)) })}
                </span>
              </span>
              <span className="shrink-0 text-xs text-secondary tabular-nums">
                {formatBytes(guide.sizeBytes ?? 0)}
              </span>
            </label>
          ))}
        </div>
        <p role="status" className="text-sm text-secondary">
          {working
            ? t("storage.working", {
                done: (props.progress?.done ?? 0) + 1,
                total: props.progress?.total ?? 0,
              })
            : chosen.size > 0
              ? t("storage.frees", { count: chosen.size, size: formatBytes(freed) })
              : t("storage.noneChosen")}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" disabled={working} onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={working || chosen.size === 0}
            onClick={() => props.onExport(guides.filter((g) => chosen.has(g.id)).map((g) => g.id))}
          >
            {chosen.size > 0
              ? t("storage.export", { count: chosen.size })
              : t("storage.exportNone")}
          </button>
        </div>
      </ModalDialog>
    </div>
  );
}
