// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const settings = require("../src/settings.js");
const costEstimate = require("../src/cost-estimate.js");
const anthropic = require("../src/anthropic.js");
const draft = require("../src/draft.js");
const { availability, plan, createPrepare } = require("../src/prepare.js");

// ---------------------------------------------------------------------------
// Fixtures

function material({ lines = 3, sections = [], kind = "manual" } = {}) {
  const entries = Array.from({ length: lines }, (_, i) => ({
    startMs: i * 4000,
    durationMs: 4000,
    text: `Line ${i} about the king and his son at Winchester.`,
  }));
  return {
    status: "ready",
    videoId: "abcdefghijk",
    title: "The Kings",
    durationMs: 600000,
    transcript: { languageCode: "en", kind, entries },
    sections,
  };
}

// Enough Transcript to push the estimate over $0.50.
const bigMaterial = () => material({ lines: 6000 });

const draftJson = (overrides = {}) =>
  JSON.stringify({
    proposedSections: [{ title: "Later", startSeconds: 120 }, { title: "Start", startSeconds: 0 }],
    entities: [
      { id: "p-a", kind: "person", name: "Alfred", summary: "A king.", mentionSeconds: [30, 4, 4], place: null, date: null },
      { id: "p-e", kind: "Person", name: "Edward", summary: "His son.", mentionSeconds: [60], place: null, date: null },
      {
        id: "pl-w", kind: "place", name: "Winchester", summary: "A city.", mentionSeconds: [8],
        place: { placement: "Located", latitude: 51.06, longitude: -1.31, approxRadiusKm: null, relativeTo: ["nope"] }, date: null,
      },
    ],
    relationships: [
      { fromId: "p-e", toId: "p-a", label: "son of" },
      { fromId: "p-e", toId: "pl-w", label: "not between People" },
    ],
    cues: [
      { kind: "gap", atSeconds: 8, entityIds: ["pl-w"], fromVideo: "Named only.", outsideKnowledge: "Capital of Wessex." },
      { kind: "callback", atSeconds: 9999, entityIds: ["p-a", "missing"], fromVideo: "The king from earlier.", outsideKnowledge: null },
    ],
    ...overrides,
  });

// A fake streaming Response body made of SSE text chunks.
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: encoder.encode(chunks[i++]) } : { done: true }),
      }),
    },
  };
}

const sse = (type, payload) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;

function messageStream(text, { stopReason = "end_turn", splitAt = 7 } = {}) {
  const parts = [];
  for (let i = 0; i < text.length; i += 40) parts.push(text.slice(i, i + 40));
  const events =
    sse("message_start", { message: { model: "claude-opus-5-5", usage: { input_tokens: 1200, output_tokens: 1 } } }) +
    sse("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }) +
    sse("content_block_stop", { index: 0 }) +
    "event: ping\ndata: {\"type\": \"ping\"}\n\n" +
    sse("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
    parts.map((t) => sse("content_block_delta", { index: 1, delta: { type: "text_delta", text: t } })).join("") +
    sse("content_block_stop", { index: 1 }) +
    sse("message_delta", { delta: { stop_reason: stopReason, stop_details: null }, usage: { output_tokens: 900 } }) +
    sse("message_stop", {});
  // Split at awkward boundaries to exercise the incremental parser.
  const chunks = [];
  for (let i = 0; i < events.length; i += splitAt) chunks.push(events.slice(i, i + splitAt));
  return chunks;
}

function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => Object.assign(data, items),
    remove: async (key) => delete data[key],
  };
}

// ---------------------------------------------------------------------------
// Settings

test("normalizeApiKey trims and rejects things that aren't Anthropic keys", () => {
  assert.deepEqual(settings.normalizeApiKey("  sk-ant-api03-abc_DEF-123  "), { ok: true, key: "sk-ant-api03-abc_DEF-123" });
  assert.equal(settings.normalizeApiKey("").ok, false);
  assert.equal(settings.normalizeApiKey("sk-proj-123").ok, false);
  assert.equal(settings.normalizeApiKey("sk-ant-api03 with space").ok, false);
});

test("maskApiKey never reveals the middle of the key", () => {
  const key = "sk-ant-api03-SECRETSECRETSECRET-WXYZ";
  const masked = settings.maskApiKey(key);
  assert.equal(masked, "sk-ant-…WXYZ");
  assert.ok(!masked.includes("SECRET"));
  assert.equal(settings.maskApiKey("sk-ant-short"), "••••••••");
  assert.equal(settings.maskApiKey(null), "");
});

