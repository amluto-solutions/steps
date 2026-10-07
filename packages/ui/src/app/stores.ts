import type { GuideStore } from "../editor/useGuideEditor";
import type { GuideFiles } from "../library-bridge";
import { imageFileOf } from "../recorded-step";
import type { RecordingJournal } from "../bridge/recording-journal";
import { readChoices } from "../settings/preferences";
import type { GuideRef } from "./documents";

/**
 * Where the editor saves an unsaved recording: the recording's own session folder. `excluded`
 * is the user's excluded apps, which Retake won't capture (the organisation's are added in Rust).
 */
export const draftStore = (
  recorder: RecordingJournal,
  sessionId: string,
  excluded: string[] = [],
): GuideStore => ({
  saveGuide: (guide) => recorder.saveDraftGuide(sessionId, guide),
  saveStep: (step) => recorder.saveDraftStep(sessionId, step),
  deleteStep: (id) => recorder.deleteDraftStep(sessionId, id),
  loadImage: (mediaId) => recorder.loadImage(sessionId, imageFileOf(mediaId)),
  retakeImage: (delayMs) =>
    recorder.retakeDraftImage(sessionId, delayMs, excluded, readChoices().screenshotQuality),
});

/** Where the editor saves a guide in a library. */
export const libraryStore = (
  library: GuideFiles,
  { libraryId, guideId }: GuideRef,
  excluded: string[] = [],
): GuideStore => ({
  saveGuide: (guide) => library.saveGuide(libraryId, guideId, guide),
  saveStep: (step) => library.saveStep(libraryId, guideId, step),
  deleteStep: (stepId) => library.deleteStep(libraryId, guideId, stepId),
  loadImage: (mediaId, thumbnail) => library.loadImage(libraryId, guideId, mediaId, thumbnail),
  importImage: (bytes) => library.importImage(libraryId, guideId, bytes),
  retakeImage: (delayMs) =>
    library.retakeImage(libraryId, guideId, delayMs, excluded, readChoices().screenshotQuality),
});
