import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";

/**
 * A stand-in for the app's Rust side, for running the bridge contracts against the desktop
 * adapter without Tauri. Each command the adapter sends must be one the Rust code declares
 * (`#[tauri::command]` in `src-tauri/src`), with the arguments its function takes, named as
 * Tauri names them (camelCase), so a renamed command or argument fails here rather than in the
 * built app. What each command answers is up to the test's handlers.
 */

/** A command's arguments: their names and whether each may be left out (`Option<…>`). */
type Arguments = Map<string, { optional: boolean }>;

/** Arguments Tauri fills in itself, never sent by the page. */
const INJECTED = /^(?:tauri::)?(?:AppHandle|State<|Window|WebviewWindow|Webview|ipc::Request<)/;

const camel = (name: string) =>
  name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Splits a parameter list at its top-level commas (`State<'_, X>` has one inside). */
function parameters(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    if (character === "<" || character === "(") depth += 1;
    if (character === ">" || character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Every command the Rust side declares, with its arguments; null for one taking a raw body. */
export function rustCommands(): Map<string, Arguments | null> {
  // A path, not a URL: the tests run in jsdom, whose URL Node's file functions refuse.
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src");
  const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((name) =>
    name.endsWith(".rs"),
  );
  const commands = new Map<string, Arguments | null>();
  const declared =
    /#\[tauri::command[^\]]*\]\s*(?:#\[[^\]]*\]\s*)*pub (?:async )?fn (\w+)(?:<[^>]*>)?\(([^{]*?)\)\s*(?:->[^{]*)?\{/g;
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    for (const [, name, list] of source.matchAll(declared)) {
      if (!name || list === undefined) continue;
      const args: Arguments = new Map();
      let rawBody = false;
      for (const parameter of parameters(list)) {
        const colon = parameter.indexOf(":");
        const argument = parameter.slice(0, colon).trim().replace(/^mut /, "");
        const type = parameter.slice(colon + 1).trim();
        if (/ipc::Request</.test(type)) rawBody = true;
        if (INJECTED.test(type)) continue;
        args.set(camel(argument), { optional: type.startsWith("Option<") });
      }
      commands.set(name, rawBody ? null : args);
    }
  }
  return commands;
}

/**
 * Answers one command: its arguments (or the raw body), and the headers a raw-body command
 * carries its other values in.
 */
export type Handler = (
  args: Record<string, unknown> | Uint8Array,
  headers: Record<string, string>,
) => unknown;

let declared: Map<string, Arguments | null> | undefined;

interface Internals {
  invoke: (
    command: string,
    args: unknown,
    options?: { headers?: Record<string, string> },
  ) => unknown;
}

/**
 * Installs the stand-in: `handlers` answer the app's own commands, `plugins` Tauri's (window,
 * autostart). A command no handler answers rejects, as one the Rust side refused would. Events
 * are mocked, so `emit` from `@tauri-apps/api/event` reaches the adapter's listeners.
 */
export function rustBackend(
  handlers: Record<string, Handler>,
  plugins: Record<string, Handler> = {},
): void {
  declared ??= rustCommands();
  const commands = declared;
  let headers: Record<string, string> = {};
  clearMocks();
  mockWindows("main");
  mockIPC(
    (command, payload) => {
      const args = (payload ?? {}) as Record<string, unknown> | Uint8Array;
      if (command.startsWith("plugin:")) {
        const plugin = plugins[command];
        if (!plugin) throw new Error(`no stand-in for ${command}`);
        return plugin(args, headers);
      }
      if (!commands.has(command)) throw new Error(`${command} isn't a command the app declares`);
      const expected = commands.get(command);
      if (expected && !(args instanceof Uint8Array)) {
        const given = Object.keys(args).filter((key) => args[key] !== undefined);
        const unknown = given.filter((key) => !expected.has(key));
        const missing = [...expected].filter(
          ([key, { optional }]) => !optional && !given.includes(key),
        );
        if (unknown.length || missing.length)
          throw new Error(
            `${command}: unknown arguments [${unknown.join()}], missing [${missing.map(([key]) => key).join()}]`,
          );
      }
      const handler = handlers[command];
      if (!handler) throw new Error(`no stand-in answers ${command}`);
      return handler(args, headers);
    },
    { shouldMockEvents: true },
  );
  // The mock drops the headers a raw-body command sends; they're kept for its handler.
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
  const mocked = internals.invoke;
  internals.invoke = (command, args, options) => {
    headers = options?.headers ?? {};
    return mocked(command, args, options);
  };
}
