import {
  LANGUAGES,
  docIn,
  looksLikeSecret,
  languageName,
  mainLanguage,
  pdfLayoutOf,
  visibleStepText,
  type GuideStep,
} from "@amluto-steps/core";
import { rebuildsWording, setAllValues, setShowValue, type Stamp } from "../editor/edits";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { headerCount, type PdfOptions } from "@amluto-steps/export";

import { Spinner } from "../components/Spinner";
import { Icon } from "../components/icons";
import type { Edit, EditorDoc } from "../editor/document";
import { errorMessage } from "../errors";
import type { FileFilter, VersionInfo } from "../library-bridge";
import { ModalDialog } from "../ModalDialog";
import type { Fonts } from "../bridge/fonts";
import type { Capabilities } from "../capabilities";
import type { ExportFiles } from "./export-files";
import { askConfirm } from "../app/ask";
import type { ExportChoices } from "../settings/preferences";
import { blurFoundEdit } from "../editor/suggestions";
import type { TextReader } from "../screen-words";
import { FORMATS, exportJob, fullyWritten, type ExportFormat, type PageLanguages } from "./job";
import { exportPreparation } from "./preparation";
import { StepQuickEdit } from "./StepQuickEdit";
import { UndoButtons } from "./UndoButtons";
import type { BrandProfile } from "@amluto-steps/core";
import { AMLUTO_PROFILE } from "../settings/brands";

export type { ExportFormat } from "./job";

export interface ExportDialogProps {
  format: ExportFormat;
  doc: EditorDoc;
  preparedBy: string;
  /** Where the export is written, the PC's fonts for a PDF, and whether this copy opens exports. */
  recorder: ExportFiles & Fonts & { readonly capabilities: Capabilities };
  /** Reads the screenshots' words for the personal-data check; absent, none can be checked. */
  textReader: TextReader | undefined;
  loadImage: (mediaId: string) => Promise<string>;
  pickSaveLocation: (
    title: string,
    defaultName: string,
    filters: FileFilter[],
  ) => Promise<string | null>;
  /** The first export of a session carries the "check for personal data" reminder. */
  firstExport: boolean;
  onClose: () => void;
  /** Export… for several guides: which of them this review is. */
  progress?: { index: number; total: number; title: string } | undefined;
  /** Called after a file is saved or the clipboard filled (for the automatic version). */
  onExported: (format: ExportFormat, message: string, path: string | null) => void;
  /** "Back to editor" at a flagged step. */
  onShowStep?: ((stepId: string) => void) | undefined;
  /** Client brands besides the built-in Amluto one. */
  brands: BrandProfile[];
  blurTerms: string[];
  /** Settings and IT policy as this export uses them, read once as it starts (`readExportChoices`). */
  choices: ExportChoices;
  /**
   * .amlsteps only: writes the file from the saved guide (after the editor's pending edits),
   * with blur burned in unless the unblurred originals are asked for.
   */
  saveAmlsteps?: ((path: string, includeOriginals: boolean) => Promise<void>) | undefined;
  /** The guide's saved versions, for the document-control page (a guide in a library). */
  listVersions?: (() => Promise<VersionInfo[]>) | undefined;
  /**
   * Changes the guide from the review (the typed-value toggles): through the editor's own undo
   * and saving when it's open, otherwise saved straight to the library. Absent: read-only.
   */
  edit?: ((make: (doc: EditorDoc, stamp: Stamp) => Edit | null) => void) | undefined;
  /** Takes back the last change made in this review (Ctrl+Z too); absent when there's none. */
  undo?: (() => void) | undefined;
  /** Puts back a change taken back (Ctrl+Y); absent when there's none. */
  redo?: (() => void) | undefined;
}

/** A finding's box on the exported (cropped) picture, as percentages, or null if cropped off. */
function onPicture(step: GuideStep, rect: { x: number; y: number; w: number; h: number }) {
  const crop = step.crop ?? { x: 0, y: 0, w: 100, h: 100 };
  if (crop.w <= 0 || crop.h <= 0) return null;
  const x = ((rect.x - crop.x) / crop.w) * 100;
  const y = ((rect.y - crop.y) / crop.h) * 100;
  const w = (rect.w / crop.w) * 100;
  const h = (rect.h / crop.h) * 100;
  return x + w <= 0 || y + h <= 0 || x >= 100 || y >= 100 ? null : { x, y, w, h };
}

