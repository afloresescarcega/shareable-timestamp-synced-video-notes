// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const notesApi = require("../src/notes.js");
const view = require("../src/cue-view.js");
const { renderCueView } = require("../src/cue-render.js");

const { fromDraft, mergeDraft, updateCue, addCue, deleteCue, mergeEntities, splitEntity, followMerge, followSplit, editCount, NotesEditError } = notesApi;

// ---------------------------------------------------------------------------
// Fixtures: Drafts in src/draft.js's shape.

const person = (id, name, mentionsMs, summary = `${name}.`) => ({
  id, kind: "person", name, summary, firstMentionMs: mentionsMs[0], mentionsMs, place: null, date: null,
});
const place = (id, name, mentionsMs) => ({
  id, kind: "place", name, summary: `${name}.`, firstMentionMs: mentionsMs[0], mentionsMs,
  place: { placement: "located", latitude: 51.06, longitude: -1.31, approxRadiusKm: null, relativeToIds: [] }, date: null,
});
const cue = (id, atMs, kind, entityIds, fromVideo, outsideKnowledge = null) => ({ id, kind, atMs, entityIds, fromVideo, outsideKnowledge });

function draft(overrides = {}) {
  return {
    type: "draft",
    version: 1,
    videoId: "abcdefghijk",
    title: "The Kings",
    source: { durationMs: 600000, transcript: { entries: [] }, sections: [] },
    sections: [{ title: "Start", startMs: 0, endMs: 600000, origin: "ai" }],
    entities: [
      person("p-alfred", "Alfred", [4000, 60000]),
      person("p-king", "The king", [30000, 200000, 300000]), // later resolved as two People
      person("p-edward", "Edward", [60000]),
      person("p-eadweard", "Eadweard", [90000]), // the same Person as Edward, misspelled
      place("pl-winchester", "Winchester", [8000]),
    ],
    relationships: [
      { fromId: "p-edward", toId: "p-alfred", label: "son of" },
      { fromId: "p-eadweard", toId: "p-alfred", label: "son of" },
    ],
    cues: [
      cue("cue-1", 8000, "gap", ["pl-winchester"], "Named, never located.", "Capital of Wessex."),
      cue("cue-2", 60000, "callback", ["p-edward", "p-alfred"], "Alfred's son."),
      cue("cue-3", 90000, "callback", ["p-eadweard"], "Edward again."),
      cue("cue-4", 200000, "callback", ["p-king"], "The king from earlier."),
      cue("cue-5", 300000, "callback", ["p-king"], "The king again."),
    ],
    ...overrides,
  };
}

// The same Video prepared again: reworded, slightly shifted, one Cue new.
function regenerated() {
  const d = draft();
  d.cues = [
    cue("cue-1", 9000, "gap", ["pl-winchester"], "Winchester, unlocated.", "Capital of Wessex."),
    cue("cue-2", 61000, "callback", ["p-edward", "p-alfred"], "Edward, Alfred's son."),
    cue("cue-3", 91000, "callback", ["p-eadweard"], "Eadweard again."),
    cue("cue-4", 201000, "callback", ["p-king"], "The king, regenerated."),
    cue("cue-5", 301000, "callback", ["p-king"], "The king again, regenerated."),
    cue("cue-6", 400000, "gap", ["p-alfred"], "A new Cue."),
  ];
  return d;
}

const byId = (notes, id) => notes.cues.find((c) => c.id === id);
const texts = (notes) => notes.cues.map((c) => c.fromVideo);

// ---------------------------------------------------------------------------
// Draft -> Notes

