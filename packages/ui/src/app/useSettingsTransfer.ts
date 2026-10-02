import i18n, { type TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { ToastMessage } from "../components/Toast";
import { errorMessage } from "../errors";
import { askConfirm } from "./ask";
import { safeFileName } from "../files";
import type { LibraryBridge } from "../library-bridge";
import { formatDate } from "../library/dates";
import type { RecorderBridge } from "../recorder-bridge";
import { buildBackup, readBackup } from "../settings/backup";
import { readDefaultBrand, saveDefaultBrand } from "../settings/brands";
import {
  isLocalFolder,
  readChoices,
  readExportPreferences,
  saveExportPreferences,
  settingsFileSchema,
  type SettingsFile,
} from "../settings/preferences";
import type { useBrands } from "./useBrands";
import type { useLibraries } from "./useLibraries";
import type { Settings } from "./useSettings";

/**
 * What a settings file or backup would loosen, for the person to agree to before it's applied: a
 * file from someone else could otherwise quietly stop keeping an app out, start recording typing,
 * or (a backup) send every recording to a folder they can read. Empty when nothing would.
 */
export function loosenedBy(recording: SettingsFile["recording"], t: TFunction): string[] {
  const now = readChoices();
  const lines: string[] = [];
  const kept = recording.excludedApps.map((app) => app.toLowerCase());
  const dropped = now.excludedApps.filter((app) => !kept.includes(app.toLowerCase()));
  if (dropped.length) lines.push(t("backup.confirm.excludedApps", { list: dropped.join(", ") }));
  if (recording.typedByDefault && !now.typedByDefault) lines.push(t("backup.confirm.typed"));
  if (recording.outputByDefault && !now.outputByDefault) lines.push(t("backup.confirm.output"));
  if (recording.showUnnamedTyping && !now.showUnnamedTyping)
    lines.push(t("backup.confirm.unnamedTyping"));
  return lines;
}

/**
 * A settings file's suggested name: "Sam Jones Steps settings 2026-09-30" (30/09/2026), or
 * without the name when there's none. The date is ISO, so files sort by it.
 */
export function settingsFileName(name: string, when: Date): string {
  const date = [
    when.getFullYear(),
    String(when.getMonth() + 1).padStart(2, "0"),
    String(when.getDate()).padStart(2, "0"),
  ].join("-");
  return safeFileName(
    [name.trim(), i18n.t("settings.file.defaultName"), date].filter(Boolean).join(" "),
  );
}

/**
 * Settings files (.amlsettings) and "Back up all" / Restore (.amlbackup), built from and applied
 * to the settings, brands and libraries hooks (docs/spec/07-settings-and-policy.md).
 */
export function useSettingsTransfer(context: {
  recorder: RecorderBridge | undefined;
  library: LibraryBridge | undefined;
  notify: (message: Omit<ToastMessage, "id">) => void;
  run: (action: () => Promise<unknown>, done?: string) => Promise<void>;
  settings: Settings;
  brands: ReturnType<typeof useBrands>;
  libraries: ReturnType<typeof useLibraries>;
}) {
  const { t } = useTranslation();
  const { recorder, library, notify, run, settings, brands, libraries } = context;

  const exportSettings = async () => {
    if (!recorder || !library) return;
    const path = await library.pickSaveLocation(
      t("settings.file.saveTitle"),
      `${settingsFileName(settings.author, new Date())}.amlsettings`,
      [{ name: t("settings.file.filter"), extensions: ["amlsettings"] }],
    );
    if (!path) return;
    const file = await settings.currentSettingsFile();
    await run(
      () => recorder.writeSettingsFile(path, JSON.stringify(file, null, 2)),
      t("settings.file.saved"),
    );
  };

  const importSettings = async () => {
    if (!recorder || !library) return;
    const path = await library.pickFile(t("settings.file.openTitle"), [
      { name: t("settings.file.filter"), extensions: ["amlsettings"] },
    ]);
    if (!path) return;
    try {
      const parsed = settingsFileSchema.safeParse(
        JSON.parse(await recorder.readSettingsFile(path)),
      );
      if (!parsed.success) {
        notify({ kind: "error", text: t("settings.file.invalid") });
        return;
      }
      const loosened = loosenedBy(parsed.data.recording, t);
      if (
        loosened.length &&
        !(await askConfirm(
          t("backup.confirm.settingsTitle"),
          [t("backup.confirm.intro"), ...loosened].join("\n"),
          t("backup.confirm.apply"),
        ))
      )
        return;
      const problems = await settings.applySettingsFile(parsed.data);
      notify({
        ...(problems.length ? { kind: "error" as const } : {}),
        text: problems.length
          ? t("settings.file.importedWithProblems", { count: problems.length })
          : t("settings.file.imported"),
      });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("settings.file.invalid")) });
    }
  };

  /** "Back up all": settings, brands and the list of libraries in one .amlbackup file. */
  const backUpAll = async () => {
    if (!recorder || !library) return;
    const path = await library.pickSaveLocation(
      t("backup.saveTitle"),
      `${t("backup.fileName")} ${formatDate(new Date()).replace(/\//g, "-")}.amlbackup`,
      [{ name: t("backup.filter"), extensions: ["amlbackup"] }],
    );
    if (!path) return;
    const saving = readExportPreferences();
    await run(
      async () =>
        recorder.writeBackupFile(
          path,
          buildBackup({
            settings: await settings.currentSettingsFile(),
            blurTerms: settings.blurTerms,
            exportFolder: saving.folder,
            exportAsk: saving.askEveryTime,
            defaultPdfBrand: readDefaultBrand(),
            appColours: brands.appColours,
            brands: brands.brands,
            libraries: libraries.libraries.map(({ name, path: folder, isDefault }) => ({
              name,
              path: folder,
              isDefault,
            })),
          }),
        ),
      t("backup.saved"),
    );
  };

  /**
   * Restore: the whole file is checked first, then applied. Libraries already listed are kept; one
   * that can't be added (its drive isn't there) is reported rather than dropped silently.
   */
  const restoreBackup = async () => {
    if (!recorder || !library) return;
    const path = await library.pickFile(t("backup.openTitle"), [
      { name: t("backup.filter"), extensions: ["amlbackup"] },
    ]);
    if (!path) return;
    try {
      const restored = await readBackup(await recorder.readBackupFile(path), (bytes) =>
        recorder.checkFont(bytes),
      );
      // Libraries it adds, and a new default (where every recording is saved), are agreed to
      // first, with anything it would loosen.
      const listed = (path: string) =>
        libraries.libraries.find((item) => item.path.toLowerCase() === path.toLowerCase());
      const changes = [
        ...restored.file.libraries
          .filter((entry) => !listed(entry.path))
          .map((entry) => t("backup.confirm.addLibrary", { name: entry.name, path: entry.path })),
        ...restored.file.libraries
          .filter((entry) => entry.isDefault && !listed(entry.path)?.isDefault)
          .map((entry) =>
            t("backup.confirm.defaultLibrary", { name: entry.name, path: entry.path }),
          ),
        ...loosenedBy(restored.settings.recording, t),
      ];
      if (
        changes.length &&
        !(await askConfirm(
          t("backup.confirm.title"),
          [t("backup.confirm.intro"), ...changes].join("\n"),
          t("backup.confirm.restore"),
        ))
      )
        return;
      const problems = await settings.applySettingsFile(restored.settings);
      // Added to, never cut: a backup can't take a word off the always-blur list.
      settings.updateBlurTerms([...new Set([...settings.blurTerms, ...restored.file.blurTerms])]);
      // Exports go to this folder without a dialog, so a network share from the file is left out.
      const exportFolder = restored.file.exportFolder;
      const folderAllowed = exportFolder === null || isLocalFolder(exportFolder);
      if (!folderAllowed) problems.push(t("exportSettings.notLocal"));
      saveExportPreferences({
        folder: folderAllowed ? exportFolder : readExportPreferences().folder,
        askEveryTime: restored.file.exportAsk,
        // A backup doesn't carry it: the choice made here stays.
        optimiseForSharing: readExportPreferences().optimiseForSharing,
      });
      for (const profile of restored.brands) {
        // A brand the organisation deploys stays as it deployed it.
        if (brands.managedBrandIds.includes(profile.id)) continue;
        await recorder.saveBrand(profile).catch((problem: unknown) => {
          problems.push(errorMessage(problem, profile.name));
        });
      }
      saveDefaultBrand(restored.file.defaultPdfBrand);
      brands.chooseAppColours(restored.file.appColours);
      for (const entry of restored.file.libraries) {
        const known = libraries.libraries.find(
          (item) => item.path.toLowerCase() === entry.path.toLowerCase(),
        );
        try {
          const added = known ?? (await library.addLibrary(entry.name, entry.path));
          if (entry.isDefault && !added.isDefault) await library.setDefaultLibrary(added.id);
        } catch (problem) {
          problems.push(errorMessage(problem, entry.path));
        }
      }
      await Promise.all([brands.refreshBrands(), libraries.refreshLibraries()]);
      notify({
        text: [
          // Each thing that couldn't be set up, by name, not just how many (F057).
          problems.length
            ? t("backup.restoredExcept", { list: problems.join("; ") })
            : t("backup.restored"),
          ...restored.droppedFonts.map((family) => t("brands.fontDropped", { family })),
        ].join(" "),
      });
    } catch (problem) {
      notify({ kind: "error", text: errorMessage(problem, t("backup.invalid")) });
    }
  };

  return { exportSettings, importSettings, backUpAll, restoreBackup };
}
