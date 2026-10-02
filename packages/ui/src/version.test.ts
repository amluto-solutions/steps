import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { APP_VERSION } from "./version";

describe("the version shown in About", () => {
  it("is the app's own version", () => {
    const conf = JSON.parse(
      readFileSync(
        new URL("../../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    ) as { version: string };
    expect(APP_VERSION).toBe(conf.version);
  });
});