test("fromDraft marks everything as from the Draft and unedited", () => {
  const n = fromDraft(draft());
  assert.equal(n.type, "notes");
  assert.deepEqual(n.cues.map((c) => c.id), ["cue-1", "cue-2", "cue-3", "cue-4", "cue-5"]);
  for (const c of n.cues) {
    assert.equal(c.origin, "draft");
    assert.equal(c.edited, false);
    assert.deepEqual(c.fromDraft, { kind: c.kind, atMs: c.atMs, entityIds: c.entityIds });
  }
  for (const e of n.entities) {
    assert.equal(e.origin, "draft");
    assert.deepEqual(e.draftIds, [e.id]);
  }
  assert.equal(editCount(n), 0);
  // The view reads Notes like a Draft, with the markers.
  const normalized = view.normalizeDraft(n);
  assert.equal(normalized.cues[0].origin, "draft");
  assert.equal(normalized.cues[0].edited, false);
});

// ---------------------------------------------------------------------------
// Cue edits

test("updateCue corrects contents and timestamp, marks the Cue edited, and keeps Cues in time order", () => {
  const before = fromDraft(draft());
  const after = updateCue(before, "cue-2", {
    kind: "gap",
    atMs: 250000,
    entityIds: ["p-edward"],
    fromVideo: "  Corrected.  ",
    outsideKnowledge: "Born c. 874.",
  });
  const c = byId(after, "cue-2");
  assert.deepEqual(
    { kind: c.kind, atMs: c.atMs, entityIds: c.entityIds, fromVideo: c.fromVideo, outsideKnowledge: c.outsideKnowledge, edited: c.edited },
    { kind: "gap", atMs: 250000, entityIds: ["p-edward"], fromVideo: "Corrected.", outsideKnowledge: "Born c. 874.", edited: true }
  );
  assert.deepEqual(c.fromDraft, { kind: "callback", atMs: 60000, entityIds: ["p-edward", "p-alfred"] }, "Draft version kept for matching");
  assert.deepEqual(after.cues.map((x) => x.id), ["cue-1", "cue-3", "cue-4", "cue-2", "cue-5"]);
  assert.equal(byId(before, "cue-2").edited, false, "input Notes untouched");

  // Clearing Outside knowledge stores null.
  assert.equal(byId(updateCue(after, "cue-2", { outsideKnowledge: "  " }), "cue-2").outsideKnowledge, null);
  // Saving unchanged fields is not an edit.
  const same = byId(before, "cue-1");
  assert.equal(updateCue(before, "cue-1", { kind: same.kind, atMs: same.atMs, fromVideo: same.fromVideo }), before);
});

test("Cue edits reject invalid input with a message", () => {
  const n = fromDraft(draft());
  const rejects = (fn, pattern) => assert.throws(fn, (e) => e instanceof NotesEditError && pattern.test(e.message));
  rejects(() => updateCue(n, "cue-1", { kind: "highlight" }), /Callback or a Gap/);
  rejects(() => updateCue(n, "cue-1", { atMs: null }), /time in the Video/);
  rejects(() => updateCue(n, "cue-1", { atMs: 700000 }), /past the end/);
  rejects(() => updateCue(n, "cue-1", { entityIds: [], fromVideo: "", outsideKnowledge: "" }), /needs some content/);
  rejects(() => updateCue(n, "nope", { fromVideo: "x" }), /no longer exists/);
  // Unknown Entity ids are dropped, not stored.
  assert.deepEqual(byId(updateCue(n, "cue-1", { entityIds: ["pl-winchester", "ghost"] }), "cue-1").entityIds, ["pl-winchester"]);
});

test("addCue adds a user Cue at the given time with a fresh id", () => {
  const n = addCue(fromDraft(draft()), { atMs: 65432, kind: "callback", entityIds: ["p-alfred"], fromVideo: "My note." });
  const added = n.cues.find((c) => c.origin === "user");
  assert.equal(added.id, "cue-6");
  assert.equal(added.atMs, 65432);
  assert.equal(added.fromDraft, null);
  assert.deepEqual(n.cues.map((c) => c.id), ["cue-1", "cue-2", "cue-6", "cue-3", "cue-4", "cue-5"]);
  const again = addCue(n, { atMs: 1000, fromVideo: "Another." });
  assert.equal(again.cues[0].id, "cue-7");
  assert.equal(again.cues[0].kind, "gap", "a new Cue defaults to a Gap");
  assert.equal(editCount(again), 2);
});

