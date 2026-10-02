import { useState } from "react";
import { isBrowserEdition } from "../recorder-bridge";
import { useTranslation } from "react-i18next";
import { Icon } from "../components/icons";
import { errorMessage } from "../errors";
import type { Updates } from "../app/useUpdates";
import { formatDate } from "../library/dates";
import { readExportPreferences } from "./preferences";
import { Row, Switch } from "./controls";
import { OpenSource } from "./OpenSource";
import type { SettingsProps } from "./settings-props";

/** The settings a support file carries: choices and counts, never lists of words or apps. */
function supportSettings(props: SettingsProps) {
  return JSON.stringify({
    recording: {
      outputSettleMs: props.choices.outputSettleMs,
      captureMode: props.choices.captureMode,
      targetMonitor: props.choices.targetMonitor,
      excludedApps: props.choices.excludedApps.length,
      inputSource: props.inputSource,
      monitors: props.monitors.length,
    },
    export: readExportPreferences(),
    general: { autoStart: props.autoStart, theme: props.theme, libraries: props.libraries.length },
    privacy: { blurTerms: props.blurTerms.length },
    brands: props.brands.length,
    managedByPolicy: props.managed,
  });
}

export function AboutSection(props: SettingsProps) {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<{ path: string; files: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  // The folder is opened once: "Write the email" doesn't open a second window after "Show the file".
  const [shown, setShown] = useState<string | null>(null);
  const failed = (problem: unknown) =>
    props.notify({ kind: "error", text: errorMessage(problem, t("settings.about.failed")) });
  const getHelp = async () => {
    if (!props.recorder) return;
    setBusy(true);
    try {
      setBundle(
        await props.recorder.createSupportBundle(
          supportSettings(props),
          props.libraries.map((library) => ({ name: library.name, path: library.path })),
          props.displayName,
        ),
      );
    } catch (problem) {
      failed(problem);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 className="mb-3.5 font-heading text-xl text-navy">{t("settings.sections.about")}</h2>
      <Row label={t("app.name")} help={t("settings.about.version", { version: props.version })}>
        <span />
      </Row>
      <Row label={t("settings.about.madeBy")} help={t("settings.about.madeByHelp")}>
        <button
          type="button"
          className="btn"
          disabled={!props.recorder}
          onClick={() => void props.recorder?.openWebPage("amluto").catch(failed)}
        >
          {t("settings.about.amlutoLink")}
        </button>
      </Row>
      <Row label={t("settings.about.freeSoftware")} help={t("settings.about.freeSoftwareHelp")}>
        <button
          type="button"
          className="btn"
          disabled={!props.recorder}
          onClick={() => void props.recorder?.openWebPage("source").catch(failed)}
        >
          {t("settings.about.sourceCode")}
        </button>
      </Row>
      {/* The Chrome Web Store updates the extension; logs and support files are the desktop's. */}
      {!isBrowserEdition(props.recorder) && (
        <>
          {props.updates && <UpdatesRow updates={props.updates} />}
          {/* Decided 30/09/2026: not in the Store edition for now. */}
          {props.updates?.channel === "store" && (
            <Row label={t("settings.link.desktop")} help={t("settings.link.store")}>
              <span />
            </Row>
          )}
          <Row label={t("settings.about.logs")} help={t("settings.about.logsHelp")}>
            <button
              type="button"
              className="btn"
              disabled={!props.recorder}
              onClick={() => void props.recorder?.openLogsFolder().catch(failed)}
            >
              <Icon name="folder" size={15} />
              {t("settings.about.openLogs")}
            </button>
          </Row>
          <Row label={t("settings.about.help")} help={t("settings.about.helpHelp")}>
            <button
              type="button"
              className="btn"
              disabled={!props.recorder || busy}
              onClick={() => void getHelp()}
            >
              <Icon name="help" size={15} />
              {t("settings.about.getHelp")}
            </button>
          </Row>
        </>
      )}
      {bundle && (
        <section
          aria-labelledby="bundle-title"
          className="card mt-3 flex flex-col gap-3 px-[18px] py-4"
        >
          <h3 id="bundle-title" className="text-sm font-semibold text-navy">
            {t("settings.about.bundleReady")}
          </h3>
          <p className="text-[13px] leading-relaxed text-secondary">
            {t("settings.about.bundleExplain")}
          </p>
          <ul className="flex flex-col gap-1 rounded-lg bg-subtle px-3 py-2 font-mono text-[12px]">
            {bundle.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2.5">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void props.recorder
                  ?.showSupportBundle(bundle.path)
                  .then(() => setShown(bundle.path))
                  .catch(failed)
              }
            >
              <Icon name="folder" size={15} />
              {t("settings.about.showFile")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                // The file goes with the email when the mail app takes it; when it doesn't, the
                // app shows the file to attach (the folder only once).
                void props.recorder
                  ?.openSupportEmail(bundle.path, shown === bundle.path)
                  .then(() => setShown(bundle.path))
                  .catch(failed);
              }}
            >
              {t("settings.about.writeEmail")}
            </button>
          </div>
        </section>
      )}
      <p className="mt-3.5 border-t border-panel pt-3.5 text-[13px] leading-relaxed text-secondary">
        {t("settings.about.privacy")}
      </p>
      <OpenSource recorder={props.recorder} />
    </>
  );
}

/**
 * Updates: what this copy does about them, and for the setup .exe's copy and the portable
 * program, Check for updates, the download, and Restart now once a new version is ready
 * (docs/spec/10-distribution.md#updates-for-the-exe).
 */
function UpdatesRow({ updates }: { updates: Updates }) {
  const { t } = useTranslation();
  const { channel, status, automatic } = updates;
  if (channel === null) return null;
  if (channel !== "checks" && channel !== "portable") {
    return (
      <Row label={t("updates.title")} help={t(`updates.${channel}`)} managed={channel === "policy"}>
        <span />
      </Row>
    );
  }
  const info =
    status.kind === "downloading" || status.kind === "ready" || status.kind === "installing"
      ? status.info
      : null;
  const label = !info
    ? t("updates.title")
    : status.kind === "downloading"
      ? t("updates.downloading", { version: info.version })
      : t("updates.ready", { version: info.version });
  const help = info
    ? t("updates.readyHelp")
    : status.kind === "newest"
      ? t("updates.newest", {
          date: formatDate(new Date(status.at)),
          time: new Date(status.at).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        })
      : automatic
        ? t("updates.checks")
        : t("updates.manual");
  return (
    <>
      <Row
        label={t("updates.automatic")}
        help={
          channel === "portable"
            ? `${t("updates.automaticHelp")} ${t("updates.portable")}`
            : t("updates.automaticHelp")
        }
        id="auto-updates-label"
      >
        <Switch
          labelledBy="auto-updates-label"
          checked={automatic}
          onChange={updates.setAutomatic}
        />
      </Row>
      <Row label={label} help={help}>
        {status.kind === "ready" || status.kind === "installing" ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={status.kind === "installing"}
            onClick={() => void updates.install()}
          >
            <Icon name="restart" size={15} />
            {status.kind === "installing" ? t("updates.restarting") : t("updates.restart")}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={status.kind === "checking" || status.kind === "downloading"}
            onClick={() => void updates.check()}
          >
            <Icon name="download" size={15} />
            {status.kind === "checking"
              ? t("updates.checking")
              : status.kind === "downloading"
                ? t("updates.downloadingButton")
                : t("updates.check")}
          </button>
        )}
      </Row>
      {/* The notes come from the unsigned release.json: plain text only, never markup. */}
      {info?.notes && (
        <p className="mb-2 rounded-lg bg-subtle px-3 py-2 text-[13px] whitespace-pre-line text-secondary">
          {info.notes}
        </p>
      )}
    </>
  );
}