test("save, load, and clear the API key in extension storage", async () => {
  const area = memoryStorage();
  assert.equal(await settings.loadApiKey(area), null);
  assert.equal((await settings.saveApiKey(area, "nope")).ok, false);
  assert.equal(await settings.loadApiKey(area), null);
  await settings.saveApiKey(area, " sk-ant-api03-abc ");
  assert.equal(await settings.loadApiKey(area), "sk-ant-api03-abc");
  await settings.clearApiKey(area);
  assert.equal(await settings.loadApiKey(area), null);
});

// ---------------------------------------------------------------------------
// Cost estimate

test("estimateCost prices input and output tokens and confirms only above $0.50", () => {
  const e = costEstimate.estimateCost({ inputChars: 30000, model: "claude-opus-5-5", maxOutputTokens: 64000 });
  assert.equal(e.inputTokens, 11000);
  assert.equal(e.outputTokens, 9500);
  assert.equal(e.usd, (11000 * 4 + 9500 * 20) / 1e6);
  assert.equal(e.needsConfirmation, false);

  const capped = costEstimate.estimateCost({ inputChars: 3e6, model: "claude-opus-5-5", maxOutputTokens: 64000 });
  assert.equal(capped.outputTokens, 64000);
  assert.equal(capped.needsConfirmation, true);
  assert.throws(() => costEstimate.estimateCost({ inputChars: 1, model: "unknown", maxOutputTokens: 1 }));
});

test("exactly $0.50 does not need confirmation", () => {
  // Find an input size whose estimate lands exactly on the threshold.
  const model = "claude-opus-5-5";
  const at = (chars) => costEstimate.estimateCost({ inputChars: chars, model, maxOutputTokens: 64000 });
  // usd = (in*4 + (4000 + in/2)*20)/1e6 = (14*in + 80000)/1e6 = 0.5  =>  in = 30000 tokens
  const chars = (30000 - 1000) * 3;
  assert.equal(at(chars).usd, 0.5);
  assert.equal(at(chars).needsConfirmation, false);
  assert.equal(at(chars + 3).needsConfirmation, true);
  assert.equal(costEstimate.formatUsd(0.004), "under $0.01");
  assert.equal(costEstimate.formatUsd(0.456), "$0.46");
});

// ---------------------------------------------------------------------------
// Request construction

test("buildRequest sends the current model, version, browser header, and schema", () => {
  const signal = new AbortController().signal;
  const [url, init] = anthropic.buildRequest({ apiKey: "sk-ant-x", system: "S", userContent: "U", schema: { type: "object" }, signal });
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.signal, signal);
  assert.deepEqual(init.headers, {
    "content-type": "application/json",
    "x-api-key": "sk-ant-x",
    "anthropic-version": "2026-10-21",
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-beta": "server-side-fallback-2026-07-01",
  });
  const body = JSON.parse(init.body);
  assert.deepEqual(body, {
    model: "claude-opus-5-5",
    max_tokens: 64000,
    stream: true,
    system: "S",
    messages: [{ role: "user", content: "U" }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: { type: "object" } } },
    fallbacks: "default",
  });
  for (const removed of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(removed in body));
  assert.throws(() => anthropic.buildRequest({ apiKey: "", system: "", userContent: "", schema: {} }));
});

test("every model the request can use has pricing", () => {
  assert.ok(costEstimate.PRICING_USD_PER_MTOK[anthropic.API.model]);
});

test("the Draft schema stays within structured-output limits", () => {
  let unions = 0;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.type) || node.anyOf) unions++;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    Object.values(node).forEach(walk);
  };
  walk(draft.DRAFT_SCHEMA);
  assert.ok(unions <= 16, `${unions} union-typed parameters`);
});

