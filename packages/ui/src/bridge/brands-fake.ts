import type { Brands } from "./brands";

const idOf = (profile: unknown) => {
  const id = (profile as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
};

/**
 * Brand profiles for tests and the preview, kept in memory: the person's own (`brands`) and those
 * the organisation deploys (`managed`), which only the start-up sync may save and nothing may
 * change or delete, as on the desktop. Brand files are kept by path.
 */
export function fakeBrands(
  options: { brands?: readonly unknown[]; managed?: readonly unknown[] } = {},
): Brands {
  const managed = new Set((options.managed ?? []).map(idOf));
  const saved = new Map<string, unknown>();
  for (const profile of [...(options.brands ?? []), ...(options.managed ?? [])]) {
    const id = idOf(profile);
    if (id) saved.set(id, structuredClone(profile));
  }
  const files = new Map<string, string>();
  const refused = () =>
    Promise.reject(new Error("Your organisation manages this brand, so it can't be changed here."));
  return {
    listBrands: () =>
      Promise.resolve([...saved.values()].map((profile) => structuredClone(profile))),
    saveBrand(profile) {
      const id = idOf(profile);
      if (!id) return Promise.reject(new Error("The brand has no id."));
      if (managed.has(id)) return refused();
      saved.set(id, structuredClone(profile));
      return Promise.resolve();
    },
    saveManagedBrand(profile) {
      const id = idOf(profile);
      if (!id || !managed.has(id))
        return Promise.reject(
          new Error("Only a brand your organisation deploys is saved this way."),
        );
      saved.set(id, structuredClone(profile));
      return Promise.resolve();
    },
    managedBrandIds: () => Promise.resolve([...managed].filter((id) => id !== null)),
    deleteBrand(id) {
      if (managed.has(id)) return refused();
      saved.delete(id);
      return Promise.resolve();
    },
    readBrandFile(path) {
      const contents = files.get(path);
      return contents === undefined
        ? Promise.reject(new Error(`No brand file at ${path}.`))
        : Promise.resolve(contents);
    },
    writeBrandFile(path, contents) {
      files.set(path, contents);
      return Promise.resolve();
    },
  };
}
