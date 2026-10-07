/**
 * Client brand profiles kept on this computer, part of the recorder bridge: the person's own,
 * those the organisation deploys, and `.amlbrand` files. Profiles are unvalidated JSON; the UI
 * checks the schema.
 */
export interface Brands {
  listBrands(): Promise<unknown[]>;
  /** Saves a profile by its id, replacing one with the same id. */
  saveBrand(profile: unknown): Promise<void>;
  /** Saves a brand the organisation deploys (the start-up sync only; others are refused). */
  saveManagedBrand(profile: unknown): Promise<void>;
  /** The brands IT deploys, including those imported before whose share is out of reach now. */
  managedBrandIds(): Promise<string[]>;
  deleteBrand(id: string): Promise<void>;
  /** Reads a `.amlbrand` file the user chose (only `.amlbrand` files). */
  readBrandFile(path: string): Promise<string>;
  writeBrandFile(path: string, contents: string): Promise<void>;
}
