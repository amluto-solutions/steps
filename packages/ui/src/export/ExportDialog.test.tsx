// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBrandProfile, type Guide, type GuideStep } from "@amluto-steps/core";
import { renderStepImage } from "@amluto-steps/export";

import { initI18n } from "../i18n";
import { blankStep } from "../editor/edits";
import type { RecorderBridge } from "../recorder-bridge";
import { NO_POLICY, setPolicy } from "../settings/policy";
import { ExportDialog } from "./ExportDialog";

// jsdom has no canvas: drawing a screenshot is stubbed, everything else is real.
vi.mock("@amluto-steps/export", async (original) => ({
  ...(await original<typeof import("@amluto-steps/export")>()),
  renderStepImage: vi.fn(async () => ({
    dataUrl: "data:image/png;base64,AAAA",
    width: 10,
    height: 10,
  })),
}));

initI18n();
afterEach(cleanup);

const guide = {
  id: "g",
  title: "Add a supplier",
  description: "",
  intro: null,
  outro: null,
} as Guide;
const shot = (id: string): GuideStep => ({
  ...blankStep(id, { at: 0, by: "Robin" }),
  kind: "interaction",
  action: "click",
  actionText: `Click ${id}`,
  media: { id: `m-${id}`, width: 10, height: 10, scale: 1, captureRect: null },
});

function open(options: {
  loadImage: (id: string) => Promise<string>;
  readText: () => Promise<unknown>;
  format?: "pdf" | "amlsteps";
  pickSaveLocation?: () => Promise<string | null>;
  saveAmlsteps?: (path: string, includeOriginals: boolean) => Promise<void>;
  onExported?: () => void;
}) {
  const recorder = { readText: options.readText } as unknown as RecorderBridge;
  render(
    <ExportDialog
      format={options.format ?? "pdf"}
      doc={{ guide, steps: [shot("a"), shot("b")] }}
      preparedBy="Robin"
      recorder={recorder}
      loadImage={options.loadImage}
      pickSaveLocation={options.pickSaveLocation ?? vi.fn()}
      saveAmlsteps={options.saveAmlsteps}
      firstExport={false}
      onClose={vi.fn()}
      onExported={options.onExported ?? vi.fn()}
      onShowStep={vi.fn()}
      brands={[]}
      blurTerms={[]}
    />,
  );
}

const exportButton = () =>
  screen.getByRole("button", { name: /^Export PDF$/ }) as HTMLButtonElement;

describe("pages before the steps", () => {
  const header = (id: string, heading: string): GuideStep => ({
    ...blankStep(id, { at: 0, by: "Robin" }),
    kind: "block",
    block: { type: "header", heading, body: null },
  });
  const show = (steps: GuideStep[], format: "pdf" | "docx" | "html") =>
    render(
      <ExportDialog
        format={format}
        doc={{ guide, steps }}
        preparedBy="Robin"
        recorder={{ readText: () => Promise.resolve([]) } as unknown as RecorderBridge}
        loadImage={() => Promise.resolve("data:image/png;base64,AAAA")}
        pickSaveLocation={vi.fn()}
        listVersions={() => Promise.resolve([])}
        firstExport={false}
        onClose={vi.fn()}
        onExported={vi.fn()}
        onShowStep={vi.fn()}
        brands={[]}
        blurTerms={[]}
      />,
    );

  it("offers a contents page, on when the guide has sections, and document control, off", () => {
    show([header("h1", "Set up"), shot("a"), header("h2", "Pay"), shot("b")], "docx");
    const contents = screen.getByRole("checkbox", { name: /Contents page/ });
    expect(contents).toHaveProperty("checked", true);
    expect(screen.getByText("Lists the guide’s 2 sections, from its header blocks.")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: /Document control page/ })).toHaveProperty(
      "checked",
      false,
    );
  });

  it("offers no contents page without sections, and neither page for a web page", () => {
    show([shot("a"), shot("b")], "pdf");
    expect(screen.queryByRole("checkbox", { name: /Contents page/ })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /Document control page/ })).toBeTruthy();
    cleanup();
    show([header("h1", "Set up"), shot("a")], "html");
    expect(screen.queryByRole("checkbox", { name: /Contents page/ })).toBeNull();
  });
});

