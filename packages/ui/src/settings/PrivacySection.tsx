import { BLUR_STRENGTHS, type BlurStrength } from "@amluto-steps/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isLinux } from "../recorder-bridge";
import { policy } from "./policy";
import { readBlurStrength, saveBlurStrength } from "./preferences";
import { ChipList, Row } from "./controls";
import type { SettingsProps } from "./settings-props";

/** "Blur suggestions": Light, Standard or Thorough (01/10/2026). Never blurs by itself. */
function StrengthRow(props: SettingsProps) {
  const { t } = useTranslation();
  const managed = policy().blurStrength !== null;
  const [strength, setStrength] = useState(readBlurStrength);
  return (
    <Row
      label={t("privacy.strength")}
      help={t(`privacy.strengthHelp.${strength}`)}
      id="strength-label"
      managed={managed}
    >
      <select
        aria-labelledby="strength-label"
        className="field"
        disabled={props.locked || managed}
        value={strength}
        onChange={(event) => {
          const next = event.currentTarget.value as BlurStrength;
          setStrength(next);
          saveBlurStrength(next);
        }}
      >
        {BLUR_STRENGTHS.map((option) => (
          <option key={option} value={option}>
            {t(`privacy.strengths.${option}`)}
          </option>
        ))}
      </select>
    </Row>
  );
}

export function PrivacySection(props: SettingsProps) {
  const { t } = useTranslation();
  const add = (text: string) => {
    const value = text.trim();
    if (
      value.length >= 2 &&
      !props.blurTerms.some((item) => item.toLowerCase() === value.toLowerCase())
    )
      props.onBlurTerms([...props.blurTerms, value]);
    return true;
  };
  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.privacy")}</h2>
      <p className="mb-4 text-sm leading-relaxed text-secondary">
        {t(isLinux(props.recorder) ? "privacy.introLinux" : "privacy.intro")}
      </p>
      <StrengthRow {...props} />
      <ChipList
        label={t("privacy.terms")}
        help={t("privacy.termsHelp")}
        managed={policy().blurTerms}
        items={props.blurTerms}
        removeLabel={(term) => t("privacy.removeTerm", { term })}
        onRemove={(term) => props.onBlurTerms(props.blurTerms.filter((item) => item !== term))}
        inputLabel={t("privacy.termLabel")}
        placeholder={t("privacy.termPlaceholder")}
        addLabel={t("privacy.addTerm")}
        canAdd={(text) => text.trim().length >= 2}
        onAdd={add}
        inputClassName="w-40"
      />
      <Row label={t("privacy.cache")} help={t("privacy.cacheHelp")}>
        <button
          type="button"
          className="btn"
          disabled={!props.recorder}
          onClick={() =>
            void props.recorder
              ?.clearTextCache()
              .then(() => props.notify({ text: t("privacy.cacheCleared") }))
              .catch(() => props.notify({ kind: "error", text: t("privacy.cacheFailed") }))
          }
        >
          {t("privacy.clearCache")}
        </button>
      </Row>
      <p className="border-t border-panel pt-3.5 text-[13px] leading-relaxed text-secondary">
        {t("privacy.notGuaranteed")}
      </p>
    </>
  );
}