/** The player, styles and embedded fonts, in bytes, on top of the screenshots. */
const WALKTHROUGH_OVERHEAD = 90_000;

/**
 * Review before export (docs/spec/05-export.md#review-before-export): every screenshot exactly as
 * it will be exported, and a checklist of what to look at, before anything leaves the app.
 */
export function ExportDialog(props: ExportDialogProps) {
  const { t } = useTranslation();
  const format = FORMATS[props.format];
  /**
   * The screenshots as they will be exported, their personal-data findings (outlined in the
   * filmstrip), and the steps unchecked or missing: prepared once for this review, each
   * screenshot loaded and read once, so a brand change only redraws them.
   */
  const [preparation] = useState(() =>
    exportPreparation({
      loadImage: props.loadImage,
      textReader: props.textReader,
      walkthrough: format.walkthrough,
      blurTerms: props.blurTerms,
      findings: props.choices.findings,
    }),
  );
  const { images, plainImages, findings, unchecked, missing, progress } = useSyncExternalStore(
    preparation.subscribe,
    () => preparation.state,
  );
  const shown = preparation.shown;
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Walkthrough only: 1920 px JPEG pictures, about half the size (docs/spec/05-export.md). */
  const optimise = props.choices.optimiseForSharing;
  /** .amlsteps only: off unless chosen, with a warning (docs/spec/03-data-and-sharing.md). */
  const [includeOriginals, setIncludeOriginals] = useState(false);
  /** IT can keep unblurred originals out of .amlsteps files (the `IncludeOriginals` lock). */
  const originalsLocked = props.choices.originalsLocked;
  const profiles = [AMLUTO_PROFILE, ...props.brands];
  const initialBrand =
    profiles.find((profile) => profile.id === props.doc.guide.brandProfileId) ??
    profiles.find((profile) => profile.id === props.choices.defaultBrand) ??
    AMLUTO_PROFILE;
  const [brand, setBrand] = useState<BrandProfile>(initialBrand);
  const [options, setOptions] = useState<PdfOptions>({
    pageSize: initialBrand.pageSize,
    orientation: initialBrand.orientation,
    layout: initialBrand.layout,
  });
  /**
   * PDF and Word: a contents page from the header blocks (on when there are two or more), and a
   * document-control page (off unless asked for).
   */
  const sectionCount = headerCount(props.doc.steps);
  const [contentsPage, setContentsPage] = useState(sectionCount >= 2);
  const [controlPage, setControlPage] = useState(false);
  const paged = props.format === "pdf" || props.format === "docx";

  // ----- Languages (docs/spec/05-export.md#languages) -----
  const main = mainLanguage(props.doc.guide);
  /** PDF, Word and the clipboard: the language exported in, the guide's main one unless chosen. */
  const [language, setLanguage] = useState(main);
  /** PDF and Word: more languages, each its own file (not asked about on every export). */
  const [alsoIn, setAlsoIn] = useState<ReadonlySet<string>>(new Set());
  /** The web page: every language, the ones fully written, or only the guide's own. */
  const [pageLanguages, setPageLanguages] = useState<PageLanguages>("all");
  /** Each language exported in, with how many hand-written texts it hasn't got yet (F041). */
  const notWrittenIn = [language, ...alsoIn]
    .filter((code, index, all) => code !== main && all.indexOf(code) === index)
    .map((code) => ({ code, count: docIn(props.doc, code).missing.length }))
    .filter((item) => item.count > 0);
  /** How many languages every text the guide's writer wrote has been written in. */
  const writtenCount = fullyWritten(props.doc).length;
  const withImages = useMemo(
    () => props.doc.steps.filter((step) => step.kind === "interaction" && step.media?.id),
    [props.doc.steps],
  );
  const numbers = useMemo(() => {
    const map = new Map<string, number>();
    let next = 1;
    for (const step of props.doc.steps) if (step.kind === "interaction") map.set(step.id, next++);
    return map;
  }, [props.doc.steps]);
  const flagged = props.doc.steps.filter((step) => step.reviewRequired);
  const withValues = props.doc.steps.filter((step) => step.textParts.value);
  const showingValues = withValues.filter((step) => step.showValue);
  /** Shown values that look like a password (A1): warned about, with one press to hide them. */
  const secretLike = showingValues.filter((step) => looksLikeSecret(step.textParts.value ?? ""));
  /** Screenshots whose alt text is still the generated one (a note only). */
  const unblurred = [...findings]
    .filter(([, found]) => found.length > 0)
    .map(([stepId, found]) => ({ stepId, count: found.length }));
  const blurCount = props.doc.steps.reduce((sum, step) => sum + step.redactions.length, 0);

  // Every screenshot drawn the way it will be exported, and again in a new brand's colours when
  // the brand changes; the first pass also checks them for personal data.
  useEffect(() => {
    const stop = new AbortController();
    void preparation.prepare(props.doc.steps, brand, stop.signal);
    return () => stop.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redrawn only when the brand changes
  }, [brand.id]);

  /**
   * Blur all, from the review: every possible personal detail found is blurred as one edit (undone
   * in the editor like any other), and those screenshots are drawn again to show it.
   */
  const [blurringAll, setBlurringAll] = useState(false);
  const blurAll = async () => {
    const edit = props.edit;
    if (!edit) return;
    setBlurringAll(true);
    await preparation.blurAll(props.doc.steps, brand, (found) =>
      edit(blurFoundEdit(found, t("editor.undo.blur"))),
    );
    setBlurringAll(false);
  };

  /** The step open for a quick fix, from a checklist line or the filmstrip (28/09/2026). */
  const [quickEdit, setQuickEdit] = useState<string | null>(null);
  const editable = props.edit !== undefined;
  // From the review a step opens on top of it when it can be edited here; otherwise the line's
  // step numbers go back to the editor as before.
  const showStep = editable ? (id: string) => setQuickEdit(id) : props.onShowStep;

  const quickStep = quickEdit ? props.doc.steps.find((item) => item.id === quickEdit) : undefined;
  const closeQuickEdit = () => {
    const id = quickEdit;
    setQuickEdit(null);
    if (id) void refreshStep(id);
  };

  /** After a quick fix: that step's picture drawn and checked for personal data again. */
  const refreshStep = async (id: string) => {
    const step = props.doc.steps.find((item) => item.id === id);
    if (step) await preparation.refresh(step, brand);
  };

  // After Undo or Redo, the screenshots they changed are drawn and checked again, once the
  // changed guide has arrived.
  const stepped = useRef(false);
  const previousDoc = useRef(props.doc);
  useEffect(() => {
    const before = previousDoc.current;
    previousDoc.current = props.doc;
    if (!stepped.current) return;
    stepped.current = false;
    const old = new Map(before.steps.map((item) => [item.id, item]));
    for (const item of props.doc.steps) if (old.get(item.id) !== item) void refreshStep(item.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the guide changes
  }, [props.doc]);
  const undo =
    props.undo &&
    (() => {
      stepped.current = true;
      props.undo?.();
    });
  const redo =
    props.redo &&
    (() => {
      stepped.current = true;
      props.redo?.();
    });

  // Every screenshot has been tried in this brand, whether it drew or not: one missing picture
  // mustn't block the export for ever.
  const ready = progress.brandId === brand.id && progress.count >= withImages.length;

  /**
   * Running the export: formats, languages, file names, the folder or the save dialog, and the
   * PDF's fonts, written through the bridge's export files.
   */
  const job = exportJob({
    files: props.recorder,
    askWhere: (defaultName) =>
      props.pickSaveLocation(
        // A .amlsteps file is for handing a guide to another Steps user, so it's always asked.
        props.format === "amlsteps" ? t("export.amlsteps.pickTitle") : t("export.saveTitle"),
        defaultName,
        [{ name: t(`export.filters.${props.format}`), extensions: [format.extension ?? ""] }],
      ),
    findFont: (family) => props.recorder.getFontFamily(family),
    listVersions: props.listVersions,
    saveAmlsteps: props.saveAmlsteps,
  });
  /** The export as chosen in this review, with its pictures as prepared. */
  const request = () => ({
    format: props.format,
    doc: props.doc,
    preparedBy: props.preparedBy,
    brand,
    images,
    plainImages,
    language,
    alsoIn: [...alsoIn],
    pageLanguages,
    pdf: options,
    contentsPage,
    controlPage,
    includeOriginals,
    choices: props.choices,
    now: new Date(),
  });

  /** The walkthrough in the default browser, exactly as a recipient will see it. */
  const preview = async () => {
    setBusy(true);
    setProblem(null);
    try {
      await job.preview(request());
    } catch (error) {
      setProblem(errorMessage(error, t("export.failed")));
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await job.run(request());
      if (outcome.kind === "cancelled") {
        setBusy(false);
        return;
      }
      if (outcome.kind === "copied") props.onExported("copy", t("export.copied"), null);
      else if (outcome.kind === "amlsteps")
        props.onExported("amlsteps", t("export.amlsteps.done"), null);
      else {
        const savedName = outcome.path.split(/[\\/]/).at(-1) ?? outcome.path;
        props.onExported(
          props.format,
          [
            outcome.count > 1
              ? t("export.savedSeveral", { count: outcome.count, name: savedName })
              : t("export.saved", { name: savedName }),
            ...(outcome.fontsMissing ? [t("export.fontsMissing")] : []),
          ].join(" "),
          // A browser saves by name only: no path to copy or file to open.
          props.recorder.capabilities.openExports ? outcome.path : null,
        );
      }
      props.onClose();
    } catch (error) {
      setProblem(errorMessage(error, t("export.failed")));
      setBusy(false);
    }
  };

  const formatName = t(`export.formats.${props.format}`);

  return (
    <div className="fixed inset-0 z-[850] grid place-items-center bg-scrim/55 p-6">
      <ModalDialog
        labelledBy="export-title"
        onEscape={props.onClose}
        onUndo={undo}
        onRedo={redo}
        className="card flex h-full max-h-[720px] w-full max-w-[1000px] flex-col overflow-hidden"
      >
        <div className="flex items-center gap-3 border-b border-panel px-6 py-4">
          <h2 id="export-title" className="flex flex-1 flex-col font-heading text-xl text-navy">
            {t("export.reviewTitle", { format: formatName })}
            {props.progress && (
              <span className="font-sans text-sm font-normal text-secondary">
                {t("export.progress", props.progress)}
              </span>
            )}
          </h2>
          {props.edit && <UndoButtons undo={undo} redo={redo} />}
          <button
            type="button"
            className="icon-btn"
            aria-label={t("common.close")}
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <section
            aria-label={t("export.filmstrip")}
            className="min-w-0 flex-1 overflow-y-auto bg-subtle p-4"
          >
            {!ready && (
              <p role="status" className="mb-3 text-sm text-secondary">
                {t("export.preparing", {
                  done: progress.brandId === brand.id ? progress.count : 0,
                  total: withImages.length,
                })}
              </p>
            )}
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {props.doc.steps
                .filter((step) => step.kind === "interaction")
                .map((step) => {
                  const image = images.get(step.id);
                  return (
                    <li key={step.id} className="card overflow-hidden">
                      <div className="flex h-[110px] items-center justify-center bg-background">
                        {image ? (
                          <span className="relative inline-flex max-h-full max-w-full">
                            <img
                              src={image.dataUrl}
                              alt={step.altText?.trim() || visibleStepText(step)}
                              className="max-h-[110px] max-w-full object-contain"
                            />
                            {/* Possible personal data not yet blurred, outlined like in the editor. */}
                            {(findings.get(step.id) ?? []).map((finding, index) => {
                              const box = onPicture(shown(step), finding.rect);
                              return box ? (
                                <span
                                  key={index}
                                  aria-hidden="true"
                                  className="absolute rounded-sm border-2 border-dashed border-warning"
                                  style={{
                                    left: `${box.x}%`,
                                    top: `${box.y}%`,
                                    width: `${box.w}%`,
                                    height: `${box.h}%`,
                                  }}
                                />
                              ) : null;
                            })}
                          </span>
                        ) : step.media?.id ? (
                          <span className="text-xs text-secondary">{t("export.drawing")}</span>
                        ) : (
                          <Icon name="note" className="text-secondary" />
                        )}
                      </div>
                      {editable ? (
                        <button
                          type="button"
                          className="line-clamp-2 w-full px-2.5 py-2 text-left text-xs text-body hover:bg-subtle"
                          aria-label={t("export.quickEdit.open", {
                            number: numbers.get(step.id) ?? "?",
                          })}
                          onClick={() => setQuickEdit(step.id)}
                        >
                          <strong className="mr-1 text-navy">{numbers.get(step.id)}.</strong>
                          {visibleStepText(step)}
                        </button>
                      ) : (
                        <p className="line-clamp-2 px-2.5 py-2 text-xs text-body">
                          <strong className="mr-1 text-navy">{numbers.get(step.id)}.</strong>
                          {visibleStepText(step)}
                        </p>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
          <aside
            aria-label={t("export.checklist")}
            className="flex w-[330px] shrink-0 flex-col border-l border-panel"
          >
            {/* The checklist and options scroll; Export stays in view below them (30/09/2026). */}
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto p-5">
              {props.firstExport && (
                <p className="rounded-lg bg-warning-soft px-3 py-2.5 text-sm text-warning">
                  {t("export.personalData")}
                </p>
              )}
              <ul className="flex flex-col gap-3 text-sm">
                <li className="flex gap-2.5">
                  <Icon
                    name={flagged.length ? "warning" : "check"}
                    className={flagged.length ? "text-warning" : "text-blue"}
                  />
                  <div className="flex flex-col gap-1">
                    <span>
                      {flagged.length
                        ? t("export.flagged", { count: flagged.length })
                        : t("export.noFlagged")}
                    </span>
                    <StepChips
                      ids={flagged.map((step) => step.id)}
                      numbers={numbers}
                      onShowStep={showStep}
                    />
                  </div>
                </li>
                {secretLike.length > 0 && (
                  <li className="flex gap-2.5">
                    <Icon name="warning" className="text-warning" />
                    <div className="flex flex-col gap-1">
                      <span>{t("export.secretLike", { count: secretLike.length })}</span>
                      <StepChips
                        ids={secretLike.map((step) => step.id)}
                        numbers={numbers}
                        onShowStep={showStep}
                      />
                      {props.edit && (
                        <button
                          type="button"
                          className="btn mt-1 h-8 self-start px-3"
                          onClick={() => {
                            for (const step of secretLike)
                              props.edit?.((doc, stamp) =>
                                setShowValue(doc, step.id, false, stamp),
                              );
                          }}
                        >
                          {t("export.hideSecretLike", { count: secretLike.length })}
                        </button>
                      )}
                    </div>
                  </li>
                )}
                <li className="flex gap-2.5">
                  <Icon name={showingValues.length ? "text" : "check"} className="text-blue" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span>
                      {showingValues.length
                        ? t("export.valuesShown", { count: showingValues.length })
                        : t("export.noValues")}
                    </span>
                    {withValues.length > 0 && props.edit && (
                      <>
                        <ul className="flex flex-col gap-1">
                          {withValues.map((step) => (
                            <li key={step.id}>
                              <label className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={step.showValue}
                                  onChange={async (event) => {
                                    const show = event.currentTarget.checked;
                                    const rebuild = await rebuildsWording(step, show, () =>
                                      askConfirm(
                                        t("editor.replaceEditedTitle"),
                                        t("editor.replaceEditedText"),
                                        t("editor.replaceEditedYes"),
                                      ),
                                    );
                                    props.edit?.((doc, stamp) =>
                                      setShowValue(doc, step.id, show, stamp, rebuild),
                                    );
                                  }}
                                />
                                <span className="truncate">
                                  {t("export.showValueFor", {
                                    number: numbers.get(step.id) ?? "?",
                                    value: step.textParts.value,
                                  })}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        {showingValues.length > 0 && (
                          <button
                            type="button"
                            className="self-start text-xs text-link underline"
                            onClick={() =>
                              props.edit?.((doc, stamp) => setAllValues(doc, false, stamp))
                            }
                          >
                            {t("export.hideAllValues")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </li>
                <li className="flex gap-2.5">
                  <Icon
                    name={unblurred.length || unchecked.length ? "warning" : "check"}
                    className={unblurred.length || unchecked.length ? "text-warning" : "text-blue"}
                  />
                  <div className="flex flex-col gap-1">
                    <span>
                      {unblurred.length
                        ? t("export.unblurred", {
                            count: unblurred.reduce((sum, item) => sum + item.count, 0),
                          })
                        : !ready
                          ? t("export.checkingPersonal")
                          : unchecked.length
                            ? t("export.notChecked", { count: unchecked.length })
                            : t("export.noUnblurred")}
                    </span>
                    {unblurred.length > 0 && unchecked.length > 0 && (
                      <span>{t("export.notChecked", { count: unchecked.length })}</span>
                    )}
                    <StepChips
                      ids={unblurred.map((item) => item.stepId)}
                      numbers={numbers}
                      onShowStep={showStep}
                    />
                    {unblurred.length > 0 && props.edit && (
                      <button
                        type="button"
                        className="btn mt-1 h-8 self-start px-3"
                        disabled={blurringAll}
                        onClick={() => void blurAll()}
                      >
                        <Icon name="blur" size={15} />
                        {t("suggest.blurAllGuide")}
                      </button>
                    )}
                  </div>
                </li>
                {props.format !== "html" &&
                  props.format !== "amlsteps" &&
                  notWrittenIn.map((item) => (
                    <li key={item.code} className="flex gap-2.5">
                      <Icon name="warning" className="text-warning" />
                      <span>
                        {t("export.languages.notWritten", {
                          count: item.count,
                          name: languageName(item.code),
                          main: languageName(main),
                        })}
                      </span>
                    </li>
                  ))}
                {missing.length > 0 && (
                  <li className="flex gap-2.5">
                    <Icon name="warning" className="text-warning" />
                    <div className="flex flex-col gap-1">
                      <span>{t("export.missingImages", { count: missing.length })}</span>
                      <StepChips ids={missing} numbers={numbers} onShowStep={showStep} />
                    </div>
                  </li>
                )}
                <li className="flex gap-2.5">
                  <Icon name="blur" className="text-blue" />
                  <span>
                    {blurCount ? t("export.blurBurned", { count: blurCount }) : t("export.noBlur")}
                  </span>
                </li>
              </ul>
              {format.brand === "always" ||
              (format.brand === "when-several" && profiles.length > 1) ? (
                <label className="flex items-center justify-between gap-2 border-t border-panel pt-4 text-sm font-semibold text-navy">
                  {t("export.brand")}
                  <select
                    className="field font-normal"
                    value={brand.id}
                    onChange={(event) => {
                      const chosen = profiles.find(
                        (profile) => profile.id === event.currentTarget.value,
                      );
                      if (!chosen) return;
                      setBrand(chosen);
                      setOptions({
                        pageSize: chosen.pageSize,
                        orientation: chosen.orientation,
                        layout: chosen.layout,
                      });
                    }}
                  >
                    {profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {props.format === "html" ? (
                <div className="flex flex-col gap-1.5 border-t border-panel pt-4 text-sm">
                  <label htmlFor="export-page-languages" className="font-semibold text-navy">
                    {t("export.languages.inPage")}
                  </label>
                  <select
                    id="export-page-languages"
                    aria-describedby="export-page-languages-help"
                    className="field"
                    value={pageLanguages}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setPageLanguages(value === "written" || value === "main" ? value : "all");
                    }}
                  >
                    <option value="all">
                      {t("export.languages.all", { count: LANGUAGES.length })}
                    </option>
                    <option value="written">
                      {t("export.languages.written", { count: writtenCount })}
                    </option>
                    <option value="main">
                      {t("export.languages.just", { name: languageName(main) })}
                    </option>
                  </select>
                  <p id="export-page-languages-help" className="text-xs text-secondary">
                    {pageLanguages === "main"
                      ? t("export.languages.justHelp")
                      : t("export.languages.pageHelp", { main: languageName(main) })}
                  </p>
                </div>
              ) : props.format !== "amlsteps" ? (
                <div className="flex min-w-0 flex-col gap-2 border-t border-panel pt-4 text-sm">
                  <label className="flex items-center justify-between gap-2 font-semibold text-navy">
                    {t("export.languages.language")}
                    <select
                      className="field min-w-0 font-normal"
                      value={language}
                      onChange={(event) => setLanguage(event.currentTarget.value)}
                    >
                      {LANGUAGES.map((item) => (
                        <option key={item.code} value={item.code} lang={item.code}>
                          {item.code === main
                            ? t("export.languages.mainOption", { name: item.name })
                            : item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {paged && (
                    // One language is the usual export; more is a choice made here, not asked
                    // every time (01/10/2026).
                    <details className="text-navy">
                      <summary className="cursor-pointer text-sm">
                        {alsoIn.size > 0
                          ? t("export.languages.moreChosen", { count: alsoIn.size })
                          : t("export.languages.more")}
                      </summary>
                      <p className="mt-1 text-xs text-secondary">
                        {t("export.languages.moreHelp")}
                      </p>
                      <ul className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
                        {LANGUAGES.filter((item) => item.code !== language).map((item) => (
                          <li key={item.code}>
                            <label className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={alsoIn.has(item.code)}
                                onChange={(event) => {
                                  const next = new Set(alsoIn);
                                  if (event.currentTarget.checked) next.add(item.code);
                                  else next.delete(item.code);
                                  setAlsoIn(next);
                                }}
                              />
                              <span lang={item.code}>{item.name}</span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              ) : null}
              {paged && (
                <fieldset className="flex min-w-0 flex-col gap-2 border-t border-panel pt-4 text-sm">
                  <legend className="mb-1 text-sm font-semibold text-navy">
                    {t("export.frontPages")}
                  </legend>
                  {/* Offered only when it can be ticked (01/10/2026): a greyed-out box with
                      a hint under it read as broken. */}
                  {sectionCount > 0 && (
                    <label className="flex items-start gap-2 text-navy">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={contentsPage}
                        onChange={(event) => setContentsPage(event.currentTarget.checked)}
                      />
                      <span className="flex flex-col gap-0.5">
                        {t("export.contentsPage")}
                        <span className="text-xs text-secondary">
                          {t("export.contentsHelp", { count: sectionCount })}
                        </span>
                      </span>
                    </label>
                  )}
                  <label className="flex items-start gap-2 text-navy">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={controlPage}
                      onChange={(event) => setControlPage(event.currentTarget.checked)}
                    />
                    <span className="flex flex-col gap-0.5">
                      {t("export.controlPage")}
                      <span className="text-xs text-secondary">
                        {props.listVersions
                          ? t("export.controlHelp")
                          : t("export.controlHelpDraft")}
                      </span>
                    </span>
                  </label>
                </fieldset>
              )}
              {props.format === "pdf" && (
                <fieldset className="flex min-w-0 flex-col gap-2 border-t border-panel pt-4">
                  <legend className="mb-1 text-sm font-semibold text-navy">
                    {t("export.page")}
                  </legend>
                  <label className="flex items-center justify-between gap-2 text-sm">
                    {t("export.pageSize")}
                    <select
                      className="field"
                      value={options.pageSize}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          pageSize: event.currentTarget.value === "LETTER" ? "LETTER" : "A4",
                        })
                      }
                    >
                      <option value="A4">{t("export.a4")}</option>
                      <option value="LETTER">{t("export.letter")}</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-sm">
                    {t("export.orientation")}
                    <select
                      className="field"
                      value={options.orientation}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          orientation:
                            event.currentTarget.value === "landscape" ? "landscape" : "portrait",
                        })
                      }
                    >
                      <option value="portrait">{t("export.portrait")}</option>
                      <option value="landscape">{t("export.landscape")}</option>
                    </select>
                  </label>
                  <label className="flex items-center justify-between gap-2 text-sm">
                    {t("export.layout")}
                    <select
                      className="field min-w-0 flex-1"
                      value={options.layout ?? "standard"}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          layout: pdfLayoutOf(event.currentTarget.value),
                        })
                      }
                    >
                      <option value="standard">{t("export.standard")}</option>
                      <option value="page">{t("export.layoutPage")}</option>
                      <option value="compact">{t("export.compact")}</option>
                    </select>
                  </label>
                  <p className="text-xs text-secondary">{t("export.publicSector")}</p>
                </fieldset>
              )}
              {props.format === "amlsteps" && (
                <div className="flex flex-col gap-2 border-t border-panel pt-4 text-sm">
                  <p className="text-xs text-secondary">{t("export.amlsteps.burnedIn")}</p>
                  <label className="flex items-start gap-2 text-navy">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={includeOriginals}
                      disabled={originalsLocked}
                      aria-describedby={
                        originalsLocked
                          ? "originals-locked"
                          : includeOriginals
                            ? "originals-warning"
                            : undefined
                      }
                      onChange={(event) => setIncludeOriginals(event.currentTarget.checked)}
                    />
                    {t("export.amlsteps.originals")}
                  </label>
                  {originalsLocked && (
                    <p
                      id="originals-locked"
                      className="flex items-center gap-1 text-xs text-secondary"
                    >
                      <Icon name="lock" size={12} />
                      {t("settings.managed")}
                    </p>
                  )}
                  {includeOriginals && (
                    <p id="originals-warning" role="alert" className="text-xs text-recording">
                      {t("export.amlsteps.originalsWarning")}
                    </p>
                  )}
                </div>
              )}
              {props.format === "html" && (
                <div className="flex flex-col gap-1.5 border-t border-panel pt-4 text-xs text-secondary">
                  <p>
                    {t("export.webSize", {
                      size: (
                        (([...images.values()].reduce(
                          (sum, image) => sum + image.dataUrl.length * 0.75,
                          0,
                        ) +
                          WALKTHROUGH_OVERHEAD) *
                          (optimise ? 0.5 : 1)) /
                        1_000_000
                      ).toFixed(1),
                    })}
                  </p>
                  {optimise && <p>{t("export.optimised")}</p>}
                  <p>{t("export.webWorks")}</p>
                  <button
                    type="button"
                    className="btn mt-1 self-start"
                    disabled={!ready || busy}
                    onClick={() => void preview()}
                  >
                    <Icon name="play" size={15} />
                    {t("export.preview")}
                  </button>
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-panel px-5 py-4">
              {problem && (
                <p role="alert" className="text-sm text-recording">
                  {problem}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button type="button" className="btn" onClick={props.onClose}>
                  {t("export.backToEditor")}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={!ready || busy}
                  onClick={() => void run()}
                >
                  {!ready || busy ? (
                    <Spinner />
                  ) : (
                    <Icon name={props.format === "copy" ? "copy" : "download"} size={16} />
                  )}
                  {busy
                    ? t("common.working")
                    : props.format === "copy"
                      ? t("export.copyNow")
                      : t("export.exportNow", { format: formatName })}
                </button>
              </div>
            </div>
          </aside>
        </div>
        {quickStep && props.edit && (
          <StepQuickEdit
            step={quickStep}
            number={numbers.get(quickStep.id) ?? 0}
            loadImage={props.loadImage}
            findings={findings.get(quickStep.id) ?? []}
            edit={props.edit}
            undo={undo}
            redo={redo}
            onOpenInEditor={props.onShowStep ? () => props.onShowStep?.(quickStep.id) : undefined}
            onClose={closeQuickEdit}
          />
        )}
      </ModalDialog>
    </div>
  );
}

/**
 * The steps a line of the review is about, by number. With the editor open each one is a button
 * that goes back to that step; from the library they are just the numbers, so everyone (screen
 * readers included) can tell which steps need a look.
 */
function StepChips(props: {
  ids: readonly string[];
  numbers: Map<string, number>;
  onShowStep: ((stepId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  if (props.ids.length === 0) return null;
  const label = (id: string) => t("export.stepNumber", { number: props.numbers.get(id) ?? "?" });
  return (
    <span className="flex flex-wrap gap-1">
      {props.ids.map((id) =>
        props.onShowStep ? (
          <button
            key={id}
            type="button"
            className="chip hover:bg-panel"
            onClick={() => props.onShowStep?.(id)}
          >
            {label(id)}
          </button>
        ) : (
          <span key={id} className="chip">
            {label(id)}
          </span>
        ),
      )}
    </span>
  );
}
