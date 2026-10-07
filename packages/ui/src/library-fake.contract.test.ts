import { describe, expect, it } from "vitest";

import { libraryContract } from "./library-contract";
import { fakeLibrary } from "./library-fake";

libraryContract("the fake library", () =>
  Promise.resolve({
    library: fakeLibrary({
      libraries: [
        { id: "lib-1", name: "My guides" },
        { id: "lib-2", name: "Finance team" },
      ],
    }),
    libraryId: "lib-1",
    otherLibraryId: "lib-2",
  }),
);

// What a test sets up through the fake's data, beyond what the contract covers.
describe("the fake library's set-ups", () => {
  const guide = { id: "g1", title: "Shared", updatedAt: "", tags: [], owner: "Sam" };
  const sam = { name: "Sam", pc: "PC-2", session: "s2", counter: 4, since: "2026-10-07T09:00:00Z" };

  it("opens a guide someone else is editing read-only, unless taking it over", async () => {
    const library = fakeLibrary({
      libraries: [{ id: "lib-1", name: "My guides", guides: [{ guide, steps: [] }] }],
    });
    const stored = library.data.libraries.get("lib-1")?.guides.get("g1");
    if (!stored) throw new Error("no guide");
    stored.editor = sam;
    expect(await library.openForEditing("lib-1", "g1", false)).toEqual({
      kind: "readOnly",
      lock: sam,
    });
    expect(await library.openForEditing("lib-1", "g1", true)).toEqual({ kind: "editing" });
  });

  it("tells whoever listens that an edit lock was lost, until they stop", async () => {
    const library = fakeLibrary();
    const heard: string[] = [];
    const stop = await library.onLockLost((lost) => heard.push(lost.guideId));
    library.loseLock({ libraryId: "lib-1", guideId: "g1", lock: sam });
    stop();
    library.loseLock({ libraryId: "lib-1", guideId: "g2", lock: sam });
    expect(heard).toEqual(["g1"]);
  });

  it("answers the file dialogs as told, and null as when cancelled", async () => {
    const library = fakeLibrary({ picks: { file: "C:/In/acme.amlbrand" } });
    expect(await library.pickFile("Open", [])).toBe("C:/In/acme.amlbrand");
    expect(await library.pickFolder("Choose")).toBeNull();
  });
});
