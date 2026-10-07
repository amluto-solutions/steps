import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  contrast,
  deriveColours,
  ensureContrast,
  pdfLayoutOf,
  type BrandFont,
  type BrandProfile,
} from "@amluto-steps/core";

import type { ToastMessage } from "../components/Toast";
import { ModalDialog } from "../ModalDialog";
import type { Fonts, LocalFonts } from "../bridge/fonts";
import { logoSource, readLogo } from "./brands";

type Logo = BrandProfile["coverLogo"];
type Colour = "primary" | "accent" | "highlight";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** What each colour must reach against white (docs/spec/06-brands-and-theming.md#export-colours). */
const MIN_RATIO: Record<Colour, number> = { primary: 4.6, accent: 3, highlight: 3 };

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-panel pt-4">
      <legend className="mb-1 text-sm font-semibold text-navy">{title}</legend>
      {children}
    </fieldset>
  );
}

function ColourField({
  id,
  label,
  value,
  minRatio,
  onChange,
  onClear,
  clearLabel,
}: {
  id: string;
  label: string;
  value: string;
  minRatio: number;
  onChange: (value: string) => void;
  onClear?: () => void;
  /** What clearing does, for this colour ("worked out from the main colour" by default). */
  clearLabel?: string;
}) {
  const { t } = useTranslation();
  const readable = contrast(value, "#FFFFFF") >= minRatio;
  const suggestion = readable ? null : ensureContrast(value, "#FFFFFF", minRatio);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id} className="w-36 text-sm text-navy">
          {label}
        </label>
        <input
          id={id}
          type="color"
          value={value.toLowerCase()}
          onChange={(event) => onChange(event.currentTarget.value.toUpperCase())}
          className="h-9 w-12 cursor-pointer rounded-lg border border-line bg-background p-1"
        />
        <input
          aria-label={t("brands.hexFor", { colour: label })}
          defaultValue={value}
          key={value}
          maxLength={7}
          onBlur={(event) => {
            const typed = event.currentTarget.value.trim();
            if (HEX.test(typed)) onChange(typed.toUpperCase());
          }}
          className="field w-28 font-mono"
        />
        {onClear && (
          <button
            type="button"
            className="btn btn-quiet h-8"
            aria-label={clearLabel ?? t("brands.useDerivedFor", { colour: label })}
            onClick={onClear}
          >
            {clearLabel ?? t("brands.useDerived")}
          </button>
        )}
      </div>
      {suggestion && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
        >
          {t("brands.lowContrastFor", { colour: label })}
          <button type="button" className="btn h-7 px-2.5" onClick={() => onChange(suggestion)}>
            <span
              aria-hidden="true"
              className="size-3.5 rounded"
              style={{ background: suggestion }}
            />
            {t("brands.useSuggestion", { colour: suggestion })}
          </button>
        </p>
      )}
    </div>
  );
}

