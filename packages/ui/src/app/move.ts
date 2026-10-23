import type { Bin, GuideCopies } from "../library-bridge";

/**
 * Moves a guide to another library. The editions move by copying it there and putting the
 * original in this library's Bin; a moved guide then looked deleted, and Restore made a second
 * copy (F053, 01/10/2026). So the original's Bin entry goes at once: the guide is in one place,
 * and moving it back is the way to undo.
 *
 * Once the guide has moved, the move is done (#111): if its Bin entry can't be removed (a file
 * held open by OneDrive), that's only logged. Failing there left the editor on the place the guide
 * had left, showing an error, though the guide was safely where it went.
 */
export async function moveGuide(
  library: Bin & GuideCopies,
  from: string,
  guideId: string,
  to: string,
) {
  const moved = await library.moveGuide(from, guideId, to);
  try {
    const entry = (await library.listTrash(from)).find((item) => item.guideId === guideId);
    if (entry) await library.deleteTrashed(from, entry.trashId);
  } catch (problem) {
    console.warn("The moved guide's original stays in its library's Bin.", problem);
  }
  return moved;
}
