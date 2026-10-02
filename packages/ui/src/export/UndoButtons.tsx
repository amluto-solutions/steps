import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";

/** Undo and Redo for changes made in the review and its quick fixes (30/09/2026). */
export function UndoButtons(props: {
  undo: (() => void) | undefined;
  redo: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        className="icon-btn"
        aria-label={t("common.undo")}
        title={t("export.undoHint")}
        disabled={!props.undo}
        onClick={props.undo}
      >
        <Icon name="undo" />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label={t("common.redo")}
        title={t("export.redoHint")}
        disabled={!props.redo}
        onClick={props.redo}
      >
        <Icon name="redo" />
      </button>
    </span>
  );
}
