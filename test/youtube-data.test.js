// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const yt = require("../src/youtube-data.js");

const chapter = (title, ms) => ({ chapterRenderer: { title: { simpleText: title }, timeRangeStartMillis: ms } });

test("parseWatchPageHtml extracts embedded objects, including braces inside strings", () => {
  const player = { videoDetails: { videoId: "abcdefghijk", title: "A } tricky \" title {" } };
  const html = `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var meta = {};</script>
    <script>var ytInitialData = {"a":1};</script>
    <script>ytcfg.set({"INNERTUBE_API_KEY":"KEY","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB"}}});</script>`;
  const page = yt.parseWatchPageHtml(html);
  assert.deepEqual(page.playerResponse, player);
  assert.deepEqual(page.initialData, { a: 1 });
  assert.equal(page.innertube.apiKey, "KEY");
  assert.deepEqual(page.innertube.context, { client: { clientName: "WEB" } });
});

test("detectUnsupported flags unplayable and live Videos", () => {
  assert.equal(yt.detectUnsupported(null), "video-unavailable");
  assert.equal(yt.detectUnsupported({ playabilityStatus: { status: "LOGIN_REQUIRED" } }), "video-unavailable");
  assert.equal(yt.detectUnsupported({ playabilityStatus: { status: "OK" }, videoDetails: { isLive: true } }), "live");
  assert.equal(yt.detectUnsupported({ playabilityStatus: { status: "OK" }, videoDetails: {} }), null);
  const result = yt.unsupported("abcdefghijk", yt.UNSUPPORTED.NO_TRANSCRIPT);
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "no-transcript");
  assert.match(result.message, /no Transcript/);
});

test("selectCaptionTrack prefers a manual track in the spoken language", () => {
  const asr = { baseUrl: "u1", languageCode: "en", kind: "asr" };
  const fr = { baseUrl: "u2", languageCode: "fr" };
  const en = { baseUrl: "u3", languageCode: "en" };
  assert.equal(yt.selectCaptionTrack([fr, asr, en]), en);
  assert.equal(yt.selectCaptionTrack([fr, asr]), asr);
  assert.equal(yt.selectCaptionTrack([fr]), fr);
  assert.equal(yt.selectCaptionTrack([]), null);
  assert.deepEqual(yt.getCaptionTracks({}), []);
});

test("normalizeJson3Transcript joins segments and drops blank events", () => {
  const entries = yt.normalizeJson3Transcript({
    events: [
      { tStartMs: 0, dDurationMs: 5000 }, // window event, no segs
      { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: "the  king" }, { utf8: "\nwas" }] },
      { tStartMs: 3000, aAppend: 1, segs: [{ utf8: "\n" }] },
      { tStartMs: 3500, segs: [{ utf8: "crowned" }] },
    ],
  });
  assert.deepEqual(entries, [
    { startMs: 1000, durationMs: 2000, text: "the king was" },
    { startMs: 3500, durationMs: 0, text: "crowned" },
  ]);
});

test("normalizeTranscriptPanel reads get_transcript segments", () => {
  const response = {
    actions: [{ updateEngagementPanelAction: { content: { transcriptRenderer: { content: { body: {
      initialSegments: [
        { transcriptSectionHeaderRenderer: { startMs: "0" } },
        { transcriptSegmentRenderer: { startMs: "4000", endMs: "6000", snippet: { runs: [{ text: "later" }] } } },
        { transcriptSegmentRenderer: { startMs: "0", endMs: "4000", snippet: { runs: [{ text: "first " }, { text: "line" }] } } },
      ],
    } } } } } }],
  };
  assert.deepEqual(yt.normalizeTranscriptPanel(response), [
    { startMs: 0, durationMs: 4000, text: "first line" },
    { startMs: 4000, durationMs: 2000, text: "later" },
  ]);
  assert.equal(yt.getTranscriptPanelParams({ x: [{ getTranscriptEndpoint: { params: "P" } }] }), "P");
  assert.equal(yt.getTranscriptPanelParams({}), null);
});

test("extractSections uses creator chapters and ignores auto chapters", () => {
  const initialData = {
    playerOverlays: { decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: { markersMap: [
      { key: "AUTO_CHAPTERS", value: { chapters: [chapter("Auto", 0)] } },
      { key: "DESCRIPTION_CHAPTERS", value: { chapters: [chapter("Rise", 60000), chapter("Intro", 0)] } },
    ] } } } },
  };
  assert.deepEqual(yt.extractSections(initialData, { videoDetails: { lengthSeconds: "120" } }), [
    { title: "Intro", startMs: 0, endMs: 60000, origin: "creator" },
    { title: "Rise", startMs: 60000, endMs: 120000, origin: "creator" },
  ]);
});

test("extractSections falls back to the chapters engagement panel", () => {
  const initialData = { engagementPanels: [{ engagementPanelSectionListRenderer: {
    panelIdentifier: "engagement-panel-macro-markers-description-chapters",
    content: { items: [
      { macroMarkersListItemRenderer: { title: { simpleText: "Start" }, timeDescription: { simpleText: "0:00" } } },
      { macroMarkersListItemRenderer: { title: { simpleText: "Fall" }, timeDescription: { simpleText: "1:02:03" } } },
    ] },
  } }] };
  assert.deepEqual(yt.extractSections(initialData, {}), [
    { title: "Start", startMs: 0, endMs: 3723000, origin: "creator" },
    { title: "Fall", startMs: 3723000, endMs: null, origin: "creator" },
  ]);
});

test("extractSections is empty when the Video has no chapters", () => {
  assert.deepEqual(yt.extractSections({ contents: {} }, { videoDetails: { lengthSeconds: "60" } }), []);
  assert.deepEqual(yt.extractSections(null, null), []);
});
