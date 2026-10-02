import { TONES, siteName, type Tone } from "@amluto-steps/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isBrowserEdition, isLinux } from "../recorder-bridge";
import { isLocked, policy } from "./policy";
import {
  OUTPUT_SETTLE,
  exeName,
  fitSettleMs,
  linuxProgramName,
  monitorKey,
  screenLabel,
  policyTone,
  readExcludedSites,
  readStepTone,
  saveExcludedSites,
  saveStepTone,
} from "./preferences";
import { ChipList, Row, Segmented, Switch } from "./controls";
import { LinkRow } from "./LinkRow";
import type { SettingsProps } from "./settings-props";

export function RecordingSection(props: SettingsProps) {
  const { t } = useTranslation();
  const { choices } = props;
  const linux = isLinux(props.recorder);
  const addApp = (text: string) => {
    const name = text.trim();
    // Windows programs are named with .exe (added if left off); Linux programs without one.
    const exe = linux || /\.exe$/i.test(name) ? name : `${name}.exe`;
    if (!(linux ? linuxProgramName : exeName).test(exe)) {
      props.notify({
        text: t(linux ? "settings.recording.appInvalidLinux" : "settings.recording.appInvalid"),
      });
      return false;
    }
    if (!choices.excludedApps.some((app) => app.toLowerCase() === exe.toLowerCase()))
      props.onChoices({ ...choices, excludedApps: [...choices.excludedApps, exe] });
    return true;
  };
  if (isBrowserEdition(props.recorder)) return <BrowserRecording {...props} />;
  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.recording")}</h2>
      <p className="mb-3.5 text-sm text-secondary">
        {props.locked ? t("settings.recording.locked") : t("settings.recording.intro")}
      </p>
      <Row
        label={t("settings.recording.screenshot")}
        id="shot-label"
        managed={isLocked("ScreenshotMode")}
      >
        <Segmented
          labelledBy="shot-label"
          disabled={props.locked || isLocked("ScreenshotMode")}
          value={choices.captureMode}
          onChange={(captureMode) => props.onChoices({ ...choices, captureMode })}
          options={[
            { value: "window", label: t("settings.recording.window") },
            { value: "monitor", label: t("settings.recording.monitor") },
          ]}
        />
      </Row>
      <QualityRow {...props} />
      <ToneRow {...props} />
      <Row
        label={t("settings.recording.monitors")}
        id="monitors-label"
        managed={isLocked("Monitors")}
      >
        <select
          aria-labelledby="monitors-label"
          disabled={props.locked || isLocked("Monitors")}
          value={choices.targetMonitor}
          onChange={(event) =>
            props.onChoices({ ...choices, targetMonitor: event.currentTarget.value })
          }
          className="field min-w-52"
        >
          <option value="all">{t("settings.recording.allMonitors")}</option>
          {props.monitors.map((monitor, index) => (
            <option key={monitorKey(monitor.bounds)} value={monitorKey(monitor.bounds)}>
              {screenLabel(t, monitor, index)}
            </option>
          ))}
        </select>
      </Row>
      {/* X11 can't leave a window out of screenshots. */}
      {!linux && (
        <Row
          label={t("settings.recording.hideBar")}
          help={t("settings.recording.hideBarHelp")}
          id="hide-bar-label"
        >
          <Switch
            labelledBy="hide-bar-label"
            disabled={props.locked}
            checked={choices.hideRecorderBar}
            onChange={(hideRecorderBar) => props.onChoices({ ...choices, hideRecorderBar })}
          />
        </Row>
      )}
      <Row
        label={t("settings.recording.appSwitch")}
        help={t("settings.recording.appSwitchHelp")}
        id="app-switch-label"
        managed={isLocked("AppSwitchSteps")}
      >
        <Switch
          labelledBy="app-switch-label"
          disabled={props.locked || isLocked("AppSwitchSteps")}
          checked={choices.appSwitchSteps}
          onChange={(appSwitchSteps) => props.onChoices({ ...choices, appSwitchSteps })}
        />
      </Row>
      <LinkRow link={props.link} browser={false} />
      <TypedDefaults {...props} />
      {!policy().disableKeystrokeRecording && (
        <Row
          label={t("settings.recording.outputWait")}
          help={t("settings.recording.outputWaitHelp")}
          id="output-wait-label"
        >
          <span className="flex items-center gap-2 text-sm">
            <input
              type="number"
              aria-labelledby="output-wait-label"
              disabled={props.locked}
              min={OUTPUT_SETTLE.min / 1000}
              max={OUTPUT_SETTLE.max / 1000}
              step={OUTPUT_SETTLE.step / 1000}
              defaultValue={choices.outputSettleMs / 1000}
              onBlur={(event) => {
                // Blank or not a number: keep what was there rather than guess.
                const typed = event.currentTarget.value.trim();
                const outputSettleMs =
                  typed === "" || !Number.isFinite(Number(typed))
                    ? choices.outputSettleMs
                    : fitSettleMs(Number(typed) * 1000);
                event.currentTarget.value = String(outputSettleMs / 1000);
                if (outputSettleMs !== choices.outputSettleMs)
                  props.onChoices({ ...choices, outputSettleMs });
              }}
              className="field w-20"
            />
            <span className="text-secondary">{t("settings.recording.seconds")}</span>
          </span>
        </Row>
      )}
      <ChipList
        label={t("settings.recording.excluded")}
        help={t("settings.recording.excludedHelp")}
        managed={policy().excludedApps}
        items={choices.excludedApps.filter(
          (app) =>
            !policy().excludedApps.some((managed) => managed.toLowerCase() === app.toLowerCase()),
        )}
        removeLabel={(app) => t("settings.recording.removeApp", { app })}
        onRemove={(app) =>
          props.onChoices({
            ...choices,
            excludedApps: choices.excludedApps.filter((item) => item !== app),
          })
        }
        inputLabel={t(linux ? "settings.recording.appNameLinux" : "settings.recording.appName")}
        placeholder={t(
          linux ? "settings.recording.appPlaceholderLinux" : "settings.recording.appPlaceholder",
        )}
        addLabel={t("settings.recording.addApp")}
        canAdd={(text) => text.trim().length > 0}
        onAdd={addApp}
        disabled={props.locked}
        inputClassName="w-36"
      />
      {/* Linux has one way of detecting clicks. */}
      {!linux && (
        <details className="border-t border-panel py-3">
          <summary className="cursor-pointer text-sm font-semibold text-secondary">
            {t("settings.recording.troubleshooting")}
          </summary>
          <div className="mt-2">
            <Row
              label={t("settings.recording.inputSource")}
              help={t("settings.recording.inputSourceHelp")}
              id="input-label"
            >
              <select
                aria-labelledby="input-label"
                disabled={props.locked}
                value={props.inputSource}
                onChange={(event) =>
                  props.onInputSource(event.currentTarget.value === "hook" ? "hook" : "rawInput")
                }
                className="field"
              >
                <option value="rawInput">{t("settings.recording.rawInput")}</option>
                <option value="hook">{t("settings.recording.hook")}</option>
              </select>
            </Row>
          </div>
        </details>
      )}
    </>
  );
}

