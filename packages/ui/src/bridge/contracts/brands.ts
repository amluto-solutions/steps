import { describe, expect, it } from "vitest";

import type { Brands } from "../brands";
import type { MakeSubject } from "./subject";

const idsOf = (profiles: unknown[]) => profiles.map((profile) => (profile as { id?: unknown }).id);
const named = (profiles: unknown[], id: string) =>
  (profiles.find((profile) => (profile as { id?: unknown }).id === id) as { name?: unknown })?.name;

/** What Settings > Brands, the brand editor and the start-up sync rely on. */
export function brandsContract(edition: string, make: MakeSubject<Brands>) {
  describe(`${edition}: brands`, () => {
    it("keep a profile by its id, replace it when saved again, and forget it when deleted", async () => {
      const { part } = await make();
      await part.saveBrand({ id: "contract-brand", name: "Contoso" });
      await part.saveBrand({ id: "contract-brand", name: "Contoso Ltd" });
      const saved = await part.listBrands();
      expect(idsOf(saved).filter((id) => id === "contract-brand")).toHaveLength(1);
      expect(named(saved, "contract-brand")).toBe("Contoso Ltd");
      await part.deleteBrand("contract-brand");
      expect(idsOf(await part.listBrands())).not.toContain("contract-brand");
    });

    it("refuse a brand the organisation doesn't deploy as one of its own", async () => {
      const { part } = await make();
      await expect(
        part.saveManagedBrand({ id: "not-deployed", name: "Made up" }),
      ).rejects.toBeDefined();
      expect(await part.managedBrandIds()).not.toContain("not-deployed");
      expect(idsOf(await part.listBrands())).not.toContain("not-deployed");
    });

    it("read back a brand file as it was written", async () => {
      const { part } = await make();
      const contents = JSON.stringify({ format: "amlbrand", profile: { id: "contoso" } });
      await part.writeBrandFile("contract.amlbrand", contents);
      expect(await part.readBrandFile("contract.amlbrand")).toBe(contents);
    });
  });
}
