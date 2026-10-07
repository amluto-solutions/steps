import type { Bin, GuideCopies } from "../library-bridge";

/**
 * Moves a guide to another library. The editions move by copying it there and putting the
 * original in this library's Bin; a moved guide then looked deleted, and Restore made a second
 * copy (F053, 01/10/2026). So the original's Bin entry goes at once: the guide is in one place,
 * and moving it back is the way to undo.
 */
export async function moveGuide(
  library: Bin & GuideCopies,
  from: string,
  guideId: string,
  to: string,
) {
  const moved = await library.moveGuide(from, guideId, to);
  const entry = (await library.listTrash(from)).find((item) => item.guideId === guideId);
  if (entry) await library.deleteTrashed(from, entry.trashId);
  return moved;
}