describe("review before export", () => {
  it("lets a guide export when one screenshot can't be loaded, and says which", async () => {
    open({
      loadImage: (id) =>
        id === "m-b" ? Promise.reject(new Error("gone")) : Promise.resolve("data:x"),
      readText: () => Promise.resolve([]),
    });
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    expect(screen.getByText(/1 screenshot couldn’t be loaded/)).toBeTruthy();
    const loadedRow = screen.getByText(/1 screenshot couldn’t be loaded/).closest("li");
    expect(loadedRow && within(loadedRow).getByRole("button", { name: "Step 2" })).toBeTruthy();
  });

  it("never reports screenshots as clean when they couldn't be checked", async () => {
    open({
      loadImage: () => Promise.resolve("data:x"),
      readText: () => Promise.reject(new Error("no OCR language")),
    });
    await waitFor(() => expect(exportButton().disabled).toBe(false));
    expect(screen.getByText(/2 screenshots couldn’t be checked for personal data/)).toBeTruthy();
    expect(screen.queryByText(/No personal data was found/)).toBeNull();
  });
});

describe("Steps file export", () => {
  it("reviews first, keeps originals out unless asked, and warns when they are in", async () => {
    const saveAmlsteps = vi.fn(() => Promise.resolve());
    const onExported = vi.fn();
    const pickSaveLocation = vi.fn(() => Promise.resolve("C:/Out/Add a supplier.amlsteps"));
    open({
      format: "amlsteps",
      loadImage: () => Promise.resolve("data:x"),
      readText: () => Promise.resolve([]),
      pickSaveLocation,
      saveAmlsteps,
      onExported,
    });
    const exportIt = () =>
      screen.getByRole("button", { name: /^Export Steps file$/ }) as HTMLButtonElement;
    await waitFor(() => expect(exportIt().disabled).toBe(false));
    const originals = screen.getByRole("checkbox", { name: /Include unblurred originals/ });
    expect((originals as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(originals);
    expect(screen.getByRole("alert").textContent).toMatch(/without its blur/);
    fireEvent.click(originals);

    fireEvent.click(exportIt());
    await waitFor(() =>
      expect(saveAmlsteps).toHaveBeenCalledWith("C:/Out/Add a supplier.amlsteps", false),
    );
    expect(pickSaveLocation).toHaveBeenCalledTimes(1);
    expect(onExported).toHaveBeenCalledWith("amlsteps", expect.any(String), null);
  });

  it("keeps originals out when the organisation locks them", async () => {
    setPolicy({ ...NO_POLICY, locked: ["IncludeOriginals"] });
    try {
      open({
        format: "amlsteps",
        loadImage: () => Promise.resolve("data:x"),
        readText: () => Promise.resolve([]),
      });
      const originals = await screen.findByRole("checkbox", {
        name: /Include unblurred originals/,
      });
      expect((originals as HTMLInputElement).disabled).toBe(true);
      expect(screen.getByText("Set by your organisation")).toBeDefined();
    } finally {
      setPolicy(NO_POLICY);
    }
  });
});

describe("the review's checklist", () => {
  const typed: GuideStep = {
    ...shot("t"),
    action: "input",
    actionText: 'Type "Acme Ltd" in "Name"',
    textParts: { verb: "Type", target: "Name", kind: "field", value: "Acme Ltd" },
    showValue: true,
  };

  function review(
    edit: ((make: never) => unknown) | null = vi.fn(),
    steps: GuideStep[] = [shot("a"), typed],
    onShowStep: ((id: string) => void) | null = vi.fn(),
  ) {
    const readText = vi.fn(() =>
      Promise.resolve([{ words: [{ text: "jane@acme.com", x: 10, y: 10, w: 20, h: 3 }] }]),
    );
    const view = render(
      <ExportDialog
        format="pdf"
        doc={{ guide, steps }}
        preparedBy="Robin"
        recorder={{ readText } as unknown as RecorderBridge}
        loadImage={() => Promise.resolve("data:image/png;base64,AAAA")}
        pickSaveLocation={vi.fn()}
        firstExport={false}
        onClose={vi.fn()}
        onExported={vi.fn()}
        onShowStep={onShowStep ?? undefined}
        brands={[{ ...newBrandProfile("client", "Client", "#113355"), accent: "#225577" }]}
        blurTerms={[]}
        edit={(edit ?? undefined) as ((make: unknown) => void) | undefined}
      />,
    );
    return { view, readText };
  }

  it("warns about a shown value that looks like a password, and hides it in one press (A1)", async () => {
    const password: GuideStep = {
      ...typed,
      id: "p",
      actionText: 'Type "Qz7Test"',
      textParts: { verb: "Type", target: "", kind: "field", value: "Qz7Test" },
    };
    const edit = vi.fn();
    review(edit, [shot("a"), typed, password]);
    expect(
      await screen.findByText("1 typed value shown looks like it could be a password."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide it" }));
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("toggles each typed value and hides them all, as edits to the guide", async () => {
    const edit = vi.fn();
    review(edit);
    const toggle = await screen.findByRole("checkbox", { name: /Step 2: show “Acme Ltd”/ });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Hide all typed values" }));
    expect(edit).toHaveBeenCalledTimes(2);
    // Each edit really hides the value when applied to the guide.
    const doc = { guide, steps: [shot("a"), typed] };
    for (const [make] of edit.mock.calls as [
      (d: typeof doc, s: { at: number; by: string }) => { changes: { after: GuideStep }[] } | null,
    ][]) {
      const made = make(doc, { at: 0, by: "Robin" });
      expect(made?.changes[0]?.after.showValue).toBe(false);
    }
  });

  it("keeps hand-edited wording when a value is hidden, and asks before showing replaces it", async () => {
    const edited: GuideStep = {
      ...typed,
      actionText: 'Enter the customer "Acme Ltd" exactly as on the invoice',
      textEdited: true,
    };
    const edit = vi.fn();
    review(edit, [shot("a"), edited]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Step 2: show “Acme Ltd”/ }));
    await waitFor(() => expect(edit).toHaveBeenCalled());
    const doc = { guide, steps: [shot("a"), edited] };
    type Make = (
      d: typeof doc,
      s: { at: number; by: string },
    ) => { changes: { after: GuideStep }[] } | null;
    const hidden = (edit.mock.calls[0] as [Make])[0](doc, { at: 0, by: "Robin" })?.changes[0]
      ?.after;
    expect(hidden?.actionText).toContain("exactly as on the invoice");
    expect(hidden?.actionText).not.toContain("Acme");
    expect(hidden?.textEdited).toBe(true);

    // Showing again: declining keeps the edited wording.
    cleanup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const again = vi.fn();
    review(again, [shot("a"), { ...edited, showValue: false }]);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Step 2: show “Acme Ltd”/ }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => expect(again).toHaveBeenCalled());
    const shown = (again.mock.calls[0] as [Make])[0](
      { guide, steps: [shot("a"), { ...edited, showValue: false }] },
      { at: 0, by: "Robin" },
    )?.changes[0]?.after;
    expect(shown?.showValue).toBe(true);
    expect(shown?.actionText).toBe(edited.actionText);
    confirm.mockRestore();
  });

  it("opens a step on top of the review to fix it there, or goes to the editor from it", async () => {
    const showStep = vi.fn();
    const edit = vi.fn();
    review(edit, [shot("a"), typed], showStep);
    fireEvent.click((await screen.findAllByRole("button", { name: "Step 1" }))[0] as HTMLElement);
    const dialog = await screen.findByRole("dialog", { name: "Step 1" });
    // Its wording, alt text and screenshot tools, each change an edit to the guide.
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Step text" }), {
      target: { value: "Click the Contacts tab" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Alt text" }), {
      target: { value: "The Contacts tab, top left" },
    });
    expect(edit).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("toolbar", { name: "Screenshot tools" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Open in the editor" }));
    expect(showStep).toHaveBeenCalledWith("a");
    // Done goes back to the review, which is still open.
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Step 1" })).toBeNull();
    expect(screen.getByRole("button", { name: "Edit step 1" })).toBeTruthy();
  });

  it("names the steps as plain text when they can't be opened from the review", async () => {
    review(null, [shot("a"), typed], null);
    await screen.findByText(/personal data/i);
    // The step is named as plain text (the review has other Step buttons of its own).
    await waitFor(() =>
      expect(
        screen.getAllByText("Step 1").some((item) => item.tagName === "SPAN" && item.closest("li")),
      ).toBe(true),
    );
  });

  it("outlines possible personal data on the picture, and says nothing of generated alt text", async () => {
    review();
    expect(await screen.findByText(/possible personal details? (isn|aren)/)).toBeTruthy();
    // 30/09/2026: the alt text note was noise in the review.
    expect(screen.queryByText(/generated alt text/)).toBeNull();
    await waitFor(() =>
      expect(document.querySelectorAll(".border-dashed.border-warning").length).toBeGreaterThan(0),
    );
  });

  it("blurs every possible personal detail in one go, as one edit, and clears the warning", async () => {
    const edit = vi.fn();
    review(edit);
    await screen.findByText(/possible personal details? (isn|aren)/);
    fireEvent.click(await screen.findByRole("button", { name: "Blur all" }));
    expect(edit).toHaveBeenCalledTimes(1);
    const doc = { guide, steps: [shot("a"), typed] };
    const [make] = edit.mock.calls[0] as [
      (d: typeof doc, s: { at: number; by: string }) => { changes: { after: GuideStep }[] } | null,
    ];
    const made = make(doc, { at: 0, by: "Robin" });
    // Both screenshots showed the email, and both get a suggested blur over it.
    expect(made?.changes).toHaveLength(2);
    expect(made?.changes[0]?.after.redactions[0]).toMatchObject({ source: "suggested" });
    expect(await screen.findByText(/No personal data was found unblurred/)).toBeTruthy();
  });

  it("redraws the pictures in a new brand's colours without reading them again", async () => {
    const { readText } = review();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /^Export PDF$/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const drawn = vi.mocked(renderStepImage).mock.calls.length;
    const reads = readText.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: "Brand" }), {
      target: { value: "client" },
    });
    await waitFor(() => expect(vi.mocked(renderStepImage).mock.calls.length).toBe(drawn + 2));
    const lastLook = vi.mocked(renderStepImage).mock.calls.at(-1)?.[2];
    expect(lastLook?.primary.toLowerCase()).toBe("#113355");
    expect(readText.mock.calls.length).toBe(reads);
  });
});

