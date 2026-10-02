import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Finding, GuideStep } from "@amluto-steps/core";

import { Icon, type IconName } from "../components/icons";
import { AltTextField } from "../editor/AltTextField";
import type { Edit, EditorDoc } from "../editor/document";
import { setStepText, updateStep, type Stamp } from "../editor/edits";
import { ImageEditor, type ImageTool } from "../editor/ImageEditor";
import { SuggestedBlurs } from "../editor/SuggestedBlurs";
import {
  blurFoundEdit,
  fullyCovered,
  markedNotPersonal,
  notPersonalEdit,
} from "../editor/suggestions";
import { ModalDialog } from "../ModalDialog";
import { UndoButtons } from "./UndoButtons";

const TOOLS: { tool: ImageTool; icon: IconName }[] = [
  { tool: "select", icon: "pointer" },
  { tool: "arrow", icon: "arrow" },
  { tool: "box", icon: "box" },
  { tool: "text", icon: "text" },
  { tool: "blur", icon: "blur" },
  { tool: "crop", icon: "crop" },
];

/**
 * One step, opened from the review before export (28/09/2026: going back to the editor to
 * fix one step, then exporting again, was clunky). Its wording, alt text and screenshot tools,
 * on top of the review; every change is an edit like any in the editor, and closing it goes back
 * to the review with that step drawn and checked again.
 */
export function StepQuickEdit(props: {
  step: GuideStep;
  number: number;
  loadImage: (mediaId: string) => Promise<string>;
  /** Possible personal data on this screenshot that isn't blurred. */
  findings: Finding[];
  edit: (make: (doc: EditorDoc, stamp: Stamp) => Edit | null) => void;
  /** The review's Undo and Redo, which reach changes made here too. */
  undo?: (() => void) | undefined;
  redo?: (() => void) | undefined;
  /** Leaves the review for the editor at this step, when the review was opened from it. */
  onOpenInEditor?: (() => void) | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { step } = props;
  const [tool, setTool] = useState<ImageTool>("select");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const mediaId = step.media?.id;
  // A finding blurred here drops out as its blur lands, and comes back if that's undone.
  const [pointed, setPointed] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<Finding["rect"] | null>(null);

  useEffect(() => {
    if (!mediaId) return;
    let cancelled = false;
    void props
      .loadImage(mediaId)
      .then((url) => {
        if (!cancelled) setImageUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per screenshot
  }, [mediaId]);

  const open = props.findings.filter(
    (finding) =>
      !fullyCovered(finding.rect, step.redactions) &&
      !markedNotPersonal(finding.rect, step.notPersonal),
  );

  return (
    <div className="fixed inset-0 z-[900] grid place-items-center bg-scrim/50 p-4">
      <ModalDialog
        labelledBy="quick-edit-title"
        onEscape={props.onClose}
        onUndo={props.undo}
        onRedo={props.redo}
        className="card flex h-[92vh] w-full max-w-6xl flex-col overflow-hidden"
      >
        <header className="flex items-center gap-3 border-b border-panel px-5 py-3">
          <h2 id="quick-edit-title" className="font-heading text-lg text-navy">
            {t("export.stepNumber", { number: props.number })}
          </h2>
          <span className="flex-1" />
          <UndoButtons undo={props.undo} redo={props.redo} />
          {props.onOpenInEditor && (
            <button type="button" className="btn btn-quiet h-8" onClick={props.onOpenInEditor}>
              {t("export.quickEdit.openInEditor")}
            </button>
          )}
          <button type="button" className="btn btn-primary h-8" onClick={props.onClose}>
            {t("export.quickEdit.done")}
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          <label className="flex flex-col gap-1 text-sm font-semibold text-navy">
            {t("editor.stepText")}
            <input
              value={step.actionText}
              onChange={(event) => {
                const text = event.currentTarget.value;
                props.edit((current, stamp) => setStepText(current, step.id, text, stamp));
              }}
              className="field h-10 text-base font-normal"
            />
          </label>
          {mediaId && (
            <div className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-lg border border-panel">
              <div
                role="toolbar"
                aria-label={t("editor.tools.label")}
                className="flex flex-wrap items-center gap-1 border-b border-panel px-2 py-1.5"
              >
                {TOOLS.map(({ tool: name, icon }) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={tool === name}
                    onClick={() => setTool(name)}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] ${tool === name ? "bg-selected font-semibold text-link" : "text-secondary hover:bg-subtle"}`}
                  >
                    <Icon name={icon} size={15} />
                    {t(`editor.tools.${name}`)}
                  </button>
                ))}
              </div>
              <SuggestedBlurs
                findings={open}
                onBlur={(items) => {
                  setPointed(null);
                  props.edit(
                    blurFoundEdit([{ stepId: step.id, findings: items }], t("editor.undo.blur")),
                  );
                }}
                onDismiss={(items) => {
                  setPointed(null);
                  props.edit(notPersonalEdit(step.id, items, t("editor.undo.notPersonal")));
                }}
                onShow={(finding) => setRevealed({ ...finding.rect })}
                onPoint={setPointed}
              />
              <div className="flex min-h-0 flex-1 bg-subtle p-3">
                <ImageEditor
                  key={step.id}
                  step={step}
                  imageUrl={imageUrl}
                  tool={tool}
                  onToolChange={setTool}
                  suggestions={open.map((finding) => finding.rect)}
                  activeSuggestion={pointed}
                  reveal={revealed}
                  onCommit={(geometry, label) =>
                    props.edit((current, stamp) =>
                      updateStep(current, step.id, geometry, label, stamp),
                    )
                  }
                />
              </div>
            </div>
          )}
          <AltTextField
            step={step}
            onChange={(altText) =>
              props.edit((current, stamp) =>
                updateStep(
                  current,
                  step.id,
                  { altText },
                  t("editor.undo.altText"),
                  stamp,
                  `alt:${step.id}`,
                ),
              )
            }
          />
        </div>
      </ModalDialog>
    </div>
  );
}
