import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import { StepsLogo } from "./StepsLogo";

export interface WelcomeChoices {
  displayName: string;
  /** A newly picked folder, or null to keep the default one. */
  libraryFolder: string | null;
  autoStart: boolean;
}

interface WelcomeProps {
  /** Steps for Chrome: no folder to choose, nothing to start with Windows. */
  browser?: boolean | undefined;
  /** The desktop app on Linux: it starts at sign-in, not with Windows. */
  linux?: boolean | undefined;
  defaultFolder: string;
  pickFolder: (() => Promise<string | null>) | null;
  managed: boolean;
  busy: boolean;
  error: string | null;
  onImportSettings: () => void;
  onDone: (choices: WelcomeChoices) => void;
}

/** The first-run screen (design canvas, board 6): name, where guides go, start with Windows. */
export function Welcome(props: WelcomeProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [autoStart, setAutoStart] = useState(false);

  return (
    <div className="flex h-full bg-background">
      <div className="flex w-[400px] shrink-0 flex-col gap-7 bg-sidebar px-10 py-10 text-white">
        <StepsLogo size="large" />
        <h1 className="mt-6 font-heading text-[30px] leading-tight">{t("welcome.tagline")}</h1>
        <ol className="flex flex-col gap-[18px]">
          {(["record", "tidy", "share"] as const).map((step, index) => (
            <li key={step} className="flex items-start gap-3.5">
              <span className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-cyan text-sm font-bold text-brand-navy">
                {index + 1}
              </span>
              <span className="flex flex-col gap-0.5">
                <strong className="text-[15px]">{t(`welcome.steps.${step}.title`)}</strong>
                <span className="text-sm text-sidebar-text">{t(`welcome.steps.${step}.body`)}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>

      <form
        className="flex max-w-[640px] flex-1 flex-col gap-[22px] px-[72px] py-16"
        onSubmit={(event) => {
          event.preventDefault();
          props.onDone({ displayName: name.trim(), libraryFolder: folder, autoStart });
        }}
      >
        <h2 className="font-heading text-2xl text-navy">{t("welcome.heading")}</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="welcome-name" className="text-sm font-semibold text-navy">
            {t("settings.general.name")}
          </label>
          <input
            id="welcome-name"
            autoComplete="name"
            aria-describedby="welcome-name-help"
            required
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder={t("settings.general.namePlaceholder")}
            className="field h-[42px] text-[15px]"
          />
          <span id="welcome-name-help" className="text-[13px] text-secondary">
            {t("settings.general.nameHelp")}
          </span>
        </div>
        {/* One library in the browser, and nothing to start with Windows. */}
        {!props.browser && (
          <>
            <div className="flex flex-col gap-1.5">
              <span id="welcome-folder" className="text-sm font-semibold text-navy">
                {t("welcome.folder")}
              </span>
              <div className="flex gap-2">
                <div
                  aria-labelledby="welcome-folder"
                  className="flex h-[42px] min-w-0 flex-1 items-center gap-2 rounded-lg border border-panel bg-subtle px-3 text-sm"
                >
                  <Icon name="folder" className="shrink-0 text-blue" />
                  <span className="truncate" title={folder ?? props.defaultFolder}>
                    {folder ?? props.defaultFolder}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn h-[42px]"
                  disabled={!props.pickFolder}
                  onClick={() =>
                    void props.pickFolder?.().then((chosen) => chosen && setFolder(chosen))
                  }
                >
                  {t("welcome.browse")}
                </button>
              </div>
              <span className="text-[13px] text-secondary">{t("welcome.folderHelp")}</span>
            </div>
            <label className="flex items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={autoStart}
                onChange={(event) => setAutoStart(event.currentTarget.checked)}
                className="size-[18px] accent-blue"
              />
              {t(props.linux ? "settings.general.autoStartLinux" : "settings.general.autoStart")}
            </label>
          </>
        )}
        {props.error && (
          <p role="alert" className="text-sm text-recording">
            {props.error}
          </p>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="btn btn-primary h-11 px-6 text-[15px]"
            disabled={props.busy}
          >
            {t("welcome.start")}
          </button>
          {!props.managed && (
            <button
              type="button"
              className="btn h-11"
              disabled={props.busy}
              onClick={props.onImportSettings}
            >
              <Icon name="upload" size={16} />
              {t("welcome.import")}
            </button>
          )}
        </div>
        <span className="-mt-2.5 text-[13px] text-secondary">
          {props.managed ? t("welcome.managed") : t("welcome.importHelp")}
        </span>
      </form>
    </div>
  );
}
