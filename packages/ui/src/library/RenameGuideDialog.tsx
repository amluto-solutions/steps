import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModalDialog } from "../ModalDialog";

/** A guide title's limit in guide.json (packages/core/src/guide.ts). */
const MAX_TITLE = 300;

/**
 * Rename, from a guide card's menu in the library (30/09/2026): the title only, so there's
 * no need to open the guide for it.
 */
export function RenameGuideDialog(props: {
  title: string;
  onRename: (title: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(props.title);
  const input = useRef<HTMLInputElement>(null);
  const trimmed = title.trim();
  const save = () => {
    if (!trimmed || trimmed === props.title) {
      props.onCancel();
      return;
    }
    props.onRename(trimmed);
  };
  return (
    <div className="fixed inset-0 z-[850] grid place-items-center bg-scrim/55 p-6">
      <ModalDialog
        labelledBy="rename-guide-title"
        initialFocus={input}
        onEscape={props.onCancel}
        className="card flex w-full max-w-md flex-col gap-4 p-6"
      >
        <h2 id="rename-guide-title" className="font-heading text-xl text-navy">
          {t("library.renameTitle")}
        </h2>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-navy">
            {t("library.renameLabel")}
            <input
              ref={input}
              value={title}
              maxLength={MAX_TITLE}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onFocus={(event) => event.currentTarget.select()}
              className="field font-normal"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={props.onCancel}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!trimmed}>
              {t("library.renameSave")}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
