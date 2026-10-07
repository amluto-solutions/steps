import type { CodeLanguage } from "../code.ts";
import { clickPhrase, isTarget, namingOfStep, type ClickNaming } from "./click-naming.ts";
import {
  asRightClick,
  phraseFor,
  renderPhrase,
  type Phrase,
  type Terminal,
  type Tone,
} from "./phrase.ts";

/**
 * A recorded step's words worked out again from what it stores (docs/spec/04-editor.md#language-
 * and-tone), for rewording it in another tone or language without retyping anything.
 */

/** What a stored step needs for its phrase to be worked out again. */
export interface PhraseFacts {
  kind: string;
  action: string;
  actionText: string;
  textParts: { verb: string; target: string; kind: string; value?: string | undefined };
  showValue: boolean;
  context: { windowTitle: string };
  target: unknown;
  code?: { language: CodeLanguage } | null | undefined;
  /** What a click is called, as recorded; absent on steps saved before 06/10/2026. */
  naming?: ClickNaming | undefined;
}

const TERMINALS = new Set<string>(["powershell", "cmd", "bash"]);

const firstNumber = (text: string) => Number(/\d+/.exec(text)?.[0] ?? "0");

/**
 * The phrase a recorded step says, worked out again from what it stores, for rewording it in
 * another tone or language; null for a step that can't be (a block, a step written by hand, or
 * one too old to say). Its own words aren't looked at, except to recover what older recordings
 * didn't store (a taskbar click, a count).
 */
export function phraseOfStep(step: PhraseFacts): Phrase | null {
  if (step.kind === "block") return null;
  const parts = step.textParts;
  switch (step.action) {
    case "click": {
      if (parts.verb === "selectRange") return { key: "selectRange", range: parts.target };
      const phrase = clickPhrase(namingOfStep(step));
      return parts.verb === "rightClick" ? asRightClick(phrase) : phrase;
    }
    case "input": {
      const value = step.showValue ? parts.value : undefined;
      const target = isTarget(step.target) ? step.target : null;
      if (target && Object.keys(target).length > 0)
        return phraseFor("input", { ...target, value }) ?? { key: "type" };
      return value ? { key: "typeValue", value } : { key: "type" };
    }
    case "keypress":
      return parts.target ? { key: "press", keys: parts.target } : null;
    case "navigation":
      return parts.target ? { key: "goTo", site: parts.target } : null;
    case "appswitch":
      return parts.target ? { key: "open", app: parts.target } : null;
    case "command": {
      const language = step.code?.language ?? "";
      return { key: "runIn", terminal: TERMINALS.has(language) ? (language as Terminal) : null };
    }
    case "formula":
      return parts.target.trim()
        ? { key: "formulaInCell", cell: parts.target.trim() }
        : { key: "formulaInSelected" };
    case "code":
      return { key: "code" };
    case "manual":
      if (parts.target === "missed" && parts.kind === "warning")
        return { key: "missed", count: Number(parts.value) || firstNumber(step.actionText) };
      if (parts.target === "touch" && parts.kind === "warning")
        return { key: "touch", count: Number(parts.value) || firstNumber(step.actionText) };
      if (parts.kind === "screenshot") return { key: "captureNow" };
      return null;
    default:
      return null;
  }
}

/** A stored step's words in `language` and `tone`, or null when they can't be worked out again. */
export function wordStepIn(step: PhraseFacts, language: string, tone: Tone): string | null {
  const phrase = phraseOfStep(step);
  return phrase ? renderPhrase(phrase, language, tone) : null;
}
