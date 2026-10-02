import { z } from "zod";

/**
 * Brand profiles (docs/spec/06-brands-and-theming.md): names, logos, colours, fonts, footer and page
 * options. Fields added after the first release have defaults, so older profile files still load.
 */
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * A logo is always carried inside the profile: a PNG or JPEG as a data URL of exactly that type,
 * or SVG markup. Anything else (a web address or a file path in a brand file someone sent) would
 * make exports and pasted rich text fetch a remote picture, which can track who opened them.
 */
const logoSchema = z
  .object({ type: z.enum(["svg", "png", "jpeg"]), data: z.string().max(3_000_000) })
  .strip()
  .refine(
    (logo) =>
      logo.type === "svg"
        ? /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(logo.data)
        : new RegExp(`^data:image/${logo.type};base64,[A-Za-z0-9+/]+={0,2}$`).test(logo.data),
    { message: "A logo must be an embedded PNG or JPEG picture, or SVG." },
  );

/**
 * A heading or body font: a family installed on the PC, or one uploaded into the profile (TrueType,
 * base64). Exports embed a font only when its own licence allows it.
 */
export const brandFontSchema = z
  .object({
    family: z.string().trim().min(1).max(80),
    uploaded: z
      .object({ regular: z.string().max(4_000_000), bold: z.string().max(4_000_000).nullable() })
      .strip()
      .nullable(),
  })
  .strip();
export type BrandFont = z.infer<typeof brandFontSchema>;

/** Colours for dark mode, when a brand wants its own instead of the derived ones. */
const darkSchema = z
  .object({
    primary: hexColour.optional(),
    accent: hexColour.optional(),
    highlight: hexColour.optional(),
  })
  .strip();

/**
 * A PDF's layouts: steps follow on, each kept whole ("standard"); each step on a new page; or
 * smaller screenshots, about two steps to a page.
 */
export const PDF_LAYOUTS = ["standard", "page", "compact"] as const;
export type PdfLayout = (typeof PDF_LAYOUTS)[number];
/** A layout from a select's value, standard for anything else. */
export const pdfLayoutOf = (value: string): PdfLayout =>
  (PDF_LAYOUTS as readonly string[]).includes(value) ? (value as PdfLayout) : "standard";

export const brandProfileSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(80),
    primary: hexColour,
    accent: hexColour,
    highlight: hexColour,
    /** SVG text, or a PNG/JPEG data URL. */
    coverLogo: logoSchema.nullable(),
    /** A small logo at the top of every page. */
    pageLogo: logoSchema.nullable().default(null),
    headingFont: brandFontSchema.nullable().default(null),
    bodyFont: brandFontSchema.nullable().default(null),
    footer: z.string().max(200),
    pageSize: z.enum(["A4", "LETTER"]),
    orientation: z.enum(["portrait", "landscape"]),
    /** How a PDF's steps are laid out (`PDF_LAYOUTS`). */
    layout: z.enum(PDF_LAYOUTS).default("standard"),
    dark: darkSchema.nullable().default(null),
    formatVersion: z.literal(1),
  })
  .strip();
export type BrandProfile = z.infer<typeof brandProfileSchema>;

export const AMLUTO_BRAND_ID = "amluto";

/** Amluto's own colours (Brand-Guidelines-v1): the built-in profile and every fallback use these. */
export const AMLUTO_COLOURS = {
  primary: "#0E2542",
  accent: "#1E6EBC",
  highlight: "#B42318",
} as const;

const channels = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const toHex = (rgb: [number, number, number]) =>
  `#${rgb
    .map((value) =>
      Math.round(Math.max(0, Math.min(255, value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();

/** WCAG 2.2 relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1 to 21). */
export function contrast(first: string, second: string): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Mixes `hex` towards `target` by `amount` (0 to 1). */
export const mix = (hex: string, target: string, amount: number) => {
  const from = channels(hex);
  const to = channels(target);
  return toHex(
    from.map((value, index) => value + ((to[index] ?? value) - value) * amount) as [
      number,
      number,
      number,
    ],
  );
};

/**
 * The nearest shade of `hex` that reaches `ratio` against `background`, darkening (or lightening
 * on a dark background) in small steps. Offered to the user; never applied silently.
 */
export function ensureContrast(hex: string, background = "#FFFFFF", ratio = 4.6): string {
  const towards = luminance(background) > 0.5 ? "#000000" : "#FFFFFF";
  for (let step = 0; step <= 40; step += 1) {
    const candidate = mix(hex, towards, step / 40);
    if (contrast(candidate, background) >= ratio) return candidate;
  }
  return towards.toUpperCase();
}

/** Accent and highlight from the primary colour, for the minimal client-brand form. */
export function deriveColours(primary: string): { accent: string; highlight: string } {
  const accent = ensureContrast(mix(primary, "#FFFFFF", 0.2), "#FFFFFF", 3);
  return { accent, highlight: AMLUTO_COLOURS.highlight };
}

export function newBrandProfile(id: string, name: string, primary: string): BrandProfile {
  return {
    id,
    version: 1,
    name,
    primary,
    ...deriveColours(primary),
    coverLogo: null,
    pageLogo: null,
    headingFont: null,
    bodyFont: null,
    footer: "",
    pageSize: "A4",
    orientation: "portrait",
    layout: "standard",
    dark: null,
    formatVersion: 1,
  };
}