test("buildPrompt includes the whole Transcript and says whether Sections exist", () => {
  const m = material({ lines: 500, kind: "auto-generated" });
  const p = draft.buildPrompt(m);
  assert.equal(p.userContent.match(/^\[\d/gm).length, 500);
  assert.match(p.userContent, /\[1996\] Line 499/);
  assert.match(p.userContent, /no creator Sections; propose them/);
  assert.match(p.userContent, /auto-generated/);
  assert.ok(p.inputChars > p.userContent.length);

  const withSections = draft.buildPrompt(material({ sections: [{ title: "Intro", startMs: 0, endMs: 5000, origin: "creator" }] }));
  assert.match(withSections.userContent, /Creator Sections \(do not propose Sections\):\n- \[0\] Intro/);
});

// ---------------------------------------------------------------------------
// Errors

test("API errors map to auth, rate-limit, and other kinds", async () => {
  const response = (status, body, retryAfter = null) => ({
    status,
    headers: { get: (name) => (name === "retry-after" ? retryAfter : null) },
    text: async () => body,
  });
  const auth = await anthropic.errorFromResponse(response(401, JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })));
  assert.equal(auth.kind, "auth");
  assert.match(auth.message, /options/);
  assert.ok(!auth.message.includes("sk-ant"));

  const limited = await anthropic.errorFromResponse(response(429, JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }), "12"));
  assert.equal(limited.kind, "rate-limit");
  assert.equal(limited.details.retryAfterSeconds, 12);
  assert.match(limited.message, /12 s/);

  assert.equal((await anthropic.errorFromResponse(response(529, "not json"))).kind, "overloaded");
  assert.equal((await anthropic.errorFromResponse(response(404, "{}"))).kind, "not-found");
  assert.equal((await anthropic.errorFromResponse(response(500, ""))).kind, "server");
  const bad = await anthropic.errorFromResponse(response(400, JSON.stringify({ error: { type: "invalid_request_error", message: "spend limit" } })));
  assert.equal(bad.kind, "bad-request");
  assert.match(bad.message, /spend limit/);
});

// ---------------------------------------------------------------------------
// Streaming

test("readMessageStream joins text deltas across arbitrary chunk boundaries", async () => {
  const text = draftJson();
  const progress = [];
  const message = await anthropic.readMessageStream(sseResponse(messageStream(text)), { onProgress: (acc) => progress.push(acc.outputTokens) });
  assert.equal(message.text, text);
  assert.equal(message.model, "claude-opus-5-5");
  assert.equal(message.inputTokens, 1200);
  assert.equal(message.outputTokens, 900);
  assert.equal(message.stopReason, "end_turn");
  assert.ok(progress.length > 1);
});

test("readMessageStream reports refusals, truncation, stream errors, and early ends", async () => {
  await assert.rejects(anthropic.readMessageStream(sseResponse(messageStream("{}", { stopReason: "refusal" }))), { kind: "refusal" });
  await assert.rejects(anthropic.readMessageStream(sseResponse(messageStream("{\"a\"", { stopReason: "max_tokens" }))), { kind: "truncated" });
  await assert.rejects(
    anthropic.readMessageStream(sseResponse([sse("error", { error: { type: "overloaded_error", message: "Overloaded" } })])),
    { kind: "overloaded" }
  );
  const cut = messageStream("{}").join("").split("event: message_delta")[0];
  await assert.rejects(anthropic.readMessageStream(sseResponse([cut])), { kind: "network" });
});

test("createSseParser handles CRLF, comments, and multi-line data", () => {
  const events = [];
  const parser = anthropic.createSseParser((e) => events.push(e));
  parser.push(": comment\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: x");
  parser.end();
  assert.deepEqual(events, [{ event: "a", data: "one\ntwo" }, { event: "message", data: "x" }]);
});

// ---------------------------------------------------------------------------
// Draft parsing

test("parseDraft builds a Draft and preserves the source Transcript and Sections", () => {
  const m = material();
  const d = draft.parseDraft(draftJson(), m, { createdAt: "2026-11-02T00:00:00.000Z", model: "claude-opus-5-5", inputTokens: 10, outputTokens: 20 });
  assert.equal(d.type, "draft");
  assert.equal(d.videoId, "abcdefghijk");
  assert.equal(d.source.transcript, m.transcript);
  assert.equal(d.source.sections, m.sections);
  assert.equal(d.source.durationMs, 600000);
  assert.deepEqual(d.usage, { inputTokens: 10, outputTokens: 20 });

  // AI-proposed Sections, sorted and labelled as such, since there are no creator Sections.
  assert.deepEqual(d.sections, [
    { title: "Start", startMs: 0, endMs: 120000, origin: "ai" },
    { title: "Later", startMs: 120000, endMs: 600000, origin: "ai" },
  ]);

  const alfred = d.entities.find((e) => e.id === "p-a");
  assert.deepEqual(alfred.mentionsMs, [4000, 30000]);
  assert.equal(alfred.firstMentionMs, 4000);
  assert.equal(d.entities.find((e) => e.id === "p-e").kind, "person"); // enum casing normalized
  const winchester = d.entities.find((e) => e.id === "pl-w");
  assert.deepEqual(winchester.place, { placement: "located", latitude: 51.06, longitude: -1.31, approxRadiusKm: null, relativeToIds: [] });

  assert.deepEqual(d.relationships, [{ fromId: "p-e", toId: "p-a", label: "son of" }]);
  assert.deepEqual(d.cues, [
    { id: "cue-1", kind: "gap", atMs: 8000, entityIds: ["pl-w"], fromVideo: "Named only.", outsideKnowledge: "Capital of Wessex." },
    { id: "cue-2", kind: "callback", atMs: 600000, entityIds: ["p-a"], fromVideo: "The king from earlier.", outsideKnowledge: null },
  ]);
});