test("deleteCue remembers deleted Draft Cues but not user Cues", () => {
  let n = fromDraft(draft());
  n = addCue(n, { atMs: 1000, fromVideo: "Mine." });
  const userId = n.cues[0].id;
  n = deleteCue(n, "cue-3");
  assert.ok(!byId(n, "cue-3"));
  assert.deepEqual(n.deletedDraftCues, [{ kind: "callback", atMs: 90000, entityIds: ["p-eadweard"] }]);
  n = deleteCue(n, userId);
  assert.equal(n.deletedDraftCues.length, 1);
  assert.ok(!byId(n, userId));
});

// ---------------------------------------------------------------------------
// Entity edits

test("mergeEntities folds one Entity into another everywhere", () => {
  const n = mergeEntities(fromDraft(draft()), "p-edward", "p-eadweard");
  assert.ok(!n.entities.some((e) => e.id === "p-eadweard"));
  const edward = n.entities.find((e) => e.id === "p-edward");
  assert.deepEqual(edward.mentionsMs, [60000, 90000]);
  assert.equal(edward.firstMentionMs, 60000);
  assert.deepEqual(edward.draftIds, ["p-edward", "p-eadweard"]);
  assert.equal(edward.edited, true);
  assert.deepEqual(byId(n, "cue-3").entityIds, ["p-edward"]);
  assert.deepEqual(n.relationships, [{ fromId: "p-edward", toId: "p-alfred", label: "son of" }], "duplicate link dropped");

  assert.throws(() => mergeEntities(n, "p-edward", "pl-winchester"), /same kind/);
  assert.throws(() => mergeEntities(n, "p-edward", "p-edward"), /two different/);
});

test("splitEntity moves chosen Mentions to a new Entity and Cues follow the nearest earlier Mention", () => {
  const before = fromDraft(draft());
  const n = splitEntity(before, "p-king", { name: "  Edmund  ", mentionsMs: [300000] });
  const king = n.entities.find((e) => e.id === "p-king");
  const edmund = n.entities.find((e) => e.name === "Edmund");
  assert.deepEqual(king.mentionsMs, [30000, 200000]);
  assert.equal(king.edited, true);
  assert.deepEqual(
    { id: edmund.id, kind: edmund.kind, origin: edmund.origin, mentionsMs: edmund.mentionsMs, firstMentionMs: edmund.firstMentionMs, splitFromId: edmund.splitFromId },
    { id: "entity-1", kind: "person", origin: "user", mentionsMs: [300000], firstMentionMs: 300000, splitFromId: "p-king" }
  );
  assert.deepEqual(byId(n, "cue-4").entityIds, ["p-king"]);
  assert.deepEqual(byId(n, "cue-5").entityIds, ["entity-1"]);
  assert.equal(before.entities.find((e) => e.id === "p-king").mentionsMs.length, 3, "input Notes untouched");

  assert.throws(() => splitEntity(before, "p-king", { name: "", mentionsMs: [300000] }), /Name the new Entity/);
  assert.throws(() => splitEntity(before, "p-king", { name: "X", mentionsMs: [] }), /Choose the Mentions/);
  assert.throws(() => splitEntity(before, "p-king", { name: "X", mentionsMs: [30000, 200000, 300000] }), /at least one Mention/);
});

// ---------------------------------------------------------------------------
// Regeneration

function editedNotes() {
  let n = fromDraft(draft());
  n = updateCue(n, "cue-1", { fromVideo: "My corrected text.", atMs: 12000 }); // edited, timestamp moved
  n = deleteCue(n, "cue-2");
  n = addCue(n, { atMs: 100000, fromVideo: "My own Cue.", entityIds: ["p-alfred"] });
  n = mergeEntities(n, "p-edward", "p-eadweard");
  n = splitEntity(n, "p-king", { name: "Edmund", mentionsMs: [300000] });
  return n;
}

