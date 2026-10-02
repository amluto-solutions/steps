import { useEffect, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { GuideStep } from "@amluto-steps/core";

import { Icon, type IconName } from "../components/icons";
import { Menu, type MenuEntry } from "../components/Menu";

export type Selection =
  { kind: "details" } | { kind: "intro" } | { kind: "outro" } | { kind: "step"; id: string };

interface StepRailProps {
  steps: GuideStep[];
  numbers: Map<string, number>;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  onMove: (id: string, toIndex: number) => void;
  onDelete: (id: string) => void;
  stepMenu: (step: GuideStep, index: number) => MenuEntry[];
  addMenu: MenuEntry[];
  loadThumbnail: (mediaId: string) => Promise<string>;
}

/** A code step in the list: its wording and the start of its code ("Run in PowerShell: Get-…"). */
const withCode = (text: string, code: string | undefined) => {
  const first = code?.trim().split("\n")[0]?.trim();
  return first ? `${text}: ${first}` : text;
};

const blockIcon: Record<string, IconName> = {
  header: "text",
  text: "note",
  tip: "info",
  callout: "info",
  warning: "warning",
  alert: "warning",
};

/** A small cached thumbnail; screenshots load lazily as rows appear. */
function Thumbnail({
  mediaId,
  load,
}: {
  mediaId: string | null | undefined;
  load: (id: string) => Promise<string>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaId) return;
    let cancelled = false;
    load(mediaId)
      .then((data) => {
        if (!cancelled) setUrl(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mediaId, load]);
  return url ? (
    <img src={url} alt="" className="size-full object-cover" draggable={false} />
  ) : (
    <Icon name="image" size={16} className="text-secondary" />
  );
}

function StepRow({
  step,
  index,
  number,
  selected,
  props,
}: {
  step: GuideStep;
  index: number;
  number: number | undefined;
  selected: boolean;
  props: Omit<StepRailProps, "steps" | "numbers" | "selection" | "onMove" | "addMenu">;
}) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: step.id,
  });
  const text =
    step.kind === "block"
      ? step.block?.heading || t(`editor.block.${step.block?.type ?? "text"}`)
      : withCode(step.actionText || t("editor.emptyStep"), step.code?.text);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Delete") {
      event.preventDefault();
      props.onDelete(step.id);
      return;
    }
    // Up and Down move through the steps, as in a list, and open the one reached (F062): a long
    // guide's list was a long way by Tab, three stops a step.
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [
      ...(event.currentTarget
        .closest("ol, ul")
        ?.querySelectorAll<HTMLButtonElement>("[data-step-button]") ?? []),
    ];
    const here = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    const next = buttons[here + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  };
  return (
    <li
      ref={setNodeRef}
      className={`group relative ${isDragging ? "z-10 opacity-80" : ""}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <div
        // The selected step has a bar down its left edge as well as its colour (WCAG 1.4.1).
        className={`flex items-center gap-1.5 rounded-xl py-1.5 pr-10 pl-1 ${selected ? "bg-selected shadow-[inset_3px_0_0_var(--amluto-focus)]" : "hover:bg-subtle"}`}
      >
        <button
          type="button"
          className="flex h-10 w-5 shrink-0 cursor-grab items-center justify-center text-secondary active:cursor-grabbing"
          aria-label={t("editor.dragStep", { text })}
          {...attributes}
          {...listeners}
        >
          <Icon name="grip" size={14} strokeWidth={3} />
        </button>
        <button
          type="button"
          aria-current={selected ? "step" : undefined}
          data-step-button={step.id}
          onClick={() => props.onSelect({ kind: "step", id: step.id })}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        >
          <span className="relative flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-subtle">
            {step.kind === "block" ? (
              <Icon
                name={blockIcon[step.block?.type ?? "text"] ?? "note"}
                size={16}
                className="text-secondary"
              />
            ) : (
              <Thumbnail mediaId={step.media?.id} load={props.loadThumbnail} />
            )}
            {number !== undefined && (
              <span
                className={`absolute top-0.5 left-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[11px] font-bold text-white ${selected ? "bg-blue" : "bg-brand-navy"}`}
              >
                {number}
              </span>
            )}
          </span>
          <span className="line-clamp-2 min-w-0 text-[13px] leading-snug text-body">
            {step.reviewRequired && (
              <Icon
                name="warning"
                size={13}
                className="mr-1 inline text-warning"
                aria-label={t("editor.needsCheck")}
              />
            )}
            {text}
          </span>
        </button>
      </div>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2">
        <Menu
          label={t("editor.stepActions")}
          entries={props.stepMenu(step, index)}
          trigger={(trigger) => (
            <button
              type="button"
              {...trigger}
              className="icon-btn size-8 opacity-70 group-hover:opacity-100 focus:opacity-100"
              aria-label={t("editor.stepActionsFor", { text })}
            >
              <Icon name="more" size={18} strokeWidth={3} />
            </button>
          )}
        />
      </div>
    </li>
  );
}

function FixedRow({
  icon,
  title,
  note,
  selected,
  onSelect,
}: {
  icon: IconName;
  title: string;
  note: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "step" : undefined}
        onClick={onSelect}
        className={`flex w-full items-center gap-2.5 rounded-xl py-1.5 pr-3 pl-6 text-left ${selected ? "bg-selected" : "hover:bg-subtle"}`}
      >
        <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded-md bg-subtle text-secondary">
          <Icon name={icon} size={16} />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-semibold text-body">{title}</span>
          <span className="truncate text-xs text-secondary">{note}</span>
        </span>
      </button>
    </li>
  );
}

/** The left-hand list: guide details, intro, the steps (drag or Move up/down), outro. */
export function StepRail(props: StepRailProps) {
  const { t } = useTranslation();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const count = [...props.numbers.values()].length;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const toIndex = props.steps.findIndex((step) => step.id === over.id);
    if (toIndex >= 0) props.onMove(String(active.id), toIndex);
  };

  return (
    <aside
      aria-label={t("editor.stepsList")}
      className="flex w-[292px] shrink-0 flex-col border-r border-panel bg-background"
    >
      <div className="flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="flex-1 text-[13px] font-bold text-secondary">
          {t("editor.stepCount", { count })}
        </span>
        <Menu
          label={t("editor.addMenu")}
          entries={props.addMenu}
          align="end"
          trigger={(trigger) => (
            <button type="button" {...trigger} className="btn h-8 px-2.5 text-link">
              <Icon name="plus" size={15} />
              {t("editor.add")}
            </button>
          )}
        />
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        accessibility={{
          announcements: {
            onDragStart: () => t("editor.dnd.start"),
            onDragOver: ({ over }) =>
              over
                ? t("editor.dnd.over", {
                    position: props.steps.findIndex((step) => step.id === over.id) + 1,
                  })
                : "",
            onDragEnd: ({ over }) =>
              over
                ? t("editor.dnd.end", {
                    position: props.steps.findIndex((step) => step.id === over.id) + 1,
                  })
                : t("editor.dnd.cancel"),
            onDragCancel: () => t("editor.dnd.cancel"),
          },
          screenReaderInstructions: { draggable: t("editor.dnd.instructions") },
        }}
      >
        <ol className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
          <FixedRow
            icon="info"
            title={t("editor.details")}
            note={t("editor.detailsNote")}
            selected={props.selection.kind === "details"}
            onSelect={() => props.onSelect({ kind: "details" })}
          />
          <FixedRow
            icon="note"
            title={t("editor.intro")}
            note={t("editor.introNote")}
            selected={props.selection.kind === "intro"}
            onSelect={() => props.onSelect({ kind: "intro" })}
          />
          <SortableContext
            items={props.steps.map((step) => step.id)}
            strategy={verticalListSortingStrategy}
          >
            {props.steps.map((step, index) => (
              <StepRow
                key={step.id}
                step={step}
                index={index}
                number={props.numbers.get(step.id)}
                selected={props.selection.kind === "step" && props.selection.id === step.id}
                props={props}
              />
            ))}
          </SortableContext>
          <FixedRow
            icon="check"
            title={t("editor.outro")}
            note={t("editor.outroNote")}
            selected={props.selection.kind === "outro"}
            onSelect={() => props.onSelect({ kind: "outro" })}
          />
        </ol>
      </DndContext>
    </aside>
  );
}