test("parseDraft keeps creator Sections and ignores proposed ones", () => {
  const creator = [{ title: "Intro", startMs: 0, endMs: 600000, origin: "creator" }];
  const d = draft.parseDraft(draftJson(), material({ sections: creator }));
  assert.deepEqual(d.sections, creator);
});

test("parseDraft rejects text that isn't a Draft", () => {
  const m = material();
  assert.throws(() => draft.parseDraft("not json", m), draft.DraftParseError);
  assert.throws(() => draft.parseDraft("[]", m), draft.DraftParseError);
  assert.throws(() => draft.parseDraft(draftJson({ cues: "none" }), m), /cues should be an array/);
  assert.throws(
    () => draft.parseDraft(draftJson({ cues: [{ kind: "highlight", atSeconds: 1, entityIds: [], fromVideo: "", outsideKnowledge: null }] }), m),
    /cues\[0\]\.kind/
  );
});

// ---------------------------------------------------------------------------
// Prepare flow

test("availability explains why Prepare is disabled", () => {
  assert.equal(availability(material()).enabled, true);
  assert.deepEqual(availability({ status: "loading" }), { enabled: false, reason: "Waiting for the Transcript…" });
  const unsupported = availability({ status: "unsupported", message: "This Video has no Transcript, so Cues can't be prepared for it." });
  assert.equal(unsupported.enabled, false);
  assert.match(unsupported.reason, /no Transcript/);
  assert.equal(availability(null).enabled, false);
});

test("no API call without a Transcript", async () => {
  const fetchImpl = fakeFetch(() => assert.fail("fetch called"));
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  await prepare.start({ status: "unsupported", videoId: "abcdefghijk", reason: "no-transcript", message: "No Transcript." });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(prepare.state.phase, "error");
  assert.equal(prepare.state.error.kind, "unavailable");
});

test("no API call without an API key, and the message says how to add one", async () => {
  const fetchImpl = fakeFetch(() => assert.fail("fetch called"));
  const prepare = createPrepare({ getApiKey: async () => null, fetchImpl });
  await prepare.start(material());
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(prepare.state.phase, "needs-key");
  assert.match(prepare.state.message, /options/i);
});

test("no API call when a cost above $0.50 is declined", async () => {
  const fetchImpl = fakeFetch(() => assert.fail("fetch called"));
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  const big = bigMaterial();
  assert.equal(plan(big).estimate.needsConfirmation, true);
  await prepare.start(big);
  assert.equal(prepare.state.phase, "confirm");
  assert.ok(prepare.state.estimate.usd > 0.5);
  prepare.cancel();
  assert.equal(prepare.state.phase, "cancelled");
  await prepare.confirm(); // too late; nothing pending
  assert.equal(fetchImpl.calls.length, 0);
});

test("a cost above $0.50 runs once confirmed", async () => {
  const fetchImpl = fakeFetch(() => sseResponse(messageStream(draftJson())));
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  await prepare.start(bigMaterial());
  assert.equal(fetchImpl.calls.length, 0);
  await prepare.confirm();
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(prepare.state.phase, "done");
});

test("a cost at or below $0.50 runs straight away and produces a Draft", async () => {
  const phases = [];
  const fetchImpl = fakeFetch(() => sseResponse(messageStream(draftJson())));
  const prepare = createPrepare({
    getApiKey: async () => "sk-ant-x",
    fetchImpl,
    onChange: (s) => phases.push(s.phase),
    now: () => new Date("2026-11-02T00:00:00Z"),
  });
  const m = material();
  assert.equal(plan(m).estimate.needsConfirmation, false);
  await prepare.start(m);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], "sk-ant-x");
  assert.equal(prepare.state.phase, "done");
  assert.equal(prepare.state.draft.cues.length, 2);
  assert.equal(prepare.state.draft.createdAt, "2026-11-02T00:00:00.000Z");
  assert.equal(prepare.state.draft.model, "claude-opus-5-5");
  assert.equal(phases[0], "generating");
  assert.equal(phases.at(-1), "done");
});

