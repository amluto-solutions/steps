import { LANGUAGES, isLanguage, languageName } from "@amluto-steps/core";
import { useState } from "react";
import { isBrowserEdition, isLinux } from "../recorder-bridge";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/icons";
import { useTour } from "../tour/TourProvider";
import { policy } from "./policy";
import { formatBytes, freeBytes } from "../library/storage";
import {
  STORAGE_WARN,
  appLanguage,
  fitStorageWarnGb,
  policyLanguage,
  readLanguageChoice,
  readMadeWith,
  readStorageWarnGb,
  saveLanguageChoice,
  saveMadeWith,
  saveStorageWarnGb,
  systemLanguage,
} from "./preferences";
import { setAppLanguage } from "../i18n";
import { Row, Switch } from "./controls";
import type { SettingsProps } from "./settings-props";

export function GeneralSection(props: SettingsProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(props.displayName);
  const [madeWith, setMadeWith] = useState(readMadeWith);
  const tour = useTour();
  return (
    <>
      <h2 className="mb-3.5 font-heading text-xl text-navy">{t("settings.sections.general")}</h2>
      <Row label={t("settings.general.name")} help={t("settings.general.nameHelp")} id="name-label">
        <input
          aria-labelledby="name-label"
          autoComplete="name"
          value={name}
          maxLength={120}
          disabled={props.locked}
          placeholder={t("settings.general.namePlaceholder")}
          onChange={(event) => setName(event.currentTarget.value)}
          onBlur={() => {
            if (name.trim() !== props.displayName) void props.onDisplayName(name.trim());
          }}
          className="field w-60"
        />
      </Row>
      <LanguageRow />
      <Row
        label={t("settings.general.madeWith")}
        help={t("settings.general.madeWithHelp")}
        id="made-with-label"
      >
        <Switch
          labelledBy="made-with-label"
          checked={madeWith}
          onChange={(on) => {
            setMadeWith(on);
            saveMadeWith(on);
          }}
        />
      </Row>
      {props.storage && (
        <Row
          label={t("storage.settingsLabel")}
          help={
            freeBytes(props.storage) === null
              ? t("storage.settingsUse", { size: formatBytes(props.storage.libraryBytes) })
              : t("storage.settingsUseFree", {
                  size: formatBytes(props.storage.libraryBytes),
                  free: formatBytes(freeBytes(props.storage) ?? 0),
                })
          }
          id="storage-warn-label"
        >
          <span className="flex items-center gap-2 text-sm">
            <span className="text-secondary">{t("storage.warnAbove")}</span>
            <input
              type="number"
              aria-labelledby="storage-warn-label"
              min={STORAGE_WARN.min}
              max={STORAGE_WARN.max}
              step={0.25}
              defaultValue={readStorageWarnGb()}
              onBlur={(event) => {
                // Blank or not a number: keep what was there rather than guess.
                const typed = event.currentTarget.value.trim();
                const gb =
                  typed === "" || !Number.isFinite(Number(typed))
                    ? readStorageWarnGb()
                    : fitStorageWarnGb(Number(typed));
                event.currentTarget.value = String(gb);
                saveStorageWarnGb(gb);
              }}
              className="field w-20"
            />
            <span className="text-secondary">{t("storage.gb")}</span>
          </span>
        </Row>
      )}
      {!isBrowserEdition(props.recorder) && (
        <Row
          label={t(
            isLinux(props.recorder)
              ? "settings.general.autoStartLinux"
              : "settings.general.autoStart",
          )}
          help={t(
            isLinux(props.recorder)
              ? "settings.general.autoStartHelpLinux"
              : "settings.general.autoStartHelp",
          )}
          id="autostart-label"
          managed={policy().autoStart !== null}
        >
          <Switch
            labelledBy="autostart-label"
            checked={policy().autoStart ?? props.autoStart}
            disabled={policy().autoStart !== null}
            onChange={props.onAutoStart}
          />
        </Row>
      )}
      <Row label={t("settings.general.tour")} help={t("settings.general.tourHelp")} id="tour-label">
        {tour.progress && (
          <button type="button" className="btn" onClick={tour.resume}>
            {t("settings.general.tourContinue", { progress: tour.progress })}
          </button>
        )}
        <button type="button" className="btn" onClick={tour.start}>
          {t("settings.general.tourStartAgain")}
        </button>
        <Switch
          labelledBy="tour-label"
          checked={tour.progress !== null}
          onChange={(on) => (on ? tour.start() : tour.turnOff())}
        />
      </Row>
      <div className="card mt-3 flex flex-col gap-3 px-[18px] py-4">
        <div className="flex items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-selected text-blue">
            <Icon name="file" size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <strong className="text-sm text-navy">{t("settings.general.file")}</strong>
            <span className="text-[13px] leading-relaxed text-secondary">
              {t("settings.general.fileHelp")}
            </span>
          </div>
        </div>
        {props.managed ? (
          <div className="ml-[54px] flex items-center gap-2.5 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-secondary">
            <Icon name="lock" size={16} />
            <span className="flex-1">{t("settings.general.managed")}</span>
            <button type="button" className="btn h-8" onClick={props.onExportSettings}>
              {t("settings.general.export")}
            </button>
          </div>
        ) : (
          <div className="ml-[54px] flex flex-wrap gap-2.5">
            <button
              type="button"
              className="btn"
              disabled={props.locked}
              onClick={props.onImportSettings}
            >
              <Icon name="upload" size={15} />
              {t("settings.general.import")}
            </button>
            <button type="button" className="btn" onClick={props.onExportSettings}>
              <Icon name="download" size={15} />
              {t("settings.general.export")}
            </button>
          </div>
        )}
      </div>
      <div className="card mt-3 flex flex-col gap-3 px-[18px] py-4">
        <div className="flex items-start gap-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-selected text-blue">
            <Icon name="history" size={20} />
          </span>
          <div className="flex flex-col gap-1">
            <strong className="text-sm text-navy">{t("backup.title")}</strong>
            <span className="text-[13px] leading-relaxed text-secondary">{t("backup.help")}</span>
          </div>
        </div>
        <div className="ml-[54px] flex flex-wrap gap-2.5">
          <button
            type="button"
            className="btn"
            disabled={!props.onBackUpAll}
            onClick={props.onBackUpAll}
          >
            <Icon name="download" size={15} />
            {t("backup.backUp")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!props.onRestore || props.locked || props.managed}
            onClick={props.onRestore}
          >
            <Icon name="upload" size={15} />
            {t("backup.restore")}
          </button>
        </div>
        {props.managed && (
          <span className="ml-[54px] text-[13px] text-secondary">{t("backup.managed")}</span>
        )}
      </div>
    </>
  );
}

