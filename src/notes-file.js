// Sharing Notes as a portable JSON file (ADR 0002): export the current Notes,
// and import someone's file for the same Video. Only Notes go in the file:
// never settings or the API key. Browser APIs (file picker, download) are
// passed in, so this loads under Node for tests, and every export and import
// starts from a user's click; nothing here runs on its own.
//
// File:
//   { format: "cue-notes", formatVersion: 1, videoId, exportedAt, notes }
//
//   CueNotesFile.toFile(notes, now)            -> { fileName, text }
//   CueNotesFile.readFile(text, activeVideoId) -> { ok: true, notes } | { ok: false, message }
//
//   const transfer = createNotesTransfer({ getActiveVideoId, getNotes, isReady,
//                                          replaceNotes, pickFile, download, onChange });
//   transfer.exportNotes()     user clicked Export Notes
//   transfer.startImport()     user clicked Import Notes
//   transfer.exportFirst()     while confirming: export the current Notes, keep asking
//   transfer.confirmReplace()  while confirming: replace the current Notes with the file's
//   transfer.cancelImport()    while confirming: keep the current Notes
//   transfer.reset()           the Video changed
//
// state.phase is one of:
//   idle | confirm-replace | imported | exported | rejected | cancelled | error
// Importing over existing Notes always stops at confirm-replace; only
// confirmReplace() replaces them. Any rejection leaves the current Notes unchanged.
(() => {
  "use strict";

  const load = (path, name) =>
    typeof module === "object" && module.exports ? require(path) : globalThis[name];
  const notesModule = load("./notes.js", "CueNotes");

  const FILE_FORMAT = "cue-notes";
  const FILE_VERSION = 1;
  const MAX_FILE_CHARS = 5 * 1024 * 1024; // chrome.storage.local holds 10 MB in all

  const NOT_A_NOTES_FILE = "That file isn't a Cue Notes file. Choose a .json file made with Export Notes.";

  function toFile(notes, now = new Date()) {
    const file = {
      format: FILE_FORMAT,
      formatVersion: FILE_VERSION,
      videoId: notes.videoId,
      exportedAt: now.toISOString(),
      notes,
    };
    return { fileName: `cue-notes-${notes.videoId}.json`, text: `${JSON.stringify(file, null, 2)}\n` };
  }

  function readFile(text, activeVideoId) {
    if (typeof text !== "string") return { ok: false, message: NOT_A_NOTES_FILE };
    if (text.length > MAX_FILE_CHARS) return { ok: false, message: "That file is too large to be Notes for one Video." };
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      return { ok: false, message: `${NOT_A_NOTES_FILE} (It isn't valid JSON.)` };
    }
    if (!file || typeof file !== "object" || file.format !== FILE_FORMAT) return { ok: false, message: NOT_A_NOTES_FILE };
    if (file.formatVersion !== FILE_VERSION) {
      const newer = Number.isInteger(file.formatVersion) && file.formatVersion > FILE_VERSION;
      return {
        ok: false,
        message: newer
          ? `That Notes file was made by a newer version of Cue (format ${file.formatVersion}). Update Cue to import it.`
          : `That Notes file's format version (${JSON.stringify(file.formatVersion)}) isn't one Cue can read.`,
      };
    }
    if (typeof file.videoId !== "string") return { ok: false, message: "That Notes file doesn't say which Video it's for." };
    if (file.videoId !== activeVideoId) {
      return { ok: false, message: `Those Notes are for a different Video (ID ${file.videoId}). Open that Video to import them.` };
    }
    const checked = notesModule.checkNotes(file.notes);
    if (!checked.ok) return { ok: false, message: `That Notes file is damaged: ${checked.message}` };
    if (checked.notes.videoId !== file.videoId) return { ok: false, message: "That Notes file is damaged: its Notes are for a different Video than it says." };
    return { ok: true, notes: checked.notes };
  }

  function createNotesTransfer({
    getActiveVideoId,
    getNotes,
    isReady = () => true,
    replaceNotes,
    pickFile, // () => Promise<string | null>; null when the user closes the picker
    download, // ({ fileName, text }) => void
    onChange = () => {},
    now = () => new Date(),
  }) {
    let state = { phase: "idle" };
    let pending = null; // { videoId, notes } awaiting the user's choice
    let importToken = 0; // invalidates a file pick after reset or a newer import

    const set = (next) => {
      state = next;
      onChange(state);
    };

    function exportCurrent() {
      const notes = getNotes();
      if (!notes) return false;
      download(toFile(notes, now()));
      return true;
    }

    function exportNotes() {
      if (state.phase === "confirm-replace") return exportFirst();
      try {
        if (!exportCurrent()) return set({ phase: "error", message: "There are no Notes for this Video to export yet." });
      } catch (error) {
        return set({ phase: "error", message: `Couldn't export Notes: ${error.message}` });
      }
      set({ phase: "exported", message: "Notes exported as a .json file. Share it with anyone who has Cue; they open this Video and choose Import Notes." });
    }

    async function startImport() {
      const videoId = getActiveVideoId();
      if (!videoId) return set({ phase: "error", message: "Open a Video to import its Notes." });
      if (!isReady(videoId)) return set({ phase: "error", message: "Wait for this Video's saved Notes to load, then import." });
      const token = ++importToken;
      pending = null;
      let text;
      try {
        text = await pickFile();
      } catch (error) {
        if (token !== importToken) return;
        return set({ phase: "error", message: `Couldn't read that file: ${error.message}` });
      }
      if (token !== importToken) return;
      if (text === null || text === undefined) return set({ phase: "idle" }); // picker closed
      if (getActiveVideoId() !== videoId) return; // moved on while choosing

      const result = readFile(text, videoId);
      if (!result.ok) return set({ phase: "rejected", message: `${result.message} Your Notes are unchanged.` });
      if (!getNotes()) return replace(result.notes);
      pending = { videoId, notes: result.notes };
      set({ phase: "confirm-replace", exportedFirst: false, message: replacePrompt(false) });
    }

    const replacePrompt = (exported) =>
      exported
        ? "Current Notes exported. Replace them with the imported Notes?"
        : "This Video already has Notes. Importing replaces them, including your edits. Export the current Notes first to keep a copy?";

    function exportFirst() {
      if (state.phase !== "confirm-replace") return;
      try {
        if (!exportCurrent()) return;
      } catch (error) {
        return set({ ...state, message: `Couldn't export the current Notes: ${error.message} Nothing has been replaced.` });
      }
      set({ phase: "confirm-replace", exportedFirst: true, message: replacePrompt(true) });
    }

    async function confirmReplace() {
      if (state.phase !== "confirm-replace" || !pending) return;
      const { videoId, notes } = pending;
      pending = null;
      if (getActiveVideoId() !== videoId) return set({ phase: "rejected", message: "The Video changed, so nothing was imported." });
      return replace(notes);
    }

    async function replace(notes) {
      importToken++;
      try {
        await replaceNotes(notes);
      } catch (error) {
        return set({ phase: "error", message: `Couldn't import Notes: ${error.message}` });
      }
      set({ phase: "imported", message: `Notes imported: ${notes.cues.length} Cues.` });
    }

    function cancelImport() {
      if (state.phase !== "confirm-replace") return;
      pending = null;
      set({ phase: "cancelled", message: "Import cancelled. Your Notes are unchanged." });
    }

    function reset() {
      importToken++;
      pending = null;
      if (state.phase !== "idle") set({ phase: "idle" });
    }

    return {
      get state() {
        return state;
      },
      exportNotes,
      startImport,
      exportFirst,
      confirmReplace,
      cancelImport,
      reset,
    };
  }

  const api = { FILE_FORMAT, FILE_VERSION, MAX_FILE_CHARS, toFile, readFile, createNotesTransfer };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueNotesFile ??= Object.freeze(api);
})();