function LogoField({
  id,
  label,
  help,
  value,
  onChange,
  notify,
}: {
  id: string;
  label: string;
  help: string;
  value: Logo;
  onChange: (value: Logo) => void;
  notify: (toast: Omit<ToastMessage, "id">) => void;
}) {
  const { t } = useTranslation();
  const source = logoSource(value);
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="text-sm text-navy">
        {label}
      </span>
      <span className="text-xs text-secondary">{help}</span>
      <div role="group" className="flex flex-wrap items-center gap-3" aria-labelledby={id}>
        <span className="flex h-12 w-36 items-center justify-center overflow-hidden rounded-lg border border-panel bg-white p-1">
          {source ? (
            <img
              src={source}
              alt={t("brands.logoPreviewOf", { logo: label })}
              className="max-h-full max-w-full object-contain"
            />
          ) : (
            <span className="text-xs text-secondary">{t("brands.noLogo")}</span>
          )}
        </span>
        <label className="btn cursor-pointer">
          {t("brands.chooseLogo")}
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,.svg"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (!file) return;
              void readLogo(file)
                .then(onChange)
                .catch(() => notify({ text: t("brands.logoInvalid") }));
            }}
          />
        </label>
        {value && (
          <button type="button" className="btn btn-quiet" onClick={() => onChange(null)}>
            {t("brands.removeLogo")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Steps for Chrome: installed fonts go into PDFs once Chrome lets Steps read them. Asked once,
 * from a click, and Chrome remembers the answer.
 */
function LocalFontsNote({ access }: { access: LocalFonts }) {
  const { t } = useTranslation();
  const [state, setState] = useState<Awaited<ReturnType<typeof access.state>> | null>(null);
  useEffect(() => {
    let current = true;
    void access.state().then((found) => {
      if (current) setState(found);
    });
    return () => {
      current = false;
    };
  }, [access]);
  if (state === null || state === "granted") return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-subtle px-3 py-2.5 text-[13px] text-secondary">
      <span className="min-w-0 flex-1">
        {t(
          state === "prompt"
            ? "brands.localFontsAsk"
            : state === "denied"
              ? "brands.localFontsDenied"
              : "brands.localFontsUnsupported",
        )}
      </span>
      {state === "prompt" && (
        <button
          type="button"
          className="btn"
          onClick={() => void access.allow().then(() => access.state().then(setState))}
        >
          {t("brands.localFontsAllow")}
        </button>
      )}
    </div>
  );
}

function FontField({
  id,
  label,
  value,
  onChange,
  recorder,
  notify,
}: {
  id: string;
  label: string;
  value: BrandFont | null;
  onChange: (value: BrandFont | null) => void;
  recorder: Fonts | undefined;
  notify: (toast: Omit<ToastMessage, "id">) => void;
}) {
  const { t } = useTranslation();
  /** An uploaded .ttf: checked on this PC for its family and whether it may be embedded. */
  const upload = async (file: File, face: "regular" | "bold") => {
    if (!recorder) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      const info = await recorder.checkFont(bytes);
      if (!info.embeddable) {
        notify({ text: t("brands.fontNotEmbeddable", { family: info.family }) });
        return;
      }
      const data = bytesToBase64(bytes);
      const current = value?.uploaded ?? { regular: data, bold: null };
      onChange({
        family: face === "regular" || !value ? info.family : value.family,
        uploaded: face === "regular" ? { ...current, regular: data } : { ...current, bold: data },
      });
    } catch {
      notify({ text: t("brands.fontInvalid") });
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={id} className="w-36 text-sm text-navy">
          {label}
        </label>
        <input
          id={id}
          value={value?.family ?? ""}
          maxLength={80}
          readOnly={Boolean(value?.uploaded)}
          placeholder={t("brands.fontPlaceholder")}
          onChange={(event) => {
            const family = event.currentTarget.value;
            onChange(family.trim() ? { family, uploaded: null } : null);
          }}
          className="field w-52"
        />
        <label className="btn cursor-pointer">
          {value?.uploaded ? t("brands.replaceFont") : t("brands.uploadFont")}
          <input
            type="file"
            accept=".ttf,font/ttf"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void upload(file, "regular");
            }}
          />
        </label>
        {value?.uploaded && (
          <>
            <label className="btn cursor-pointer">
              {value.uploaded.bold ? t("brands.replaceBold") : t("brands.uploadBold")}
              <input
                type="file"
                accept=".ttf,font/ttf"
                className="sr-only"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file, "bold");
                }}
              />
            </label>
            <button type="button" className="btn btn-quiet" onClick={() => onChange(null)}>
              {t("brands.removeFont")}
            </button>
          </>
        )}
      </div>
      <span className="text-xs text-secondary">
        {value?.uploaded ? t("brands.fontUploaded") : t("brands.fontInstalled")}
      </span>
    </div>
  );
}

/** A small sample of an exported page in this brand, redrawn as the form changes. */
function Preview({ profile }: { profile: BrandProfile }) {
  const { t } = useTranslation();
  const logo = logoSource(profile.coverLogo);
  const heading = profile.headingFont?.family ?? "Century Gothic";
  const body = profile.bodyFont?.family ?? "Aptos";
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-paper-line bg-white p-4 text-paper-ink">
      <figcaption className="sr-only">{t("brands.preview")}</figcaption>
      {logo && <img src={logo} alt="" className="h-7 w-auto self-start object-contain" />}
      <strong
        style={{ color: profile.primary, fontFamily: `"${heading}", sans-serif` }}
        className="text-lg"
      >
        {t("brands.previewTitle")}
      </strong>
      <span className="flex items-center gap-2" style={{ fontFamily: `"${body}", sans-serif` }}>
        <span
          aria-hidden="true"
          className="grid size-6 place-items-center rounded-full text-xs font-bold text-white"
          style={{ background: profile.primary }}
        >
          1
        </span>
        <span className="text-sm font-semibold">{t("brands.previewStep")}</span>
      </span>
      <span className="relative ml-8 h-12 rounded border border-paper-line bg-paper-subtle">
        <span
          aria-hidden="true"
          className="absolute top-2 left-4 h-6 w-20 rounded border-[3px]"
          style={{ borderColor: profile.highlight }}
        />
        <span
          aria-hidden="true"
          className="absolute top-3 left-32 h-1 w-16 rounded"
          style={{ background: profile.accent }}
        />
      </span>
      {profile.footer && (
        <span
          className="text-[11px] text-paper-muted"
          style={{ fontFamily: `"${body}", sans-serif` }}
        >
          {profile.footer}
        </span>
      )}
    </figure>
  );
}

