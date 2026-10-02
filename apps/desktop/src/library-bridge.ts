import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { z } from "zod";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { LibraryBridge } from "@amluto-steps/ui";

const lockLostSchema = z.object({
  libraryId: z.string(),
  guideId: z.string(),
  lock: z.object({
    name: z.string(),
    pc: z.string(),
    session: z.string(),
    counter: z.number(),
    since: z.string(),
  }),
});

/** The desktop's guide libraries: folders on disk, through the `library_*` commands. */
export const desktopLibrary: LibraryBridge = {
  listLibraries: () => invoke("library_list_libraries"),
  addLibrary: (name, path) => invoke("library_add_library", { name, path }),
  renameLibrary: (libraryId, name) => invoke("library_rename_library", { libraryId, name }),
  removeLibrary: (libraryId) => invoke("library_remove_library", { libraryId }),
  setDefaultLibrary: (libraryId) => invoke("library_set_default_library", { libraryId }),

  listGuides: (libraryId) => invoke("library_list_guides", { libraryId }),
  searchGuides: (libraryId, query) => invoke("library_search_guides", { libraryId, query }),
  loadGuide: (libraryId, guideId) => invoke("library_load_guide", { libraryId, guideId }),
  createGuide: (libraryId, title) => invoke("library_create_guide", { libraryId, title }),
  openForEditing: (libraryId, guideId, takeOver) =>
    invoke("library_open_for_editing", { libraryId, guideId, takeOver }),
  releaseLock: (libraryId, guideId) => invoke("library_release_lock", { libraryId, guideId }),
  fingerprint: (libraryId) => invoke("library_fingerprint", { libraryId }),
  guideFingerprint: (libraryId, guideId) =>
    invoke("library_guide_fingerprint", { libraryId, guideId }),
  listConflicts: (libraryId, guideId) => invoke("library_list_conflicts", { libraryId, guideId }),
  resolveConflict: (libraryId, guideId, conflict, choice) =>
    invoke("library_resolve_conflict", { libraryId, guideId, conflict, choice }),
  listComments: (libraryId, guideId) => invoke("library_list_comments", { libraryId, guideId }),
  addComment: (libraryId, guideId, stepId, replyTo, text) =>
    invoke("library_add_comment", { libraryId, guideId, stepId, replyTo, text }),
  resolveComment: (libraryId, guideId, thread, resolved) =>
    invoke("library_resolve_comment", { libraryId, guideId, thread, resolved }),
  deleteComment: (libraryId, guideId, comment) =>
    invoke("library_delete_comment", { libraryId, guideId, comment }),
  // Checked before the window acts on it, like the recorder's events.
  onLockLost: (handler) =>
    listen<unknown>("library:lock-lost", (event) => {
      const parsed = lockLostSchema.safeParse(event.payload);
      if (parsed.success) handler(parsed.data);
      else console.error("A library:lock-lost event did not match its schema.");
    }),
  saveDraft: (libraryId, guideId, draft) =>
    invoke("library_save_draft", { libraryId, guideId, draft }),
  listDrafts: (libraryId, guideId) => invoke("library_list_drafts", { libraryId, guideId }),
  discardDraft: (libraryId, guideId, draftId) =>
    invoke("library_discard_draft", { libraryId, guideId, draftId }),
  draftToCopy: (libraryId, guideId, draftId, title) =>
    invoke("library_draft_to_copy", { libraryId, guideId, draftId, title }),
  saveGuide: (libraryId, guideId, guide) =>
    invoke("library_save_guide", { libraryId, guideId, guide }),
  saveStep: (libraryId, guideId, step) => invoke("library_save_step", { libraryId, guideId, step }),
  deleteStep: (libraryId, guideId, stepId) =>
    invoke("library_delete_step", { libraryId, guideId, stepId }),
  retakeImage: (libraryId, guideId, delayMs, excluded, quality) =>
    invoke("library_retake_image", { libraryId, guideId, delayMs, excluded, quality }),
  // The image goes as the raw body; the ids are plain letters, digits, - and _.
  importImage: (libraryId, guideId, bytes) =>
    invoke("library_import_image", bytes, {
      headers: { "x-library": libraryId, "x-guide": guideId },
    }),
  loadImage: (libraryId, guideId, mediaId, thumbnail) =>
    invoke("library_load_image", { libraryId, guideId, mediaId, thumbnail }),

  trashGuide: (libraryId, guideId) => invoke("library_trash_guide", { libraryId, guideId }),
  listTrash: (libraryId) => invoke("library_list_trash", { libraryId }),
  restoreGuide: (libraryId, trashId) => invoke("library_restore_guide", { libraryId, trashId }),
  deleteTrashed: (libraryId, trashId) => invoke("library_delete_trashed", { libraryId, trashId }),
  emptyTrash: (libraryId) => invoke<number>("library_empty_trash", { libraryId }),
  duplicateGuide: (libraryId, guideId, title) =>
    invoke("library_duplicate_guide", { libraryId, guideId, title }),
  createFromParts: (libraryId, guide, steps, media) =>
    invoke("library_create_from_parts", { libraryId, guide, steps, media }),
  copyGuide: (fromLibraryId, guideId, toLibraryId) =>
    invoke("library_copy_guide", { fromLibraryId, guideId, toLibraryId }),
  moveGuide: (fromLibraryId, guideId, toLibraryId) =>
    invoke("library_move_guide", { fromLibraryId, guideId, toLibraryId }),

  applyRedactions: (libraryId, guideId) =>
    invoke<number>("library_apply_redactions", { libraryId, guideId }),
  saveVersion: (libraryId, guideId, note) =>
    invoke("library_save_version", { libraryId, guideId, note }),
  listVersions: (libraryId, guideId) => invoke("library_list_versions", { libraryId, guideId }),
  loadVersion: (libraryId, guideId, versionId) =>
    invoke("library_load_version", { libraryId, guideId, versionId }),
  restoreVersion: (libraryId, guideId, versionId) =>
    invoke("library_restore_version", { libraryId, guideId, versionId }),

  exportAmlsteps: (libraryId, guideId, destination, includeOriginals) =>
    invoke("library_export_amlsteps", { libraryId, guideId, destination, includeOriginals }),
  importAmlsteps: (libraryId, source) => invoke("library_import_amlsteps", { libraryId, source }),

  pickFolder: async (title) => {
    const chosen = await open({ title, directory: true, multiple: false });
    return typeof chosen === "string" ? chosen : null;
  },
  pickFile: async (title, filters) => {
    const chosen = await open({ title, multiple: false, directory: false, filters });
    return typeof chosen === "string" ? chosen : null;
  },
  pickSaveLocation: async (title, defaultName, filters) => {
    const chosen = await save({ title, defaultPath: defaultName, filters });
    return chosen ?? null;
  },
};
