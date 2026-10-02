import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isBrowserEdition } from "../recorder-bridge";
import { isLocked } from "./policy";
import { isLocalFolder, readExportPreferences, saveExportPreferences } from "./preferences";
import { Row, Switch } from "./controls";
import type { SettingsProps } from "./settings-props";

export function ExportSection(props: SettingsProps) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState(readExportPreferences);
  const [downloads, setDownloads] = useState<string | null>(null);
  useEffect(() => {
    void props.recorder
      ?.defaultExportFolder()
      .then(setDownloads)
      .catch(() => setDownloads(null));
  }, [props.recorder]);
  const update = (next: typeof preferences) => {
    setPreferences(next);
    saveExportPreferences(next);
  };
  return (
    <>
      <h2 className="mb-3.5 font-heading text-xl text-navy">{t("settings.sections.export")}</h2>
      {/* A browser saves exports to its own downloads folder. */}
      {!isBrowserEdition(props.recorder) && (
        <Row
          label={t("exportSettings.folder")}
          help={preferences.folder ?? downloads ?? t("exportSettings.downloads")}
          managed={isLocked("ExportFolder")}
        >
          <span className="flex gap-2">
            {preferences.folder && !isLocked("ExportFolder") && (
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => update({ ...preferences, folder: null })}
              >
                {t("exportSettings.useDownloads")}
              </button>
            )}
            <button
              type="button"
              className="btn"
              disabled={!props.library || isLocked("ExportFolder")}
              onClick={() =>
                void props.library?.pickFolder(t("exportSettings.pickTitle")).then((folder) => {
                  if (!folder) return;
                  if (isLocalFolder(folder)) update({ ...preferences, folder });
                  else props.notify({ kind: "error", text: t("exportSettings.notLocal") });
                })
              }
            >
              {t("exportSettings.change")}
            </button>
          </span>
        </Row>
      )}
      <Row
        label={t("exportSettings.ask")}
        help={t("exportSettings.askHelp")}
        id="export-ask-label"
        managed={isLocked("AskWhereToSave")}
      >
        <Switch
          labelledBy="export-ask-label"
          disabled={isLocked("AskWhereToSave")}
          checked={preferences.askEveryTime}
          onChange={(askEveryTime) => update({ ...preferences, askEveryTime })}
        />
      </Row>
      <Row
        label={t("exportSettings.optimise")}
        help={t("exportSettings.optimiseHelp")}
        id="export-optimise-label"
      >
        <Switch
          labelledBy="export-optimise-label"
          checked={preferences.optimiseForSharing}
          onChange={(optimiseForSharing) => update({ ...preferences, optimiseForSharing })}
        />
      </Row>
    </>
  );
}
