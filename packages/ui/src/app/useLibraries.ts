import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ToastMessage } from "../components/Toast";
import { errorCode, errorMessage } from "../errors";
import type {
  Bin,
  GuideFiles,
  Libraries,
  LibraryGuideSummary,
  LibraryInfo,
  TrashEntry,
  StorageUse,
} from "../library-bridge";

/** The libraries, the one being shown, and its guides and Bin. */
export function useLibraries(
  library: (Libraries & GuideFiles & Bin) | undefined,
  loadingAtStart: boolean,
  notify: (message: Omit<ToastMessage, "id">) => void,
) {
  const { t } = useTranslation();
  const [libraries, setLibraries] = useState<LibraryInfo[]>([]);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [guides, setGuides] = useState<LibraryGuideSummary[]>([]);
  const [guidesLoading, setGuidesLoading] = useState(loadingAtStart);
  const [trash, setTrash] = useState<TrashEntry[]>([]);
  /** Steps for Chrome: what the library takes in browser storage; null elsewhere. */
  const [storage, setStorage] = useState<StorageUse | null>(null);

  const refreshGuides = useCallback(
    async (id: string | null) => {
      if (!library || !id) {
        setGuides([]);
        setGuidesLoading(false);
        return;
      }
      try {
        const [nextGuides, nextTrash] = await Promise.all([
          library.listGuides(id),
          library.listTrash(id),
        ]);
        setGuides(nextGuides);
        setTrash(nextTrash);
        if (library.storageUse) setStorage(await library.storageUse(id).catch(() => null));
      } catch (problem) {
        // A folder the browser needs permission for again says so on the page, with a button.
        if (errorCode(problem) === "folderAccess") {
          setGuides([]);
          setTrash([]);
        } else notify({ kind: "error", text: errorMessage(problem, t("library.loadFailed")) });
      } finally {
        setGuidesLoading(false);
      }
    },
    [library, notify, t],
  );

  /** Lists the libraries again and shows `preferred`, else the default; returns the one shown. */
  const refreshLibraries = useCallback(
    async (preferred?: string | null) => {
      if (!library) {
        setGuidesLoading(false);
        return null;
      }
      const list = await library.listLibraries();
      setLibraries(list);
      const chosen =
        list.find((item) => item.id === preferred)?.id ??
        list.find((item) => item.isDefault)?.id ??
        list[0]?.id ??
        null;
      setLibraryId(chosen);
      await refreshGuides(chosen);
      return chosen;
    },
    [library, refreshGuides],
  );

  const showLibrary = useCallback(
    (id: string) => {
      setLibraryId(id);
      setGuidesLoading(true);
      void refreshGuides(id);
    },
    [refreshGuides],
  );

  /** The default library's id, or the one shown when there's no default. */
  const defaultLibraryId = libraries.find((entry) => entry.isDefault)?.id ?? libraryId;

  return {
    libraries,
    libraryId,
    defaultLibraryId,
    guides,
    guidesLoading,
    trash,
    storage,
    refreshGuides,
    refreshLibraries,
    showLibrary,
  };
}
