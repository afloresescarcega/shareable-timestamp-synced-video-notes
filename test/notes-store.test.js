// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const notesApi = require("../src/notes.js");
const settings = require("../src/settings.js");
const { storageKey, createNotesStore } = require("../src/notes-store.js");

// ---------------------------------------------------------------------------
// Fixtures

const VIDEO_A = "aaaaaaaaaaa";
const VIDEO_B = "bbbbbbbbbbb";

function draft(videoId = VIDEO_A) {
  return {
    type: "draft",
    version: 1,
    videoId,
    title: `Video ${videoId}`,
    source: { durationMs: 600000, transcript: { entries: [] }, sections: [] },
    sections: [{ title: "Start", startMs: 0, endMs: 600000, origin: "ai" }],
    entities: [{ id: "p-alfred", kind: "person", name: "Alfred", summary: "A king.", firstMentionMs: 4000, mentionsMs: [4000, 60000], place: null, date: null }],
    relationships: [],
    cues: [{ id: "cue-1", kind: "callback", atMs: 60000, entityIds: ["p-alfred"], fromVideo: "Alfred again.", outsideKnowledge: null }],
  };
}
const notesFor = (videoId = VIDEO_A) => notesApi.fromDraft(draft(videoId));

// chrome.storage.local stand-in. Values are copied through JSON, like the
// real one. With `manual`, each get/set waits until release() is called, so
// tests can choose the order operations finish in.
function fakeArea({ manual = false } = {}) {
  const data = new Map();
  const waiting = [];
  const settle = (fn) =>
    manual ? new Promise((resolve, reject) => waiting.push(() => { try { resolve(fn()); } catch (e) { reject(e); } })) : Promise.resolve().then(fn);
  return {
    data,
    log: [],
    get(key) {
      this.log.push(["get", key]);
      return settle(() => (data.has(key) ? { [key]: JSON.parse(JSON.stringify(data.get(key))) } : {}));
    },
    set(items) {
      this.log.push(["set", ...Object.keys(items)]);
      const copy = JSON.parse(JSON.stringify(items));
      return settle(() => {
        for (const [k, v] of Object.entries(copy)) data.set(k, v);
      });
    },
    remove(key) {
      return settle(() => data.delete(key));
    },
    pending: () => waiting.length,
    // Lets every queued operation finish, one at a time, in order.
    async releaseAll() {
      for (;;) {
        await flush();
        if (!waiting.length) break;
        waiting.shift()();
      }
    },
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Per-Video keying

test("Notes are saved under their own Video ID and read back per Video", async () => {
  const area = fakeArea();
  const store = createNotesStore(area);

  assert.deepEqual(await store.open(VIDEO_A), { videoId: VIDEO_A, notes: null });
  const a = notesFor(VIDEO_A);
  assert.deepEqual(await store.save(a), { ok: true });

  assert.deepEqual(await store.open(VIDEO_B), { videoId: VIDEO_B, notes: null });
  const b = notesApi.addCue(notesFor(VIDEO_B), { atMs: 1000, kind: "gap", fromVideo: "Only on B." });
  await store.save(b);

  assert.deepEqual([...area.data.keys()].sort(), [storageKey(VIDEO_A), storageKey(VIDEO_B)]);
  assert.equal(storageKey(VIDEO_A), `notes:${VIDEO_A}`);
  assert.deepEqual((await store.open(VIDEO_A)).notes, a);
  assert.deepEqual((await store.open(VIDEO_B)).notes, b);
});

test("saving Notes never touches the API key or other settings", async () => {
  const area = fakeArea();
  await settings.saveApiKey(area, "sk-ant-secret_123");
  const store = createNotesStore(area);
  await store.open(VIDEO_A);
  await store.save(notesFor(VIDEO_A));

  assert.equal(await settings.loadApiKey(area), "sk-ant-secret_123");
  const saved = JSON.stringify(area.data.get(storageKey(VIDEO_A)));
  assert.ok(!saved.includes("sk-ant"));
  assert.ok(!saved.includes(settings.API_KEY_STORAGE_KEY));
});

test("Notes for another Video than the open one are refused, not saved under the wrong key", async () => {
  const area = fakeArea();
  const store = createNotesStore(area);
  await store.open(VIDEO_B);
  const result = await store.save(notesFor(VIDEO_A));
  assert.equal(result.ok, false);
  assert.equal(area.data.size, 0);
});

test("damaged saved Notes are reported and left as they are, never overwritten", async () => {
  const area = fakeArea();
  area.data.set(storageKey(VIDEO_A), { type: "notes", version: 1, videoId: VIDEO_A }); // lists missing
  const store = createNotesStore(area);

  assert.deepEqual(await store.open(VIDEO_A), { videoId: VIDEO_A, notes: null });
  assert.equal(store.state.status, "error");
  assert.match(store.state.message, /couldn't be read/);
  assert.equal(store.isReady(VIDEO_A), false);

  const result = await store.save(notesFor(VIDEO_A));
  assert.equal(result.ok, false);
  assert.deepEqual(area.data.get(storageKey(VIDEO_A)), { type: "notes", version: 1, videoId: VIDEO_A });
});

test("a failed read blocks saving for that Video", async () => {
  const area = fakeArea();
  area.get = () => Promise.reject(new Error("storage unavailable"));
  const store = createNotesStore(area);
  const opened = await store.open(VIDEO_A);
  assert.deepEqual(opened, { videoId: VIDEO_A, notes: null });
  assert.equal(store.state.status, "error");
  assert.equal((await store.save(notesFor(VIDEO_A))).ok, false);
  assert.equal(area.data.size, 0);
});

test("a storage failure on save is reported, not thrown", async () => {
  const area = fakeArea();
  area.set = () => Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
  const store = createNotesStore(area);
  await store.open(VIDEO_A);
  const result = await store.save(notesFor(VIDEO_A));
  assert.equal(result.ok, false);
  assert.match(result.message, /quota/);
});

// ---------------------------------------------------------------------------
// Race safety

test("saves can't happen while the Video's saved Notes are still loading", async () => {
  const area = fakeArea({ manual: true });
  area.data.set(storageKey(VIDEO_A), notesFor(VIDEO_A));
  const store = createNotesStore(area);
  const opening = store.open(VIDEO_A);
  assert.equal(store.state.status, "loading");

  const early = await store.save(notesFor(VIDEO_A));
  assert.equal(early.ok, false);
  await area.releaseAll();
  assert.ok((await opening).notes);
  assert.ok(!area.log.some(([op]) => op === "set"));
});

test("a load for a Video the user has left resolves null and doesn't change the open Video", async () => {
  const area = fakeArea({ manual: true });
  area.data.set(storageKey(VIDEO_A), notesFor(VIDEO_A));
  const store = createNotesStore(area);

  const openingA = store.open(VIDEO_A);
  const openingB = store.open(VIDEO_B);
  await area.releaseAll();

  assert.equal(await openingA, null);
  assert.deepEqual(await openingB, { videoId: VIDEO_B, notes: null });
  assert.equal(store.state.videoId, VIDEO_B);
  assert.equal(store.isReady(VIDEO_B), true);
  assert.equal(store.isReady(VIDEO_A), false);
});

test("leaving and coming back reads the latest save, not what was stored before it", async () => {
  const area = fakeArea({ manual: true });
  const store = createNotesStore(area);
  const first = store.open(VIDEO_A);
  await area.releaseAll();
  await first;

  const edited = notesApi.addCue(notesFor(VIDEO_A), { atMs: 5000, kind: "gap", fromVideo: "A user Cue." });
  const saving = store.save(edited); // still in flight
  const openingB = store.open(VIDEO_B);
  const openingA = store.open(VIDEO_A);
  await area.releaseAll();

  assert.deepEqual(await saving, { ok: true });
  assert.equal(await openingB, null);
  assert.deepEqual((await openingA).notes, edited);
  // Every operation ran in the order it was asked for.
  assert.deepEqual(area.log.map(([op]) => op), ["get", "set", "get", "get"]);
});

test("saves land in the order they were made, so the newest Notes win", async () => {
  const area = fakeArea({ manual: true });
  const store = createNotesStore(area);
  const opening = store.open(VIDEO_A);
  await area.releaseAll();
  await opening;

  const older = notesFor(VIDEO_A);
  const newer = notesApi.addCue(older, { atMs: 5000, kind: "gap", fromVideo: "Newer." });
  const s1 = store.save(older);
  const s2 = store.save(newer);
  await area.releaseAll();
  await Promise.all([s1, s2]);
  assert.deepEqual(area.data.get(storageKey(VIDEO_A)), JSON.parse(JSON.stringify(newer)));
});

test("close() makes an in-flight load resolve null and blocks saves", async () => {
  const area = fakeArea({ manual: true });
  const store = createNotesStore(area);
  const opening = store.open(VIDEO_A);
  store.close();
  await area.releaseAll();
  assert.equal(await opening, null);
  assert.equal(store.state.status, "none");
  assert.equal((await store.save(notesFor(VIDEO_A))).ok, false);
});