test("regenerating the Draft never overwrites user-made or user-edited items", () => {
  const before = editedNotes();
  const n = mergeDraft(before, regenerated());

  // The edited Cue survives verbatim and its regenerated counterpart doesn't duplicate it.
  const edited = n.cues.filter((c) => c.edited);
  assert.deepEqual(edited.map((c) => [c.id, c.atMs, c.fromVideo]), [["cue-1", 12000, "My corrected text."]]);
  assert.ok(!texts(n).includes("Winchester, unlocated."));
  // The deleted Cue doesn't come back.
  assert.ok(!texts(n).includes("Edward, Alfred's son."));
  // The user Cue survives.
  const mine = n.cues.filter((c) => c.origin === "user");
  assert.deepEqual(mine.map((c) => [c.atMs, c.fromVideo, c.entityIds]), [[100000, "My own Cue.", ["p-alfred"]]]);
  // Unedited Draft Cues are replaced by the new Draft; new Cues arrive.
  assert.deepEqual(texts(n), ["My corrected text.", "Eadweard again.", "My own Cue.", "The king, regenerated.", "The king again, regenerated.", "A new Cue."]);

  // The merge holds: the regenerated Cue naming the misspelled Entity points at the kept one.
  assert.ok(!n.entities.some((e) => e.id === "p-eadweard"));
  assert.deepEqual(n.cues.find((c) => c.fromVideo === "Eadweard again.").entityIds, ["p-edward"]);
  assert.deepEqual(n.entities.find((e) => e.id === "p-edward").mentionsMs, [60000, 90000], "edited Entity not overwritten");
  assert.deepEqual(n.relationships, [{ fromId: "p-edward", toId: "p-alfred", label: "son of" }]);
  // The split holds: regenerated Cues follow the nearest earlier Mention.
  assert.deepEqual(n.cues.find((c) => c.fromVideo === "The king, regenerated.").entityIds, ["p-king"]);
  assert.deepEqual(n.cues.find((c) => c.fromVideo === "The king again, regenerated.").entityIds, ["entity-1"]);
  assert.equal(n.entities.find((e) => e.id === "entity-1").name, "Edmund");

  // Ids stay unique, and kept items keep theirs.
  assert.equal(new Set(n.cues.map((c) => c.id)).size, n.cues.length);
  assert.ok(byId(n, mine[0].id) && mine[0].id === before.cues.find((c) => c.origin === "user").id);
  assert.equal(n.draft.cues.length, 6);
});

test("regeneration is deterministic and stable when repeated", () => {
  const a = mergeDraft(editedNotes(), regenerated());
  const b = mergeDraft(editedNotes(), regenerated());
  assert.deepEqual(a, b);
  const again = mergeDraft(a, regenerated());
  assert.deepEqual(texts(again), texts(a));
  assert.deepEqual(again.cues.filter((c) => c.origin === "user" || c.edited), a.cues.filter((c) => c.origin === "user" || c.edited));
});

test("each edited or deleted Cue absorbs at most one regenerated Cue, the nearest", () => {
  let n = fromDraft(draft({ cues: [cue("cue-1", 10000, "gap", ["pl-winchester"], "Once.")] }));
  n = deleteCue(n, "cue-1");
  const d = draft({
    cues: [
      cue("cue-1", 3000, "gap", ["pl-winchester"], "Far."), // 7s away
      cue("cue-2", 11000, "gap", ["pl-winchester"], "Near."), // 1s away
      cue("cue-3", 30000, "gap", ["pl-winchester"], "Outside the window."),
    ],
  });
  assert.deepEqual(texts(mergeDraft(n, d)), ["Far.", "Outside the window."]);
});

test("a kept Cue keeps an Entity the new Draft no longer has", () => {
  let n = fromDraft(draft());
  n = addCue(n, { atMs: 9000, entityIds: ["pl-winchester"], fromVideo: "About Winchester." });
  const d = regenerated();
  d.entities = d.entities.filter((e) => e.id !== "pl-winchester");
  const merged = mergeDraft(n, d);
  assert.ok(merged.entities.some((e) => e.id === "pl-winchester"));
  assert.deepEqual(merged.cues.find((c) => c.origin === "user").entityIds, ["pl-winchester"]);
  assert.deepEqual(merged.cues.find((c) => c.fromVideo === "Winchester, unlocated.").entityIds, [], "Draft Cue only references the new Draft");
});

