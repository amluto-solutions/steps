import { z } from "zod";
import type { BrandProfile } from "@amluto-steps/core";

import { amlbrandFile, readAmlbrand } from "./brands";
import { settingsFileSchema, type SettingsFile } from "./preferences";

/**
 * "Back up all" (docs/spec/07-settings-and-policy.md, Backup): one `.amlbackup` file with the
 * settings file's contents plus blur words, export choices, brand choices, every client brand and
 * the list of libraries. Guides are not in it: they live in their library folders.
 */
export const backupFileSchema = z
  .object({
    kind: z.literal("amluto-steps-backup"),
    formatVersion: z.literal(1),
    createdAt: z.string().max(40),
    settings: settingsFileSchema,
    blurTerms: z.array(z.string().max(200)).max(500),
    exportFolder: z.string().max(1024).nullable(),
    exportAsk: z.boolean(),
    defaultPdfBrand: z.string().max(64),
    appColours: z.string().max(64),
    /** Each brand as it would be in its own .amlbrand file, so it is checked the same way. */
    brands: z.array(z.string().max(40_000_000)).max(100),
    libraries: z
      .array(
        z
          .object({ name: z.string().max(80), path: z.string().max(1024), isDefault: z.boolean() })
          .strip(),
      )
      .max(50),
  })
  .strip();
export type BackupFile = z.infer<typeof backupFileSchema>;

export function buildBackup(
  parts: Omit<BackupFile, "kind" | "formatVersion" | "createdAt" | "brands"> & {
    brands: BrandProfile[];
  },
  now = new Date(),
): string {
  const file: BackupFile = {
    kind: "amluto-steps-backup",
    formatVersion: 1,
    createdAt: now.toISOString(),
    ...parts,
    brands: parts.brands.map(amlbrandFile),
  };
  return JSON.stringify(file);
}

export interface RestoredBackup {
  file: BackupFile;
  settings: SettingsFile;
  brands: BrandProfile[];
  /** Fonts left out of brands because their licence forbids embedding them. */
  droppedFonts: string[];
}

/**
 * Reads a backup. Everything is checked before anything is applied: the file as a whole, then
 * each brand as an outside file (SVG logos converted, fonts checked), exactly like an import.
 */
export async function readBackup(
  text: string,
  checkFont: (bytes: Uint8Array) => Promise<{ embeddable: boolean }>,
  convertSvg?: (svg: string) => Promise<string>,
): Promise<RestoredBackup> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("notBackupFile");
  }
  const result = backupFileSchema.safeParse(parsed);
  if (!result.success) throw new Error("notBackupFile");
  const brands: BrandProfile[] = [];
  const droppedFonts: string[] = [];
  for (const brand of result.data.brands) {
    const read = await readAmlbrand(brand, checkFont, convertSvg);
    brands.push(read.profile);
    droppedFonts.push(...read.droppedFonts);
  }
  return { file: result.data, settings: result.data.settings, brands, droppedFonts };
}
