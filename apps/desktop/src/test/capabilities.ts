import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app's Tauri permissions (`src-tauri/permissions/*.toml`) and capabilities
 * (`src-tauri/capabilities/*.json`), read as Tauri reads them, so tests can say which commands a
 * window may call.
 */

// A path, not a URL: some tests run in jsdom, whose URL Node's file functions refuse.
const tauri = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri");
export const tauriText = (path: string) => readFileSync(join(tauri, path), "utf8");

export interface Permission {
  identifier: string;
  commands: string[];
}

export interface Capability {
  identifier: string;
  windows: string[];
  permissions: string[];
}

export const permissions: Permission[] = readdirSync(join(tauri, "permissions"))
  .filter((name) => name.endsWith(".toml"))
  .flatMap((name) =>
    tauriText(`permissions/${name}`)
      .split("[[permission]]")
      .slice(1)
      .map((block) => ({
        identifier: /identifier = "([^"]+)"/.exec(block)?.[1] ?? "",
        commands: JSON.parse(/commands\.allow = (\[[^\]]*\])/.exec(block)?.[1] ?? "[]") as string[],
      })),
  );

export const capabilities: Capability[] = readdirSync(join(tauri, "capabilities"))
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(tauriText(`capabilities/${name}`)) as Capability);

/** The app's own commands a capability grants (Tauri's `core:` permissions aren't among them). */
export const commandsOf = (identifier: string): string[] => {
  const capability = capabilities.find((item) => item.identifier === identifier);
  if (!capability) throw new Error(`no capability ${identifier}`);
  return capability.permissions.flatMap(
    (name) => permissions.find((item) => item.identifier === name)?.commands ?? [],
  );
};
