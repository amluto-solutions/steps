import { describe, expect, it } from "vitest";

import { appNameOf } from "./app-name.ts";

/** A window as the Windows recorder journals it: only the facts that name its app. */
const window = (facts: {
  title: string;
  exe: string | null;
  appName?: string | null;
  hostedApp?: string | null;
}) => facts;

describe("appNameOf", () => {
  it("names a store app by the app its frame shows, not the frame's host (#50)", () => {
    // Calculator's window belongs to ApplicationFrameHost.exe, whose description is its own.
    const calculator = window({
      title: "Calculator",
      exe: "ApplicationFrameHost.exe",
      appName: "Application Frame Host",
      hostedApp: "Calculator",
    });
    expect(appNameOf(calculator)).toBe("Calculator");
  });

  it("names a store app by its window's title when the app it shows wasn't found", () => {
    // Recordings before #50, or a frame whose app had let go of it (minimised).
    const settings = window({
      title: "Settings",
      exe: "ApplicationFrameHost.exe",
      appName: "Application Frame Host",
    });
    expect(appNameOf(settings)).toBe("Settings");
    expect(appNameOf({ ...settings, exe: "applicationframehost.exe", hostedApp: null })).toBe(
      "Settings",
    );
    // A store app that puts what it shows in its title too.
    expect(appNameOf({ ...settings, title: "IMG_0001.JPG ‎- Photos" })).toBe("Photos");
  });

  it("names a program by its own description, as before", () => {
    const word = window({
      title: "Document1 - Word",
      exe: "WINWORD.EXE",
      appName: "Microsoft Word",
    });
    const excel = window({ title: "Book1 - Excel", exe: "EXCEL.EXE", appName: "Microsoft Excel" });
    const explorer = window({
      title: "Downloads",
      exe: "explorer.exe",
      appName: "Windows Explorer",
    });
    expect(appNameOf(word)).toBe("Microsoft Word");
    expect(appNameOf(excel)).toBe("Microsoft Excel");
    expect(appNameOf(explorer)).toBe("Windows Explorer");
  });

  it("names a program without a description by the app part of its window's title", () => {
    // Paint describes itself only as "mspaint.exe", which the recorder doesn't take for a name.
    const paint = window({ title: "Untitled - Paint", exe: "mspaint.exe", appName: null });
    expect(appNameOf(paint)).toBe("Paint");
  });

  it("finds the app part of a title whichever dash it uses", () => {
    const untitled = (title: string) => appNameOf(window({ title, exe: "app.exe", appName: null }));
    expect(untitled("Quarterly report — Excel")).toBe("Excel");
    expect(untitled("Quarterly report – Excel")).toBe("Excel");
    // Store apps' titles put a left-to-right mark before the dash.
    expect(untitled("IMG_0001.JPG ‎- Photos")).toBe("Photos");
    // A title that is only the app's name.
    expect(untitled("Paint")).toBe("Paint");
    expect(untitled("Untitled - Paint - ")).toBe("Paint");
  });

  it("names a program by its file only when nothing else names it", () => {
    expect(appNameOf(window({ title: "", exe: "mspaint.exe", appName: null }))).toBe("mspaint");
    expect(appNameOf(window({ title: "  ", exe: "TOOL.EXE" }))).toBe("TOOL");
    expect(appNameOf(window({ title: "", exe: null }))).toBeNull();
    // Never after the frame's host: it isn't an app anyone went to.
    const frame = window({
      title: "",
      exe: "ApplicationFrameHost.exe",
      appName: "Application Frame Host",
    });
    expect(appNameOf(frame)).toBeNull();
  });
});
