import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { AnnouncerProvider, useAnnounce } from "./components/Announcer";
import { isBrowserEdition, isLinux } from "./recorder-bridge";
import { Icon } from "./components/icons";
import type { MenuEntry } from "./components/Menu";
import { Toast, type ToastMessage } from "./components/Toast";
import type { EditorDoc } from "./editor/document";
import { toDoc, type GuideRef } from "./app/documents";
import { guidesInView, needsReview, readRecent, rememberRecent, tagCounts } from "./library/views";
import { RenameGuideDialog } from "./library/RenameGuideDialog";
import { ExportAndRemoveDialog } from "./library/ExportAndRemoveDialog";
import { MergeDialog, type MergeChoice } from "./library/MergeDialog";
import { storageWarning } from "./library/storage";
import { AnyGuideEditor } from "./app/LibraryGuideEditor";
import { useLibraryWatch } from "./app/useLibraryWatch";
import type { GuideStore } from "./editor/useGuideEditor";
import { errorMessage } from "./errors";
import type { LibraryBridge, TrashEntry, VersionInfo } from "./library-bridge";
import { LibraryHome } from "./library/LibraryHome";
import { TrashView } from "./library/TrashView";
import { useBrands } from "./app/useBrands";
import { useLibraries } from "./app/useLibraries";
import { useSettings } from "./app/useSettings";
import { useSettingsTransfer } from "./app/useSettingsTransfer";
import { useRecordingSession } from "./app/useRecordingSession";
import {
  ConfirmDialog,
  DiscardDialog,
  NoticeDialog,
  StartRecordingDialog,
  VersionsDialog,
} from "./app/dialogs";
import { draftStore, libraryStore } from "./app/stores";
import { useBulkActions } from "./app/useBulkActions";
import { useExports } from "./app/useExports";
import { useShortcutWarning } from "./app/useShortcutWarning";
import { useLink } from "./app/useLink";
import { useUpdates } from "./app/useUpdates";
import { AskHost, askConfirm, askText } from "./app/ask";
import { moveGuide } from "./app/move";
import { setPeopleNames } from "./editor/suggestions";
import type { RecorderBridge } from "./recorder-bridge";
import { SettingsView, type SettingsSection } from "./settings/SettingsView";
import { isManaged, policy } from "./settings/policy";
import { readStorageWarnGb } from "./settings/preferences";
import { Sidebar, type LibraryView } from "./shell/Sidebar";
import { Welcome, type WelcomeChoices } from "./shell/Welcome";
import { TourProvider } from "./tour/TourProvider";
import { startTourAfterWelcome } from "./tour/store";
import { APP_VERSION } from "./version";

export { errorMessage } from "./errors";

export { RecorderBar } from "./recorder/RecorderBar";
export { ShortcutPopup, shortcutKeyName } from "./recorder/ShortcutPopup";

type EditorTarget =
  | { kind: "guide"; libraryId: string; doc: EditorDoc; key: string }
  | { kind: "draft"; sessionId: string; doc: EditorDoc; key: string };

type Route =
  | { screen: "library"; view: LibraryView }
  | { screen: "editor"; target: EditorTarget }
  | { screen: "settings"; section: SettingsSection };

interface AppProps {
  recorder?: RecorderBridge;
  library?: LibraryBridge;
}

/** The app, with the window's one live region for announcements. */
export function App(props: AppProps) {
  return (
    <AnnouncerProvider>
      <AppContent {...props} />
    </AnnouncerProvider>
  );
}