test("auth and rate-limit failures end in an error state", async () => {
  for (const [status, kind] of [[401, "auth"], [429, "rate-limit"]]) {
    const fetchImpl = fakeFetch(() => ({ ok: false, status, headers: { get: () => null }, text: async () => "{}" }));
    const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
    await prepare.start(material());
    assert.equal(prepare.state.phase, "error");
    assert.equal(prepare.state.error.kind, kind);
  }
});

test("network failures and unreadable answers end in an error state", async () => {
  const offline = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  await offline.start(material());
  assert.equal(offline.state.error.kind, "network");

  const garbled = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl: async () => sseResponse(messageStream("{\"nope\": 1}")) });
  await garbled.start(material());
  assert.equal(garbled.state.error.kind, "invalid-response");
});

test("cancel during generation aborts the request", async () => {
  let signal;
  const fetchImpl = fakeFetch((url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  });
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  const running = prepare.start(material());
  await new Promise((r) => setImmediate(r));
  assert.equal(prepare.state.phase, "generating");
  prepare.cancel();
  await running;
  assert.equal(signal.aborted, true);
  assert.equal(prepare.state.phase, "cancelled");
});

test("reset while the key is being read prevents a later API call", async () => {
  let releaseKey;
  const fetchImpl = fakeFetch(() => assert.fail("fetch called"));
  const prepare = createPrepare({ getApiKey: () => new Promise((r) => (releaseKey = r)), fetchImpl });
  const starting = prepare.start(material());
  prepare.reset();
  releaseKey("sk-ant-x");
  await starting;
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(prepare.state.phase, "idle");
});

// ---------------------------------------------------------------------------
// Import wins over a Prepare that hasn't finished

test("supersede during generation stops it, and a response arriving later never becomes a Draft", async () => {
  let respond;
  let signal;
  const fetchImpl = fakeFetch((url, init) => {
    signal = init.signal;
    return new Promise((resolve) => (respond = resolve)); // ignores abort, like a response already on its way
  });
  const phases = [];
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl, onChange: (s) => phases.push(s.phase) });
  const running = prepare.start(material());
  await new Promise((r) => setImmediate(r));
  assert.equal(prepare.state.phase, "generating");
  prepare.supersede(); // Notes were imported
  assert.equal(signal.aborted, true);
  assert.equal(prepare.state.phase, "cancelled");
  assert.match(prepare.state.message, /imported/);
  respond(sseResponse(messageStream(draftJson())));
  await running;
  assert.equal(prepare.state.phase, "cancelled");
  assert.equal(prepare.state.draft, undefined);
  assert.ok(!phases.includes("done"), "no Draft was ever produced to merge");
});

test("supersede while a cost awaits confirmation, or while the key is read, sends nothing", async () => {
  const fetchImpl = fakeFetch(() => assert.fail("fetch called"));
  const confirming = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  await confirming.start(bigMaterial());
  assert.equal(confirming.state.phase, "confirm");
  confirming.supersede();
  assert.equal(confirming.state.phase, "cancelled");
  assert.match(confirming.state.message, /Nothing was sent/);
  await confirming.confirm();

  let releaseKey;
  const starting = createPrepare({ getApiKey: () => new Promise((r) => (releaseKey = r)), fetchImpl });
  const pending = starting.start(material());
  starting.supersede();
  releaseKey("sk-ant-x");
  await pending;
  assert.equal(fetchImpl.calls.length, 0);
});

test("supersede leaves a finished Draft alone and a later Prepare still works", async () => {
  const fetchImpl = fakeFetch(() => sseResponse(messageStream(draftJson())));
  const prepare = createPrepare({ getApiKey: async () => "sk-ant-x", fetchImpl });
  await prepare.start(material());
  const { draft: finished } = prepare.state;
  prepare.supersede();
  assert.equal(prepare.state.phase, "done");
  assert.equal(prepare.state.draft, finished, "the panel marks it handled; nothing new is produced");
  await prepare.start(material());
  assert.equal(prepare.state.phase, "done");
  assert.notEqual(prepare.state.draft, finished);
});

test("the API request sends no cookies or Referer and refuses redirects", () => {
  const [, init] = anthropic.buildRequest({ apiKey: "sk-ant-x", system: "S", userContent: "U", schema: {} });
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(init.redirect, "error");
  assert.equal(init.cache, "no-store");
  assert.equal(anthropic.API.url, "https://api.anthropic.com/v1/messages");
});
