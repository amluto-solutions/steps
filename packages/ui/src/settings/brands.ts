import { policy } from "./policy";
import {
  AMLUTO_BRAND_ID,
  AMLUTO_COLOURS,
  brandProfileSchema,
  type BrandProfile,
} from "@amluto-steps/core";
import type { BrandLook } from "@amluto-steps/export";

import amlutoLogo from "../assets/logo-horizontal-colour.svg?raw";

const DEFAULT_KEY = "amluto-steps-default-brand";

/** Base64 in chunks: spreading a large file into one call would overflow the argument limit. */
const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

/** The built-in Amluto profile: always there, can't be deleted (docs/spec/06-brands-and-theming.md). */
export const AMLUTO_PROFILE: BrandProfile = {
  id: AMLUTO_BRAND_ID,
  version: 1,
  name: "Amluto",
  ...AMLUTO_COLOURS,
  coverLogo: { type: "svg", data: amlutoLogo },
  pageLogo: { type: "svg", data: amlutoLogo },
  headingFont: { family: "Century Gothic", uploaded: null },
  bodyFont: { family: "Aptos", uploaded: null },
  footer: "",
  pageSize: "A4",
  orientation: "portrait",
  layout: "standard",
  dark: null,
  formatVersion: 1,
};

/** Profiles read from disk, keeping only the ones that pass the schema. */
export const parseBrands = (raw: unknown[]): BrandProfile[] =>
  raw.flatMap((value) => {
    const parsed = brandProfileSchema.safeParse(value);
    return parsed.success && parsed.data.id !== AMLUTO_BRAND_ID ? [parsed.data] : [];
  });

export const lookFor = (profile: BrandProfile): BrandLook => ({
  name: profile.name,
  primary: profile.primary,
  accent: profile.accent,
  highlight: profile.highlight,
  coverLogo: profile.coverLogo,
  pageLogo: profile.pageLogo,
  headingFont: profile.headingFont?.family ?? "Century Gothic",
  bodyFont: profile.bodyFont?.family ?? "Aptos",
  footer: profile.footer,
});

export const readDefaultBrand = (): string => {
  const managed = policy().defaultPdfBrand;
  if (managed) return managed;
  try {
    return window.localStorage.getItem(DEFAULT_KEY) ?? AMLUTO_BRAND_ID;
  } catch {
    return AMLUTO_BRAND_ID;
  }
};

export const saveDefaultBrand = (id: string) => {
  try {
    window.localStorage.setItem(DEFAULT_KEY, id);
  } catch {
    // The choice still applies until the app closes.
  }
};

/**
 * A client's SVG logo becomes a PNG on import, so no SVG from outside (which can carry scripts or
 * external references) is ever stored, exported or pasted (docs/spec/08-privacy-and-security.md).
 * Drawing it through an <img> runs no script and loads nothing.
 */
export async function rasterise(svg: string): Promise<string> {
  const image = new Image();
  image.src = svgSource(svg);
  await image.decode();
  const width = image.naturalWidth || 600;
  const height = image.naturalHeight || 200;
  const scale = Math.min(4, 1200 / width, 600 / height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("notImage");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/** Logos: PNG or JPEG as a data URL (SVG converted to PNG); at most 1 MB. */
export async function readLogo(file: File): Promise<BrandProfile["coverLogo"]> {
  if (file.size > 1024 * 1024) throw new Error("tooLarge");
  if (file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg")) {
    const text = await file.text();
    if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text))
      throw new Error("notImage");
    return { type: "png", data: await rasterise(text) };
  }
  if (file.type !== "image/png" && file.type !== "image/jpeg") throw new Error("notImage");
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    type: file.type === "image/png" ? "png" : "jpeg",
    data: `data:${file.type};base64,${bytesToBase64(bytes)}`,
  };
}

