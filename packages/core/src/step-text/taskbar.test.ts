import { describe, expect, it } from "vitest";

import { taskbarAppName } from "./phrase";

describe("the app a taskbar button stands for", () => {
  it("is the last part of its window's name, without the count", () => {
    expect(taskbarAppName("New tab - Work - Microsoft\u{200B} Edge - 1 running window")).toBe(
      "Microsoft Edge",
    );
    expect(taskbarAppName("Notepad - 2 running windows")).toBe("Notepad");
  });

  it("leaves out pinned, running or not", () => {
    expect(taskbarAppName("Google Chrome - 1 running window pinned")).toBe("Google Chrome");
    expect(taskbarAppName("Steps by Amluto - Google Chrome - 3 running windows pinned")).toBe(
      "Google Chrome",
    );
    expect(taskbarAppName("Google Chrome pinned")).toBe("Google Chrome");
  });
});