function AppContent({ recorder, library }: AppProps) {
  const { t } = useTranslation();
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [route, setRoute] = useState<Route>({ screen: "library", view: { kind: "all" } });
  const [versionsFor, setVersionsFor] = useState<(GuideRef & { versions: VersionInfo[] }) | null>(
    null,
  );
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  // Said once as work starts; a status element added with its words already in is often missed.
  useEffect(() => {
    if (busy) announce(t("common.working"));
  }, [busy, announce, t]);
  const notify = useCallback(
    (message: Omit<ToastMessage, "id">) => setToast({ ...message, id: Date.now() }),
    [],
  );
  const closeToast = useCallback(() => setToast(null), []);
  // Started again while open (F001): this copy came forward, and says why.
  const [alreadyOpen, setAlreadyOpen] = useState(false);
  useEffect(() => {
    const stop = recorder?.onAlreadyOpen?.(() => setAlreadyOpen(true));
    return () => void stop?.then((unlisten) => unlisten());
  }, [recorder]);

  const settings = useSettings(recorder, notify);
  const {
    preferences,
    setPreferences,
    author,
    autoStart,
    setAutoStart,
    choices,
    updateChoices,
    theme,
    allBlurTerms,
  } = settings;

  // The person's own names, so screenshots showing them get suggested for blurring (F006).
  useEffect(() => {
    void (recorder?.identityNames?.() ?? Promise.resolve([]))
      .catch(() => [])
      .then((names) => setPeopleNames([...names, author]));
  }, [recorder, author]);
  const libraryState = useLibraries(library, recorder !== undefined, notify);
  const {
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
  } = libraryState;
  const brandState = useBrands(recorder, theme);
  const {
    brands,
    refreshBrands,
    managedBrandIds,
    syncManagedBrands,
    appColours,
    chooseAppColours,
  } = brandState;

  const openLibraryGuide = async ({ libraryId: id, guideId }: GuideRef) => {
    if (!library) return;
    const doc = toDoc(await library.loadGuide(id, guideId));
    setRecent((current) => rememberRecent(current, id, guideId));
    setRoute({
      screen: "editor",
      target: { kind: "guide", libraryId: id, doc, key: `${id}/${guideId}:${Date.now()}` },
    });
  };

  // ----- The recording session -----

  const session = useRecordingSession({
    recorder,
    notify,
    settings,
    setBusy,
    showDraft: (sessionId, doc) =>
      setRoute({
        screen: "editor",
        target: { kind: "draft", sessionId, doc, key: `draft:${sessionId}:${Date.now()}` },
      }),
    showGuides: () => setRoute({ screen: "library", view: { kind: "all" } }),
    openSaved: async (guideId, savedTo) => {
      const target = (await refreshLibraries(savedTo ?? defaultLibraryId)) ?? libraryId;
      if (target) await openLibraryGuide({ libraryId: target, guideId });
    },
    // Everything else start-up needs from the recorder, once it answers.
    // The libraries and brands, once the recorder is set up.
    onConnected: async () => {
      await Promise.all([refreshLibraries(), refreshBrands()]);
      await syncManagedBrands();
    },
  });
  const {
    snapshot,
    setSnapshot,
    monitors,
    recording,
    hasPending,
    pending,
    fatal,
    refreshRecoveries,
    requestRecording,
    startRecording,
    reviewPending,
    saveDraft,
    startOpen,
    closeStart,
    discardTarget,
    setDiscardTarget,
    discard,
  } = session;
  const recordHint = recording ? t("nav.recordingNow") : hasPending ? t("nav.saveFirst") : null;

  // ----- Guide actions -----

  const run = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) notify({ text: done });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) });
    } finally {
      setBusy(false);
    }
  };

  const bulk = useBulkActions({
    library,
    libraryId,
    libraries,
    refreshGuides,
    notify,
    setBusy,
    author,
    openGuide: (id, guideId) => void run(() => openLibraryGuide({ libraryId: id, guideId })),
  });
  /** Merge guides: the guides chosen so far, while its dialog is open. */
  const [merging, setMerging] = useState<MergeChoice[] | null>(null);
  const listGuidesIn = useCallback(
    (id: string) => (library ? library.listGuides(id) : Promise.resolve([])),
    [library],
  );

  const {
    exportMenu,
    exportManyMenu,
    dialog: exportDialog,
  } = useExports({
    recorder,
    library,
    notify,
    run,
    author,
    brands,
    blurTerms: allBlurTerms,
    saveDraft: (sessionId, flush, doc) => saveDraft(sessionId, flush, doc, true),
  });

  const trashGuide = async ({ libraryId: id, guideId }: GuideRef, title: string) => {
    if (!library) return;
    try {
      const entry = await library.trashGuide(id, guideId);
      await refreshGuides(id);
      notify({
        text: t("library.trashed", { title }),
        action: {
          label: t("common.undo"),
          run: () =>
            void run(async () => {
              await library.restoreGuide(id, entry.trashId);
              await refreshGuides(id);
            }),
        },
      });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("library.actionFailed")) });
    }
  };

  /**
   * "Apply blur permanently": burns the blur into the screenshots, in the guide and its saved
   * versions, and deletes the originals (docs/spec/03-data-and-sharing.md). It can't be undone, so
   * it asks first. From the editor, pending edits are saved first and the guide is reopened after,
   * since the open copy still points at the originals.
   */
  const applyBlurPermanently = async (
    ref: GuideRef,
    title: string,
    flush?: () => Promise<void>,
  ) => {
    if (!library) return;
    const sure = await askConfirm(
      t("library.applyBlurTitle"),
      t("library.applyBlurConfirm", { title }),
      t("library.applyBlurYes"),
    );
    if (!sure) return;
    await run(async () => {
      if (flush) await flush();
      try {
        const changed = await library.applyRedactions(ref.libraryId, ref.guideId);
        notify({
          text: changed ? t("library.blurApplied", { count: changed }) : t("library.noBlurToApply"),
        });
      } finally {
        // Even when it stopped part-way, steps on disk may now show the blurred copies: the
        // editor reloads so it never saves a step back onto an original.
        if (flush) await openLibraryGuide(ref).catch(() => undefined);
      }
    });
  };

  /**
   * Steps for Chrome, "Export and remove": one folder is asked for, then each guide is saved there
   * and checked before it leaves the browser. It stops at the first that fails, which stays.
   */
  const [exportRemove, setExportRemove] = useState<{
    progress: { done: number; total: number } | null;
  } | null>(null);
  const exportAndRemove = async (ids: string[]) => {
    if (!library?.exportAndRemove || !library.pickExportFolder || !libraryId) return;
    const folder = await library.pickExportFolder(t("storage.folderTitle"));
    if (!folder) {
      notify({ text: t("storage.noFolder") });
      return;
    }
    let done = 0;
    let failed: { title: string; problem: unknown } | null = null;
    for (const id of ids) {
      setExportRemove({ progress: { done, total: ids.length } });
      try {
        await library.exportAndRemove(libraryId, id, folder);
        done += 1;
      } catch (problem) {
        failed = { title: guides.find((guide) => guide.id === id)?.title ?? "", problem };
        break;
      }
    }
    setExportRemove(null);
    await refreshGuides(libraryId);
    notify(
      failed
        ? {
            kind: "error",
            text: t("storage.failed", {
              count: done,
              title: failed.title,
              reason: errorMessage(failed.problem, t("library.actionFailed")),
            }),
          }
        : { text: t("storage.done", { count: done }) },
    );
  };

  /** Something that can't be undone, waiting for the person to confirm it. */
  const [confirming, setConfirming] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    run: () => Promise<void>;
  } | null>(null);

  /** Delete for good, from the Bin: asked about first, as it can't be undone. */
  const deleteForGood = (entry: TrashEntry) => {
    if (!library || !libraryId) return;
    setConfirming({
      title: t("library.deleteForGoodTitle", { title: entry.title }),
      body: t("library.deleteForGoodBody"),
      confirmLabel: t("library.deleteForGood"),
      run: () =>
        run(
          async () => {
            try {
              await library.deleteTrashed(libraryId, entry.trashId);
            } finally {
              await refreshGuides(libraryId);
            }
          },
          t("library.deletedForGood", { title: entry.title }),
        ),
    });
  };

  const emptyTrash = () => {
    if (!library || !libraryId || trash.length === 0) return;
    setConfirming({
      title: t("library.emptyTrashTitle"),
      body: t("library.emptyTrashBody", { count: trash.length }),
      confirmLabel: t("library.emptyTrash"),
      run: () =>
        run(async () => {
          try {
            const count = await library.emptyTrash(libraryId);
            notify({ text: t("library.trashEmptied", { count }) });
          } finally {
            // Some may have gone even if one couldn't: the list shows what's left.
            await refreshGuides(libraryId);
          }
        }),
    });
  };

  /** A guide being renamed from its card in the library. */
  const [renaming, setRenaming] = useState<{ ref: GuideRef; title: string } | null>(null);
  /** Rename from a card: under the guide's edit lock, as any change to it is. */
  const renameGuide = (ref: GuideRef, title: string) => {
    if (!library) return;
    setRenaming(null);
    void run(async () => {
      const editing = await library.openForEditing(ref.libraryId, ref.guideId, false);
      if (editing.kind === "readOnly") {
        notify({ kind: "error", text: t("library.renameLocked", { name: editing.lock.name }) });
        return;
      }
      try {
        const { guide } = toDoc(await library.loadGuide(ref.libraryId, ref.guideId));
        await library.saveGuide(ref.libraryId, ref.guideId, {
          ...guide,
          title,
          updatedAt: new Date().toISOString(),
          updatedBy: author,
        });
      } finally {
        await library.releaseLock(ref.libraryId, ref.guideId).catch(() => undefined);
      }
      await refreshGuides(ref.libraryId);
      notify({ text: t("library.renamed", { title }) });
    });
  };

  const guideMenu = (ref: GuideRef, title: string, flush?: () => Promise<void>): MenuEntry[] => {
    if (!library) return [];
    const { libraryId: id, guideId } = ref;
    const others = libraries.filter((item) => item.id !== id);
    return [
      {
        label: t("library.open"),
        icon: "note",
        onSelect: () => void run(() => openLibraryGuide(ref)),
      },
      // In the editor the title is changed in place (and the editor holds the guide's lock).
      ...(flush
        ? []
        : [
            {
              label: t("library.rename"),
              icon: "text" as const,
              onSelect: () => setRenaming({ ref, title }),
            },
          ]),
      {
        label: t("library.duplicate"),
        icon: "copy",
        onSelect: () =>
          void run(async () => {
            await library.duplicateGuide(id, guideId, t("library.copyTitle", { title }));
            await refreshGuides(id);
          }, t("library.duplicated")),
      },
      ...others.flatMap((other): MenuEntry[] => [
        {
          label: t("library.copyTo", { name: other.name }),
          note: t("library.copyNote"),
          icon: "copy" as const,
          onSelect: () =>
            void run(
              () => library.copyGuide(id, guideId, other.id),
              t("library.copied", { name: other.name }),
            ),
        },
        {
          label: t("library.moveTo", { name: other.name }),
          icon: "folder" as const,
          onSelect: () =>
            void run(async () => {
              const moved = await moveGuide(library, id, guideId, other.id);
              await refreshGuides(id);
              // As a move of several guides can be undone, so can a move of one (F053).
              notify({
                text: t("library.moved", { name: other.name }),
                action: {
                  label: t("common.undo"),
                  run: () =>
                    void run(async () => {
                      await moveGuide(library, other.id, moved.id, id);
                      await refreshGuides(id);
                    }),
                },
              });
            }),
        },
      ]),
      {
        label: t("merge.menu"),
        icon: "merge",
        onSelect: () =>
          setMerging([
            {
              libraryId: id,
              guide: guides.find((guide) => guide.id === guideId) ?? {
                id: guideId,
                title,
                updatedAt: "",
                stepCount: 0,
                tags: [],
                owner: "",
                reviewBy: null,
                thumbnailMediaId: null,
              },
            },
          ]),
      },
      {
        label: t("library.applyBlur"),
        icon: "blur",
        onSelect: () => void applyBlurPermanently(ref, title, flush),
      },
      "divider",
      {
        label: t("library.toTrash"),
        icon: "trash",
        danger: true,
        onSelect: () => void trashGuide(ref, title),
      },
    ];
  };

  const importAmlsteps = async () => {
    if (!library || !libraryId) return;
    const path = await library.pickFile(t("library.importTitle"), [
      { name: t("export.amlsteps.filter"), extensions: ["amlsteps"] },
    ]);
    if (!path) return;
    await run(async () => {
      const before = new Set((await library.listGuides(libraryId)).map((guide) => guide.title));
      const summary = await library.importAmlsteps(libraryId, path);
      // Two cards with one title, and no telling which is new (F045): the import says so.
      let title = summary.title;
      if (before.has(title)) {
        title = t("library.importedTitle", { title });
        await library.openForEditing(libraryId, summary.id, false);
        try {
          const { guide } = toDoc(await library.loadGuide(libraryId, summary.id));
          await library.saveGuide(libraryId, summary.id, { ...guide, title });
        } finally {
          await library.releaseLock(libraryId, summary.id).catch(() => undefined);
        }
      }
      await refreshGuides(libraryId);
      notify({
        text: t("library.imported", { title }),
        action: {
          label: t("library.open"),
          run: () => void openLibraryGuide({ libraryId, guideId: summary.id }),
        },
      });
    });
  };

  const openVersions = async (ref: GuideRef, flush: () => Promise<void>) => {
    if (!library) return;
    await run(async () => {
      await flush();
      setVersionsFor({ ...ref, versions: await library.listVersions(ref.libraryId, ref.guideId) });
    });
  };

  // ----- Settings -----

  const { exportSettings, importSettings, backUpAll, restoreBackup } = useSettingsTransfer({
    recorder,
    library,
    notify,
    run,
    settings,
    brands: brandState,
    libraries: libraryState,
  });

  const finishWelcome = async (welcome: WelcomeChoices) => {
    if (!recorder || !preferences) return;
    setBusy(true);
    setWelcomeError(null);
    try {
      let folder = preferences.libraryFolder;
      if (library && welcome.libraryFolder && welcome.libraryFolder !== preferences.libraryFolder) {
        const previous = libraries.find((item) => item.isDefault);
        const added = await library.addLibrary(
          t("settings.libraries.defaultName"),
          welcome.libraryFolder,
        );
        await library.setDefaultLibrary(added.id);
        if (previous && previous.guideCount === 0)
          await library.removeLibrary(previous.id).catch(() => undefined);
        folder = added.path;
      }
      const saved = await recorder.setPreferences({
        displayName: welcome.displayName,
        libraryFolder: folder,
      });
      // Only people who have just been welcomed get the tour; it greets them on the guides.
      startTourAfterWelcome();
      setPreferences(saved);
      if (welcome.autoStart && policy().autoStart === null) {
        await recorder.setAutoStartEnabled(true).catch(() => undefined);
        setAutoStart(true);
      }
      await refreshLibraries();
    } catch (problem) {
      setWelcomeError(errorMessage(problem, t("recorder.preferencesFailed")));
    } finally {
      setBusy(false);
    }
  };

  // ----- Rendering -----

  const libraryName = libraries.find((item) => item.id === libraryId)?.name ?? t("nav.allGuides");
  const tags = useMemo(() => tagCounts(guides), [guides]);

  const view = route.screen === "library" ? route.view : null;
  const visibleGuides = useMemo(
    () => guidesInView(guides, view, recent, libraryId),
    [guides, view, recent, libraryId],
  );

  const heading =
    view?.kind === "tag"
      ? view.tag
      : view?.kind === "recent"
        ? t("nav.recent")
        : view?.kind === "review"
          ? t("nav.needsReview")
          : libraries.length > 1
            ? libraryName
            : t("nav.allGuides");

  // Stable across renders: the editor re-reads a screenshot's text, and every library card its
  // thumbnail, whenever these change, and App re-renders on every toast and recorder fact.
  const readText = useMemo(
    () =>
      recorder
        ? (image: Uint8Array, blurred?: { x: number; y: number; w: number; h: number }[]) =>
            recorder.readText(image, blurred)
        : undefined,
    [recorder],
  );
  const loadThumbnail = useCallback(
    (guide: { id: string; thumbnailMediaId: string | null }) =>
      library && libraryId && guide.thumbnailMediaId
        ? library.loadImage(libraryId, guide.id, guide.thumbnailMediaId, true)
        : Promise.reject(new Error("no thumbnail")),
    [library, libraryId],
  );

  const editorTarget = route.screen === "editor" ? route.target : null;
  const excludedApps = choices.excludedApps;
  const editorStore = useMemo<GuideStore | null>(() => {
    if (editorTarget?.kind === "draft")
      return recorder ? draftStore(recorder, editorTarget.sessionId, excludedApps) : null;
    if (editorTarget?.kind === "guide" && library)
      return libraryStore(
        library,
        { libraryId: editorTarget.libraryId, guideId: editorTarget.doc.guide.id },
        excludedApps,
      );
    return null;
  }, [recorder, library, editorTarget, excludedApps]);

  const tourPlace =
    route.screen === "library"
      ? route.view.kind === "all"
        ? "guides"
        : `library:${route.view.kind}`
      : route.screen === "settings"
        ? `settings:${route.section}`
        : "editor";
  const showGuides = useCallback(() => setRoute({ screen: "library", view: { kind: "all" } }), []);
  const showAbout = useCallback(() => setRoute({ screen: "settings", section: "about" }), []);
  const updates = useUpdates(recorder, notify, showAbout);
  const link = useLink(recorder);
  const showShortcuts = useCallback(
    () => setRoute({ screen: "settings", section: "shortcuts" }),
    [],
  );
  useShortcutWarning(recorder, notify, showShortcuts);
  // Someone else's changes arrive through the sync client: the list follows them.
  useLibraryWatch(
    library,
    libraryId,
    route.screen === "library",
    () => void refreshGuides(libraryId),
  );

  if (preferences && preferences.displayName === "" && route.screen !== "settings") {
    return (
      <>
        <Welcome
          browser={isBrowserEdition(recorder)}
          linux={isLinux(recorder)}
          defaultFolder={preferences.libraryFolder}
          pickFolder={library ? () => library.pickFolder(t("settings.libraries.pickTitle")) : null}
          managed={isManaged()}
          busy={busy}
          error={welcomeError}
          onImportSettings={() => void importSettings()}
          onDone={(welcome) => void finishWelcome(welcome)}
        />
        <Toast toast={toast} onClose={closeToast} />
      </>
    );
  }

  return (
    <TourProvider
      enabled
      place={tourPlace}
      onGo={showGuides}
      firstName={author.trim().split(/\s+/)[0] || null}
    >
      <div className="flex h-screen overflow-hidden bg-page text-body">
        {route.screen !== "editor" && route.screen !== "settings" && (
          <Sidebar
            libraries={libraries}
            libraryId={libraryId}
            onLibrary={showLibrary}
            view={view}
            onView={(next) => setRoute({ screen: "library", view: next })}
            tags={tags}
            guideCount={guides.length}
            reviewCount={guides.filter(needsReview).length}
            canRecord={Boolean(recorder) && !recording && !hasPending && !busy && !fatal}
            recordHint={recordHint}
            recordingControls={
              recorder && (snapshot.state === "recording" || snapshot.state === "paused")
                ? {
                    paused: snapshot.state === "paused",
                    onPause: () =>
                      void (snapshot.state === "paused" ? recorder.resume() : recorder.pause())
                        .then(setSnapshot)
                        .catch(() => undefined),
                    onStop: () =>
                      void recorder
                        .stop()
                        .then(setSnapshot)
                        .catch(() => undefined),
                  }
                : null
            }
            onRecord={requestRecording}
            onSettings={() => setRoute({ screen: "settings", section: "general" })}
            settingsActive={false}
          />
        )}
        {/* The one main landmark, around whichever screen is showing. */}
        <main className="min-w-0 flex-1">
          {fatal && (
            <div role="alert" className="card m-6 flex items-start gap-3 p-4">
              <Icon name="warning" className="mt-0.5 text-warning" />
              <div>
                <h2 className="font-heading text-base text-navy">{t("recorder.errorTitle")}</h2>
                <p className="mt-1 text-secondary">{fatal}</p>
              </div>
            </div>
          )}

          {route.screen === "library" && route.view.kind === "trash" && (
            <TrashView
              trash={trash}
              busy={busy}
              onDeleteForGood={deleteForGood}
              onEmpty={emptyTrash}
              onRestore={(entry) =>
                libraryId &&
                void run(
                  async () => {
                    await library?.restoreGuide(libraryId, entry.trashId);
                    await refreshGuides(libraryId);
                  },
                  t("library.restored", { title: entry.title }),
                )
              }
            />
          )}

          {route.screen === "library" && route.view.kind !== "trash" && (
            <LibraryHome
              heading={heading}
              guides={visibleGuides}
              loading={guidesLoading}
              pending={pending}
              busy={busy}
              onOpen={(guide) =>
                libraryId && void run(() => openLibraryGuide({ libraryId, guideId: guide.id }))
              }
              onReviewPending={(item) => void reviewPending(item)}
              onDiscardPending={setDiscardTarget}
              guideMenu={(guide) =>
                libraryId ? guideMenu({ libraryId, guideId: guide.id }, guide.title) : []
              }
              exportMenu={(guide) =>
                libraryId
                  ? exportMenu({ kind: "guide", libraryId, guideId: guide.id, title: guide.title })
                  : []
              }
              loadThumbnail={loadThumbnail}
              bulk={
                library && libraryId
                  ? {
                      targets: libraries
                        .filter((item) => item.id !== libraryId && !item.needsAccess)
                        .map(({ id, name }) => ({ id, name })),
                      onMove: (chosen, to) => void bulk.move(chosen, to),
                      onCopy: (chosen, to) => void bulk.copy(chosen, to),
                      onTrash: (chosen) => void bulk.trash(chosen),
                      onMerge: (chosen) =>
                        setMerging(chosen.map((guide) => ({ libraryId, guide }))),
                      exportMenu: (chosen) =>
                        exportManyMenu(
                          chosen.map((guide) => ({
                            kind: "guide" as const,
                            libraryId,
                            guideId: guide.id,
                            title: guide.title,
                          })),
                        ),
                    }
                  : undefined
              }
              onNewRecording={requestRecording}
              onImport={() => void importAmlsteps()}
              searchGuides={
                library && libraryId ? (query) => library.searchGuides(libraryId, query) : undefined
              }
              storage={(() => {
                const warning = storageWarning(storage, readStorageWarnGb() * 1024 ** 3);
                return warning && storage ? { warning, use: storage } : null;
              })()}
              onExportAndRemove={
                library?.exportAndRemove ? () => setExportRemove({ progress: null }) : undefined
              }
              access={(() => {
                const shown = libraries.find((item) => item.id === libraryId);
                const allow = library?.allowAccess;
                if (!shown?.needsAccess || !allow) return null;
                return {
                  folder: shown.path,
                  // Straight from the click: the browser only asks from one.
                  onAllow: () =>
                    void run(async () => {
                      if (await allow.call(library, shown.id)) await refreshLibraries(shown.id);
                    }),
                };
              })()}
            />
          )}

          {editorTarget && editorStore && (
            <AnyGuideEditor
              key={editorTarget.key}
              library={editorTarget.kind === "guide" ? library : undefined}
              libraryId={editorTarget.kind === "guide" ? editorTarget.libraryId : undefined}
              onOpenGuide={(summary) =>
                editorTarget.kind === "guide" &&
                void openLibraryGuide({ libraryId: editorTarget.libraryId, guideId: summary.id })
              }
              initial={editorTarget.doc}
              store={editorStore}
              author={author}
              mode={editorTarget.kind === "draft" ? "draft" : "saved"}
              readText={readText}
              sharedLibrary={
                editorTarget.kind === "guide" &&
                libraries.some(
                  (item) => item.id === editorTarget.libraryId && (item.synced || item.managed),
                )
              }
              blurTerms={allBlurTerms}
              busy={busy}
              notify={notify}
              onBack={() => {
                setRoute({ screen: "library", view: { kind: "all" } });
                void refreshGuides(libraryId);
                void refreshRecoveries();
              }}
              onSave={
                editorTarget.kind === "draft"
                  ? (flush, doc) => void saveDraft(editorTarget.sessionId, flush, doc)
                  : undefined
              }
              saveTargets={editorTarget.kind === "draft" ? libraries : undefined}
              saveVersion={
                editorTarget.kind === "guide" && library
                  ? async (note) => {
                      await library.saveVersion(
                        editorTarget.libraryId,
                        editorTarget.doc.guide.id,
                        note,
                      );
                    }
                  : undefined
              }
              onSaveTo={
                editorTarget.kind === "draft"
                  ? (flush, doc, id) => {
                      const chosen = libraries.find((item) => item.id === id);
                      void saveDraft(
                        editorTarget.sessionId,
                        flush,
                        doc,
                        false,
                        chosen && !chosen.isDefault ? { id, name: chosen.name } : undefined,
                      );
                    }
                  : undefined
              }
              onDiscard={
                editorTarget.kind === "draft"
                  ? () =>
                      setDiscardTarget({
                        sessionId: editorTarget.sessionId,
                        title: editorTarget.doc.guide.title,
                        stepCount: editorTarget.doc.steps.length,
                        savedGuideId: null,
                      })
                  : undefined
              }
              exportMenu={(doc, flush, editor) =>
                exportMenu(
                  editorTarget.kind === "guide"
                    ? {
                        kind: "guide",
                        libraryId: editorTarget.libraryId,
                        guideId: doc.guide.id,
                        title: doc.guide.title,
                      }
                    : { kind: "draft", sessionId: editorTarget.sessionId, title: doc.guide.title },
                  doc,
                  flush,
                  editor,
                )
              }
              guideMenu={
                editorTarget.kind === "guide"
                  ? (doc, flush) => [
                      {
                        label: t("versions.save"),
                        icon: "history",
                        onSelect: async () => {
                          const note = await askText(
                            t("versions.saveTitle"),
                            t("versions.notePrompt"),
                            "",
                            t("versions.saveYes"),
                          );
                          if (note === null) return;
                          // A version is only saved from files that are all on disk.
                          void run(async () => {
                            await flush();
                            await library?.saveVersion(editorTarget.libraryId, doc.guide.id, note);
                          }, t("versions.saved"));
                        },
                      },
                      {
                        label: t("versions.list"),
                        icon: "clock",
                        onSelect: () =>
                          void openVersions(
                            { libraryId: editorTarget.libraryId, guideId: doc.guide.id },
                            flush,
                          ),
                      },
                      "divider",
                      ...guideMenu(
                        { libraryId: editorTarget.libraryId, guideId: doc.guide.id },
                        doc.guide.title,
                        flush,
                      ).filter(
                        (entry) =>
                          typeof entry !== "object" ||
                          !("label" in entry) ||
                          entry.label !== t("library.open"),
                      ),
                    ]
                  : undefined
              }
            />
          )}

          {route.screen === "settings" && (
            <SettingsView
              recorder={recorder}
              library={library}
              section={route.section}
              onSection={(section) => setRoute({ screen: "settings", section })}
              onBack={() => setRoute({ screen: "library", view: { kind: "all" } })}
              locked={recording || hasPending}
              displayName={author}
              onDisplayName={settings.saveName}
              autoStart={autoStart}
              onAutoStart={settings.changeAutoStart}
              choices={choices}
              onChoices={updateChoices}
              monitors={monitors}
              inputSource={snapshot.inputSource}
              onInputSource={(source) =>
                void recorder
                  ?.setInputSource(source)
                  .then(setSnapshot)
                  .catch((problem: unknown) =>
                    notify({
                      kind: "error",
                      text: errorMessage(problem, t("recorder.errorTitle")),
                    }),
                  )
              }
              libraries={libraries}
              storage={storage}
              onLibrariesChanged={async () => {
                await refreshLibraries(libraryId);
                if (recorder) setPreferences(await recorder.getPreferences());
              }}
              theme={theme}
              onTheme={settings.setTheme}
              managedBrandIds={managedBrandIds}
              appColours={appColours}
              onAppColours={chooseAppColours}
              managed={isManaged()}
              onImportSettings={() => void importSettings()}
              onExportSettings={() => void exportSettings()}
              onBackUpAll={() => void backUpAll()}
              onRestore={() => void restoreBackup()}
              notify={notify}
              version={APP_VERSION}
              updates={updates}
              link={link}
              brands={brands}
              onBrandsChanged={refreshBrands}
              blurTerms={settings.blurTerms}
              onBlurTerms={settings.updateBlurTerms}
            />
          )}
        </main>

        {startOpen && (
          <StartRecordingDialog
            defaults={{
              keys: settings.choices.typedByDefault,
              output: settings.choices.outputByDefault,
            }}
            onCancel={closeStart}
            onStart={(choices) => void startRecording(choices)}
          />
        )}

        {exportRemove && (
          <ExportAndRemoveDialog
            guides={guides}
            progress={exportRemove.progress}
            onCancel={() => setExportRemove(null)}
            onExport={(ids) => void exportAndRemove(ids)}
          />
        )}

        {merging && libraryId && (
          <MergeDialog
            libraries={libraries}
            libraryId={libraryId}
            initial={merging}
            listGuides={listGuidesIn}
            busy={busy}
            onCancel={() => setMerging(null)}
            onMerge={(request) => {
              setMerging(null);
              void bulk.merge(request);
            }}
          />
        )}

        <AskHost />

        {alreadyOpen && (
          <NoticeDialog
            title={t("app.alreadyOpenTitle")}
            body={t("app.alreadyOpenBody")}
            onClose={() => setAlreadyOpen(false)}
          />
        )}

        {confirming && (
          <ConfirmDialog
            title={confirming.title}
            body={confirming.body}
            confirmLabel={confirming.confirmLabel}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              const { run: confirmed } = confirming;
              setConfirming(null);
              void confirmed();
            }}
          />
        )}

        {renaming && (
          <RenameGuideDialog
            title={renaming.title}
            onRename={(title) => renameGuide(renaming.ref, title)}
            onCancel={() => setRenaming(null)}
          />
        )}

        {discardTarget && (
          <DiscardDialog
            onKeep={() => setDiscardTarget(null)}
            onDiscard={() => void discard(discardTarget)}
          />
        )}

        {versionsFor && (
          <VersionsDialog
            versions={versionsFor.versions}
            onClose={() => setVersionsFor(null)}
            onRestore={(version) =>
              void run(async () => {
                if (!library) return;
                const restored = toDoc(
                  await library.restoreVersion(
                    versionsFor.libraryId,
                    versionsFor.guideId,
                    version.id,
                  ),
                );
                setVersionsFor(null);
                setRoute({
                  screen: "editor",
                  target: {
                    kind: "guide",
                    libraryId: versionsFor.libraryId,
                    doc: restored,
                    key: `${versionsFor.guideId}:${Date.now()}`,
                  },
                });
              }, t("versions.restored"))
            }
          />
        )}

        {exportDialog}
        <Toast toast={toast} onClose={closeToast} />
      </div>
    </TourProvider>
  );
}
