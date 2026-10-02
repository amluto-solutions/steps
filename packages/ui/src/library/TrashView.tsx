import { useTranslation } from "react-i18next";

import type { TrashEntry } from "../library-bridge";
import { formatDate } from "./dates";

/**
 * The Bin: guides removed from the library, each with Restore and Delete for good, and Empty Bin
 * for all of them. Deleting for good is asked about first, by the caller.
 */
export function TrashView(props: {
  trash: TrashEntry[];
  busy: boolean;
  onRestore: (entry: TrashEntry) => void;
  onDeleteForGood: (entry: TrashEntry) => void;
  onEmpty: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col px-7 py-5">
      <div className="mb-1 flex items-center gap-3">
        <h1 className="min-w-0 flex-1 font-heading text-2xl text-navy">{t("nav.trash")}</h1>
        {props.trash.length > 0 && (
          <button type="button" className="btn h-8" disabled={props.busy} onClick={props.onEmpty}>
            {t("library.emptyTrash")}
          </button>
        )}
      </div>
      <p className="mb-4 text-sm text-secondary">{t("library.trashHelp")}</p>
      {props.trash.length === 0 ? (
        <p className="py-10 text-center text-secondary">{t("library.trashEmpty")}</p>
      ) : (
        <ul className="card flex flex-col">
          {props.trash.map((entry, index) => (
            <li
              key={entry.trashId}
              className={`flex flex-wrap items-center gap-3 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <span className="min-w-0 flex-1 truncate font-semibold text-navy">{entry.title}</span>
              <span className="text-xs text-secondary">
                {formatDate(new Date(entry.deletedAt))}
              </span>
              <button
                type="button"
                className="btn h-8"
                disabled={props.busy}
                onClick={() => props.onRestore(entry)}
              >
                {t("library.restore")}
              </button>
              <button
                type="button"
                className="btn h-8"
                disabled={props.busy}
                aria-label={t("library.deleteForGoodNamed", { title: entry.title })}
                onClick={() => props.onDeleteForGood(entry)}
              >
                {t("library.deleteForGood")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
