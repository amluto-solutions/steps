import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AMLUTO_BRAND_ID, newBrandProfile, type BrandProfile } from "@amluto-steps/core";

import { Icon } from "../components/icons";
import type { ToastMessage } from "../components/Toast";
import { errorMessage } from "../errors";
import { safeFileName } from "../files";
import type { FileDialogs } from "../library-bridge";
import type { Brands } from "../bridge/brands";
import type { Fonts } from "../bridge/fonts";
import { policy } from "./policy";
import { BrandEditor } from "./BrandEditor";
import {
  AMLUTO_PROFILE,
  amlbrandFile,
  logoSource,
  readAmlbrand,
  readDefaultBrand,
  saveDefaultBrand,
} from "./brands";

interface BrandsSectionProps {
  recorder: (Brands & Fonts) | undefined;
  /** For the open and save dialogs (brand files). */
  library?: FileDialogs | undefined;
  /** Brands IT deploys by policy: they can't be edited or deleted here. */
  managedIds?: string[];
  brands: BrandProfile[];
  onChanged: () => Promise<void>;
  notify: (toast: Omit<ToastMessage, "id">) => void;
}

const newId = () => `brand-${Date.now().toString(36)}`;
/** A new client brand starts from Amluto's blue until its own colour is chosen. */
const NEW_BRAND_COLOUR = AMLUTO_PROFILE.accent;

function Swatch({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-secondary">
      <span
        aria-hidden="true"
        className="size-4 rounded border border-panel"
        style={{ background: colour }}
      />
      {label}
    </span>
  );
}

/**
 * Brand profiles (docs/spec/06-brands-and-theming.md): the list, the default brand, and the
 * profile editor for client brands. The built-in Amluto profile can't be changed or deleted.
 */