/** SVG markup as an image source (an <img> never runs an SVG's scripts). */
function svgSource(svg: string): string {
  return `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
}

/** A logo as an image source for showing it in the app. */
export const logoSource = (logo: BrandProfile["coverLogo"]) =>
  !logo ? null : logo.type === "svg" ? svgSource(logo.data) : logo.data;

/** A `.amlbrand` file: one profile, marked so it can't be mistaken for something else. */
export const amlbrandFile = (profile: BrandProfile) =>
  JSON.stringify({ format: "amlbrand", formatVersion: 1, profile }, null, 2);

export interface AmlbrandImport {
  profile: BrandProfile;
  /** Uploaded fonts left out because their licence forbids embedding them. */
  droppedFonts: string[];
}

const base64Bytes = (base64: string) =>
  Uint8Array.from(atob(base64.includes(",") ? (base64.split(",")[1] ?? "") : base64), (character) =>
    character.charCodeAt(0),
  );

/**
 * Reads a `.amlbrand` file someone sent. It comes from outside, so it gets the same treatment
 * as a logo or font chosen here: the schema, SVG logos converted to PNG, and uploaded fonts
 * checked for their embedding licence (docs/spec/06-brands-and-theming.md#sharing-profiles).
 */
export async function readAmlbrand(
  text: string,
  checkFont: (bytes: Uint8Array) => Promise<{ embeddable: boolean }>,
  convertSvg: (svg: string) => Promise<string> = rasterise,
): Promise<AmlbrandImport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("notBrandFile");
  }
  const file = parsed as { format?: unknown; profile?: unknown };
  const result = brandProfileSchema.safeParse(file.profile);
  if (file.format !== "amlbrand" || !result.success || result.data.id === AMLUTO_BRAND_ID) {
    throw new Error("notBrandFile");
  }
  const profile = result.data;
  const png = async (logo: BrandProfile["coverLogo"]): Promise<BrandProfile["coverLogo"]> =>
    logo?.type === "svg" ? { type: "png", data: await convertSvg(logo.data) } : logo;
  const droppedFonts: string[] = [];
  const font = async (value: BrandProfile["headingFont"]) => {
    if (!value?.uploaded) return value;
    const faces = [value.uploaded.regular, value.uploaded.bold].filter(
      (face): face is string => face !== null,
    );
    for (const face of faces) {
      const info = await checkFont(base64Bytes(face)).catch(() => ({ embeddable: false }));
      if (!info.embeddable) {
        droppedFonts.push(value.family);
        return null;
      }
    }
    return value;
  };
  return {
    profile: {
      ...profile,
      coverLogo: await png(profile.coverLogo),
      pageLogo: await png(profile.pageLogo),
      headingFont: await font(profile.headingFont),
      bodyFont: await font(profile.bodyFont),
    },
    droppedFonts,
  };
}

/**
 * Brands IT deploys by policy (`BrandProfiles`: `.amlbrand` files on a share or synced folder):
 * imported when missing, updated when the file's version is higher, and returned so Settings can
 * show them read-only. A file that can't be read right now (offline, not synced yet) is skipped
 * and tried again next time.
 */
export async function syncPolicyBrands(
  paths: string[],
  existing: BrandProfile[],
  bridge: {
    readBrandFile: (path: string) => Promise<string>;
    checkFont: (bytes: Uint8Array) => Promise<{ embeddable: boolean }>;
    saveBrand: (profile: BrandProfile) => Promise<void>;
  },
  convertSvg?: (svg: string) => Promise<string>,
): Promise<{ managedIds: string[]; changed: boolean }> {
  const managedIds: string[] = [];
  let changed = false;
  for (const path of paths) {
    try {
      const { profile } = await readAmlbrand(
        await bridge.readBrandFile(path),
        bridge.checkFont,
        convertSvg,
      );
      managedIds.push(profile.id);
      const current = existing.find((item) => item.id === profile.id);
      if (!current || current.version < profile.version) {
        await bridge.saveBrand(profile);
        changed = true;
      }
    } catch {
      // Not reachable or not a brand file: skipped, tried again at the next start.
    }
  }
  return { managedIds, changed };
}
