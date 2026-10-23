import type { LibraryBridge } from "../library-bridge";
import type { GuideRef } from "./documents";

const blurredStep = (step: unknown) => {
  const redactions = (step as { redactions?: unknown } | null)?.redactions;
  return Array.isArray(redactions) && redactions.length > 0;
};

/**
 * Whether any step of the guide, or of one of its saved versions, has a blur. Apply blur
 * permanently burns them in everywhere, so with none anywhere it has nothing to do and needn't ask
 * "This can't be undone" first (#52). The guide is looked at first, its versions only when it has
 * none, one at a time, stopping at the first blur.
 */
export async function hasBlur(
  library: Pick<LibraryBridge, "loadGuide" | "listVersions" | "loadVersion">,
  { libraryId, guideId }: GuideRef,
): Promise<boolean> {
  if ((await library.loadGuide(libraryId, guideId)).steps.some(blurredStep)) return true;
  for (const version of await library.listVersions(libraryId, guideId)) {
    const kept = await library.loadVersion(libraryId, guideId, version.id);
    if (kept.steps.some(blurredStep)) return true;
  }
  return false;
}
