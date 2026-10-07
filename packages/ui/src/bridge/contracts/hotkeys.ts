import { describe, expect, it } from "vitest";

import { HOTKEY_ACTIONS, type HotkeyBinding, type Hotkeys } from "../hotkeys";
import type { MakeSubject } from "./subject";

const keysOf = (bindings: HotkeyBinding[], action: HotkeyBinding["action"]) =>
  bindings.find((binding) => binding.action === action)?.keys;

/** What Settings > Keyboard shortcuts and the shortcut warning rely on. */
export function hotkeysContract(edition: string, make: MakeSubject<Hotkeys>) {
  describe(`${edition}: keyboard shortcuts`, () => {
    it("list one binding per action where the edition has shortcuts, and none where it hasn't", async () => {
      const { part, capabilities } = await make();
      const actions = (await part.getHotkeys()).map((binding) => binding.action).sort();
      expect(actions).toEqual(capabilities.hotkeys ? [...HOTKEY_ACTIONS].sort() : []);
    });

    it("change, switch off and reset, each answering every binding as it now is", async () => {
      const { part, capabilities } = await make();
      const before = await part.getHotkeys();
      const changed = await part.setHotkey("addShortcut", "ctrl+alt+shift+j");
      const off = await part.setHotkey("stop", null);
      const reset = await part.resetHotkeys();
      if (!capabilities.hotkeys) {
        // Nothing to change, and asking isn't an error.
        expect([changed, off, reset]).toEqual([[], [], []]);
        return;
      }
      expect(keysOf(changed, "addShortcut")).toBe("ctrl+alt+shift+j");
      expect(keysOf(off, "stop")).toBeNull();
      expect(keysOf(off, "addShortcut")).toBe("ctrl+alt+shift+j");
      expect(reset.map(({ action, keys }) => ({ action, keys }))).toEqual(
        before.map(({ action, keys }) => ({ action, keys })),
      );
      expect(await part.getHotkeys()).toEqual(reset);
    });

    it("are suspended while Settings reads new keys, and answer the bindings", async () => {
      const { part, capabilities } = await make();
      const suspended = await part.suspendHotkeys(true);
      const resumed = await part.suspendHotkeys(false);
      expect(suspended).toHaveLength(capabilities.hotkeys ? HOTKEY_ACTIONS.length : 0);
      expect(resumed).toHaveLength(suspended.length);
    });
  });
}
