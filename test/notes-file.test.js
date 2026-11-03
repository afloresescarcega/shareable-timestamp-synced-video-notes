// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const notesApi = require("../src/notes.js");
const view = require("../src/cue-view.js");
const { FILE_FORMAT, FILE_VERSION, MAX_FILE_CHARS, toFile, readFile, createNotesTransfer } = require("../src/notes-file.js");

// ---------------------------------------------------------------------------
// Fixtures

const VIDEO_A = "aaaaaaaaaaa";
const VIDEO_B = "bbbbbbbbbbb";
const NOW = new Date("2026-11-02T12:00:00Z");

function draft(videoId = VIDEO_A) {
  return {
    type: "draft",
    version: 1,
    videoId,
    title: "The Kings",
    createdAt: "2026-11-01T00:00:00Z",
    model: "claude-opus-5-5",
    source: { durationMs: 600000, transcript: { languageCode: "en", kind: "manual", entries: [] }, sections: [] },
    sections: [{ title: "Start", startMs: 0, endMs: 600000, origin: "ai" }],
    entities: [
      { id: "p-alfred", kind: "person", name: "Alfred", summary: "A king.", firstMentionMs: 4000, mentionsMs: [4000, 60000], place: null, date: null },
      { id: "p-edward", kind: "person", name: "Edward", summary: "His son.", firstMentionMs: 60000, mentionsMs: [60000], place: null, date: null },
      {
        id: "pl-w", kind: "place", name: "Winchester", summary: "A city.", firstMentionMs: 8000, mentionsMs: [8000],
        place: { placement: "located", latitude: 51.06, longitude: -1.31, approxRadiusKm: null, relativeToIds: [] }, date: null,
      },
    ],
    relationships: [{ fromId: "p-edward", toId: "p-alfred", label: "son of" }],
    cues: [
      { id: "cue-1", kind: "gap", atMs: 8000, entityIds: ["pl-w"], fromVideo: "Named only.", outsideKnowledge: "Capital of Wessex." },
      { id: "cue-2", kind: "callback", atMs: 60000, entityIds: ["p-edward", "p-alfred"], fromVideo: "Alfred's son.", outsideKnowledge: null },
    ],
    usage: { inputTokens: 1000, outputTokens: 500 },
  };
}

// Notes with every kind of user edit in them.
function editedNotes(videoId = VIDEO_A) {
  let notes = notesApi.fromDraft(draft(videoId));
  notes = notesApi.addCue(notes, { atMs: 30000, kind: "gap", fromVideo: "A user Cue.", outsideKnowledge: "Outside knowledge." });
  notes = notesApi.updateCue(notes, notes.cues.find((c) => c.atMs === 8000).id, { fromVideo: "Edited." });
  notes = notesApi.deleteCue(notes, notes.cues.find((c) => c.atMs === 60000).id);
  notes = notesApi.splitEntity(notes, "p-alfred", { name: "Alfred the younger", mentionsMs: [60000] });
  return notes;
}

const fileText = (overrides = {}, notes = editedNotes()) => JSON.stringify({ ...JSON.parse(toFile(notes, NOW).text), ...overrides });

// ---------------------------------------------------------------------------
// The file format

test("exported file carries a format marker, version and Video ID, and only Notes", () => {
  const notes = editedNotes();
  const { fileName, text } = toFile(notes, NOW);
  assert.equal(fileName, `cue-notes-${VIDEO_A}.json`);
  const file = JSON.parse(text);
  assert.deepEqual(Object.keys(file).sort(), ["exportedAt", "format", "formatVersion", "notes", "videoId"]);
  assert.equal(file.format, FILE_FORMAT);
  assert.equal(file.formatVersion, FILE_VERSION);
  assert.equal(file.videoId, VIDEO_A);
  assert.equal(file.exportedAt, NOW.toISOString());
  assert.ok(!/sk-ant|apiKey|anthropicApiKey/i.test(text));
});

test("Notes round-trip through a file unchanged, edits included", () => {
  const notes = editedNotes();
  const result = readFile(toFile(notes, NOW).text, VIDEO_A);
  assert.equal(result.ok, true);
  assert.deepEqual(result.notes, JSON.parse(JSON.stringify(notes)));
  assert.equal(notesApi.editCount(result.notes), notesApi.editCount(notes));
  // Imported Notes keep working: they render and accept further edits.
  assert.ok(view.buildView(view.normalizeDraft(result.notes), 61000, null).current);
  const more = notesApi.addCue(result.notes, { atMs: 70000, kind: "gap", fromVideo: "After import." });
  assert.equal(more.cues.length, result.notes.cues.length + 1);
  // Regeneration still respects the imported edits.
  const merged = notesApi.mergeDraft(result.notes, draft());
  assert.equal(merged.cues.filter((c) => c.atMs === 60000).length, 0, "a deleted Draft Cue stays deleted");
});

