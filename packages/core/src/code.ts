import { z } from "zod";

import { ENGLISH, renderPhrase } from "./step-text/phrase.ts";

/**
 * Code on a step (docs/spec/03-data-and-sharing.md#step-file): a command run in a terminal, code
 * typed into an editor, or an Excel formula, shown in a monospace block with a Copy button
 * (docs/spec/04-editor.md#code-steps).
 */

/** The languages a code block can be labelled with. `plain` is monospace with no label. */
export const CODE_LANGUAGES = [
  "powershell",
  "cmd",
  "bash",
  "excel",
  "python",
  "javascript",
  "sql",
  "json",
  "xml",
  "plain",
] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** What a masked secret shows as, in commands and code (the recorder writes it). */
export const MASK_TEXT = "••••";

/** The longest code and output a step keeps (the recorder cuts output to 200 lines or 16 KB). */
export const MAX_CODE_CHARS = 20_000;
export const MAX_OUTPUT_CHARS = 16_384;

export const codeSchema = z
  .object({
    text: z.string().max(MAX_CODE_CHARS),
    language: z.enum(CODE_LANGUAGES).catch("plain"),
    /** What the command printed, when "Include command output" was ticked. */
    output: z.string().max(MAX_OUTPUT_CHARS).nullable(),
    /** The output was cut to what a step keeps, or its start had scrolled away. */
    outputShortened: z.boolean(),
  })
  .strip();
export type StepCode = z.infer<typeof codeSchema>;

/** The block's label, the same in the editor and every export. English, like step wording. */
export const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  powershell: "PowerShell",
  cmd: "Command Prompt",
  bash: "Bash",
  excel: "Excel formula",
  python: "Python",
  javascript: "JavaScript",
  sql: "SQL",
  json: "JSON",
  xml: "XML",
  plain: "",
};

/** The terminals a command's wording names; anything else runs "in the terminal". */
const TERMINALS = new Set<CodeLanguage>(["powershell", "cmd", "bash"]);

/** Wording for a command step: "Run in PowerShell" (English, casual, as recorded). */
export const describeCommand = (language: CodeLanguage, wording = ENGLISH): string =>
  renderPhrase(
    {
      key: "runIn",
      terminal: TERMINALS.has(language) ? (language as "powershell" | "cmd" | "bash") : null,
    },
    wording.language,
    wording.tone,
  );

/** Wording for an Excel formula step: "Type the formula in cell B6". */
export const describeFormula = (cell: string | null | undefined, wording = ENGLISH): string =>
  renderPhrase(
    cell?.trim() ? { key: "formulaInCell", cell: cell.trim() } : { key: "formulaInSelected" },
    wording.language,
    wording.tone,
  );

/** Wording for code typed into an editor. */
export const describeCode = (wording = ENGLISH): string =>
  renderPhrase({ key: "code" }, wording.language, wording.tone);

/**
 * A step's code text for the clipboard and exports: exactly as stored, with the line endings
 * Windows expects, so it pastes into a terminal or editor as one block.
 */
export const codeForClipboard = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/** Joins command steps into one script (the editor's Merge on command steps). */
export function mergeCode(parts: readonly StepCode[]): StepCode {
  const languages = new Set(parts.map((part) => part.language));
  const language = languages.size === 1 ? (parts[0]?.language ?? "plain") : "plain";
  const outputs = parts.map((part) => part.output).filter((output): output is string => !!output);
  return {
    text: parts
      .map((part) => part.text)
      .join("\n")
      .slice(0, MAX_CODE_CHARS),
    language,
    output: outputs.length > 0 ? outputs.join("\n").slice(0, MAX_OUTPUT_CHARS) : null,
    outputShortened: parts.some((part) => part.outputShortened),
  };
}

const VK_NAMES: Record<number, string> = {
  0x08: "Backspace",
  0x09: "Tab",
  0x0d: "Enter",
  0x13: "Pause",
  0x1b: "Esc",
  0x20: "Space",
  0x21: "Page Up",
  0x22: "Page Down",
  0x23: "End",
  0x24: "Home",
  0x25: "Left",
  0x26: "Up",
  0x27: "Right",
  0x28: "Down",
  0x2c: "Print Screen",
  0x2d: "Insert",
  0x2e: "Delete",
  0x6a: "Num *",
  0x6b: "Num +",
  0x6d: "Num -",
  0x6e: "Num .",
  0x6f: "Num /",
};

/**
 * A key's name for "Press …" wording, from its Windows virtual-key code. Letters and digits are
 * themselves; keys whose name depends on the keyboard layout (`;`, `ß`) use what the key types
 * there, which the recorder sends as `typed`.
 */
export function keyName(vkey: number, typed?: string | null): string {
  if ((vkey >= 0x41 && vkey <= 0x5a) || (vkey >= 0x30 && vkey <= 0x39))
    return String.fromCharCode(vkey);
  if (vkey >= 0x60 && vkey <= 0x69) return `Num ${vkey - 0x60}`;
  if (vkey >= 0x70 && vkey <= 0x87) return `F${vkey - 0x6f}`;
  const named = VK_NAMES[vkey];
  if (named) return named;
  const shown = typed?.trim();
  if (!shown) return `Key ${vkey}`;
  // Upper case as on the key cap, unless that changes the character (ß would become SS).
  const upper = shown.toUpperCase();
  return upper.length === shown.length ? upper : shown;
}

/** "Ctrl + Shift + N", the way the Add-shortcut popup writes a combination. */
export function keyCombo(keys: {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
  vkey: number;
  key: string | null;
}): string {
  return [
    keys.ctrl ? "Ctrl" : null,
    keys.alt ? "Alt" : null,
    keys.shift ? "Shift" : null,
    keys.win ? "Win" : null,
    keyName(keys.vkey, keys.key),
  ]
    .filter((part): part is string => part !== null)
    .join(" + ");
}