describe("languages", () => {
  const show = (format: "pdf" | "copy" | "html") =>
    render(
      <ExportDialog
        format={format}
        doc={{ guide, steps: [shot("a"), shot("b")] }}
        preparedBy="Robin"
        recorder={{ readText: () => Promise.resolve([]) } as unknown as RecorderBridge}
        loadImage={() => Promise.resolve("data:image/png;base64,AAAA")}
        pickSaveLocation={vi.fn()}
        firstExport={false}
        onClose={vi.fn()}
        onExported={vi.fn()}
        onShowStep={vi.fn()}
        brands={[]}
        blurTerms={[]}
      />,
    );

  it("exports in the guide's own language, and says which texts another one is missing", () => {
    show("pdf");
    const language = screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
    expect(language.value).toBe("en");
    expect(screen.queryByText(/yet, so (it|they) exports? in English/)).toBeNull();
    fireEvent.change(language, { target: { value: "de" } });
    // The title and the two hand-written step texts were written in English only.
    expect(
      screen.getByText("3 texts you wrote aren’t in Deutsch yet, so they export in English."),
    ).toBeTruthy();
  });

  it("makes more languages a choice in the dialog, for PDF and Word only", () => {
    show("pdf");
    fireEvent.click(screen.getByText("More languages"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Français" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "日本語" }));
    expect(screen.getByText("2 more languages")).toBeTruthy();
    // Each extra language says what it hasn't got, too (F041).
    expect(
      screen.getByText("3 texts you wrote aren’t in Français yet, so they export in English."),
    ).toBeTruthy();
    cleanup();
    show("copy");
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
    expect(screen.queryByText("More languages")).toBeNull();
  });

  it("puts every language in the web page unless told otherwise", () => {
    show("html");
    const select = screen.getByRole("combobox", {
      name: "Languages in the page",
    }) as HTMLSelectElement;
    expect(select.value).toBe("all");
    expect([...select.options].map((option) => option.text)).toEqual([
      "All 38",
      "Only fully written (1)",
      "Just English",
    ]);
    expect(screen.queryByRole("combobox", { name: "Language" })).toBeNull();
  });
});