/**
 * The brand profile editor (docs/spec/06-brands-and-theming.md): logos, the three colours with a
 * contrast warning and a suggested shade (never applied silently), fonts, footer, page options and
 * optional dark-mode colours, with a live preview.
 */
export function BrandEditor({
  initial,
  recorder,
  notify,
  onCancel,
  onSave,
}: {
  initial: BrandProfile;
  recorder: Fonts | undefined;
  notify: (toast: Omit<ToastMessage, "id">) => void;
  onCancel: () => void;
  onSave: (profile: BrandProfile) => void;
}) {
  const { t } = useTranslation();
  const [profile, setProfile] = useState(initial);
  const update = (patch: Partial<BrandProfile>) =>
    setProfile((current) => ({ ...current, ...patch }));
  const setDark = (colour: Colour, value: string | undefined) =>
    setProfile((current) => {
      const kept = Object.entries(current.dark ?? {}).filter(([name]) => name !== colour);
      const dark = Object.fromEntries(value ? [...kept, [colour, value]] : kept) as NonNullable<
        BrandProfile["dark"]
      >;
      return { ...current, dark: Object.keys(dark).length ? dark : null };
    });

  // A dialog the size of the window (28/09/2026: squeezed into the settings column, the
  // editor and its preview were a thin strip), with the preview beside the choices it shows,
  // and under them in a window too narrow for both (06/10/2026: it sat over the logo buttons).
  return (
    <div className="fixed inset-0 z-[800] grid place-items-center bg-scrim/50 p-4">
      <ModalDialog
        labelledBy="brand-editor-title"
        onEscape={onCancel}
        className="card flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          aria-label={t("brands.form")}
          onSubmit={(event) => {
            event.preventDefault();
            if (profile.name.trim()) onSave({ ...profile, name: profile.name.trim() });
          }}
        >
          <h2
            id="brand-editor-title"
            className="border-b border-panel px-6 py-4 font-heading text-xl text-navy"
          >
            {initial.version === 0
              ? t("brands.newTitle")
              : t("brands.editTitle", { name: initial.name })}
          </h2>
          <div className="grid min-h-0 flex-1 gap-6 overflow-y-auto px-6 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,380px)]">
            <div className="flex min-w-0 flex-col gap-4">
              <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
                {t("brands.name")}
                <input
                  required
                  maxLength={80}
                  value={profile.name}
                  onChange={(event) => update({ name: event.currentTarget.value })}
                  placeholder={t("brands.namePlaceholder")}
                  className="field font-normal"
                />
              </label>

              <Section title={t("brands.logos")}>
                <LogoField
                  id="brand-cover-logo"
                  label={t("brands.coverLogo")}
                  help={t("brands.coverLogoHelp")}
                  value={profile.coverLogo}
                  onChange={(coverLogo) => update({ coverLogo })}
                  notify={notify}
                />
                <LogoField
                  id="brand-page-logo"
                  label={t("brands.pageLogo")}
                  help={t("brands.pageLogoHelp")}
                  value={profile.pageLogo}
                  onChange={(pageLogo) => update({ pageLogo })}
                  notify={notify}
                />
              </Section>

              <Section title={t("brands.colours")}>
                <ColourField
                  id="brand-primary"
                  label={t("brands.colour")}
                  value={profile.primary}
                  minRatio={MIN_RATIO.primary}
                  onChange={(primary) => update({ primary })}
                />
                <ColourField
                  id="brand-accent"
                  label={t("brands.accent")}
                  value={profile.accent}
                  minRatio={MIN_RATIO.accent}
                  onChange={(accent) => update({ accent })}
                  onClear={() => update({ accent: deriveColours(profile.primary).accent })}
                />
                <ColourField
                  id="brand-highlight"
                  label={t("brands.highlight")}
                  value={profile.highlight}
                  minRatio={MIN_RATIO.highlight}
                  onChange={(highlight) => update({ highlight })}
                  onClear={() => update({ highlight: deriveColours(profile.primary).highlight })}
                />
              </Section>

              <Section title={t("brands.fonts")}>
                <FontField
                  id="brand-heading-font"
                  label={t("brands.headingFont")}
                  value={profile.headingFont}
                  onChange={(headingFont) => update({ headingFont })}
                  recorder={recorder}
                  notify={notify}
                />
                <FontField
                  id="brand-body-font"
                  label={t("brands.bodyFont")}
                  value={profile.bodyFont}
                  onChange={(bodyFont) => update({ bodyFont })}
                  recorder={recorder}
                  notify={notify}
                />
                {recorder?.localFonts && <LocalFontsNote access={recorder.localFonts} />}
              </Section>

              <Section title={t("brands.pages")}>
                <label className="flex flex-col gap-1 text-sm text-navy">
                  {t("brands.footer")}
                  <input
                    maxLength={200}
                    value={profile.footer}
                    onChange={(event) => update({ footer: event.currentTarget.value })}
                    placeholder={t("brands.footerPlaceholder")}
                    className="field"
                  />
                </label>
                <div className="flex flex-wrap gap-3 text-sm text-navy">
                  <label className="flex items-center gap-2">
                    {t("export.pageSize")}
                    <select
                      className="field"
                      value={profile.pageSize}
                      onChange={(event) =>
                        update({
                          pageSize: event.currentTarget.value === "LETTER" ? "LETTER" : "A4",
                        })
                      }
                    >
                      <option value="A4">{t("export.a4")}</option>
                      <option value="LETTER">{t("export.letter")}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    {t("export.orientation")}
                    <select
                      className="field"
                      value={profile.orientation}
                      onChange={(event) =>
                        update({
                          orientation:
                            event.currentTarget.value === "landscape" ? "landscape" : "portrait",
                        })
                      }
                    >
                      <option value="portrait">{t("export.portrait")}</option>
                      <option value="landscape">{t("export.landscape")}</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    {t("export.layout")}
                    <select
                      className="field"
                      value={profile.layout}
                      onChange={(event) =>
                        update({
                          layout: pdfLayoutOf(event.currentTarget.value),
                        })
                      }
                    >
                      <option value="standard">{t("export.standard")}</option>
                      <option value="page">{t("export.layoutPage")}</option>
                      <option value="compact">{t("export.compact")}</option>
                    </select>
                  </label>
                </div>
              </Section>

              <details className="border-t border-panel pt-4">
                <summary className="cursor-pointer text-sm font-semibold text-navy">
                  {t("brands.dark")}
                </summary>
                <p className="mt-2 text-xs text-secondary">{t("brands.darkHelp")}</p>
                <div className="mt-3 flex flex-col gap-3">
                  {(["primary", "accent", "highlight"] as const).map((colour) => {
                    const value = profile.dark?.[colour];
                    return value ? (
                      <ColourField
                        key={colour}
                        id={`brand-dark-${colour}`}
                        label={t(`brands.dark_${colour}`)}
                        value={value}
                        minRatio={0}
                        onChange={(next) => setDark(colour, next)}
                        onClear={() => setDark(colour, undefined)}
                        clearLabel={t("brands.clearDark", { colour: t(`brands.dark_${colour}`) })}
                      />
                    ) : (
                      <button
                        key={colour}
                        type="button"
                        className="btn self-start"
                        onClick={() => setDark(colour, profile[colour])}
                      >
                        {t("brands.setDark", { colour: t(`brands.dark_${colour}`) })}
                      </button>
                    );
                  })}
                </div>
              </details>
            </div>
            <div className="lg:sticky lg:top-0 lg:self-start">
              <Preview profile={profile} />
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-panel px-6 py-4">
            <button type="button" className="btn" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary">
              {t("brands.save")}
            </button>
          </div>
        </form>
      </ModalDialog>
    </div>
  );
}
