// Notes: the full set of generated-and-edited material for one Video, built
// from a Draft plus the user's edits. Pure; loads under Node for tests. Saving
// lives in src/notes-store.js, export/import in src/notes-file.js.
//
//   let notes = CueNotes.fromDraft(draft);
//   notes = CueNotes.updateCue(notes, cueId, { atMs, kind, entityIds, fromVideo, outsideKnowledge });
//   notes = CueNotes.addCue(notes, { atMs, ... });          a user Cue
//   notes = CueNotes.deleteCue(notes, cueId);
//   notes = CueNotes.mergeEntities(notes, keepId, mergeId);
//   notes = CueNotes.splitEntity(notes, entityId, { name, mentionsMs });
//   notes = CueNotes.mergeDraft(notes, regeneratedDraft);   user edits always win
//   values = CueNotes.followMerge(values, keepId, mergeId);  unsaved Cue editor values
//   values = CueNotes.followSplit(notesAfterSplit, values, entityId, cueAtMs)
//   CueNotes.checkNotes(value) -> { ok: true, notes } | { ok: false, message }
//                                 for Notes read back from storage or a file
//
// Every operation returns new Notes and leaves its input untouched. Invalid
// edits throw NotesEditError with a message fit to show the user.
//
// Notes:
//   { type: "notes", version: 1, videoId, title,
//     draft,            the latest Draft (source material, usage)
//     sections, relationships,
//     entities: [{ ...Draft Entity fields,
//                  origin: "draft" | "user",   where it came from
//                  edited: boolean,            changed by the user (merge or split)
//                  draftIds: [id],             Draft Entity ids it stands for (more than one after a merge)
//                  splitFromId: id | null }]   the Entity it was split from (user Entities only)
//     cues: [{ id, kind, atMs, entityIds, fromVideo, outsideKnowledge,
//              origin: "draft" | "user",
//              edited: boolean,                changed by the user
//              fromDraft: { kind, atMs, entityIds } | null }]   as the Draft had it, for matching on regeneration
//     deletedDraftCues: [{ kind, atMs, entityIds }]   Draft Cues the user deleted; never come back
//     nextCueNumber, nextEntityNumber }
//
// Regeneration (mergeDraft) is deterministic:
//   - User Cues and edited Cues are kept exactly as they are.
//   - A regenerated Cue is dropped when it matches a deleted Draft Cue or the
//     Draft version of an edited Cue (within MATCH_WINDOW_MS, sharing an Entity,
//     or both with no Entities). Each such Cue absorbs at most one regenerated
//     Cue, and together they absorb as many as they can: when several compete
//     for the same regenerated Cue, one nearest choice can't leave another
//     with nothing and let its deleted or edited Cue come back. Within that,
//     anchors are taken in time order and each prefers the nearest Cue
//     (earliest on ties), so the result never depends on the order of edits.
//   - User and edited Entities are kept; a regenerated Entity whose Draft id
//     they stand for is folded into them rather than added again.
//   - Everything else is replaced by the new Draft.
(() => {
  "use strict";

  const NOTES_VERSION = 1;
  const MATCH_WINDOW_MS = 10000;
  const KINDS = ["callback", "gap"];

  class NotesEditError extends Error {
    constructor(message) {
      super(message);
      this.name = "NotesEditError";
    }
  }
  const reject = (message) => {
    throw new NotesEditError(message);
  };

  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const byTime = (a, b) => a.atMs - b.atMs; // Array#sort is stable: ties keep order
  const unique = (list) => [...new Set(list)];
  const sortedMs = (list) => unique(list.filter(isFiniteNumber)).sort((a, b) => a - b);

  const durationOf = (notes) => notes.draft?.source?.durationMs ?? null;

  // ---------------------------------------------------------------------------
  // Ids

  function nextCueId(notes) {
    const taken = new Set(notes.cues.map((c) => c.id));
    let n = notes.nextCueNumber;
    while (taken.has(`cue-${n}`)) n++;
    notes.nextCueNumber = n + 1;
    return `cue-${n}`;
  }

  function nextEntityId(notes) {
    const taken = new Set(notes.entities.map((e) => e.id));
    let n = notes.nextEntityNumber;
    while (taken.has(`entity-${n}`)) n++;
    notes.nextEntityNumber = n + 1;
    return `entity-${n}`;
  }

  // Shallow-enough copy for the immutable operations below.
  function copy(notes) {
    return {
      ...notes,
      entities: notes.entities.map((e) => ({ ...e, mentionsMs: [...e.mentionsMs], draftIds: [...e.draftIds] })),
      cues: notes.cues.map((c) => ({ ...c, entityIds: [...c.entityIds] })),
      relationships: notes.relationships.map((r) => ({ ...r })),
      deletedDraftCues: [...notes.deletedDraftCues],
    };
  }

  const findCue = (notes, id) => notes.cues.find((c) => c.id === id) ?? reject("That Cue no longer exists.");
  const findEntity = (notes, id) => notes.entities.find((e) => e.id === id) ?? reject("That Entity no longer exists.");
  const isKept = (item) => item.origin === "user" || item.edited;

  // ---------------------------------------------------------------------------
  // Splits: which of an Entity and those split from it a Mention at `atMs`
  // refers to. The one with the latest Mention at or before `atMs` wins; with
  // none, the original Entity.

  function assignAfterSplit(entities, id, atMs) {
    const seen = new Set();
    let current = id;
    while (!seen.has(current)) {
      seen.add(current);
      const candidates = entities.filter((e) => e.id === current || e.splitFromId === current);
      let best = current;
      let bestMs = -Infinity;
      for (const e of candidates) {
        const latest = e.mentionsMs.filter((ms) => ms <= atMs).pop();
        if (latest !== undefined && latest > bestMs) {
          best = e.id;
          bestMs = latest;
        }
      }
      if (best === current) break;
      current = best;
    }
    return current;
  }

  // ---------------------------------------------------------------------------
  // Cue fields

  // Validates user-entered Cue fields; missing fields fall back to `base`.
  function cueFields(notes, changes, base) {
    const has = (k) => Object.prototype.hasOwnProperty.call(changes, k);
    const kind = has("kind") ? changes.kind : base.kind;
    if (!KINDS.includes(kind)) reject("A Cue is either a Callback or a Gap.");
    const atMs = has("atMs") ? changes.atMs : base.atMs;
    if (!isFiniteNumber(atMs) || atMs < 0) reject("Enter a time in the Video, like 3:05.");
    const duration = durationOf(notes);
    if (duration && atMs > duration) reject("That time is past the end of the Video.");
    const known = new Set(notes.entities.map((e) => e.id));
    const entityIds = unique((has("entityIds") ? changes.entityIds : base.entityIds) ?? []).filter((id) => known.has(id));
    const fromVideo = text(has("fromVideo") ? changes.fromVideo : base.fromVideo);
    const outsideKnowledge = text(has("outsideKnowledge") ? changes.outsideKnowledge : base.outsideKnowledge) || null;
    if (!fromVideo && !outsideKnowledge && !entityIds.length) reject("A Cue needs some content: an Entity, what the Video says, or Outside knowledge.");
    return { kind, atMs: Math.round(atMs), entityIds, fromVideo, outsideKnowledge };
  }

  const sameCueFields = (a, b) =>
    a.kind === b.kind &&
    a.atMs === b.atMs &&
    a.fromVideo === b.fromVideo &&
    a.outsideKnowledge === b.outsideKnowledge &&
    a.entityIds.length === b.entityIds.length &&
    a.entityIds.every((id, i) => id === b.entityIds[i]);

  // ---------------------------------------------------------------------------
  // Cue edits

  function updateCue(notes, cueId, changes) {
    const original = findCue(notes, cueId);
    const fields = cueFields(notes, changes, original);
    if (sameCueFields(fields, original)) return notes;
    const next = copy(notes);
    next.cues = next.cues.map((c) => (c.id === cueId ? { ...c, ...fields, edited: true } : c)).sort(byTime);
    return next;
  }

  function addCue(notes, changes) {
    const base = { kind: "gap", atMs: null, entityIds: [], fromVideo: "", outsideKnowledge: null };
    const fields = cueFields(notes, changes, base);
    const next = copy(notes);
    const cue = { id: nextCueId(next), ...fields, origin: "user", edited: false, fromDraft: null };
    next.cues = [...next.cues, cue].sort(byTime);
    return next;
  }

  function deleteCue(notes, cueId) {
    const cue = findCue(notes, cueId);
    const next = copy(notes);
    next.cues = next.cues.filter((c) => c.id !== cueId);
    // A deleted Draft Cue is remembered so regenerating the Draft can't bring it back.
    if (cue.origin === "draft" && cue.fromDraft) next.deletedDraftCues.push(cue.fromDraft);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Entity edits: correcting which Entity a Mention refers to.

  function mergeEntities(notes, keepId, mergeId) {
    if (keepId === mergeId) reject("Choose two different Entities to merge.");
    const keep = findEntity(notes, keepId);
    const merged = findEntity(notes, mergeId);
    if (keep.kind !== merged.kind) reject("Only Entities of the same kind can be merged.");
    const next = copy(notes);
    const mentionsMs = sortedMs([...keep.mentionsMs, ...merged.mentionsMs]);
    next.entities = next.entities
      .filter((e) => e.id !== mergeId)
      .map((e) => {
        if (e.id === keepId) {
          return {
            ...e,
            summary: e.summary || merged.summary,
            place: e.place ?? merged.place ?? null,
            date: e.date ?? merged.date ?? null,
            mentionsMs,
            firstMentionMs: mentionsMs[0] ?? null,
            draftIds: unique([...e.draftIds, ...merged.draftIds]),
            edited: true,
          };
        }
        return e.splitFromId === mergeId ? { ...e, splitFromId: keepId } : e;
      });
    const swap = (id) => (id === mergeId ? keepId : id);
    for (const cue of next.cues) cue.entityIds = unique(cue.entityIds.map(swap));
    next.relationships = dedupeRelationships(next.relationships.map((r) => ({ ...r, fromId: swap(r.fromId), toId: swap(r.toId) })));
    for (const e of next.entities) if (e.place?.relativeToIds) e.place = { ...e.place, relativeToIds: unique(e.place.relativeToIds.map(swap)).filter((id) => id !== e.id) };
    return next;
  }

  // Moves the chosen Mentions to a new Entity. Cues that refer to the Entity
  // follow whichever of the two was mentioned most recently before them.
  function splitEntity(notes, entityId, { name, mentionsMs } = {}) {
    const source = findEntity(notes, entityId);
    const newName = text(name);
    if (!newName) reject("Name the new Entity.");
    const chosen = sortedMs(mentionsMs ?? []).filter((ms) => source.mentionsMs.includes(ms));
    if (!chosen.length) reject("Choose the Mentions that belong to the new Entity.");
    const remaining = source.mentionsMs.filter((ms) => !chosen.includes(ms));
    if (!remaining.length) reject("Leave at least one Mention with the original Entity.");
    const next = copy(notes);
    const split = {
      id: nextEntityId(next),
      kind: source.kind,
      name: newName,
      summary: "",
      firstMentionMs: chosen[0],
      mentionsMs: chosen,
      place: source.kind === "place" ? { placement: "unmappable", latitude: null, longitude: null, approxRadiusKm: null, relativeToIds: [] } : null,
      date: null,
      origin: "user",
      edited: false,
      draftIds: [],
      splitFromId: entityId,
    };
    next.entities = next.entities.map((e) =>
      e.id === entityId ? { ...e, mentionsMs: remaining, firstMentionMs: remaining[0], edited: true } : e
    );
    next.entities.push(split);
    for (const cue of next.cues) {
      cue.entityIds = unique(cue.entityIds.map((id) => (id === entityId ? assignAfterSplit(next.entities, id, cue.atMs) : id)));
    }
    return next;
  }

  function dedupeRelationships(relationships, kindOf = null) {
    const seen = new Set();
    return relationships.filter((r) => {
      if (r.fromId === r.toId) return false;
      if (kindOf && (kindOf.get(r.fromId) !== "person" || kindOf.get(r.toId) !== "person")) return false;
      const key = `${r.fromId}\u0000${r.toId}\u0000${r.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // Draft -> Notes, and regeneration

  function emptyNotes(draft) {
    return {
      type: "notes",
      version: NOTES_VERSION,
      videoId: draft?.videoId ?? null,
      title: draft?.title ?? null,
      draft: null,
      sections: [],
      entities: [],
      relationships: [],
      cues: [],
      deletedDraftCues: [],
      nextCueNumber: 1,
      nextEntityNumber: 1,
    };
  }

  function fromDraft(draft) {
    return mergeDraft(emptyNotes(draft), draft);
  }

  // Folds a (re)generated Draft into Notes; see the header for the rules.
  function mergeDraft(notes, draft) {
    const next = copy(notes);
    const draftEntities = (Array.isArray(draft?.entities) ? draft.entities : []).filter((e) => e && text(e.id));
    const draftCues = (Array.isArray(draft?.cues) ? draft.cues : []).filter((c) => c && isFiniteNumber(c.atMs));

    // Entities: kept ones first, so they own the Draft ids they stand for.
    const kept = next.entities.filter(isKept);
    const owner = new Map();
    for (const e of kept) for (const id of e.draftIds) if (!owner.has(id)) owner.set(id, e.id);
    const taken = new Set(kept.map((e) => e.id));
    const fresh = [];
    for (const d of draftEntities) {
      if (owner.has(d.id)) continue;
      let id = d.id;
      for (let n = 2; taken.has(id); n++) id = `${d.id}-${n}`;
      taken.add(id);
      owner.set(d.id, id);
      fresh.push({
        ...d,
        id,
        mentionsMs: sortedMs(d.mentionsMs ?? []),
        place: d.place ? { ...d.place, relativeToIds: [...(d.place.relativeToIds ?? [])] } : null,
        origin: "draft",
        edited: false,
        draftIds: [d.id],
        splitFromId: null,
      });
    }
    for (const e of fresh) if (e.place) e.place.relativeToIds = unique(e.place.relativeToIds.map((id) => owner.get(id)).filter((id) => id && id !== e.id));

    // Cues: user and edited Cues stay; the rest come from the new Draft.
    const keptCues = next.cues.filter(isKept);
    const entities = [...kept, ...fresh];
    // An Entity no longer in the Draft but still used by a kept Cue stays too.
    const present = new Set(entities.map((e) => e.id));
    for (const e of next.entities) {
      if (!present.has(e.id) && keptCues.some((c) => c.entityIds.includes(e.id))) {
        entities.push(e);
        present.add(e.id);
      }
    }
    for (const e of entities) if (!e.firstMentionMs && e.firstMentionMs !== 0) e.firstMentionMs = e.mentionsMs[0] ?? null;

    const matchKeys = (ids) => new Set((ids ?? []).flatMap((id) => [`draft:${id}`, ...(owner.has(id) ? [`notes:${owner.get(id)}`] : [])]));
    const regenerated = draftCues.map((c) => ({
      cue: c,
      keys: matchKeys(c.entityIds),
      empty: !(c.entityIds ?? []).length,
      consumed: false,
    }));
    const anchors = [...next.deletedDraftCues, ...keptCues.filter((c) => c.origin === "draft" && c.fromDraft).map((c) => c.fromDraft)];
    for (const index of matchAnchors(anchors, regenerated, matchKeys)) regenerated[index].consumed = true;

    next.entities = entities;
    next.cues = keptCues;
    for (const { cue: c, consumed } of regenerated) {
      if (consumed) continue;
      const kind = KINDS.includes(c.kind) ? c.kind : "gap";
      const rawIds = unique((c.entityIds ?? []).filter((id) => owner.has(id)));
      next.cues.push({
        id: nextCueId(next),
        kind,
        atMs: c.atMs,
        entityIds: unique(rawIds.map((id) => assignAfterSplit(entities, owner.get(id), c.atMs))),
        fromVideo: text(c.fromVideo),
        outsideKnowledge: text(c.outsideKnowledge) || null,
        origin: "draft",
        edited: false,
        fromDraft: { kind, atMs: c.atMs, entityIds: [...(c.entityIds ?? [])] },
      });
    }
    next.cues.sort(byTime);

    const kindOf = new Map(entities.map((e) => [e.id, e.kind]));
    next.relationships = dedupeRelationships(
      (Array.isArray(draft?.relationships) ? draft.relationships : [])
        .filter((r) => r && owner.has(r.fromId) && owner.has(r.toId) && text(r.label))
        .map((r) => ({ fromId: owner.get(r.fromId), toId: owner.get(r.toId), label: text(r.label) })),
      kindOf
    );
    next.sections = (Array.isArray(draft?.sections) ? draft.sections : []).map((s) => ({ ...s }));
    next.draft = draft;
    next.videoId = draft?.videoId ?? next.videoId;
    next.title = draft?.title ?? next.title;
    return next;
  }

  // Which regenerated Cues the anchors (deleted Draft Cues and the Draft
  // versions of edited Cues) absorb: a maximum matching, each anchor taking at
  // most one Cue within MATCH_WINDOW_MS that shares an Entity with it (or, with
  // no Entities, one that has none either). Anchors go in time order (then
  // kind, then Entity ids) and try candidates nearest first (then earliest,
  // then Draft order); an anchor whose candidates are taken may move an
  // earlier anchor to another of its candidates (an augmenting path), so the
  // most anchors are matched. Returns the absorbed indices into `regenerated`.
  function matchAnchors(anchors, regenerated, matchKeys) {
    const anchorKey = (a) => `${a.kind ?? ""}\u0000${(a.entityIds ?? []).join("\u0001")}`;
    const ordered = anchors
      .filter((a) => isFiniteNumber(a.atMs))
      .map((a) => ({ a, key: anchorKey(a) }))
      .sort((x, y) => x.a.atMs - y.a.atMs || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      .map(({ a }) => a);
    const candidates = ordered.map((anchor) => {
      const keys = matchKeys(anchor.entityIds);
      const empty = !(anchor.entityIds ?? []).length;
      return regenerated
        .map((r, index) => ({ index, atMs: r.cue.atMs, delta: Math.abs(r.cue.atMs - anchor.atMs), r }))
        .filter(({ r, delta }) => delta <= MATCH_WINDOW_MS && ([...keys].some((k) => r.keys.has(k)) || (empty && r.empty)))
        .sort((x, y) => x.delta - y.delta || x.atMs - y.atMs || x.index - y.index)
        .map(({ index }) => index);
    });
    const holder = new Map(); // regenerated index -> anchor index
    const augment = (a, seen) => {
      for (const index of candidates[a]) {
        if (seen.has(index)) continue;
        seen.add(index);
        if (!holder.has(index) || augment(holder.get(index), seen)) {
          holder.set(index, a);
          return true;
        }
      }
      return false;
    };
    for (let a = 0; a < ordered.length; a++) augment(a, new Set());
    return [...holder.keys()];
  }

  // ---------------------------------------------------------------------------
  // The Cue editor's unsaved values across Entity edits. Merging or splitting
  // applies at once while the editor stays open; its form still holds the Entity
  // ids from before, and saving them would undo the edit for that Cue. These
  // move the form's ids the way the edit moved the saved Cues'.

  function followMerge(values, keepId, mergeId) {
    if (!values) return values;
    return { ...values, entityIds: unique((values.entityIds ?? []).map((id) => (id === mergeId ? keepId : id))) };
  }

  // `notes` are the Notes after the split. The form's id for the split Entity
  // follows whichever of the two was mentioned most recently before the
  // form's time (or `fallbackAtMs`, the Cue's saved time, if the typed time
  // isn't valid), as the saved Cues did.
  function followSplit(notes, values, entityId, fallbackAtMs = null) {
    if (!values) return values;
    const atMs = isFiniteNumber(values.atMs) ? values.atMs : fallbackAtMs;
    if (!isFiniteNumber(atMs)) return values;
    return {
      ...values,
      entityIds: unique((values.entityIds ?? []).map((id) => (id === entityId ? assignAfterSplit(notes.entities, id, atMs) : id))),
    };
  }

  // How many items the user has added or changed.
  function editCount(notes) {
    if (!notes) return 0;
    return notes.cues.filter(isKept).length + notes.entities.filter(isKept).length + notes.deletedDraftCues.length;
  }

  // ---------------------------------------------------------------------------
  // Checking Notes read back from storage or an imported file

  const VIDEO_ID_PATTERN = /^[\w-]{11}$/;
  const ENTITY_KINDS = ["person", "place", "event"];
  const ORIGINS = ["draft", "user"];
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const isMsList = (v) => Array.isArray(v) && v.every(isFiniteNumber);
  const isOptionalText = (v) => v === null || v === undefined || typeof v === "string";

  // Validates the Notes shape (see the header) and returns a copy holding only
  // the known fields, so nothing else in a file is ever kept or rendered.
  // Messages describe the first problem found and are fit to show the user.
  function checkNotes(value) {
    try {
      return { ok: true, notes: readNotes(value) };
    } catch (error) {
      if (error instanceof NotesEditError) return { ok: false, message: error.message };
      throw error;
    }
  }

  function readNotes(value) {
    if (!isObject(value) || value.type !== "notes") reject("They aren't Notes.");
    if (value.version !== NOTES_VERSION) reject(`They're Notes version ${JSON.stringify(value.version)}; this version of Cue reads version ${NOTES_VERSION}.`);
    if (typeof value.videoId !== "string" || !VIDEO_ID_PATTERN.test(value.videoId)) reject("They don't name a valid Video ID.");
    for (const key of ["sections", "entities", "relationships", "cues", "deletedDraftCues"]) {
      if (!Array.isArray(value[key])) reject(`Their ${key} list is missing.`);
    }
    for (const key of ["nextCueNumber", "nextEntityNumber"]) {
      if (!Number.isInteger(value[key]) || value[key] < 1) reject(`Their ${key} is missing.`);
    }
    if (value.draft !== null && !isObject(value.draft)) reject("Their Draft is damaged.");
    if (value.draft && value.draft.videoId !== undefined && value.draft.videoId !== value.videoId) reject("Their Draft is for a different Video.");
    if (!isOptionalText(value.title)) reject("Their title is damaged.");

    const entityIds = new Set();
    const entities = value.entities.map((e) => {
      if (!isObject(e) || typeof e.id !== "string" || !e.id || entityIds.has(e.id)) reject("An Entity is missing or has a repeated id.");
      entityIds.add(e.id);
      if (!ENTITY_KINDS.includes(e.kind)) reject(`Entity ${e.id} isn't a Person, Place, or Event.`);
      if (typeof e.name !== "string" || !isOptionalText(e.summary) || !isOptionalText(e.date)) reject(`Entity ${e.id} is damaged.`);
      if (!isMsList(e.mentionsMs) || !isStringList(e.draftIds)) reject(`Entity ${e.id} has damaged Mentions.`);
      if (!ORIGINS.includes(e.origin) || typeof e.edited !== "boolean") reject(`Entity ${e.id} is damaged.`);
      if (e.place !== null && e.place !== undefined && !isObject(e.place)) reject(`Entity ${e.id} has a damaged Place.`);
      if (e.place?.relativeToIds !== undefined && !isStringList(e.place.relativeToIds)) reject(`Entity ${e.id} has a damaged Place.`);
      if (e.firstMentionMs !== null && e.firstMentionMs !== undefined && !isFiniteNumber(e.firstMentionMs)) reject(`Entity ${e.id} has a damaged First mention.`);
      if (e.splitFromId !== null && e.splitFromId !== undefined && typeof e.splitFromId !== "string") reject(`Entity ${e.id} is damaged.`);
      return {
        id: e.id,
        kind: e.kind,
        name: e.name,
        summary: e.summary ?? "",
        firstMentionMs: e.firstMentionMs ?? null,
        mentionsMs: [...e.mentionsMs],
        place: e.place
          ? {
              placement: e.place.placement,
              latitude: e.place.latitude ?? null,
              longitude: e.place.longitude ?? null,
              approxRadiusKm: e.place.approxRadiusKm ?? null,
              relativeToIds: [...(e.place.relativeToIds ?? [])],
            }
          : null,
        date: e.date ?? null,
        origin: e.origin,
        edited: e.edited,
        draftIds: [...e.draftIds],
        splitFromId: e.splitFromId ?? null,
      };
    });
    const known = (id) => entityIds.has(id);

    const cueIds = new Set();
    const cues = value.cues.map((c) => {
      if (!isObject(c) || typeof c.id !== "string" || !c.id || cueIds.has(c.id)) reject("A Cue is missing or has a repeated id.");
      cueIds.add(c.id);
      if (!KINDS.includes(c.kind)) reject(`Cue ${c.id} is neither a Callback nor a Gap.`);
      if (!isFiniteNumber(c.atMs) || c.atMs < 0) reject(`Cue ${c.id} has no valid time.`);
      if (!isStringList(c.entityIds) || !c.entityIds.every(known)) reject(`Cue ${c.id} refers to an Entity that isn't in the Notes.`);
      if (typeof c.fromVideo !== "string" || !isOptionalText(c.outsideKnowledge)) reject(`Cue ${c.id} is damaged.`);
      if (!ORIGINS.includes(c.origin) || typeof c.edited !== "boolean") reject(`Cue ${c.id} is damaged.`);
      const fromDraft = c.fromDraft ?? null;
      if (fromDraft !== null && !isDraftCueRef(fromDraft)) reject(`Cue ${c.id} is damaged.`);
      return {
        id: c.id,
        kind: c.kind,
        atMs: c.atMs,
        entityIds: [...c.entityIds],
        fromVideo: c.fromVideo,
        outsideKnowledge: c.outsideKnowledge ?? null,
        origin: c.origin,
        edited: c.edited,
        fromDraft: fromDraft && { kind: fromDraft.kind, atMs: fromDraft.atMs, entityIds: [...fromDraft.entityIds] },
      };
    });

    const relationships = value.relationships.map((r) => {
      if (!isObject(r) || !known(r.fromId) || !known(r.toId) || typeof r.label !== "string") reject("A Relationship refers to a Person that isn't in the Notes.");
      return { fromId: r.fromId, toId: r.toId, label: r.label };
    });
    const sections = value.sections.map((s) => {
      if (!isObject(s) || typeof s.title !== "string" || !isFiniteNumber(s.startMs)) reject("A Section is damaged.");
      return { ...s };
    });
    const deletedDraftCues = value.deletedDraftCues.map((d) => {
      if (!isDraftCueRef(d)) reject("A deleted Draft Cue is damaged.");
      return { kind: d.kind, atMs: d.atMs, entityIds: [...d.entityIds] };
    });

    return {
      type: "notes",
      version: NOTES_VERSION,
      videoId: value.videoId,
      title: value.title ?? null,
      draft: value.draft ? structuredCopy(value.draft) : null,
      sections,
      entities,
      relationships,
      cues: cues.sort(byTime),
      deletedDraftCues,
      nextCueNumber: value.nextCueNumber,
      nextEntityNumber: value.nextEntityNumber,
    };
  }

  const isDraftCueRef = (d) => isObject(d) && isFiniteNumber(d.atMs) && isStringList(d.entityIds);
  // The Draft is plain JSON data; copying it through JSON drops anything else.
  const structuredCopy = (v) => JSON.parse(JSON.stringify(v));

  const api = {
    NOTES_VERSION,
    MATCH_WINDOW_MS,
    NotesEditError,
    fromDraft,
    mergeDraft,
    updateCue,
    addCue,
    deleteCue,
    mergeEntities,
    splitEntity,
    followMerge,
    followSplit,
    editCount,
    checkNotes,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueNotes ??= Object.freeze(api);
})();
