// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBrandProfile } from "@amluto-steps/core";

import { fakeBrands } from "../bridge/brands-fake";
import { fakeFonts } from "../bridge/fonts-fake";
import { initI18n } from "../i18n";
import { fakeLibrary } from "../library-fake";
import { amlbrandFile } from "./brands";
import { BrandsSection } from "./BrandsSection";

initI18n();
afterEach(cleanup);

describe("importing a brand file", () => {
  it("can't replace a brand the organisation deploys, whatever its version", async () => {
    const deployed = newBrandProfile("acme", "Acme", "#113355");
    const incoming = { ...deployed, name: "Not Acme", version: 999 };
    const brands = fakeBrands({ managed: [deployed] });
    await brands.writeBrandFile("C:/In/acme.amlbrand", amlbrandFile(incoming));
    const saveBrand = vi.spyOn(brands, "saveBrand");
    const notify = vi.fn();
    render(
      <BrandsSection
        recorder={{ ...brands, ...fakeFonts() }}
        library={fakeLibrary({ picks: { file: "C:/In/acme.amlbrand" } })}
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
