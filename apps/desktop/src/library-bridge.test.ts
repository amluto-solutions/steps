import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  invoke: [] as { command: string; args: unknown; options: unknown }[],
  listen: [] as string[],
  dialogs: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args: unknown, options: unknown) => {
    calls.invoke.push({ command, args, options });
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string) => {
    calls.listen.push(event);
    return Promise.resolve(() => undefined);
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: () => {
    calls.dialogs.push("open");
    return Promise.resolve(null);
  },
  save: () => {
    calls.dialogs.push("save");
    return Promise.resolve(null);
  },
}));

const { desktopLibrary } = await import("./library-bridge");

/*
 * The desktop's half of the library contract (07/10/2026): its library is Rust, tested by the
 * `library` crate, so the TypeScript adapter is checked against the commands it calls. Each method
 * must reach a command the app registers, with exactly the arguments that command takes, or the
 * call fails only in the built app.
 */

const rust = (path: string) =>
  readFileSync(new URL(`../src-tauri/src/${path}`, import.meta.url), "utf8");

const registered = new Set(
  [...(rust("lib.rs").split("generate_handler![")[1]?.split("])")[0] ?? "").matchAll(/(\w+),/g)]
    .map((match) => match[1])
    .filter((name) => name?.startsWith("library_")),
);

/** Tauri's own parameters, which the window doesn't send. */
const SUPPLIED = /^(State<|AppHandle|tauri::AppHandle|tauri::ipc::Request|Window|WebviewWindow)/;
const camel = (name: string) => name.replace(/_(\w)/g, (_, letter: string) => letter.toUpperCase());

/** Each `library_*` command's own source: what the window must send it. */
const commands = new Map(
  [...rust("library.rs").matchAll(/pub (?:async )?fn (library_\w+)\(([\s\S]*?)\)\s*->/g)].map(
    ([, name = "", params = ""]) => {
      const args = [...params.matchAll(/^\s*(\w+):\s*([^\n]+?),?\s*$/gm)]
        .filter(([, , type = ""]) => !SUPPLIED.test(type.trim()))
        .map(([, param = ""]) => camel(param))
        .sort();
      return [name, args] as const;
    },
  ),
);

const raw = rust("library.rs");
/** The headers a raw-body command reads (`x-library`, `x-guide`). */
const headersOf = (command: string) => {
  const start = raw.indexOf(`fn ${command}(`);
  const end = raw.indexOf("\n}\n", start);
  return [...raw.slice(start, end).matchAll(/"(x-[a-z-]+)"/g)].map((match) => match[1]).sort();
};

type Method = (...args: unknown[]) => Promise<unknown>;
const methods = Object.entries(desktopLibrary) as [string, Method][];

beforeEach(() => {
  calls.invoke.length = 0;
  calls.listen.length = 0;
  calls.dialogs.length = 0;
});

describe("the desktop's library adapter", () => {
  it("sends each method to a registered command, with the arguments it takes", async () => {
    const checked: string[] = [];
    for (const [name, method] of methods) {
      calls.invoke.length = 0;
      calls.dialogs.length = 0;
      calls.listen.length = 0;
      await method("one", "two", "three", "four", "five");
      if (name.startsWith("pick")) {
        expect(calls.dialogs, name).toHaveLength(1);
        continue;
      }
      if (name === "onLockLost") {
        expect(calls.listen).toEqual(["library:lock-lost"]);
        expect(rust("locks.rs")).toContain('"library:lock-lost"');
        continue;
      }
      expect(calls.invoke, name).toHaveLength(1);
      const [call] = calls.invoke;
      if (!call) continue;
      expect(registered.has(call.command), `${name} → ${call.command}`).toBe(true);
      const takes = commands.get(call.command);
      expect(takes, `${call.command} in library.rs`).toBeDefined();
      if (call.args instanceof Uint8Array || typeof call.args === "string") {
        // A raw body: the ids go as headers.
        const headers = (call.options as { headers?: Record<string, string> }).headers ?? {};
        expect(Object.keys(headers).sort(), name).toEqual(headersOf(call.command));
      } else {
        expect(Object.keys(call.args ?? {}).sort(), name).toEqual(takes);
      }
      checked.push(call.command);
    }
    // Every library command is reached from the window, so none is left behind unused.
    expect(checked.sort()).toEqual([...registered].sort());
  });
});
