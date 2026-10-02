// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBrandProfile } from "@amluto-steps/core";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import type { RecorderBridge } from "../recorder-bridge";
import { BrandEditor } from "./BrandEditor";

initI18n();
afterEach(cleanup);

function open(checkFont = vi.fn()) {
  const onSave = vi.fn();
  const notify = vi.fn();
  const view = render(
    <BrandEditor
      initial={newBrandProfile("client", "Client", "#113355")}
      recorder={{ checkFont } as unknown as RecorderBridge}
      notify={notify}
      onCancel={vi.fn()}
      onSave={onSave}
    />,
  );
  return { onSave, notify, checkFont, view };
}

const font = (name: string) =>
  new File([new Uint8Array([0, 1, 0, 0, 9, 9])], name, { type: "font/ttf" });

describe("brand profile editor", () => {
  it("offers a readable shade for a pale colour, and never applies it by itself", async () => {
    const { onSave, view } = open();
    fireEvent.change(screen.getByLabelText("Accent", { selector: "input[type=color]" }), {
      target: { value: "#ffee99" },
    });
    const suggestion = await screen.findByRole("button", { name: /^Use #/ });
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    expect(onSave.mock.calls[0]?.[0].accent).toBe("#FFEE99");
    fireEvent.click(suggestion);
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    expect(onSave.mock.calls[1]?.[0].accent).not.toBe("#FFEE99");
    await expectNoSeriousAxeViolations(view.container);
  });

  it("uploads a font only when its licence allows embedding it", async () => {
    const checkFont = vi
      .fn()
      .mockResolvedValueOnce({ family: "Locked Sans", subfamily: "Regular", embeddable: false })
      .mockResolvedValueOnce({ family: "Brand Sans", subfamily: "Regular", embeddable: true });
    const { onSave, notify } = open(checkFont);
    const [headingUpload] = screen.getAllByLabelText("Upload .ttf…");
    if (!headingUpload) throw new Error("no upload");
    fireEvent.change(headingUpload, { target: { files: [font("locked.ttf")] } });
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({ text: expect.stringContaining("Locked Sans") }),
    );
    fireEvent.change(headingUpload, { target: { files: [font("brand.ttf")] } });
    await waitFor(() =>
      expect((screen.getByLabelText("Headings") as HTMLInputElement).value).toBe("Brand Sans"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    expect(onSave.mock.calls[0]?.[0].headingFont).toMatchObject({
      family: "Brand Sans",
      uploaded: { regular: expect.any(String), bold: null },
    });
  });

  it("in Chrome, asks once to use installed fonts, and says so when they're blocked", async () => {
    let state: "prompt" | "granted" | "denied" = "prompt";
    const allow = vi.fn(() => {
      state = "granted";
      return Promise.resolve(true);
    });
    const recorder = {
      checkFont: vi.fn(),
      localFonts: { state: () => Promise.resolve(state), allow },
    } as unknown as RecorderBridge;
    const brand = newBrandProfile("client", "Client", "#113355");
    const view = render(
      <BrandEditor
        initial={brand}
        recorder={recorder}
        notify={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Use my installed fonts" }));
    expect(allow).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Use my installed fonts" })).toBeNull(),
    );
    await expectNoSeriousAxeViolations(view.container);
    cleanup();
    state = "denied";
    render(
      <BrandEditor
        initial={brand}
        recorder={recorder}
        notify={vi.fn()}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Chrome is blocking installed fonts/)).toBeTruthy();
  });

  it("keeps dark colours only when the brand sets its own", () => {
    const { onSave } = open();
    fireEvent.click(screen.getByText("Dark mode colours"));
    fireEvent.click(screen.getByRole("button", { name: "Set Main (dark)…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save brand" }));
    expect(onSave.mock.calls[0]?.[0].dark).toEqual({ primary: "#113355" });
    fireEvent.click(screen.getByRole("button", { name: "Use the worked-out Main (dark)" }));
    expect(screen.getByRole("button", { name: "Set Main (dark)…" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Work out Accent from the main colour" }),
    ).toBeTruthy();
  });
});
