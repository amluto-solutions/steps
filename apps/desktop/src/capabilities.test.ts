import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// App hardening (docs/spec/08-privacy-and-security.md#app-hardening): one permission per command,
// no wildcards, and each window gets only what it uses.
const tauri = new URL("../src-tauri/", import.meta.url);
const text = (path: string) => readFileSync(new URL(path, tauri), "utf8");

const permissions = readdirSync(new URL("permissions/", tauri))
  .filter((name) => name.endsWith(".toml"))
  .flatMap((name) =>
    text(`permissions/${name}`)
      .split("[[permission]]")
      .slice(1)
      .map((block) => ({
        identifier: /identifier = "([^"]+)"/.exec(block)?.[1] ?? "",
        commands: JSON.parse(/commands\.allow = (\[[^\]]*\])/.exec(block)?.[1] ?? "[]") as string[],
      })),
  );

const capabilities = readdirSync(new URL("capabilities/", tauri))
  .filter((name) => name.endsWith(".json"))
  .map(
    (name) =>
      JSON.parse(text(`capabilities/${name}`)) as {
        identifier: string;
        windows: string[];
        permissions: string[];
      },
  );

const commandsOf = (identifier: string) => {
  const capability = capabilities.find((item) => item.identifier === identifier);
  if (!capability) throw new Error(`no capability ${identifier}`);
  return capability.permissions.flatMap(
    (name) => permissions.find((item) => item.identifier === name)?.commands ?? [],
  );
};

const handlerList = text("src/lib.rs").split("generate_handler![")[1]?.split("])")[0] ?? "";
const registered = [...handlerList.matchAll(/(\w+)::(\w+),/g)].map((match) => match[2]);

describe("Tauri permissions", () => {
  it("allow exactly one command each, named after it", () => {
    for (const permission of permissions) {
      expect(permission.commands).toHaveLength(1);
      expect(permission.identifier).toBe(`allow-${permission.commands[0]?.replace(/_/g, "-")}`);
    }
  });

  it("cover every registered command, and no command that isn't registered", () => {
    const allowed = permissions.flatMap((item) => item.commands).sort();
    expect(registered.length).toBeGreaterThan(50);
    expect(allowed).toEqual([...registered].sort());
  });

  it("are granted per window, never with wildcards", () => {
    expect(capabilities.map((item) => item.windows.join()).sort()).toEqual([
      "main",
      "recorder-bar",
      "shortcut-popup",
    ]);
    for (const capability of capabilities) {
      for (const name of capability.permissions)
        expect(name).not.toMatch(/\*|:allow-all|^allow-all/);
      // core:default would let a window emit events to others (e.g. start a recording) and use
      // the tray and menus.
      expect(capability.permissions.filter((name) => name.endsWith(":default"))).toEqual([]);
      expect(capability.permissions).not.toContain("core:event:allow-emit");
      expect(capability.permissions).not.toContain("core:event:allow-emit-to");
      // The updater plugin's own commands would skip the checks in updates.rs.
      expect(capability.permissions.filter((name) => name.startsWith("updater:"))).toEqual([]);
    }
  });

  it("let the main window call every command the app's bridges send, but the bar's own", () => {
    // Pause, Resume and Stop in the main window (F002) were refused in the built app: the
    // permissions were only the bar's, and the tests mock the bridge.
    const bridges = ["library-bridge.ts", "recorder-bridge.ts"]
      .map((name) => readFileSync(new URL(name, import.meta.url), "utf8"))
      .join("\n");
    const sent = new Set(
      [...bridges.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    const barOnly = [
      "recorder_move_bar",
      "recorder_bar_heartbeat",
      "recorder_start_again",
      "recorder_undo_start_again",
      "recorder_add_shortcut",
      "recorder_close_shortcut_popup",
    ];
    const main = new Set(commandsOf("main"));
    expect(sent.size).toBeGreaterThan(100);
    expect(
      [...sent].filter((command) => command && !main.has(command) && !barOnly.includes(command)),
    ).toEqual([]);
  });

  it("keep the recorder bar and the shortcut popup away from guides, files and settings", () => {
    for (const window of ["recorder-bar", "shortcut-popup"]) {
      const commands = commandsOf(window);
      expect(commands.length).toBeGreaterThan(0);
      expect(
        commands.filter((command) =>
          /^(library_|export_|settings_|brands_|support_|policy_|privacy_|hotkeys_|updates_)/.test(
            command,
          ),
        ),
      ).toEqual([]);
    }
    expect(commandsOf("shortcut-popup").sort()).toEqual([
      "recorder_append_step",
      "recorder_close_shortcut_popup",
    ]);
  });
});

describe("The updater (docs/spec/10-distribution.md#updates-for-the-exe)", () => {
  const updater = (
    JSON.parse(text("tauri.conf.json")) as {
      plugins?: { updater?: Record<string, unknown> & { endpoints?: string[] } };
    }
  ).plugins?.updater;

  it("asks only steps.amluto.com, over HTTPS, and only for signed versions", () => {
    // Not latest.json: SiteGround refuses every file with that name (found at the 0.2.0 upload).
    expect(updater?.endpoints).toEqual(["https://steps.amluto.com/update/release.json"]);
    expect(updater?.requireSignedVersion).toBe(true);
    for (const flag of [
      "dangerousInsecureTransportProtocol",
      "dangerousAcceptInvalidCerts",
      "dangerousAcceptInvalidHostnames",
    ])
      expect(updater?.[flag], flag).toBeUndefined();
  });

  it("carries Amluto's public key, and never a private one", () => {
    const key = Buffer.from(String(updater?.pubkey), "base64").toString("utf8");
    expect(key).toMatch(/^untrusted comment: minisign public key: [0-9A-F]+\n[A-Za-z0-9+/=]+\n?$/);
    expect(text("tauri.conf.json")).not.toMatch(/secret key|PRIVATE/i);
  });
});
