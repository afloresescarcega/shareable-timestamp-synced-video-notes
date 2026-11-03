// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const yt = require("../src/youtube-data.js");
const { createSourceMaterialLoader } = require("../src/source-material.js");

const VIDEO = "abcdefghijk";
const ORIGIN = "https://www.youtube.com";

const watchPage = (player, initialData = {}) =>
  `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>` +
  `<script>var ytInitialData = ${JSON.stringify(initialData)};</script>`;

const ok = (body) => ({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) });

const playable = (extra = {}) => ({
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VIDEO, title: "The Kings", lengthSeconds: "600" },
  ...extra,
});
const withCaptions = () =>
  playable({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "/api/timedtext?v=x", languageCode: "en" }] } } });
const timedText = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "Hello" }] }] });

// A fetch that answers each watch-page request with the next page in `pages`.
function youtube(pages) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/api/timedtext")) return ok(timedText);
    const next = pages.shift();
    if (next instanceof Error) throw next;
    return ok(next);
  };
  const watchLoads = () => calls.filter((u) => u.includes("/watch")).length;
  return { loader: createSourceMaterialLoader({ fetchImpl, origin: ORIGIN }), watchLoads };
}

test("a watch page that can't be parsed is a retryable error, not 'unavailable' forever", async () => {
  const { loader, watchLoads } = youtube(["<html>Before you continue to YouTube</html>", watchPage(withCaptions())]);
  const first = await loader.load(VIDEO);
  assert.equal(first.status, "error");
  assert.match(first.message, /couldn't be read/);
  const second = await loader.load(VIDEO);
  assert.equal(second.status, "ready", "the next load fetched again");
  assert.equal(watchLoads(), 2);
});

test("a Video not playable right now (sign-in or bot check) is reported but fetched again next time", async () => {
  const blocked = { playabilityStatus: { status: "LOGIN_REQUIRED" } };
  const { loader, watchLoads } = youtube([watchPage(blocked), watchPage(withCaptions())]);
  const first = await loader.load(VIDEO);
  assert.equal(first.status, "unsupported");
  assert.equal(first.reason, yt.UNSUPPORTED.UNAVAILABLE);
  assert.equal((await loader.load(VIDEO)).status, "ready");
  assert.equal(watchLoads(), 2);
});

test("a network failure is retried on the next load", async () => {
  const { loader, watchLoads } = youtube([new TypeError("Failed to fetch"), watchPage(withCaptions())]);
  assert.equal((await loader.load(VIDEO)).status, "error");
  assert.equal((await loader.load(VIDEO)).status, "ready");
  assert.equal(watchLoads(), 2);
});

test("a Video with no Transcript stays unsupported without fetching again", async () => {
  const { loader, watchLoads } = youtube([watchPage(playable())]);
  const first = await loader.load(VIDEO);
  assert.deepEqual([first.status, first.reason], ["unsupported", yt.UNSUPPORTED.NO_TRANSCRIPT]);
  assert.match(first.message, /no Transcript/);
  assert.equal(await loader.load(VIDEO), await loader.load(VIDEO));
  assert.equal(watchLoads(), 1);
});

test("a Transcript that was read is reused", async () => {
  const { loader, watchLoads } = youtube([watchPage(withCaptions())]);
  const first = await loader.load(VIDEO);
  assert.equal(first.status, "ready");
  assert.deepEqual(first.transcript.entries, [{ startMs: 0, durationMs: 2000, text: "Hello" }]);
  assert.equal(await loader.load(VIDEO), first);
  assert.equal(watchLoads(), 1);
});

test("isSettled: only a read Transcript or a true no-Transcript Video is final", () => {
  assert.equal(yt.isSettled({ status: "ready" }), true);
  assert.equal(yt.isSettled(yt.unsupported(VIDEO, yt.UNSUPPORTED.NO_TRANSCRIPT)), true);
  assert.equal(yt.isSettled(yt.unsupported(VIDEO, yt.UNSUPPORTED.UNAVAILABLE)), false);
  assert.equal(yt.isSettled(yt.unsupported(VIDEO, yt.UNSUPPORTED.LIVE)), false);
  assert.equal(yt.isSettled({ status: "error" }), false);
  assert.equal(yt.isSettled({ status: "loading" }), false);
  assert.equal(yt.isSettled(null), false);
});