// ---------------------------------------------------------------------------
// Timestamps typed into the editor

test("parseTimestamp reads m:ss, h:mm:ss, and seconds", () => {
  assert.equal(view.parseTimestamp("3:05"), 185000);
  assert.equal(view.parseTimestamp(" 1:02:03 "), 3723000);
  assert.equal(view.parseTimestamp("75"), 75000);
  assert.equal(view.parseTimestamp("0:07.5"), 7500);
  for (const bad of ["", "1:75", "1:60:00", "abc", "-3", "1::2", null]) assert.equal(view.parseTimestamp(bad), null, String(bad));
  assert.equal(view.parseTimestamp(view.formatTimestamp(3723000)), 3723000);
});

// ---------------------------------------------------------------------------
// Editor rendering

test("cueEditorModel only offers Entities introduced by the playhead", () => {
  const n = view.normalizeDraft(fromDraft(draft()));
  const model = view.cueEditorModel(n, { cueId: "cue-2" }, 61000);
  assert.deepEqual(model.choices.map((e) => e.id), ["p-alfred", "pl-winchester", "p-king", "p-edward"]);
  assert.deepEqual(model.entityTools.map((t) => t.entity.id), ["p-edward", "p-alfred"]);
  assert.deepEqual(model.entityTools[0].mergeTargets.map((e) => e.id), ["p-alfred", "p-king"], "same kind, already introduced");
  assert.equal(view.cueEditorModel(n, { cueId: "gone" }, 61000), null);
  const fresh = view.cueEditorModel(n, { atMs: 5000 }, 5000);
  assert.equal(fresh.isNew, true);
  assert.deepEqual(fresh.choices.map((e) => e.id), ["p-alfred"]);
});

test("the editor saves typed values, keeps the exact time unless changed, and deletes in two steps", () => {
  const n = view.normalizeDraft(updateCue(fromDraft(draft()), "cue-1", { atMs: 8250 }));
  const calls = [];
  const handlers = {
    onEdit: (id) => calls.push(["edit", id]),
    onSave: (values) => (calls.push(["save", values]), "Bad time"),
    onDelete: (id) => calls.push(["delete", id]),
    onCancelEdit: () => calls.push(["cancel"]),
    onAdd: () => calls.push(["add"]),
  };
  const v = view.buildView(n, 9000);

  // Reading: provenance marker, Edit and Add buttons.
  const reading = renderCueView(fakeDocument(), v, handlers);
  assert.equal(find(reading, (x) => hasClass(x, "cue-card__origin")).textContent, " · Edited");
  find(reading, (x) => hasClass(x, "cue-card__edit")).click();
  find(reading, (x) => hasClass(x, "cue-add")).click();

  // Editing: the form replaces the Cue card.
  const root = renderCueView(fakeDocument(), v, handlers, view.cueEditorModel(n, { cueId: "cue-1" }, 9000));
  assert.equal(findAll(root, (x) => hasClass(x, "cue-add")).length, 0);
  const form = find(root, (x) => x.tagName === "form");
  assert.equal(form.getAttribute("aria-label"), "Edit Cue");
  find(root, (x) => hasClass(x, "cue-editor__outside")).value = "Wessex.";
  form.submit();
  const [, saved] = calls.find((c) => c[0] === "save");
  assert.deepEqual(saved, { kind: "gap", atMs: 8250, entityIds: ["pl-winchester"], fromVideo: "Named, never located.", outsideKnowledge: "Wessex." });
  assert.equal(find(root, (x) => hasClass(x, "cue-editor__error")).textContent, "Bad time", "error shown");

  find(root, (x) => hasClass(x, "cue-editor__at")).value = "0:30";
  form.submit();
  assert.equal(calls.filter((c) => c[0] === "save")[1][1].atMs, 30000);

  const del = find(root, (x) => hasClass(x, "cue-editor__delete"));
  del.click();
  assert.ok(!calls.some((c) => c[0] === "delete"), "first click only asks");
  assert.equal(del.textContent, "Confirm delete");
  del.click();
  assert.deepEqual(calls.filter((c) => c[0] !== "save"), [["edit", "cue-1"], ["add"], ["delete", "cue-1"]]);
});

