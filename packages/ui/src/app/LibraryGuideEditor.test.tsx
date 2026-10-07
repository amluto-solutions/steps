// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import type { GuideStore } from "../editor/useGuideEditor";
import { initI18n } from "../i18n";
import type { EditLock, LibraryBridge } from "../library-bridge";
import { fakeLibrary } from "../library-fake";
import { toDoc } from "./documents";
import { LibraryGuideEditor } from "./LibraryGuideEditor";

initI18n();
afterEach(cleanup);

const guideFile = {
  id: "g1",
  title: "Payroll run",
  description: "",
  intro: null,
  outro: null,
  brandProfileId: null,
  tags: [],
  owner: "Robin",
  reviewBy: null,
  createdAt: "2026-09-25T10:00:00.000Z",
  createdBy: "Robin",
  updatedAt: "2026-09-25T10:00:00.000Z",
  updatedBy: "Robin",
  formatVersion: 1,
};
const raw = { guide: guideFile, steps: [] };

const sam: EditLock = {
  name: "Sam",
  pc: "PC-2",
  session: "s2",
  counter: 4,
  since: "2026-09-29T09:32:00.000Z",
};

/**
 * The UI package's fake library holding the guide, with every method spied on. `stored` is the
 * guide as the fake keeps it, for a test to put someone else's lock, drafts, conflicts or
 * comments on.
 */
function makeLibrary() {
  const library = fakeLibrary({ libraries: [{ id: "lib", name: "Payroll", guides: [raw] }] });
  for (const name of Object.keys(library) as (keyof LibraryBridge)[])
    if (typeof library[name] === "function") vi.spyOn(library, name);
  const stored = library.data.libraries.get("lib")?.guides.get("g1");
  if (!stored) throw new Error("the guide isn't in the fake library");
  return { library, stored };
}

const store: GuideStore = {
  saveGuide: vi.fn().mockResolvedValue(undefined),
  saveStep: vi.fn().mockResolvedValue(undefined),
  deleteStep: vi.fn().mockResolvedValue(undefined),
  loadImage: vi.fn().mockRejectedValue(new Error("no images here")),
};

function show(library: LibraryBridge, onOpenGuide = vi.fn()) {
  return render(
    <LibraryGuideEditor
      library={library}
      libraryId="lib"
      initial={toDoc(raw)}
      store={store}
      author="Robin"
      mode="saved"
      busy={false}
      onBack={vi.fn()}
      exportMenu={() => []}
      notify={vi.fn()}
      blurTerms={[]}
      onOpenGuide={onOpenGuide}
    />,
  );
}