export function BrandsSection({
  recorder,
  library,
  managedIds = [],
  brands,
  onChanged,
  notify,
}: BrandsSectionProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<BrandProfile | null>(null);
  const [defaultId, setDefaultId] = useState(readDefaultBrand);

  const save = async (profile: BrandProfile) => {
    if (!recorder) return;
    try {
      await recorder.saveBrand({ ...profile, version: profile.version + 1 });
      setEditing(null);
      await onChanged();
    } catch (error) {
      notify({ kind: "error", text: errorMessage(error, t("brands.failed")) });
    }
  };

  const filter = { name: t("brands.fileFilter"), extensions: ["amlbrand"] };

  /** Exports a profile as a `.amlbrand` file for someone else to import. */
  const exportBrand = async (profile: BrandProfile) => {
    if (!recorder || !library) return;
    const path = await library.pickSaveLocation(
      t("brands.exportTitle"),
      `${safeFileName(profile.name, "Brand")}.amlbrand`,
      [filter],
    );
    if (!path) return;
    try {
      await recorder.writeBrandFile(path, amlbrandFile(profile));
      notify({ text: t("brands.exported", { name: profile.name }) });
    } catch (error) {
      notify({ kind: "error", text: errorMessage(error, t("brands.failed")) });
    }
  };

  /**
   * Imports a `.amlbrand` file. A newer version of a brand already here updates it in place;
   * the same or an older one changes nothing.
   */
  const importBrand = async () => {
    if (!recorder || !library) return;
    const path = await library.pickFile(t("brands.importTitle"), [filter]);
    if (!path) return;
    try {
      const { profile, droppedFonts } = await readAmlbrand(
        await recorder.readBrandFile(path),
        (bytes) => recorder.checkFont(bytes),
      );
      const existing = brands.find((item) => item.id === profile.id);
      if (managedIds.includes(profile.id)) {
        notify({ text: t("brands.managedImport", { name: existing?.name ?? profile.name }) });
        return;
      }
      if (existing && existing.version >= profile.version) {
        notify({ text: t("brands.alreadyCurrent", { name: existing.name }) });
        return;
      }
      await recorder.saveBrand(profile);
      await onChanged();
      notify({
        text: [
          existing
            ? t("brands.importUpdated", { name: profile.name })
            : t("brands.imported", { name: profile.name }),
          ...droppedFonts.map((family) => t("brands.fontDropped", { family })),
        ].join(" "),
      });
    } catch {
      notify({ text: t("brands.importInvalid") });
    }
  };

  const remove = async (profile: BrandProfile) => {
    if (!recorder) return;
    try {
      await recorder.deleteBrand(profile.id);
      if (defaultId === profile.id) {
        saveDefaultBrand(AMLUTO_BRAND_ID);
        setDefaultId(AMLUTO_BRAND_ID);
      }
      await onChanged();
      notify({
        text: t("brands.deleted", { name: profile.name }),
        action: {
          label: t("common.undo"),
          run: () => void recorder.saveBrand(profile).then(onChanged),
        },
      });
    } catch (error) {
      notify({ kind: "error", text: errorMessage(error, t("brands.failed")) });
    }
  };

  return (
    <>
      <h2 className="mb-1 font-heading text-xl text-navy">{t("settings.sections.brands")}</h2>
      <p className="mb-4 text-sm leading-relaxed text-secondary">{t("brands.intro")}</p>
      <ul className="card flex flex-col">
        {[AMLUTO_PROFILE, ...brands].map((profile, index) => {
          const logo = logoSource(profile.coverLogo);
          return (
            <li
              key={profile.id}
              className={`flex flex-wrap items-center gap-3.5 px-4 py-3 ${index > 0 ? "border-t border-subtle" : ""}`}
            >
              <span className="flex h-10 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white p-1">
                {logo ? (
                  <img src={logo} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="size-6 rounded" style={{ background: profile.primary }} />
                )}
              </span>
              <div className="flex min-w-40 flex-1 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-navy">{profile.name}</strong>
                  {profile.id === AMLUTO_BRAND_ID && (
                    <span className="chip">{t("brands.builtIn")}</span>
                  )}
                  {profile.id === defaultId && (
                    <span className="chip bg-selected font-semibold text-link">
                      {t("brands.default")}
                    </span>
                  )}
                </div>
                <span className="flex gap-3">
                  <Swatch colour={profile.primary} label={t("brands.primary")} />
                  <Swatch colour={profile.accent} label={t("brands.accent")} />
                </span>
              </div>
              {/* The buttons move under the name when the window is narrow, rather than over it. */}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                {profile.id !== defaultId && policy().defaultPdfBrand === null && (
                  <button
                    type="button"
                    className="btn h-8 px-3"
                    onClick={() => {
                      saveDefaultBrand(profile.id);
                      setDefaultId(profile.id);
                    }}
                  >
                    {t("brands.makeDefault")}
                  </button>
                )}
                {managedIds.includes(profile.id) && (
                  <span className="flex items-center gap-1.5 text-xs text-secondary">
                    <Icon name="lock" size={14} />
                    {t("settings.managed")}
                  </span>
                )}
                {/* Any brand, the built-in Amluto one and your organisation's included, can start a new
                  one (29/09/2026): the copy is yours to change, the original stays as it is. */}
                <button
                  type="button"
                  className="btn h-8 px-3"
                  aria-label={t("brands.duplicateOne", { name: profile.name })}
                  onClick={() =>
                    setEditing({
                      ...profile,
                      id: newId(),
                      name: t("brands.copyName", { name: profile.name }),
                      version: 0,
                    })
                  }
                >
                  {t("brands.duplicate")}
                </button>
                {profile.id !== AMLUTO_BRAND_ID && !managedIds.includes(profile.id) && (
                  <>
                    <button
                      type="button"
                      className="btn h-8 px-3"
                      onClick={() => setEditing(profile)}
                    >
                      {t("brands.edit")}
                    </button>
                    <button
                      type="button"
                      className="btn h-8 px-3"
                      disabled={!library}
                      aria-label={t("brands.exportOne", { name: profile.name })}
                      onClick={() => void exportBrand(profile)}
                    >
                      {t("brands.export")}
                    </button>
                    <button
                      type="button"
                      className="icon-btn size-8"
                      aria-label={t("brands.delete", { name: profile.name })}
                      onClick={() => void remove(profile)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {!editing && (
        <div className="mt-3.5 flex gap-2.5">
          <button
            type="button"
            className="btn text-link"
            disabled={!recorder}
            onClick={() =>
              setEditing({ ...newBrandProfile(newId(), "", NEW_BRAND_COLOUR), version: 0 })
            }
          >
            <Icon name="plus" size={15} />
            {t("brands.add")}
          </button>
          <button
            type="button"
            className="btn"
            disabled={!recorder || !library}
            onClick={() => void importBrand()}
          >
            <Icon name="upload" size={15} />
            {t("brands.import")}
          </button>
        </div>
      )}

      {editing && (
        <BrandEditor
          key={editing.id}
          initial={editing}
          recorder={recorder}
          notify={notify}
          onCancel={() => setEditing(null)}
          onSave={(profile) => void save(profile)}
        />
      )}
    </>
  );
}