test("Entity merge and split controls pass the chosen Entities and Mentions", () => {
  const n = view.normalizeDraft(fromDraft(draft()));
  const calls = [];
  const handlers = {
    onMergeEntities: (keep, merge, values) => (calls.push(["merge", keep, merge, values.fromVideo]), null),
    onSplitEntity: (id, split) => (calls.push(["split", id, split]), null),
  };
  const v = view.buildView(n, 300000);
  const root = renderCueView(fakeDocument(), v, handlers, view.cueEditorModel(n, { cueId: "cue-5" }, 300000));
  const tool = find(root, (x) => x.getAttribute?.("data-entity-id") === "p-king");
  find(tool, (x) => hasClass(x, "cue-entity-tool__target")).value = "p-edward";
  find(tool, (x) => hasClass(x, "cue-entity-tool__merge")).click();
  find(tool, (x) => hasClass(x, "cue-entity-tool__split-name")).value = "Edmund";
  findAll(tool, (x) => hasClass(x, "cue-entity-tool__mention"))[2].checked = true;
  find(tool, (x) => hasClass(x, "cue-entity-tool__split")).click();
  assert.deepEqual(calls, [
    ["merge", "p-edward", "p-king", "The king again."],
    ["split", "p-king", { name: "Edmund", mentionsMs: [300000] }],
  ]);
});

// ---------------------------------------------------------------------------
// The open editor across Entity merges and splits

test("after a split, the open editor's values follow it, so saving can't restore the old Entity", () => {
  const before = fromDraft(draft());
  // Editing cue-5 (300000, "The king"); the form holds the Entity ids from before the split.
  const values = { kind: "callback", atMs: 300000, entityIds: ["p-king"], fromVideo: "The king again, edited.", outsideKnowledge: "" };
  const after = splitEntity(before, "p-king", { name: "Edmund", mentionsMs: [300000] });
  assert.deepEqual(byId(after, "cue-5").entityIds, ["entity-1"], "the split moved the saved Cue");

  // The bug: saving the stale form puts the Cue back on the original Entity.
  assert.deepEqual(byId(updateCue(after, "cue-5", values), "cue-5").entityIds, ["p-king"]);

  const followed = followSplit(after, values, "p-king", 300000);
  assert.deepEqual(followed.entityIds, ["entity-1"]);
  assert.equal(followed.fromVideo, "The king again, edited.", "typing is kept");
  const saved = updateCue(after, "cue-5", followed);
  assert.deepEqual(byId(saved, "cue-5").entityIds, ["entity-1"]);
  assert.equal(byId(saved, "cue-5").fromVideo, "The king again, edited.");

  // The re-rendered editor shows the reconciled choice.
  const model = view.cueEditorModel(view.normalizeDraft(after), { cueId: "cue-5", values: followed }, 300000);
  assert.deepEqual(model.values.entityIds, ["entity-1"]);

  // A form time earlier than the split-off Mentions keeps the original Entity;
  // an unreadable typed time falls back to the Cue's saved time.
  assert.deepEqual(followSplit(after, { ...values, atMs: 210000 }, "p-king", 300000).entityIds, ["p-king"]);
  assert.deepEqual(followSplit(after, { ...values, atMs: null }, "p-king", 300000).entityIds, ["entity-1"]);
  // Unrelated ids and unchecked Entities are untouched.
  assert.deepEqual(followSplit(after, { ...values, entityIds: ["p-alfred"] }, "p-king", 300000).entityIds, ["p-alfred"]);
});