/**
 * "Language" (01/10/2026): the app's language, Windows' (or the browser's) unless chosen, or
 * set by IT (`Language`). Every language but English says it was translated automatically, with
 * where to tell Amluto about a mistake.
 */
function LanguageRow() {
  const { t } = useTranslation();
  const managed = policyLanguage();
  const system = systemLanguage();
  const [choice, setChoice] = useState(readLanguageChoice);
  const shown = managed ?? choice ?? system ?? "en";
  return (
    <Row
      label={t("settings.general.language")}
      help={
        shown === "en"
          ? t("settings.general.languageHelp")
          : `${t("settings.general.languageHelp")} ${t("settings.general.translated")}`
      }
      id="language-label"
      managed={managed !== null}
    >
      <select
        aria-labelledby="language-label"
        className="field max-w-60"
        disabled={managed !== null}
        value={managed ?? choice ?? ""}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const code = isLanguage(next) ? next : null;
          setChoice(code);
          saveLanguageChoice(code);
          void setAppLanguage(appLanguage());
        }}
      >
        <option value="">
          {t("settings.general.systemLanguage", { name: languageName(system ?? "en") })}
        </option>
        {LANGUAGES.map((item) => (
          <option key={item.code} value={item.code} lang={item.code}>
            {item.name}
          </option>
        ))}
      </select>
    </Row>
  );
}
