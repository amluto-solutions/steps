import { describe, expect, it } from "vitest";

import { readStamp, unstamped } from "./stamp.mjs";

const program = (stamp) =>
  Buffer.concat([
    Buffer.from([0x4d, 0x5a, 0, 1, 2]),
    Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${stamp}`, "latin1"),
    Buffer.from([3, 4, 0xff]),
  ]);

describe("the installer stamp", () => {
  it("is read, and replaced with unknown without moving anything", () => {
    expect(readStamp(program("NSS"))).toBe("NSS");
    const cleared = unstamped(program("NSS"));
    expect(readStamp(cleared)).toBe("UNK");
    expect(cleared).toHaveLength(program("NSS").length);
    expect(cleared.subarray(0, 5)).toEqual(program("NSS").subarray(0, 5));
    expect(cleared.subarray(-3)).toEqual(program("NSS").subarray(-3));
  });

  it("refuses a program with no stamp, or more than one", () => {
    expect(() => readStamp(Buffer.from("MZ nothing here"))).toThrow(/found 0/);
    expect(() => unstamped(Buffer.concat([program("NSS"), program("MSI")]))).toThrow(/found 2/);
  });
});