test("after a merge, the open editor's values name the kept Entity once", () => {
  const values = { kind: "callback", atMs: 90000, entityIds: ["p-eadweard", "p-edward"], fromVideo: "x", outsideKnowledge: "" };
  assert.deepEqual(followMerge(values, "p-edward", "p-eadweard").entityIds, ["p-edward"]);
  assert.equal(followMerge(null, "a", "b"), null);
});

// ---------------------------------------------------------------------------
// Regeneration with competing anchors

test("competing deleted Cues each absorb a regenerated Cue, whatever order they were deleted in", () => {
  const base = draft({
    cues: [cue("cue-1", 10000, "gap", ["pl-winchester"], "A."), cue("cue-2", 12500, "gap", ["pl-winchester"], "B.")],
  });
  const regen = draft({
    cues: [
      cue("cue-1", 1000, "gap", ["pl-winchester"], "Only A can absorb this."), // 9s from A, 11.5s from B (outside the window)
      cue("cue-2", 12000, "gap", ["pl-winchester"], "Nearest to both."), // 2s from A, 0.5s from B
      cue("cue-3", 40000, "gap", ["pl-winchester"], "New."),
    ],
  });
  const aFirst = deleteCue(deleteCue(fromDraft(base), "cue-1"), "cue-2");
  const bFirst = deleteCue(deleteCue(fromDraft(base), "cue-2"), "cue-1");
  // Taking A's nearest Cue first would leave B nothing and bring a deleted Cue back.
  assert.deepEqual(texts(mergeDraft(aFirst, regen)), ["New."]);
  assert.deepEqual(texts(mergeDraft(bFirst, regen)), ["New."]);
  assert.deepEqual(mergeDraft(aFirst, regen).cues, mergeDraft(bFirst, regen).cues);
});

test("competing edited and deleted Cues: matching is global, and still at most one each", () => {
  let n = fromDraft(draft({
    cues: [cue("cue-1", 10000, "gap", ["pl-winchester"], "A."), cue("cue-2", 12500, "gap", ["pl-winchester"], "B.")],
  }));
  n = updateCue(n, "cue-2", { fromVideo: "B, edited." }); // anchor at 12500
  n = deleteCue(n, "cue-1"); // anchor at 10000
  const regen = draft({
    cues: [
      cue("cue-1", 1000, "gap", ["pl-winchester"], "r1"),
      cue("cue-2", 12000, "gap", ["pl-winchester"], "r2"),
      cue("cue-3", 13000, "gap", ["pl-winchester"], "r3"),
    ],
  });
  // B (12500) needs r2 or r3; A (10000) takes the other of those, its next
  // nearest, rather than r1. Two anchors absorb exactly two; r1 stays.
  assert.deepEqual(texts(mergeDraft(n, regen)), ["r1", "B, edited."]);
});

// ---------------------------------------------------------------------------
// Only the user's own clicks change Notes

test("editor actions ignore clicks and submits a page script makes", () => {
  const n = view.normalizeDraft(fromDraft(draft()));
  const calls = [];
  const handlers = {
    onSave: () => (calls.push("save"), null),
    onDelete: () => calls.push("delete"),
    onMergeEntities: () => (calls.push("merge"), null),
    onSplitEntity: () => (calls.push("split"), null),
    onCancelEdit: () => calls.push("cancel"),
  };
  const root = renderCueView(fakeDocument(), view.buildView(n, 300000), handlers, view.cueEditorModel(n, { cueId: "cue-5" }, 300000));
  const del = find(root, (x) => hasClass(x, "cue-editor__delete"));
  del.untrustedClick();
  del.untrustedClick();
  assert.equal(del.textContent, "Delete Cue", "not even armed");
  find(root, (x) => x.tagName === "form").untrustedSubmit();
  const tool = find(root, (x) => x.getAttribute?.("data-entity-id") === "p-king");
  find(tool, (x) => hasClass(x, "cue-entity-tool__merge")).untrustedClick();
  find(tool, (x) => hasClass(x, "cue-entity-tool__split-name")).value = "Edmund";
  findAll(tool, (x) => hasClass(x, "cue-entity-tool__mention"))[2].checked = true;
  find(tool, (x) => hasClass(x, "cue-entity-tool__split")).untrustedClick();
  assert.deepEqual(calls, []);

  // The same controls work for the user.
  find(root, (x) => x.tagName === "form").submit();
  find(tool, (x) => hasClass(x, "cue-entity-tool__split")).click();
  del.click();
  del.click();
  assert.deepEqual(calls, ["save", "split", "delete"]);
});

