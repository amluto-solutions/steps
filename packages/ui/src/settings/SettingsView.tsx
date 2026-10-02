import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "../components/icons";
import type { BrandProfile } from "@amluto-steps/core";
import { ThemeSwitch } from "./ThemeSwitch";
import { BrandsSection } from "./BrandsSection";
import { AMLUTO_PROFILE, readDefaultBrand, saveDefaultBrand } from "./brands";
import { policy } from "./policy";
import { Row } from "./controls";
import { isBrowserEdition } from "../recorder-bridge";
import type { SettingsProps, SettingsSection } from "./settings-props";
import { ShortcutsSection } from "./ShortcutsSection";
import { LibrariesSection } from "./LibrariesSection";
import { RecordingSection } from "./RecordingSection";
import { GeneralSection } from "./GeneralSection";
import { ExportSection } from "./ExportSection";
import { PrivacySection } from "./PrivacySection";
import { AboutSection } from "./AboutSection";

export type { SettingsProps, SettingsSection } from "./settings-props";

const SECTIONS: { id: SettingsSection; icon: IconName }[] = [
  { id: "general", icon: "gear" },
  { id: "libraries", icon: "folder" },
  { id: "recording", icon: "record" },
  { id: "shortcuts", icon: "keyboard" },
  { id: "privacy", icon: "shield" },
  { id: "export", icon: "download" },
  { id: "brands", icon: "droplet" },
  { id: "appearance", icon: "contrast" },
  { id: "about", icon: "info" },
];

/** Settings > Appearance: which brand profile to use, from Amluto's own and the client brands. */
function BrandPicker(props: {
  id: string;
  label: string;
  help: string;
  brands: BrandProfile[];
  value: string;
  managed: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <Row label={props.label} help={props.help} id={props.id} managed={props.managed}>
      <select
        aria-labelledby={props.id}
        className="field min-w-52"
        disabled={props.managed}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      >
        {[AMLUTO_PROFILE, ...props.brands].map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Settings (docs/spec/07-settings-and-policy.md): a section list with icons, one section at a time. */
export function SettingsView(props: SettingsProps) {
  const { t } = useTranslation();
  const [pdfBrand, setPdfBrand] = useState(readDefaultBrand);
  return (
    <div className="flex h-full">
      <nav
        aria-label={t("settings.sectionsLabel")}
        className="flex w-[232px] shrink-0 flex-col gap-1 border-r border-panel bg-background px-3 py-4"
      >
        <button type="button" className="btn self-start pl-2" onClick={props.onBack}>
          <Icon name="back" size={16} strokeWidth={2.4} />
          {t("nav.guides")}
        </button>
        <h1 className="mx-2.5 mt-3.5 mb-2.5 font-heading text-[22px] text-navy">
          {t("nav.settings")}
        </h1>
        {SECTIONS.filter(
          // In the browser there are no Windows shortcuts, and libraries only where the browser
          // can open folders (Chrome and Edge, not Firefox).
          (section) =>
            !isBrowserEdition(props.recorder) ||
            (section.id === "libraries"
              ? props.library?.folderLibraries === true
              : section.id !== "shortcuts"),
        ).map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={props.section === section.id ? "page" : undefined}
            onClick={() => props.onSection(section.id)}
            className={`flex h-[38px] items-center gap-2.5 rounded-lg px-3 text-left text-sm ${props.section === section.id ? "bg-selected font-bold text-link" : "text-secondary hover:bg-subtle"}`}
          >
            <Icon name={section.icon} />
            {t(`settings.sections.${section.id}`)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-10 py-7">
        <div className="flex max-w-[640px] flex-col">
          {props.section === "general" && <GeneralSection key={props.displayName} {...props} />}
          {props.section === "libraries" && <LibrariesSection {...props} />}
          {props.section === "recording" && <RecordingSection {...props} />}
          {props.section === "shortcuts" && (
            <ShortcutsSection recorder={props.recorder} notify={props.notify} />
          )}
          {props.section === "privacy" && <PrivacySection {...props} />}
          {props.section === "export" && <ExportSection {...props} />}
          {props.section === "brands" && (
            <BrandsSection
              recorder={props.recorder}
              library={props.library}
              managedIds={props.managedBrandIds ?? []}
              brands={props.brands}
              onChanged={props.onBrandsChanged}
              notify={props.notify}
            />
          )}
          {props.section === "appearance" && (
            <>
              <h2 className="mb-3.5 font-heading text-xl text-navy">
                {t("settings.sections.appearance")}
              </h2>
              <Row label={t("settings.appearance.theme")} id="theme-label">
                <ThemeSwitch labelledBy="theme-label" theme={props.theme} onTheme={props.onTheme} />
              </Row>
              <BrandPicker
                id="app-colours"
                label={t("settings.appearance.appColours")}
                help={t("settings.appearance.appColoursHelp")}
                brands={props.brands}
                value={props.appColours}
                managed={policy().appColoursBrand !== null}
                onChange={props.onAppColours}
              />
              <BrandPicker
                id="pdf-brand"
                label={t("settings.appearance.pdfBrand")}
                help={t("settings.appearance.pdfBrandHelp")}
                brands={props.brands}
                value={pdfBrand}
                managed={policy().defaultPdfBrand !== null}
                onChange={(id) => {
                  saveDefaultBrand(id);
                  setPdfBrand(id);
                }}
              />
            </>
          )}
          {props.section === "about" && <AboutSection {...props} />}
        </div>
      </div>
    </div>
  );
}
