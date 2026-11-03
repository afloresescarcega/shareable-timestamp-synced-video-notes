// What Prepare asks Claude for, and how the answer becomes a Draft.
// Pure; loads under Node for tests.
//
// Draft (Notes as produced by the AI, before any user edits):
//   { type: "draft", version: 1, videoId, title, createdAt, model,
//     source:        { durationMs, transcript, sections }   (exactly as read; Sections from creator chapters)
//     sections:      [{ title, startMs, endMs, origin: "creator" | "ai" }]
//     entities:      [{ id, kind: "person" | "place" | "event", name, summary,
//                       firstMentionMs, mentionsMs: [ms],
//                       place: null | { placement: "located" | "uncertain" | "unmappable",
//                                       latitude, longitude, approxRadiusKm, relativeToIds },
//                       date: string | null }]
//     relationships: [{ fromId, toId, label }]                (between People)
//     cues:          [{ id, kind: "callback" | "gap", atMs, entityIds, fromVideo, outsideKnowledge }]
//     usage:         { inputTokens, outputTokens } }
(() => {
  "use strict";

  const DRAFT_VERSION = 1;

  const SYSTEM_PROMPT = `You prepare Notes for one YouTube Video: a companion for dense, talking-head narration (for example complex history) that shows context exactly when the viewer needs it.

Read the whole Transcript, then return:

- entities: every Person, Place, and Event the narration relies on. Give each a short stable id (e.g. "p-alfred"), its name, a one-sentence summary drawn only from the Video, and mentionSeconds: every Mention, i.e. each timestamp where it is referred to by name or indirectly ("the king"). The first is its First mention.
  - For a Place, set place.placement: "located" (position known; give latitude/longitude), "uncertain" (real but disputed or lost; give an approximate centre and approxRadiusKm), or "unmappable" (legendary, or known only relative to other Places; latitude/longitude null and relativeTo lists those Places' ids). For People and Events, place is null.
  - For an Event, date is its date or date range as text; otherwise null.
- relationships: named links between two People ("son of", "betrayed"), using entity ids.
- cues: the moments where following the narration depends on context the viewer doesn't currently have. A plainly stated fact is not a Cue. Each Cue is either a "callback" (the narration refers back to an Entity from earlier in this Video, e.g. "the son of the king we discussed") or a "gap" (the narration assumes context the Video never provides, e.g. a city named but never located). atSeconds is when the viewer needs it; entityIds are the Entities involved; fromVideo is the context the Video itself provides, in one or two sentences.
  - outsideKnowledge: anything the Cue needs that does not come from the Video itself, kept separate because it is less trustworthy; null when the Video provides everything. Never put outside knowledge in fromVideo or summary.
- proposedSections: only if the request says the Video has no creator Sections, propose contiguous Sections (title and startSeconds) covering the whole Video; otherwise an empty array.

All times are seconds from the start of the Video, taken from the Transcript's [seconds] timestamps.`;

  const nullable = (type) => ({ type: [type, "null"] });
  const object = (properties) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  const arrayOf = (items) => ({ type: "array", items });

  // JSON schema for output_config.format. Kept within the structured-output
  // limits: every property required, few nullable unions.
  const DRAFT_SCHEMA = object({
    proposedSections: arrayOf(object({ title: { type: "string" }, startSeconds: { type: "number" } })),
    entities: arrayOf(
      object({
        id: { type: "string" },
        kind: { type: "string", enum: ["person", "place", "event"] },
        name: { type: "string" },
        summary: { type: "string" },
        mentionSeconds: arrayOf({ type: "number" }),
        place: {
          anyOf: [
            { type: "null" },
            object({
              placement: { type: "string", enum: ["located", "uncertain", "unmappable"] },
              latitude: nullable("number"),
              longitude: nullable("number"),
              approxRadiusKm: nullable("number"),
              relativeTo: arrayOf({ type: "string" }),
            }),
          ],
        },
        date: nullable("string"),
      })
    ),
    relationships: arrayOf(object({ fromId: { type: "string" }, toId: { type: "string" }, label: { type: "string" } })),
    cues: arrayOf(
      object({
        kind: { type: "string", enum: ["callback", "gap"] },
        atSeconds: { type: "number" },
        entityIds: arrayOf({ type: "string" }),
        fromVideo: { type: "string" },
        outsideKnowledge: nullable("string"),
      })
    ),
  });

  const formatSeconds = (ms) => (Math.round(ms / 100) / 10).toString();

  // The whole Transcript, one timed line per entry. Never truncated.
  function formatTranscript(transcript) {
    return transcript.entries.map((e) => `[${formatSeconds(e.startMs)}] ${e.text}`).join("\n");
  }

  function buildUserContent(material) {
    const lines = [`Video title: ${material.title ?? "(unknown)"}`];
    if (material.durationMs) lines.push(`Video length: ${formatSeconds(material.durationMs)} seconds`);
    if (material.transcript.kind === "auto-generated") {
      lines.push("The Transcript is auto-generated, so names may be misspelled; use the correct spelling.");
    }
    if (material.sections.length) {
      lines.push("Creator Sections (do not propose Sections):");
      for (const s of material.sections) lines.push(`- [${formatSeconds(s.startMs)}] ${s.title}`);
    } else {
      lines.push("The Video has no creator Sections; propose them.");
    }
    lines.push("", "<transcript>", formatTranscript(material.transcript), "</transcript>");
    return lines.join("\n");
  }

  // Everything Prepare will send for this source material.
  function buildPrompt(material) {
    const userContent = buildUserContent(material);
    const schemaText = JSON.stringify(DRAFT_SCHEMA);
    return {
      system: SYSTEM_PROMPT,
      userContent,
      schema: DRAFT_SCHEMA,
      inputChars: SYSTEM_PROMPT.length + userContent.length + schemaText.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Parsing

  class DraftParseError extends Error {
    constructor(message) {
      super(message);
      this.name = "DraftParseError";
    }
  }

  const fail = (path, expected) => {
    throw new DraftParseError(`Draft response: ${path} should be ${expected}`);
  };
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const str = (v, path) => (typeof v === "string" ? v.trim() : fail(path, "a string"));
  const num = (v, path) => (typeof v === "number" && Number.isFinite(v) ? v : fail(path, "a number"));
  const numOrNull = (v, path) => (v === null ? null : num(v, path));
  const strOrNull = (v, path) => (v === null ? null : str(v, path) || null);
  const arr = (v, path) => (Array.isArray(v) ? v : fail(path, "an array"));
  // Enum values may come back with different capitalization.
  const oneOf = (v, allowed, path) => {
    const value = str(v, path).toLowerCase();
    return allowed.includes(value) ? value : fail(path, `one of ${allowed.join(", ")}`);
  };

  // Converts seconds from the model to ms within the Video.
  function toMs(seconds, durationMs) {
    const ms = Math.max(0, Math.round(seconds * 1000));
    return durationMs ? Math.min(ms, durationMs) : ms;
  }

  function parseEntity(raw, path, durationMs) {
    if (!isObj(raw)) fail(path, "an object");
    const kind = oneOf(raw.kind, ["person", "place", "event"], `${path}.kind`);
    const mentionsMs = [...new Set(arr(raw.mentionSeconds, `${path}.mentionSeconds`)
      .map((s, i) => toMs(num(s, `${path}.mentionSeconds[${i}]`), durationMs)))].sort((a, b) => a - b);
    let place = null;
    if (raw.place !== null) {
      if (!isObj(raw.place)) fail(`${path}.place`, "an object or null");
      const p = raw.place;
      place = {
        placement: oneOf(p.placement, ["located", "uncertain", "unmappable"], `${path}.place.placement`),
        latitude: numOrNull(p.latitude, `${path}.place.latitude`),
        longitude: numOrNull(p.longitude, `${path}.place.longitude`),
        approxRadiusKm: numOrNull(p.approxRadiusKm, `${path}.place.approxRadiusKm`),
        relativeToIds: arr(p.relativeTo, `${path}.place.relativeTo`).map((id, i) => str(id, `${path}.place.relativeTo[${i}]`)),
      };
      const validPosition =
        place.latitude !== null && place.longitude !== null &&
        Math.abs(place.latitude) <= 90 && Math.abs(place.longitude) <= 180;
      if (!validPosition) {
        place.latitude = null;
        place.longitude = null;
      }
    }
    return {
      id: str(raw.id, `${path}.id`),
      kind,
      name: str(raw.name, `${path}.name`),
      summary: str(raw.summary, `${path}.summary`),
      firstMentionMs: mentionsMs[0] ?? null,
      mentionsMs,
      place: kind === "place" ? place : null,
      date: strOrNull(raw.date, `${path}.date`),
    };
  }

  function aiSections(proposed, durationMs) {
    const starts = proposed
      .filter((s) => s.title)
      .sort((a, b) => a.startMs - b.startMs)
      .filter((s, i, all) => i === 0 || s.startMs !== all[i - 1].startMs);
    return starts.map((s, i) => ({
      title: s.title,
      startMs: s.startMs,
      endMs: starts[i + 1]?.startMs ?? durationMs ?? null,
      origin: "ai",
    }));
  }

  // Parses Claude's JSON text into a Draft. Throws DraftParseError when the
  // text isn't JSON in the requested shape; quietly drops references to
  // unknown Entities and clamps times into the Video.
  function parseDraft(text, material, meta = {}) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new DraftParseError("Draft response wasn't valid JSON");
    }
    if (!isObj(raw)) fail("the response", "an object");
    const durationMs = material.durationMs ?? null;

    const entities = [];
    const ids = new Set();
    arr(raw.entities, "entities").forEach((e, i) => {
      const entity = parseEntity(e, `entities[${i}]`, durationMs);
      if (!entity.id || ids.has(entity.id)) return;
      ids.add(entity.id);
      entities.push(entity);
    });
    for (const entity of entities) {
      if (entity.place) entity.place.relativeToIds = entity.place.relativeToIds.filter((id) => ids.has(id) && id !== entity.id);
    }
    const kindOf = new Map(entities.map((e) => [e.id, e.kind]));

    const relationships = arr(raw.relationships, "relationships")
      .map((r, i) => {
        if (!isObj(r)) fail(`relationships[${i}]`, "an object");
        return {
          fromId: str(r.fromId, `relationships[${i}].fromId`),
          toId: str(r.toId, `relationships[${i}].toId`),
          label: str(r.label, `relationships[${i}].label`),
        };
      })
      .filter((r) => r.fromId !== r.toId && kindOf.get(r.fromId) === "person" && kindOf.get(r.toId) === "person");

    const cues = arr(raw.cues, "cues")
      .map((c, i) => {
        const path = `cues[${i}]`;
        if (!isObj(c)) fail(path, "an object");
        return {
          kind: oneOf(c.kind, ["callback", "gap"], `${path}.kind`),
          atMs: toMs(num(c.atSeconds, `${path}.atSeconds`), durationMs),
          entityIds: [...new Set(arr(c.entityIds, `${path}.entityIds`).map((id, j) => str(id, `${path}.entityIds[${j}]`)))]
            .filter((id) => ids.has(id)),
          fromVideo: str(c.fromVideo, `${path}.fromVideo`),
          outsideKnowledge: strOrNull(c.outsideKnowledge, `${path}.outsideKnowledge`),
        };
      })
      .sort((a, b) => a.atMs - b.atMs)
      .map((cue, i) => ({ id: `cue-${i + 1}`, ...cue }));

    const proposed = arr(raw.proposedSections, "proposedSections").map((s, i) => {
      if (!isObj(s)) fail(`proposedSections[${i}]`, "an object");
      return {
        title: str(s.title, `proposedSections[${i}].title`),
        startMs: toMs(num(s.startSeconds, `proposedSections[${i}].startSeconds`), durationMs),
      };
    });
    const sections = material.sections.length
      ? material.sections.map((s) => ({ ...s }))
      : aiSections(proposed, durationMs);

    return {
      type: "draft",
      version: DRAFT_VERSION,
      videoId: material.videoId,
      title: material.title ?? null,
      createdAt: meta.createdAt ?? new Date().toISOString(),
      model: meta.model ?? null,
      source: {
        durationMs,
        transcript: material.transcript,
        sections: material.sections,
      },
      sections,
      entities,
      relationships,
      cues,
      usage: { inputTokens: meta.inputTokens ?? null, outputTokens: meta.outputTokens ?? null },
    };
  }

  const api = {
    DRAFT_VERSION,
    SYSTEM_PROMPT,
    DRAFT_SCHEMA,
    DraftParseError,
    formatTranscript,
    buildUserContent,
    buildPrompt,
    parseDraft,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueDraft ??= Object.freeze(api);
})();