/**
 * "Language tone" (01/10/2026): how new recordings' steps are worded. Casual unless chosen;
 * IT can set it (`LanguageTone`). A guide can still be reworded with Language and tone.
 */
function ToneRow(props: SettingsProps) {
  const { t } = useTranslation();
  const managed = policyTone() !== null;
  const [tone, setTone] = useState(readStepTone);
  return (
    <Row
      label={t("settings.recording.tone")}
      help={t("settings.recording.toneHelp")}
      id="tone-label"
      managed={managed}
    >
      <select
        aria-labelledby="tone-label"
        className="field"
        disabled={props.locked || managed}
        value={tone}
        onChange={(event) => {
          const next = event.currentTarget.value as Tone;
          setTone(next);
          saveStepTone(next);
        }}
      >
        {TONES.map((option) => (
          <option key={option} value={option}>
            {t(`editor.languages.tones.${option}`)}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** "Screenshot quality": Balanced unless Original is chosen, in both editions. */
function QualityRow(props: SettingsProps) {
  const { t } = useTranslation();
  const locked = isLocked("ScreenshotQuality");
  return (
    <Row
      label={t("settings.recording.quality")}
      help={t("settings.recording.qualityHelp")}
      id="quality-label"
      managed={locked}
    >
      <Segmented
        labelledBy="quality-label"
        disabled={props.locked || locked}
        value={props.choices.screenshotQuality}
        onChange={(screenshotQuality) => props.onChoices({ ...props.choices, screenshotQuality })}
        options={[
          { value: "balanced", label: t("settings.recording.balanced") },
          { value: "original", label: t("settings.recording.original") },
        ]}
      />
    </Row>
  );
}

/**
 * Recording settings in Steps for Chrome: what's typed is chosen in the side panel, and the sites
 * never recorded stand in for the desktop's apps. Changes apply from the next recording.
 */
function BrowserRecording(props: SettingsProps) {
  const { t } = useTranslation();
  const [sites, setSites] = useState(readExcludedSites);
  const managed = policy().excludedApps;
  const update = (next: string[]) => {
    setSites(next);
    saveExcludedSites(next);
  };
  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.recording")}</h2>
      <p className="mb-3.5 text-sm text-secondary">
        {props.locked ? t("settings.recording.locked") : t("settings.recording.intro")}
      </p>
      <QualityRow {...props} />
      <ToneRow {...props} />
      <TypedDefaults {...props} />
      <ChipList
        label={t("settings.recording.sites")}
        help={t("settings.recording.sitesHelp")}
        managed={managed}
        items={sites.filter((site) => !managed.includes(site))}
        removeLabel={(site) => t("settings.recording.removeSite", { site })}
        onRemove={(site) => update(sites.filter((item) => item !== site))}
        inputLabel={t("settings.recording.siteName")}
        placeholder={t("settings.recording.sitePlaceholder")}
        addLabel={t("settings.recording.addSite")}
        canAdd={(text) => text.trim().length > 0}
        onAdd={(text) => {
          const site = siteName(text);
          if (!site) {
            props.notify({ text: t("settings.recording.siteInvalid") });
            return false;
          }
          if (!sites.includes(site)) update([...sites, site]);
          return true;
        }}
        disabled={props.locked}
        inputClassName="w-48"
      />
      <LinkRow link={props.link} browser />
    </>
  );
}

/**
 * "Record what's typed" (docs/spec/07-settings-and-policy.md#start-dialog): whether its tick box,
 * and "Include command output" under it, start ticked when a recording starts (30/09/2026).
 * IT can set either, or switch the whole thing off.
 */
function TypedDefaults(props: SettingsProps) {
  const { t } = useTranslation();
  const { choices } = props;
  if (policy().disableKeystrokeRecording)
    return (
      <Row
        label={t("settings.recording.typed")}
        help={t("settings.recording.typedOff")}
        id="typed-label"
        managed
      >
        {null}
      </Row>
    );
  const typedManaged = policy().recordTypingByDefault !== null;
  const outputManaged = policy().includeOutputByDefault !== null;
  const unnamedManaged = policy().showUnnamedTyping !== null;
  // Steps for Chrome has no terminals, so no command output.
  const output = !isBrowserEdition(props.recorder);
  return (
    <>
      <Row
        label={t("settings.recording.typedDefault")}
        help={t("settings.recording.typedDefaultHelp")}
        id="typed-default-label"
        managed={typedManaged}
      >
        <Switch
          labelledBy="typed-default-label"
          disabled={props.locked || typedManaged}
          checked={choices.typedByDefault}
          onChange={(typedByDefault) => props.onChoices({ ...choices, typedByDefault })}
        />
      </Row>
      <Row
        label={t("settings.recording.unnamedTyping")}
        help={t("settings.recording.unnamedTypingHelp")}
        id="unnamed-typing-label"
        managed={unnamedManaged}
      >
        <Switch
          labelledBy="unnamed-typing-label"
          disabled={props.locked || unnamedManaged}
          checked={choices.showUnnamedTyping}
          onChange={(showUnnamedTyping) => props.onChoices({ ...choices, showUnnamedTyping })}
        />
      </Row>
      {output && (
        <Row
          label={t("settings.recording.outputDefault")}
          help={t("settings.recording.outputDefaultHelp")}
          id="output-default-label"
          managed={outputManaged}
        >
          <Switch
            labelledBy="output-default-label"
            disabled={props.locked || outputManaged || !choices.typedByDefault}
            checked={choices.typedByDefault && choices.outputByDefault}
            onChange={(outputByDefault) => props.onChoices({ ...choices, outputByDefault })}
          />
        </Row>
      )}
    </>
  );
}