test("a file for another Video is rejected with its Video ID", () => {
  const result = readFile(toFile(editedNotes(VIDEO_B), NOW).text, VIDEO_A);
  assert.equal(result.ok, false);
  assert.match(result.message, new RegExp(`different Video \\(ID ${VIDEO_B}\\)`));
});

test("invalid files are rejected with an explanation", () => {
  const cases = [
    ["not json {", /isn't a Cue Notes file.*valid JSON/],
    ["[]", /isn't a Cue Notes file/],
    [JSON.stringify({ notes: editedNotes() }), /isn't a Cue Notes file/],
    [fileText({ format: "something-else" }), /isn't a Cue Notes file/],
    [fileText({ formatVersion: 2 }), /newer version of Cue \(format 2\)/],
    [fileText({ formatVersion: "1" }), /format version/],
    [fileText({ videoId: undefined }), /doesn't say which Video/],
    [fileText({ notes: null }), /damaged: They aren't Notes/],
    [fileText({ notes: { ...editedNotes(), version: 9 } }), /damaged: They're Notes version 9/],
    [fileText({ notes: { ...editedNotes(), cues: "nope" } }), /damaged: Their cues list is missing/],
    [fileText({ notes: { ...editedNotes(), videoId: VIDEO_B } }), /damaged: .*different Video/],
    [fileText({ notes: { ...editedNotes(), videoId: VIDEO_B, draft: null } }), /different Video than it says/],
    [fileText({ notes: { ...editedNotes(), cues: [{ ...editedNotes().cues[0], kind: "highlight" }] } }), /neither a Callback nor a Gap/],
    [fileText({ notes: { ...editedNotes(), cues: [{ ...editedNotes().cues[0], entityIds: ["ghost"] }] } }), /refers to an Entity that isn't in the Notes/],
    [fileText({ notes: { ...editedNotes(), entities: [...editedNotes().entities, editedNotes().entities[0]] } }), /repeated id/],
  ];
  for (const [text, message] of cases) {
    const result = readFile(text, VIDEO_A);
    assert.equal(result.ok, false, text.slice(0, 60));
    assert.match(result.message, message);
  }
  assert.match(readFile("x".repeat(MAX_FILE_CHARS + 1), VIDEO_A).message, /too large/);
});

test("unknown fields in a file are dropped, never kept in the Notes", () => {
  const notes = editedNotes();
  const tampered = JSON.parse(toFile(notes, NOW).text);
  tampered.notes.anthropicApiKey = "sk-ant-should-not-survive";
  tampered.notes.cues[0].onclick = "alert(1)";
  tampered.notes.entities[0].extra = true;
  const result = readFile(JSON.stringify(tampered), VIDEO_A);
  assert.equal(result.ok, true);
  assert.ok(!("anthropicApiKey" in result.notes));
  assert.ok(!("onclick" in result.notes.cues[0]));
  assert.ok(!("extra" in result.notes.entities[0]));
});

// ---------------------------------------------------------------------------
// The import/export flow

function harness({ videoId = VIDEO_A, notes = null, ready = true, file = null } = {}) {
  const h = {
    videoId,
    notes,
    ready,
    downloads: [],
    replaced: [],
    picks: 0,
    file, // the text the user picks, null for "closed the picker", or a function
    changes: [],
  };
  h.transfer = createNotesTransfer({
    getActiveVideoId: () => h.videoId,
    getNotes: () => h.notes,
    isReady: () => h.ready,
    replaceNotes: (n) => {
      h.replaced.push(n);
      h.notes = n;
    },
    pickFile: async () => {
      h.picks++;
      return typeof h.file === "function" ? h.file() : h.file;
    },
    download: (f) => h.downloads.push(f),
    onChange: (s) => h.changes.push(s.phase),
    now: () => NOW,
  });
  return h;
}

test("nothing is exported, picked or replaced until the user acts", () => {
  const h = harness({ notes: editedNotes(), file: fileText() });
  assert.equal(h.transfer.state.phase, "idle");
  assert.deepEqual([h.downloads.length, h.picks, h.replaced.length], [0, 0, 0]);
});

test("Export Notes downloads the current Notes as a file", () => {
  const notes = editedNotes();
  const h = harness({ notes });
  h.transfer.exportNotes();
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].fileName, `cue-notes-${VIDEO_A}.json`);
  assert.deepEqual(readFile(h.downloads[0].text, VIDEO_A).notes, JSON.parse(JSON.stringify(notes)));
  assert.equal(h.transfer.state.phase, "exported");
});

test("Export Notes with no Notes explains instead of downloading", () => {
  const h = harness();
  h.transfer.exportNotes();
  assert.equal(h.downloads.length, 0);
  assert.equal(h.transfer.state.phase, "error");
});

test("importing when the Video has no Notes yet replaces nothing and needs no confirmation", async () => {
  const h = harness({ file: fileText() });
  await h.transfer.startImport();
  assert.equal(h.replaced.length, 1);
  assert.equal(h.replaced[0].videoId, VIDEO_A);
  assert.equal(h.transfer.state.phase, "imported");
});

test("importing over existing Notes asks first and offers to export them", async () => {
  const current = notesApi.fromDraft(draft());
  const h = harness({ notes: current, file: fileText() });
  await h.transfer.startImport();
  assert.equal(h.transfer.state.phase, "confirm-replace");
  assert.equal(h.transfer.state.exportedFirst, false);
  assert.match(h.transfer.state.message, /Export the current Notes first/);
  assert.equal(h.replaced.length, 0, "nothing replaced before the user confirms");
  assert.equal(h.notes, current);
  assert.equal(h.downloads.length, 0, "not exported unless the user asks");
});

test("export first saves the current Notes and still waits for an explicit Replace", async () => {
  const current = notesApi.fromDraft(draft());
  const h = harness({ notes: current, file: fileText() });
  await h.transfer.startImport();
  h.transfer.exportFirst();
  assert.equal(h.downloads.length, 1);
  assert.deepEqual(readFile(h.downloads[0].text, VIDEO_A).notes, JSON.parse(JSON.stringify(current)), "the current Notes, not the imported ones");
  assert.equal(h.transfer.state.phase, "confirm-replace");
  assert.equal(h.transfer.state.exportedFirst, true);
  assert.equal(h.replaced.length, 0);

  await h.transfer.confirmReplace();
  assert.equal(h.replaced.length, 1);
  assert.equal(notesApi.editCount(h.notes), notesApi.editCount(editedNotes()));
  assert.equal(h.transfer.state.phase, "imported");
});

test("confirming without exporting replaces the Notes", async () => {
  const h = harness({ notes: notesApi.fromDraft(draft()), file: fileText() });
  await h.transfer.startImport();
  await h.transfer.confirmReplace();
  assert.equal(h.replaced.length, 1);
  assert.equal(h.downloads.length, 0);
});

test("declining leaves the current Notes unchanged", async () => {
  const current = notesApi.fromDraft(draft());
  const h = harness({ notes: current, file: fileText() });
  await h.transfer.startImport();
  h.transfer.cancelImport();
  assert.equal(h.transfer.state.phase, "cancelled");
  assert.match(h.transfer.state.message, /unchanged/);
  await h.transfer.confirmReplace(); // a late click does nothing
  assert.equal(h.replaced.length, 0);
  assert.equal(h.notes, current);
});

test("a rejected file leaves the current Notes unchanged and says why", async () => {
  const current = notesApi.fromDraft(draft());
  for (const file of ["not json", fileText({}, editedNotes(VIDEO_B)), fileText({ formatVersion: 7 })]) {
    const h = harness({ notes: current, file });
    await h.transfer.startImport();
    assert.equal(h.transfer.state.phase, "rejected");
    assert.match(h.transfer.state.message, /Your Notes are unchanged\.$/);
    assert.equal(h.replaced.length, 0);
    assert.equal(h.notes, current);
  }
});

test("closing the file picker changes nothing", async () => {
  const h = harness({ notes: notesApi.fromDraft(draft()), file: null });
  await h.transfer.startImport();
  assert.equal(h.transfer.state.phase, "idle");
  assert.equal(h.replaced.length, 0);
});

test("import waits for the Video's saved Notes to load first", async () => {
  const h = harness({ ready: false, file: fileText() });
  await h.transfer.startImport();
  assert.equal(h.picks, 0);
  assert.equal(h.transfer.state.phase, "error");
});

test("a file picked after the Video changed is ignored", async () => {
  const h = harness({ file: () => { h.videoId = VIDEO_B; return fileText(); } });
  await h.transfer.startImport();
  assert.equal(h.replaced.length, 0);
});

test("confirming after the Video changed imports nothing", async () => {
  const h = harness({ notes: notesApi.fromDraft(draft()), file: fileText() });
  await h.transfer.startImport();
  h.videoId = VIDEO_B;
  await h.transfer.confirmReplace();
  assert.equal(h.replaced.length, 0);
  assert.equal(h.transfer.state.phase, "rejected");
});

test("reset() drops a pending confirmation and a file still being picked", async () => {
  const h = harness({ notes: notesApi.fromDraft(draft()), file: fileText() });
  await h.transfer.startImport();
  h.transfer.reset();
  await h.transfer.confirmReplace();
  assert.equal(h.replaced.length, 0);
  assert.equal(h.transfer.state.phase, "idle");

  let release;
  h.file = () => new Promise((resolve) => (release = resolve));
  const importing = h.transfer.startImport();
  h.transfer.reset();
  release(fileText());
  await importing;
  assert.equal(h.replaced.length, 0);
  assert.equal(h.transfer.state.phase, "idle");
});
