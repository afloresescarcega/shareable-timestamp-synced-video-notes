// Injects the Cue panel into the right-hand column of YouTube watch pages.
// YouTube is a single-page app, so this script runs once per tab on any
// youtube.com page and reacts to in-app navigation rather than page loads.
(() => {
  "use strict";

  if (window.__cuePanelLoaded) return; // guard against double execution
  window.__cuePanelLoaded = true;

  const PANEL_ID = "cue-panel";
  const COLUMN_SELECTOR = "ytd-watch-flexy #secondary";

  let observer = null;

  // Source material (Transcript + Sections) for the Video being watched, as
  // produced by CueSourceMaterial.load, or { status: "loading", videoId }.
  // Later panel code reads it through getSourceMaterial().
  let sourceMaterial = null;
  const getSourceMaterial = () => sourceMaterial;

  // Prepare flow for the current Video (src/prepare.js). The Draft it produces
  // becomes Notes (src/notes.js), saved in this browser per Video ID
  // (src/notes-store.js) and rendered as Cues. Preparing again merges the new
  // Draft into the Notes without overwriting anything the user added or edited.
  const prepare = globalThis.CuePrepare.createPrepare({
    getApiKey: () => globalThis.CueSettings.loadApiKey(chrome.storage.local),
    fetchImpl: (...args) => fetch(...args),
    onChange: () => {
      renderPrepare();
      adoptDraft();
    },
  });
  let estimateCache = null; // { material, estimate } so the prompt is built once per Video

  // Saved Notes, one entry per Video ID in chrome.storage.local. Loaded when
  // the Video changes; saved after every Draft, edit and import.
  const store = globalThis.CueNotesStore.createNotesStore(chrome.storage.local);
  let saveMessage = ""; // why the latest save failed, if it did
  let saveSeq = 0; // only the latest save's outcome is shown

  // Export and import of Notes as a .json file (src/notes-file.js); each step
  // starts from a click in the panel.
  const transfer = globalThis.CueNotesFile.createNotesTransfer({
    getActiveVideoId: () => currentVideoId(),
    getNotes: () => (notesData?.videoId === currentVideoId() ? notesData : null),
    isReady: (videoId) => store.isReady(videoId),
    replaceNotes: (imported) => replaceNotes(imported),
    pickFile: () => pickNotesFile(),
    download: (file) => downloadFile(file),
    onChange: () => renderNotesFile(),
  });

  // Cues for the current Video: the Notes, their normalized view, the YouTube
  // playhead, and the jump-back "Return to" point (src/cue-view.js).
  let notesData = null; // CueNotes shape; the source of truth for edits
  let adoptedDraft = null; // the last Draft merged into notesData
  let notes = null; // CueView.normalizeDraft(notesData)
  // The Cue editor: null, { cueId } or { atMs } for a new Cue, plus the form
  // values to restore after an Entity merge/split re-renders it.
  let editing = null;
  let playheadMs = null;
  let renderedKey = null;
  const jumpBack = globalThis.CueView.createJumpBack();

  const isWatchPage = () =>
    location.pathname === "/watch" &&
    new URLSearchParams(location.search).has("v");

  const currentVideoId = () => {
    const id = new URLSearchParams(location.search).get("v");
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  };

  function buildPanel() {
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    panel.setAttribute("aria-label", "Cue panel");

    const title = document.createElement("h2");
    title.className = "cue-panel__title";
    title.textContent = "Cue panel";

    const body = document.createElement("p");
    body.className = "cue-panel__body";
    body.textContent = "No Notes for this Video yet.";

    const status = document.createElement("p");
    status.className = "cue-panel__status";

    const cues = document.createElement("div");
    cues.className = "cue-view";
    cues.setAttribute("aria-live", "polite");

    panel.append(title, body, cues, status, buildPrepareControls(), buildNotesFileControls());
    renderStatus(panel); // also renders the Prepare and Notes file controls
    renderCues(panel, { force: true });
    return panel;
  }

  // Every panel button here can spend the user's money or replace their Notes
  // (Prepare, confirming a cost, export/import, replacing), so each responds
  // only to the user's own click or key press, never to a script in YouTube's
  // page calling .click() on it (src/user-action.js).
  function button(text, className, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `cue-panel__button ${className}`;
    el.textContent = text;
    el.addEventListener("click", globalThis.CueUserAction.userOnly(onClick));
    return el;
  }

  function buildPrepareControls() {
    const box = document.createElement("div");
    box.className = "cue-prepare";

    const prepareButton = button("Prepare", "cue-prepare__start", () => prepare.start(sourceMaterial));
    prepareButton.setAttribute("aria-describedby", "cue-prepare-message");
    const confirmButton = button("Prepare anyway", "cue-prepare__confirm", () => prepare.confirm());
    const cancelButton = button("Cancel", "cue-prepare__cancel", () => prepare.cancel());

    const actions = document.createElement("div");
    actions.className = "cue-prepare__actions";
    actions.append(prepareButton, confirmButton, cancelButton);

    const message = document.createElement("p");
    message.id = "cue-prepare-message";
    message.className = "cue-prepare__message";
    message.setAttribute("role", "status");

    box.append(actions, message);
    return box;
  }

  function buildNotesFileControls() {
    const box = document.createElement("div");
    box.className = "cue-notes-file";

    const actions = document.createElement("div");
    actions.className = "cue-notes-file__actions";
    actions.append(
      button("Export Notes", "cue-notes-file__export", () => transfer.exportNotes()),
      button("Import Notes", "cue-notes-file__import", () => transfer.startImport()),
      button("Export current Notes first", "cue-notes-file__export-first", () => transfer.exportFirst()),
      button("Replace Notes", "cue-notes-file__replace", () => transfer.confirmReplace()),
      button("Keep current Notes", "cue-notes-file__keep", () => transfer.cancelImport())
    );

    const message = document.createElement("p");
    message.className = "cue-notes-file__message";
    message.setAttribute("role", "status");

    box.append(actions, message);
    return box;
  }

  function renderNotesFile(panel = document.getElementById(PANEL_ID)) {
    const box = panel?.querySelector(".cue-notes-file");
    if (!box) return;
    const state = transfer.state;
    const videoId = currentVideoId();
    const confirming = state.phase === "confirm-replace";
    const exportButton = box.querySelector(".cue-notes-file__export");
    const importButton = box.querySelector(".cue-notes-file__import");
    exportButton.hidden = confirming;
    exportButton.disabled = !(notesData && notesData.videoId === videoId);
    importButton.hidden = confirming;
    importButton.disabled = !(videoId && store.isReady(videoId));
    const exportFirst = box.querySelector(".cue-notes-file__export-first");
    exportFirst.hidden = !confirming || state.exportedFirst;
    box.querySelector(".cue-notes-file__replace").hidden = !confirming;
    box.querySelector(".cue-notes-file__keep").hidden = !confirming;
    const message = box.querySelector(".cue-notes-file__message");
    message.textContent = state.message ?? "";
    message.dataset.tone = state.phase === "rejected" || state.phase === "error" ? "error" : confirming ? "confirm" : "";
  }

  // A .json file the user chooses; null if they close the picker.
  function pickNotesFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return resolve(null);
        // Bytes can be up to 4x the characters; readFile checks the exact limit.
        if (file.size > globalThis.CueNotesFile.MAX_FILE_CHARS * 4) return reject(new Error("it's too large to be Notes for one Video."));
        file.text().then(resolve, reject);
      });
      input.addEventListener("cancel", () => resolve(null));
      input.click();
    });
  }

  // Saves a file through the browser's normal download flow; no extra permission.
  function downloadFile({ fileName, text }) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a"); // detached, so YouTube's click handlers never see it
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function currentEstimate() {
    if (sourceMaterial?.status !== "ready") return null;
    if (estimateCache?.material !== sourceMaterial) {
      estimateCache = { material: sourceMaterial, estimate: globalThis.CuePrepare.plan(sourceMaterial).estimate };
    }
    return estimateCache.estimate;
  }

  const describeCost = (estimate) =>
    `Estimated cost: about ${globalThis.CueCostEstimate.formatUsd(estimate.usd)} on your Anthropic account.`;

  // What the Prepare controls show for the current source material and Prepare state.
  function describePrepare() {
    const state = prepare.state;
    const { enabled, reason } = globalThis.CuePrepare.availability(sourceMaterial);
    const estimate = state.estimate ?? currentEstimate();
    const fmt = globalThis.CueCostEstimate.formatUsd;
    switch (state.phase) {
      case "needs-key":
        return { canStart: enabled, message: state.message, tone: "error" };
      case "confirm":
        return {
          showConfirm: true,
          showCancel: true,
          message: `Preparing this Video will cost about ${fmt(estimate.usd)} (over $${globalThis.CueCostEstimate.CONFIRM_ABOVE_USD.toFixed(2)}). Prepare anyway?`,
        };
      case "generating": {
        const tokens = state.progress?.outputTokens;
        return {
          showCancel: true,
          busy: true,
          message: `Preparing Cues from the whole Transcript…${tokens ? ` (${tokens.toLocaleString()} tokens so far)` : ""} This can take a few minutes.`,
        };
      }
      case "done": {
        const { cues, entities } = state.draft;
        return { canStart: enabled, startLabel: "Prepare again", message: `Draft ready: ${cues.length} Cues, ${entities.length} Entities.` };
      }
      case "cancelled":
        return { canStart: enabled, message: state.message };
      case "error":
        return { canStart: enabled, message: state.error.message, tone: "error" };
      default:
        if (!enabled) return { canStart: false, message: reason };
        return { canStart: true, message: describeCost(estimate) };
    }
  }

  function renderPrepare(panel = document.getElementById(PANEL_ID)) {
    const box = panel?.querySelector(".cue-prepare");
    if (!box) return;
    const view = describePrepare();
    const start = box.querySelector(".cue-prepare__start");
    start.textContent = view.startLabel ?? "Prepare";
    start.disabled = !view.canStart;
    start.hidden = Boolean(view.showConfirm || view.busy);
    box.querySelector(".cue-prepare__confirm").hidden = !view.showConfirm;
    box.querySelector(".cue-prepare__cancel").hidden = !view.showCancel;
    const message = box.querySelector(".cue-prepare__message");
    message.textContent = view.message ?? "";
    message.dataset.tone = view.tone ?? "";
    box.setAttribute("aria-busy", String(Boolean(view.busy)));
  }

  function describeSourceMaterial(material) {
    if (!material) return "";
    switch (material.status) {
      case "loading":
        return "Reading the Transcript…";
      case "ready": {
        const lines = material.transcript.entries.length;
        const sections = material.sections.length;
        return `Transcript ready (${lines} lines, ${sections ? `${sections} Sections` : "no creator chapters"}).`;
      }
      default:
        return material.message;
    }
  }

  function renderStatus(panel = document.getElementById(PANEL_ID)) {
    const status = panel?.querySelector(".cue-panel__status");
    if (!status) return;
    status.textContent = describeSourceMaterial(sourceMaterial);
    status.dataset.state = sourceMaterial?.status ?? "";
    status.dataset.reason = sourceMaterial?.reason ?? "";
    renderPrepare(panel);
    renderNotesFile(panel);
  }

  // ---------------------------------------------------------------------------
  // Cues

  // YouTube's main player video (not ad or preview players).
  const mainVideo = () => document.querySelector("#movie_player video.html5-main-video") ??
    document.querySelector("ytd-watch-flexy video");
  const isMainVideo = (target) => target instanceof HTMLVideoElement && target === mainVideo();
  // During ads the main video element plays the ad; its time isn't the Video's.
  const adShowing = () => Boolean(document.querySelector("#movie_player.ad-showing"));

  function readPlayhead() {
    const video = mainVideo();
    if (!video || adShowing() || !Number.isFinite(video.currentTime)) return false;
    playheadMs = video.currentTime * 1000;
    jumpBack.onTime(playheadMs);
    return true;
  }

  function seekTo(ms) {
    const video = mainVideo();
    if (!video) return;
    video.currentTime = ms / 1000;
  }

  // Shows the Draft once Prepare finishes for the Video being watched. A
  // Draft prepared again is merged into the existing Notes, keeping edits.
  function adoptDraft() {
    const state = prepare.state;
    if (state.phase !== "done" || !state.draft || state.draft.videoId !== currentVideoId()) return;
    if (adoptedDraft === state.draft) return;
    if (editing && notesData) return; // adopted when the editor closes, so typing isn't lost
    // Merged into the saved Notes once they've loaded, never in place of them.
    if (store.state.videoId !== state.draft.videoId || store.state.status === "loading") return;
    adoptedDraft = state.draft;
    const regenerating = notesData?.videoId === state.draft.videoId;
    commitNotes(regenerating ? globalThis.CueNotes.mergeDraft(notesData, state.draft) : globalThis.CueNotes.fromDraft(state.draft));
    if (!regenerating) jumpBack.clear();
    readPlayhead();
    renderCues(undefined, { force: true });
  }

  function setNotes(next) {
    notesData = next;
    notes = next ? globalThis.CueView.normalizeDraft(next) : null;
  }

  // Sets new Notes for the current Video and saves them in this browser.
  function commitNotes(next) {
    setNotes(next);
    const seq = ++saveSeq;
    store.save(next).then((result) => {
      if (seq !== saveSeq) return; // a newer save, or a different Video, has taken over
      saveMessage = result.ok ? "" : result.message;
      renderNotesStatus();
    });
  }

  // The user chose to import a file's Notes (src/notes-file.js has already
  // checked the file and, over existing Notes, asked first). Import wins: a
  // Prepare still starting, awaiting confirmation or generating is stopped so
  // its Draft is never produced, and a finished Draft not yet merged (say,
  // waiting for the editor to close) is marked handled, so neither is merged
  // into the imported Notes.
  function replaceNotes(imported) {
    editing = null;
    prepare.supersede();
    adoptedDraft = prepare.state.draft ?? adoptedDraft;
    commitNotes(imported);
    jumpBack.clear();
    readPlayhead();
    renderCues(undefined, { force: true });
  }

  // Loads the saved Notes for a Video the user just opened.
  function openNotes(videoId) {
    store.open(videoId).then((result) => {
      if (!result || currentVideoId() !== videoId) return; // the user moved on
      if (result.notes && !notesData) {
        setNotes(result.notes);
        readPlayhead();
      }
      renderCues(undefined, { force: true });
      adoptDraft(); // a Draft finished while loading merges into what was saved
    });
  }

  function clearNotes() {
    setNotes(null);
    saveSeq++;
    saveMessage = "";
    adoptedDraft = null;
    editing = null;
    playheadMs = null;
    jumpBack.clear();
    renderCues(undefined, { force: true });
  }

  // ---------------------------------------------------------------------------
  // Editing (each edit is saved)

  // Applies a CueNotes operation; returns an error message for the editor, or
  // null. `values` (the open editor's unsaved form) may be a function of the
  // new Notes, so Entity ids in the form follow a merge or split.
  function applyEdit(operation, { close = true, values } = {}) {
    let next;
    try {
      next = operation(notesData);
    } catch (error) {
      if (error.name !== "NotesEditError") console.warn("[Cue]", error);
      return error.name === "NotesEditError" ? error.message : "That edit couldn't be applied.";
    }
    const kept = typeof values === "function" ? values(next) : values;
    if (next !== notesData) commitNotes(next);
    editing = close ? null : { ...editing, values: kept, error: "" };
    readPlayhead();
    renderCues(undefined, { force: true });
    if (!editing) adoptDraft();
    return null;
  }

  const editHandlers = {
    onAdd() {
      if (!notesData) return;
      readPlayhead();
      editing = { atMs: Math.round(playheadMs ?? 0) };
      renderCues(undefined, { force: true });
    },
    onEdit(cueId) {
      editing = { cueId };
      renderCues(undefined, { force: true });
    },
    onCancelEdit() {
      editing = null;
      readPlayhead();
      renderCues(undefined, { force: true });
      adoptDraft();
    },
    onSave(values) {
      if (!editing) return null;
      const { cueId } = editing;
      return applyEdit((n) => (cueId ? globalThis.CueNotes.updateCue(n, cueId, values) : globalThis.CueNotes.addCue(n, values)));
    },
    onDelete(cueId) {
      return applyEdit((n) => globalThis.CueNotes.deleteCue(n, cueId));
    },
    onUsePlayhead() {
      return readPlayhead() ? playheadMs : null;
    },
    onMergeEntities(keepId, mergeId, values) {
      return applyEdit((n) => globalThis.CueNotes.mergeEntities(n, keepId, mergeId), {
        close: false,
        values: globalThis.CueNotes.followMerge(values, keepId, mergeId),
      });
    },
    onSplitEntity(entityId, split, values) {
      const savedAtMs = notesData?.cues.find((c) => c.id === editing?.cueId)?.atMs ?? null;
      return applyEdit((n) => globalThis.CueNotes.splitEntity(n, entityId, split), {
        close: false,
        // Without this, saving would put back the Entity a Cue just moved off.
        values: (next) => globalThis.CueNotes.followSplit(next, values, entityId, savedAtMs),
      });
    },
  };

  function onJumpBack(entity) {
    readPlayhead();
    if (!jumpBack.jump(playheadMs, entity.firstMentionMs)) return;
    seekTo(entity.firstMentionMs);
    renderCues();
  }

  function onReturn() {
    const target = jumpBack.takeReturn();
    if (target !== null) seekTo(target);
    renderCues();
  }

  // Re-renders only when what's shown changes (a new current Cue, a Cue
  // joining the feed, or the Return point), not on every timeupdate. While
  // the editor is open, playback never re-renders (it would lose typing).
  function renderCues(panel = document.getElementById(PANEL_ID), { force = false } = {}) {
    const box = panel?.querySelector(".cue-view");
    if (!box) return;
    if (editing && !force && box.isConnected) return;
    const view = globalThis.CueView.buildView(notes, playheadMs, jumpBack.returnToMs);
    const key = view ? view.key : "";
    if (!force && key === renderedKey && box.isConnected) return;
    renderedKey = key;
    renderNotesStatus(panel);
    const editor = globalThis.CueView.cueEditorModel(notes, editing, playheadMs);
    if (editing && !editor) editing = null; // the Cue it was editing is gone
    box.replaceChildren();
    box.hidden = !view;
    if (view) box.append(globalThis.CueRender.renderCueView(document, view, { onJumpBack, onReturn, ...editHandlers }, editor));
  }

  // Returns { text, tone }.
  function describeNotes() {
    const videoId = currentVideoId();
    const storeProblem = store.state.videoId === videoId && store.state.status === "error" ? store.state.message : "";
    if (!notes) {
      if (store.state.videoId === videoId && store.state.status === "loading") return { text: "Loading saved Notes…", tone: "" };
      return storeProblem ? { text: storeProblem, tone: "error" } : { text: "No Notes for this Video yet.", tone: "" };
    }
    const edits = globalThis.CueNotes.editCount(notesData);
    const shown = `${notes.cues.length} Cues, shown as the Video reaches them.`;
    const what = edits ? `Notes for this Video: ${shown}` : `Draft for this Video: ${shown}`;
    const problem = saveMessage || storeProblem;
    return problem ? { text: `${what} ${problem}`, tone: "error" } : { text: `${what} Saved in this browser.`, tone: "" };
  }

  function renderNotesStatus(panel = document.getElementById(PANEL_ID)) {
    const body = panel?.querySelector(".cue-panel__body");
    if (body) {
      const { text, tone } = describeNotes();
      body.textContent = text;
      body.dataset.tone = tone;
    }
    renderNotesFile(panel);
  }

  // Media events don't bubble, but capture-phase listeners on the document
  // still see them, which survives YouTube swapping the <video> element.
  function onMediaEvent(event) {
    if (!notes || !isMainVideo(event.target)) return;
    if (readPlayhead()) renderCues();
  }
  for (const type of ["timeupdate", "seeking", "seeked", "play", "loadedmetadata"]) {
    document.addEventListener(type, onMediaEvent, true);
  }

  // Loads source material for the current Video once; repeated navigation
  // events for the same Video reuse the in-flight or cached result.
  function syncSourceMaterial() {
    const videoId = currentVideoId();
    if (!videoId) {
      globalThis.CueSourceMaterial.cancel();
      prepare.reset();
      transfer.reset();
      store.close();
      clearNotes();
      sourceMaterial = null;
      return renderStatus();
    }
    // Same Video: keep what's loading or settled; retry anything passing (a
    // failure, a page that couldn't be read, a Video not playable right now).
    if (sourceMaterial?.videoId === videoId &&
      (sourceMaterial.status === "loading" || globalThis.CueYouTubeData.isSettled(sourceMaterial))) return;

    if (sourceMaterial?.videoId !== videoId) {
      // A different Video, not a retry.
      prepare.reset();
      transfer.reset();
      openNotes(videoId); // first, so clearNotes renders "Loading saved Notes…"
      clearNotes();
    }
    sourceMaterial = { status: "loading", videoId };
    renderStatus();
    globalThis.CueSourceMaterial.load(videoId).then(
      (result) => {
        if (currentVideoId() !== videoId) return; // user moved on
        sourceMaterial = result;
        renderStatus();
      },
      (error) => {
        if (error.name !== "AbortError") console.warn("[Cue]", error);
      }
    );
  }

  // Inserts the panel if the column exists. Returns true when the panel is in place.
  function tryInject() {
    const column = document.querySelector(COLUMN_SELECTOR);
    if (!column) return false;

    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      if (existing.parentElement === column) return true;
      existing.remove(); // stale copy left somewhere YouTube moved/recreated
    }
    column.prepend(buildPanel());
    return true;
  }

  function stopWaiting() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // The right-hand column renders asynchronously; wait for it if needed.
  function waitForColumn() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!isWatchPage()) return stopWaiting();
      if (tryInject()) stopWaiting();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function sync() {
    if (!isWatchPage()) {
      stopWaiting();
      document.getElementById(PANEL_ID)?.remove();
      syncSourceMaterial();
      return;
    }
    if (!tryInject()) waitForColumn();
    syncSourceMaterial();
  }

  // YouTube fires this after each in-app navigation completes.
  document.addEventListener("yt-navigate-finish", sync);
  // Fallback for back/forward if the YouTube event is ever missing.
  window.addEventListener("popstate", sync);

  sync();
})();
