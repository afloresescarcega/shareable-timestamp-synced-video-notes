// Saves Notes in this browser (chrome.storage.local), one entry per Video ID
// (ADR 0002: no backend, no account). The storage area is passed in, so this
// loads under Node for tests. Only Notes are written here; settings such as the
// API key live under their own key (src/settings.js) and are never touched.
//
//   const store = createNotesStore(chrome.storage.local);
//   const { notes } = await store.open(videoId)   the Video being watched changed;
//                                                 resolves null if superseded
//   await store.save(notes)                       after a Draft or an edit
//   store.close()                                 no Video is being watched
//   store.state -> { videoId, status: "none" | "loading" | "ready" | "error", message }
//
// Race safety:
//   - Every read and write goes through one queue, in call order, so a load
//     never reads around a save still in flight and saves never land out of order.
//   - A load for a Video the user has since left resolves null and changes nothing.
//   - save() writes under the key of the Notes' own Video ID, and only when
//     that Video is the open one and its saved Notes were read successfully, so
//     it can't overwrite another Video's Notes or Notes it failed to read.
(() => {
  "use strict";

  const load = (path, name) =>
    typeof module === "object" && module.exports ? require(path) : globalThis[name];
  const notesModule = load("./notes.js", "CueNotes");

  const KEY_PREFIX = "notes:";
  const storageKey = (videoId) => `${KEY_PREFIX}${videoId}`;

  function createNotesStore(area) {
    let queue = Promise.resolve();
    let state = { videoId: null, status: "none", message: "" };
    let generation = 0;

    // Runs `task` after everything queued before it; failures don't block later tasks.
    function enqueue(task) {
      const run = queue.then(task);
      queue = run.catch(() => {});
      return run;
    }

    async function open(videoId) {
      const token = ++generation;
      state = { videoId, status: "loading", message: "" };
      let stored;
      try {
        stored = await enqueue(() => area.get(storageKey(videoId)));
      } catch (error) {
        if (token !== generation) return null;
        state = { videoId, status: "error", message: `Couldn't read saved Notes for this Video: ${error.message}. Changes won't be saved; reload the page to try again.` };
        return { videoId, notes: null };
      }
      if (token !== generation) return null; // the user moved on
      const value = stored?.[storageKey(videoId)];
      if (value === undefined || value === null) {
        state = { videoId, status: "ready", message: "" };
        return { videoId, notes: null };
      }
      const checked = notesModule.checkNotes(value);
      if (!checked.ok || checked.notes.videoId !== videoId) {
        // Left as they are rather than overwritten.
        state = { videoId, status: "error", message: `Saved Notes for this Video couldn't be read (${checked.ok ? "they're for another Video" : checked.message}). They're left as they are, and changes won't be saved.` };
        return { videoId, notes: null };
      }
      state = { videoId, status: "ready", message: "" };
      return { videoId, notes: checked.notes };
    }

    function close() {
      generation++;
      state = { videoId: null, status: "none", message: "" };
    }

    // Returns { ok: true } or { ok: false, message }; never throws.
    async function save(notes) {
      const videoId = notes?.videoId;
      if (!videoId || videoId !== state.videoId) return { ok: false, message: "These Notes aren't for the Video being watched, so they weren't saved." };
      if (state.status !== "ready") return { ok: false, message: state.message || "Saved Notes are still loading." };
      try {
        await enqueue(() => area.set({ [storageKey(videoId)]: notes }));
        return { ok: true };
      } catch (error) {
        return { ok: false, message: `Couldn't save Notes in this browser: ${error.message}` };
      }
    }

    return {
      get state() {
        return state;
      },
      isReady: (videoId) => state.videoId === videoId && state.status === "ready",
      open,
      close,
      save,
    };
  }

  const api = { KEY_PREFIX, storageKey, createNotesStore };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueNotesStore ??= Object.freeze(api);
})();