test("the editor keeps a chosen Entity first mentioned after the Cue, and says it isn't shown there", () => {
  // cue-2 is at 60000; the playhead (300000) is past "The king"'s later Mentions.
  let n = fromDraft(draft());
  n = splitEntity(n, "p-king", { name: "Edmund", mentionsMs: [200000, 300000] }); // entity-1, first mentioned at 200000
  n = updateCue(n, "cue-2", { entityIds: ["p-edward", "entity-1"] }); // the user links a later Entity
  assert.deepEqual(byId(n, "cue-2").entityIds, ["p-edward", "entity-1"], "the edit is kept, not silently dropped");
  const normalized = view.normalizeDraft(n);
  const model = view.cueEditorModel(normalized, { cueId: "cue-2" }, 300000);
  assert.deepEqual(model.values.entityIds, ["p-edward", "entity-1"]);
  // Every offered Entity first mentioned after 1:00 is flagged (Eadweard at 1:30 too).
  assert.deepEqual(model.notShownIds, ["p-eadweard", "entity-1"]);
  const root = renderCueView(fakeDocument(), view.buildView(normalized, 300000), {}, model);
  const labels = findAll(root, (x) => hasClass(x, "cue-editor__check"));
  const edmund = labels.find((l) => l.textContent.includes("Edmund"));
  assert.match(edmund.textContent, /first mentioned at 3:20, so not shown at this Cue/);
  assert.ok(!labels.find((l) => l.textContent.includes("Alfred")).textContent.includes("not shown"));
  // ...and the Cue itself, at its time, doesn't show it.
  assert.deepEqual(view.buildView(normalized, 60000).current.entities.map((e) => e.id), ["p-edward"]);
});

// ---------------------------------------------------------------------------
// Minimal fake DOM: just what cue-render.js uses.

class FakeNode {
  constructor(tagName, ns = null) {
    this.tagName = tagName;
    this.namespaceURI = ns;
    this.children = [];
    this.attributes = new Map();
    this.listeners = {};
    this._text = "";
  }
  set className(v) {
    this.attributes.set("class", v);
  }
  get className() {
    return this.attributes.get("class") ?? "";
  }
  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  // A real user's click; untrustedClick() is a page script calling .click().
  click() {
    for (const fn of this.listeners.click ?? []) fn({ type: "click", isTrusted: true });
  }
  untrustedClick() {
    for (const fn of this.listeners.click ?? []) fn({ type: "click", isTrusted: false });
  }
  submit() {
    for (const fn of this.listeners.submit ?? []) fn({ type: "submit", isTrusted: true, preventDefault() {} });
  }
  untrustedSubmit() {
    for (const fn of this.listeners.submit ?? []) fn({ type: "submit", isTrusted: false, preventDefault() {} });
  }
}

function fakeDocument() {
  return {
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (ns, tag) => new FakeNode(tag, ns),
    createTextNode: (text) => Object.assign(new FakeNode("#text"), { textContent: text }),
  };
}

function findAll(root, pred, out = []) {
  if (pred(root)) out.push(root);
  for (const c of root.children ?? []) findAll(c, pred, out);
  return out;
}
const find = (root, pred) => {
  const found = findAll(root, pred)[0];
  assert.ok(found, "element not found");
  return found;
};
const hasClass = (node, cls) => (node.getAttribute?.("class") ?? "").split(/\s+/).includes(cls);
