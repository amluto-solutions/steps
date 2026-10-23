import { describe, expect, it } from "vitest";

import { commonShortcut } from "./common-shortcuts";

describe("a combination other apps use themselves", () => {
  it("names what it does where that's the same in most apps", () => {
    // P24 (10/10/2026 test): Ctrl+Shift+R as Start took browsers' hard reload.
    expect(commonShortcut("ctrl+shift+r")).toBe("reloadNoCache");
    expect(commonShortcut("ctrl+f5")).toBe("reloadNoCache");
    expect(commonShortcut("ctrl+shift+t")).toBe("reopenTab");
    expect(commonShortcut("ctrl+shift+v")).toBe("pastePlain");
    expect(commonShortcut("alt+f4")).toBe("closeWindow");
  });

  it("says many apps use Ctrl with one letter or number, and Alt with a letter", () => {
    expect(commonShortcut("ctrl+c")).toBe("many");
    expect(commonShortcut("ctrl+r")).toBe("many");
    expect(commonShortcut("ctrl+1")).toBe("many");
    // Alt and a letter opens a menu (Alt + F, the File menu).
    expect(commonShortcut("alt+f")).toBe("many");
  });

  it("is quiet about combinations few apps use", () => {
    expect(commonShortcut("ctrl+alt+shift+n")).toBeNull();
    expect(commonShortcut("ctrl+alt+r")).toBeNull();
    expect(commonShortcut("ctrl+shift+u")).toBeNull();
    expect(commonShortcut("alt+shift+f")).toBeNull();
    expect(commonShortcut("ctrl+f9")).toBeNull();
  });

  it("reads the keys however they're written", () => {
    expect(commonShortcut("Shift+Ctrl+R")).toBe("reloadNoCache");
  });
});
