// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBrandProfile } from "@amluto-steps/core";

import { initI18n } from "../i18n";
import type { LibraryBridge } from "../library-bridge";
import type { RecorderBridge } from "../recorder-bridge";
import { amlbrandFile } from "./brands";
import { BrandsSection } from "./BrandsSection";

initI18n();
afterEach(cleanup);

describe("importing a brand file", () => {
  it("can't replace a brand the organisation deploys, whatever its version", async () => {
    const deployed = newBrandProfile("acme", "Acme", "#113355");
    const incoming = { ...deployed, name: "Not Acme", version: 999 };
    const saveBrand = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    render(
      <BrandsSection
        recorder={
          {
            readBrandFile: vi.fn().mockResolvedValue(amlbrandFile(incoming)),
            checkFont: vi.fn().mockResolvedValue({ embeddable: true }),
            saveBrand,
          } as unknown as RecorderBridge
        }
        library={
          { pickFile: vi.fn().mockResolvedValue("C:/In/acme.amlbrand") } as unknown as LibraryBridge
        }
        managedIds={["acme"]}
        brands={[deployed]}
        onChanged={vi.fn().mockResolvedValue(undefined)}
        notify={notify}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Import brand/ }));
    await waitFor(() => expect(notify).toHaveBeenCalled());
    expect(notify.mock.calls[0]?.[0]).toEqual({
      text: "“Acme” is a brand your organisation manages, so a file can’t replace it.",
    });
    expect(saveBrand).not.toHaveBeenCalled();
  });
});
