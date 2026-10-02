import { describe, expect, it, vi } from "vitest";
import { newBrandProfile } from "@amluto-steps/core";

import { amlbrandFile, readAmlbrand, syncPolicyBrands } from "./brands";

const client = {
  ...newBrandProfile("client", "Client", "#113355"),
  version: 4,
  coverLogo: { type: "svg" as const, data: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
  headingFont: { family: "Brand Sans", uploaded: { regular: "AAEAAA==", bold: null } },
};
const toPng = vi.fn(async () => "data:image/png;base64,AAAA");

describe(".amlbrand files", () => {
  it("round-trip a profile, converting SVG logos and keeping fonts that may be embedded", async () => {
    const { profile, droppedFonts } = await readAmlbrand(
      amlbrandFile(client),
      async () => ({ embeddable: true }),
      toPng,
    );
    expect(profile.coverLogo).toEqual({ type: "png", data: "data:image/png;base64,AAAA" });
    expect(profile.headingFont?.family).toBe("Brand Sans");
    expect(profile.version).toBe(4);
    expect(droppedFonts).toEqual([]);
  });

  it("leave out a font whose licence forbids embedding", async () => {
    const { profile, droppedFonts } = await readAmlbrand(
      amlbrandFile(client),
      async () => ({ embeddable: false }),
      toPng,
    );
    expect(profile.headingFont).toBeNull();
    expect(droppedFonts).toEqual(["Brand Sans"]);
  });

  it("refuse anything else, including a file claiming to be the built-in Amluto brand", async () => {
    const check = async () => ({ embeddable: true });
    await expect(readAmlbrand("not json", check, toPng)).rejects.toThrow("notBrandFile");
    await expect(readAmlbrand(JSON.stringify({ profile: client }), check, toPng)).rejects.toThrow(
      "notBrandFile",
    );
    await expect(
      readAmlbrand(amlbrandFile({ ...client, id: "amluto" }), check, toPng),
    ).rejects.toThrow("notBrandFile");
    await expect(
      readAmlbrand(amlbrandFile({ ...client, primary: "red" }), check, toPng),
    ).rejects.toThrow("notBrandFile");
  });
});

describe("brands deployed by policy", () => {
  const file = (version: number) => amlbrandFile({ ...client, version, coverLogo: null });
  const bridge = (files: Record<string, string>) => ({
    readBrandFile: vi.fn(async (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error("not reachable");
      return text;
    }),
    checkFont: vi.fn(async () => ({ embeddable: true })),
    saveBrand: vi.fn(async () => undefined),
  });

  it("import new ones, update older copies, and skip files they can't reach", async () => {
    const io = bridge({ "S:/Brands/client.amlbrand": file(5) });
    const result = await syncPolicyBrands(
      ["S:/Brands/client.amlbrand", "S:/Brands/offline.amlbrand"],
      [{ ...client, version: 4 }],
      io,
      toPng,
    );
    expect(result).toEqual({ managedIds: ["client"], changed: true });
    expect(io.saveBrand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "client", version: 5 }),
    );
  });

  it("leave a brand alone when this PC already has that version", async () => {
    const io = bridge({ "S:/Brands/client.amlbrand": file(4) });
    const result = await syncPolicyBrands(
      ["S:/Brands/client.amlbrand"],
      [{ ...client, version: 4 }],
      io,
      toPng,
    );
    expect(result).toEqual({ managedIds: ["client"], changed: false });
    expect(io.saveBrand).not.toHaveBeenCalled();
  });
});
