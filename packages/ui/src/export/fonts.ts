import interBold from "@fontsource/inter/files/inter-latin-700-normal.woff?inline";
import interBoldItalic from "@fontsource/inter/files/inter-latin-700-italic.woff?inline";
import interItalic from "@fontsource/inter/files/inter-latin-400-italic.woff?inline";
import interRegular from "@fontsource/inter/files/inter-latin-400-normal.woff?inline";
import jostBold from "@fontsource/jost/files/jost-latin-700-normal.woff?inline";
import jostRegular from "@fontsource/jost/files/jost-latin-400-normal.woff?inline";
import interBold2 from "@fontsource/inter/files/inter-latin-700-normal.woff2?inline";
import interRegular2 from "@fontsource/inter/files/inter-latin-400-normal.woff2?inline";
import jostBold2 from "@fontsource/jost/files/jost-latin-700-normal.woff2?inline";
import monoRegular from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff?inline";
import type { PdfFonts, WalkthroughFonts } from "@amluto-steps/export";

import type { FaceSet } from "../recorder-bridge";
import { bundledCovers, charactersOf, fontCodePoints, fontsToTry } from "./coverage";

const bytes = (base64: string) => {
  const binary = atob(base64.includes(",") ? (base64.split(",")[1] ?? "") : base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
};

/**
 * The PDF's fonts (docs/spec/05-export.md#fonts): the brand's heading and body families, found on
 * the PC or uploaded into the profile, when their licence allows embedding (Century Gothic and
 * Aptos for Amluto); otherwise the bundled OFL fallbacks, Jost and Inter. A missing face falls
 * back to the nearest one found.
 */
export function pdfFonts(
  brand: { heading: FaceSet | null; body: FaceSet | null } | null,
): PdfFonts {
  const heading = brand?.heading;
  const body = brand?.body;
  const headingBold = heading?.bold ?? heading?.regular;
  const headingRegular = heading?.regular ?? heading?.bold;
  const bodyRegular = body?.regular ?? undefined;
  const bodyBold = body?.bold ?? body?.regular ?? undefined;
  return {
    heading:
      headingBold && headingRegular
        ? { normal: bytes(headingRegular), bold: bytes(headingBold) }
        : { normal: bytes(jostRegular), bold: bytes(jostBold) },
    body:
      bodyRegular && bodyBold
        ? {
            normal: bytes(bodyRegular),
            bold: bytes(bodyBold),
            italics: bytes(body?.italic ?? bodyRegular),
            bolditalics: bytes(body?.boldItalic ?? bodyBold),
          }
        : {
            normal: bytes(interRegular),
            bold: bytes(interBold),
            italics: bytes(interItalic),
            bolditalics: bytes(interBoldItalic),
          },
    // Code blocks: JetBrains Mono (OFL), the same on every PC.
    mono: bytes(monoRegular),
  };
}

/**
 * The walkthrough's fonts: only the OFL fallbacks are embedded, as WOFF2. Brand fonts such as
 * Century Gothic and Aptos are named in its CSS but never copied into a file that gets passed
 * around (docs/spec/05-export.md#what-goes-into-the-file).
 */
export const webFonts = (): WalkthroughFonts => ({
  heading: jostBold2,
  body: interRegular2,
  bodyBold: interBold2,
});

/**
 * The PDF's heading and body faces for one export (docs/spec/05-export.md#languages): the brand's
 * when they have every character the export uses, else the first font on the PC that has them
 * (Yu Gothic for Japanese, Microsoft YaHei for Simplified Chinese, Segoe UI for Greek…). `missing`
 * says no font on the PC had them all, so some characters may not show.
 */
export async function pdfFacesFor(
  brand: { heading: FaceSet | null; body: FaceSet | null },
  text: string,
  language: string,
  find: (family: string) => Promise<FaceSet | null>,
): Promise<{ heading: FaceSet | null; body: FaceSet | null; missing: boolean }> {
  const needed = charactersOf(text);
  if (needed.length === 0) return { ...brand, missing: false };
  const fits = (faces: FaceSet | null) => {
    const regular = faces?.regular ?? faces?.bold;
    if (!regular) return bundledCovers(needed);
    const points = fontCodePoints(bytes(regular));
    return points !== null && needed.every((point) => points.has(point));
  };
  /** How many of the characters a font has (all of them for the bundled fallbacks if covered). */
  const covered = (faces: FaceSet | null) => {
    const regular = faces?.regular ?? faces?.bold;
    if (!regular) return bundledCovers(needed) ? needed.length : 0;
    const points = fontCodePoints(bytes(regular));
    return points ? needed.filter((point) => points.has(point)).length : 0;
  };
  let found: FaceSet | null | undefined;
  /**
   * A font with every character, or failing that the one with the most: a title with an emoji
   * then loses only the emoji, not its Chinese too (a PDF font holds one script's worth).
   */
  const substitute = async () => {
    if (found !== undefined) return found;
    found = null;
    let best = 0;
    for (const family of fontsToTry(language, needed)) {
      const faces = await find(family).catch(() => null);
      if (!faces?.regular) continue;
      if (fits(faces)) {
        found = faces;
        break;
      }
      const count = covered(faces);
      if (count > best && count > covered(brand.body)) {
        best = count;
        found = faces;
      }
    }
    return found;
  };
  const heading = fits(brand.heading) ? brand.heading : await substitute();
  const body = fits(brand.body) ? brand.body : await substitute();
  return {
    heading: heading ?? brand.heading,
    body: body ?? brand.body,
    missing: !fits(heading ?? brand.heading) || !fits(body ?? brand.body),
  };
}