describe("a guide in a shared library", () => {
  it("opens read-only while someone else is editing, and takes over only when confirmed", async () => {
    const { library, stored } = makeLibrary();
    stored.editor = sam;
    const { container } = show(library);
    expect(await screen.findByText(/Sam is editing this guide/)).toBeTruthy();
    await expectNoSeriousAxeViolations(container);

    fireEvent.click(screen.getByRole("button", { name: "Take over editing" }));
    const dialog = await screen.findByRole("alertdialog");
    // It starts on the safe choice.
    expect(document.activeElement?.textContent).toBe("Keep reading");
    fireEvent.click(within(dialog).getByRole("button", { name: "Take over editing" }));
    await waitFor(() => expect(library.openForEditing).toHaveBeenLastCalledWith("lib", "g1", true));
    await waitFor(() => expect(screen.queryByText(/Sam is editing this guide/)).toBeNull());
  });

  it("lets go of the lock when the editor closes", async () => {
    const { library } = makeLibrary();
    const { unmount } = show(library);
    await waitFor(() => expect(library.openForEditing).toHaveBeenCalledWith("lib", "g1", false));
    unmount();
    expect(library.releaseLock).toHaveBeenCalledWith("lib", "g1");
  });

  it("offers a displaced editor's draft, and opens it as a copy", async () => {
    const onOpenGuide = vi.fn();
    const { library, stored } = makeLibrary();
    const step = (id: string) => ({ id, sortKey: id, actionText: `Click ${id}` });
    stored.drafts = [
      {
        info: { id: "s1", by: "Robin", at: "2026-09-29T10:45:00.000Z", stepCount: 3 },
        document: { guide: guideFile, steps: [step("a1"), step("a2"), step("a3")] },
      },
    ];
    show(library, onOpenGuide);
    expect(await screen.findByText(/Unsaved changes by Robin from 29\/09\/2026/)).toBeTruthy();
    expect(screen.getByText(/\(3 steps\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open as a copy" }));
    await waitFor(() =>
      expect(onOpenGuide).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Payroll run (Robin's changes)", stepCount: 3 }),
      ),
    );
    expect(library.draftToCopy).toHaveBeenCalledWith(
      "lib",
      "g1",
      "s1",
      "Payroll run (Robin's changes)",
    );
  });

  it("shows both versions of a step saved in two places, and keeps the one chosen", async () => {
    const { library, stored } = makeLibrary();
    stored.conflicts = [
      {
        kind: "step",
        file: "s1-SAMS-PC.json",
        id: "s1",
        from: "SAMS-PC",
        ours: { actionText: 'Click "Run"', updatedBy: "Robin" },
        theirs: { actionText: 'Click "Run payroll"', updatedBy: "Sam" },
      },
    ];
    show(library);
    expect(
      await screen.findByText(/changed in two places at once \(one copy from SAMS-PC\)/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: 'Keep "Click "Run"" (Robin)' })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: 'Keep "Click "Run payroll"" (Sam)' }));
    await waitFor(() =>
      expect(library.resolveConflict).toHaveBeenCalledWith(
        "lib",
        "g1",
        "s1-SAMS-PC.json",
        "keepTheirs",
      ),
    );
    await waitFor(() => expect(screen.queryByText(/changed in two places at once/)).toBeNull());
  });

  it("says who deleted a step that came back, and deletes it again only when asked", async () => {
    const { library, stored } = makeLibrary();
    stored.conflicts = [
      {
        kind: "restored",
        id: "s1",
        deletedBy: "Robin",
        step: { actionText: "Click Send", updatedBy: "Sam" },
      },
    ];
    show(library);
    expect(
      await screen.findByText(
        'Robin deleted the step "Click Send", but Sam changed it meanwhile, so it\'s back.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete it" }));
    await waitFor(() =>
      expect(library.resolveConflict).toHaveBeenCalledWith("lib", "g1", "s1", "keepOurs"),
    );
  });

  it("adds a comment about the whole guide, and shows it once saved", async () => {
    const thread = { text: "Step 4 changed after the October update" };
    const { library } = makeLibrary();
    const { container } = show(library);
    fireEvent.click(await screen.findByRole("button", { name: "Comments" }));
    const panel = screen.getByRole("complementary", { name: "Review comments" });
    expect(within(panel).getByText("No comments yet.")).toBeTruthy();
    fireEvent.change(within(panel).getByRole("textbox", { name: "New comment" }), {
      target: { value: thread.text },
    });
    fireEvent.click(within(panel).getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(library.addComment).toHaveBeenCalledWith("lib", "g1", null, null, thread.text),
    );
    expect(await within(panel).findByText(thread.text)).toBeTruthy();
    expect(within(panel).getByRole("textbox", { name: "New comment" })).toHaveProperty("value", "");
    // Yours and nobody has replied, so you can delete it.
    expect(within(panel).getByRole("button", { name: "Delete comment" })).toBeTruthy();
    await expectNoSeriousAxeViolations(container);
  });

  it("replies to and resolves someone else's thread; resolved threads are tucked away", async () => {
    const { library, stored } = makeLibrary();
    stored.comments = [
      {
        id: "c1",
        text: "Is this still right?",
        by: "Sam",
        at: "2026-09-29T10:00:00.000Z",
        stepId: null,
        replyTo: null,
        resolved: null,
      },
    ];
    show(library);
    fireEvent.click(await screen.findByRole("button", { name: /Comments/ }));
    const panel = screen.getByRole("complementary", { name: "Review comments" });
    expect(await within(panel).findByText("Is this still right?")).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: "Delete comment" })).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Reply" }));
    fireEvent.change(within(panel).getByRole("textbox", { name: "Reply" }), {
      target: { value: "Yes" },
    });
    fireEvent.click(within(panel).getAllByRole("button", { name: "Reply" }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(library.addComment).toHaveBeenCalledWith("lib", "g1", null, "c1", "Yes"),
    );

    fireEvent.click(within(panel).getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(library.resolveComment).toHaveBeenCalledWith("lib", "g1", "c1", true),
    );
    await waitFor(() => expect(within(panel).queryByText("Is this still right?")).toBeNull());
    fireEvent.click(within(panel).getByRole("checkbox", { name: "Show 1 resolved thread" }));
    expect(within(panel).getByText(/Resolved by Robin/)).toBeTruthy();
  });

  it("takes comments on a guide someone else is editing", async () => {
    const { library, stored } = makeLibrary();
    stored.editor = sam;
    show(library);
    expect(await screen.findByText(/Sam is editing this guide/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    fireEvent.change(screen.getByRole("textbox", { name: "New comment" }), {
      target: { value: "Looks good" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    await waitFor(() =>
      expect(library.addComment).toHaveBeenCalledWith("lib", "g1", null, null, "Looks good"),
    );
  });

  it("moves focus into the comments panel and back out with Escape", async () => {
    show(makeLibrary().library);
    const button = await screen.findByRole("button", { name: "Comments" });
    fireEvent.click(button);
    const box = screen.getByRole("textbox", { name: "New comment" });
    await waitFor(() => expect(document.activeElement).toBe(box));
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Review comments" })).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
