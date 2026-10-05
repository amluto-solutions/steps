import { describe, expect, it } from "vitest";

import {
  GuessLimit,
  checkPassword,
  hashPassword,
  parseGuideHistory,
  parseGuideLock,
  passwordProblem,
  withEvent,
} from "./guide-lock.ts";

describe("guide password locks (04/10/2026)", () => {
  it("keeps a salted hash that only the password matches", async () => {
    const stored = await hashPassword("correct horse", 1_000);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(stored).not.toContain("correct horse");
    expect(await checkPassword("correct horse", stored)).toBe(true);
    expect(await checkPassword("Correct horse", stored)).toBe(false);
    // A second hash of the same password has its own salt.
    expect(await hashPassword("correct horse", 1_000)).not.toBe(stored);
    expect(await checkPassword("x", "nonsense")).toBe(false);
    expect(await checkPassword("x", "pbkdf2-sha256$10$AAAA$AAAA")).toBe(false);
  });

  it("checks a hash made by PowerShell's Rfc2898DeriveBytes, as IT makes the recovery password", async () => {
    // Made with Windows PowerShell 5.1: Rfc2898DeriveBytes("Recovery-2026", [byte[]](0..15), 1000,
    // SHA256).GetBytes(32), as docs/it/guide-locks.md shows.
    const stored =
      "pbkdf2-sha256$1000$AAECAwQFBgcICQoLDA0ODw==$HDeZ2ndXjp4MzPV0kQa9a8WPFqwRz3dBV0YTt3IBgbg=";
    expect(await checkPassword("Recovery-2026", stored)).toBe(true);
    expect(await checkPassword("Recovery-2027", stored)).toBe(false);
  });

  it("asks for at least 6 characters", () => {
    expect(passwordProblem("12345")).toBe("short");
    expect(passwordProblem("123456")).toBeNull();
    expect(passwordProblem("x".repeat(201))).toBe("long");
  });

  it("waits 30 seconds after 10 wrong tries", () => {
    let clock = 0;
    const limit = new GuessLimit(() => clock);
    for (let index = 0; index < 9; index += 1) limit.failed("g");
    expect(limit.waitFor("g")).toBe(0);
    limit.failed("g");
    expect(limit.waitFor("g")).toBe(30_000);
    clock = 30_000;
    expect(limit.waitFor("g")).toBe(0);
    limit.failed("g");
    expect(limit.waitFor("g")).toBe(30_000);
    limit.succeeded("g");
    expect(limit.waitFor("g")).toBe(0);
    expect(limit.waitFor("other")).toBe(0);
  });

  it("reads its files leniently, and keeps the newest 200 events", () => {
    expect(parseGuideLock({ formatVersion: 1 })).toBeNull();
    expect(
      parseGuideLock({
        formatVersion: 1,
        locked: { by: "Robin", at: "2026-10-04T10:00:00Z" },
        password: "pbkdf2-sha256$1000$AAAA$AAAA",
      })?.locked,
    ).toEqual({ by: "Robin", login: "", pc: "", at: "2026-10-04T10:00:00Z" });
    let history = parseGuideHistory("junk");
    expect(history.saves).toBe(0);
    for (let index = 0; index < 205; index += 1)
      history = withEvent(history, {
        kind: "locked",
        by: String(index),
        login: "",
        pc: "",
        at: "",
      });
    expect(history.events).toHaveLength(200);
    expect(history.events[0]?.by).toBe("5");
  });
});
