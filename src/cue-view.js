// What the Cue panel shows at a given playhead, computed from a Draft.
// Pure (no DOM); loads under Node for tests. src/cue-render.js turns these
// view models into DOM.
//
//   const notes = CueView.normalizeDraft(draft);
//   const view  = CueView.buildView(notes, playheadMs, returnToMs);
//     view.current   the latest Cue at or before the playhead (or null)
//     view.earlier   earlier Cues, most recent first
//   Nothing later than the playhead is ever included: no later Cue, and no
//   Entity whose First mention comes after the Cue being shown, even one the
//   Cue itself names (a Draft can link one, and so can a user's edit). Such an
//   Entity stays in the Notes untouched and is still offered in the Cue
//   editor, marked as not shown at that Cue; it is only left out of what the
//   Cue displays: its names, summaries, Relationship cards, Map and Timeline.
(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Timestamps

  // "3:05" or "1:02:03", like YouTube's own player.
  function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const ss = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
  }

  // The reverse, for typed times: "3:05", "1:02:03", or plain seconds ("185").
  // null when the text isn't a timestamp.
  function parseTimestamp(input) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(value)) return null;
    const parts = value.split(":");
    const seconds = Number(parts.pop());
    const rest = parts.map(Number);
    if (rest.length && seconds >= 60) return null;
    if (rest.length === 2 && rest[1] >= 60) return null;
    return Math.round((rest.reduce((acc, n) => acc * 60 + n, 0) * 60 + seconds) * 1000);
  }

  // ---------------------------------------------------------------------------
  // Draft normalization

  const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
  const text = (v) => (typeof v === "string" ? v.trim() : "");

  // Adapts a Draft (src/draft.js shape) or Notes (src/notes.js shape, which
  // adds origin/edited markers) into what the views read, tolerating
  // missing fields so a hand-edited or older Draft can't crash the panel.
  function normalizeDraft(draft) {
    if (!draft || typeof draft !== "object") return null;
    const entities = (Array.isArray(draft.entities) ? draft.entities : [])
      .filter((e) => e && text(e.id))
      .map((e) => {
        const mentionsMs = (Array.isArray(e.mentionsMs) ? e.mentionsMs : []).filter(isFiniteNumber).sort((a, b) => a - b);
        const kind = ["person", "place", "event"].includes(e.kind) ? e.kind : "event";
        return {
          id: text(e.id),
          kind,
          name: text(e.name) || text(e.id),
          summary: text(e.summary),
          firstMentionMs: isFiniteNumber(e.firstMentionMs) ? e.firstMentionMs : mentionsMs[0] ?? null,
          mentionsMs,
          place: kind === "place" && e.place && typeof e.place === "object" ? e.place : null,
          date: text(e.date) || null,
          origin: e.origin === "user" ? "user" : "draft",
          edited: e.edited === true,
        };
      });
    const byId = new Map(entities.map((e) => [e.id, e]));
    const cues = (Array.isArray(draft.cues) ? draft.cues : [])
      .filter((c) => c && isFiniteNumber(c.atMs))
      .map((c, i) => ({
        id: text(c.id) || `cue-${i + 1}`,
        kind: c.kind === "callback" ? "callback" : "gap",
        atMs: Math.max(0, c.atMs),
        entityIds: (Array.isArray(c.entityIds) ? c.entityIds : []).filter((id) => byId.has(id)),
        fromVideo: text(c.fromVideo),
        outsideKnowledge: text(c.outsideKnowledge) || null,
        origin: c.origin === "user" ? "user" : "draft",
        edited: c.edited === true,
      }))
      .sort((a, b) => a.atMs - b.atMs); // stable: ties keep Draft order
    const relationships = (Array.isArray(draft.relationships) ? draft.relationships : []).filter(
      (r) => r && byId.has(r.fromId) && byId.has(r.toId) && r.fromId !== r.toId && text(r.label)
    );
    return { videoId: draft.videoId ?? null, draft, cues, entities, byId, relationships };
  }

  // ---------------------------------------------------------------------------
  // Cue selection

  // The Cues reached by the playhead: the latest is current, the rest feed
  // below it (most recent first). A Cue later than the playhead is never shown.
  function selectCues(cues, playheadMs) {
    if (!isFiniteNumber(playheadMs)) return { current: null, earlier: [] };
    let reached = 0;
    while (reached < cues.length && cues[reached].atMs <= playheadMs) reached++;
    const visible = cues.slice(0, reached);
    return { current: visible[reached - 1] ?? null, earlier: visible.slice(0, -1).reverse() };
  }

  // Known by the time `ms` is reached in the Video.
  const knownBy = (entity, ms) => entity.firstMentionMs !== null && entity.firstMentionMs <= ms;

  // Whether the Video has introduced an Entity by the time a Cue is reached.
  // One with no known Mention is introduced by the Cue that names it.
  const shownAtCue = (entity, atMs) => entity.firstMentionMs === null || entity.firstMentionMs <= atMs;

  // Every Entity the Cue names, shown or not (for the editor).
  const linkedEntities = (notes, cue) => cue.entityIds.map((id) => notes.byId.get(id)).filter(Boolean);
  // The Entities the Cue names that may be shown at it: none first mentioned later.
  const cueEntities = (notes, cue) => linkedEntities(notes, cue).filter((e) => shownAtCue(e, cue.atMs));

  // The Entity a Callback refers back to: one in the Cue first mentioned earlier.
  function callbackEntity(notes, cue) {
    if (cue.kind !== "callback") return null;
    return cueEntities(notes, cue).find((e) => e.firstMentionMs !== null && e.firstMentionMs < cue.atMs) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Jump-back: after jumping to a First mention, offer "Return to mm:ss" until
  // it's clicked or playback reaches that point again.

  function createJumpBack() {
    let returnToMs = null;
    let armed = false; // false until the seek has visibly landed before returnToMs

    return {
      get returnToMs() {
        return returnToMs;
      },
      // Records a jump from `fromMs` back to `toMs`. Repeated jump-backs keep
      // the furthest point, so Return goes back to where the viewer was.
      jump(fromMs, toMs) {
        if (!isFiniteNumber(fromMs) || !isFiniteNumber(toMs) || toMs >= fromMs) return false;
        returnToMs = returnToMs === null ? fromMs : Math.max(returnToMs, fromMs);
        armed = false;
        return true;
      },
      // Playhead updates. Updates still reporting the pre-seek time are
      // ignored until the seek lands.
      onTime(ms) {
        if (returnToMs === null || !isFiniteNumber(ms)) return;
        if (!armed) {
          if (ms < returnToMs) armed = true;
          return;
        }
        if (ms >= returnToMs) returnToMs = null;
      },
      // User clicked Return; the time to seek to (or null).
      takeReturn() {
        const target = returnToMs;
        returnToMs = null;
        return target;
      },
      clear() {
        returnToMs = null;
        armed = false;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Dates for the Timeline. The text is always shown as the Transcript said
  // it; parsing only orders and places Events, never adds precision.

  const MONTHS =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const DAY_BEFORE_MONTH = new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?=(?:${MONTHS})\\b)`, "gi");
  const DAY_AFTER_MONTH = new RegExp(`\\b((?:${MONTHS})\\.?)\\s+\\d{1,2}(?:st|nd|rd|th)?(?=\\s*,|\\s*$)`, "gi");
  const APPROXIMATE =
    /\b(?:c|ca|circa|around|about|approx(?:imately)?|roughly|perhaps|probably|possibly|maybe|early|mid|middle|late|before|after|by|or|sometime|some time)\b|[?~≈]/i;
  const CENTURY = /\b(\d{1,2})(?:st|nd|rd|th)[\s-]+centur(?:y|ies)\b/gi;
  const DECADE = /\b(\d{2,3}0)s\b/g;
  const BC = /(?:^|[^a-z])b\.?\s?c\.?(?:\s?e\.?)?(?![a-z])/i;
  const AD = /(?:^|[^a-z])(?:a\.?\s?d\.?|c\.?\s?e\.?)(?![a-z])/i;

  // Returns { text, kind: "exact" | "range" | "approximate", start, end }.
  // start/end are years (negative for BC) used only for ordering and
  // placement; null when the text gives no year to place it by.
  function parseDate(input) {
    const said = text(input);
    const result = (kind, start = null, end = start) => ({ text: said, kind, start, end });
    if (!said) return result("approximate");

    const bcAt = said.search(BC);
    const hasAd = AD.test(said);
    const era = (index, year) => (bcAt !== -1 && (!hasAd || index < bcAt) ? -year : year);
    const approximate = APPROXIMATE.test(said);

    const centuries = [...said.matchAll(CENTURY)];
    if (centuries.length) {
      const span = (m) => {
        const n = Number(m[1]);
        const [a, b] = [(n - 1) * 100 + 1, n * 100];
        return era(m.index, 1) < 0 ? [-b, -a] : [a, b];
      };
      const bounds = centuries.flatMap(span);
      return result("approximate", Math.min(...bounds), Math.max(...bounds));
    }

    const decades = [...said.matchAll(DECADE)];
    if (decades.length) {
      const bounds = decades.flatMap((m) => {
        const y = era(m.index, Number(m[1]));
        return y < 0 ? [y - 9, y] : [y, y + 9];
      });
      return result("approximate", Math.min(...bounds), Math.max(...bounds));
    }

    const withoutDays = said.replace(DAY_BEFORE_MONTH, " ").replace(DAY_AFTER_MONTH, "$1 ");
    const years = [...withoutDays.matchAll(/\b\d{1,4}\b/g)].map((m) => ({ digits: m[0], year: Number(m[0]), index: m.index }));
    if (!years.length) return result("approximate");

    if (years.length === 1) {
      const y = era(years[0].index, years[0].year);
      return result(approximate ? "approximate" : "exact", y);
    }

    // A range, such as "871–899", "871 to 899", or "50–44 BC". "871–99"
    // abbreviates the end year, so it borrows the start's leading digits.
    const first = years[0];
    const last = years[years.length - 1];
    let endYear = last.year;
    if (bcAt === -1 && endYear < first.year && last.digits.length < first.digits.length) {
      const prefix = first.digits.slice(0, first.digits.length - last.digits.length);
      endYear = Number(prefix + last.digits);
    }
    const a = era(first.index, first.year);
    const b = era(last.index, endYear);
    return result(approximate ? "approximate" : "range", Math.min(a, b), Math.max(a, b));
  }

  // ---------------------------------------------------------------------------
  // Cue visuals

  const MAX_EARLIER = 6;

  // Earlier Entities of a kind known by the Cue, most recently introduced first.
  function earlierOfKind(notes, cue, kind, exclude) {
    return notes.entities
      .filter((e) => e.kind === kind && !exclude.has(e.id) && knownBy(e, cue.atMs))
      .sort((a, b) => b.firstMentionMs - a.firstMentionMs);
  }

  // Relationship card: each Person in the Cue linked to the related People it
  // depends on (only People already introduced).
  function relationshipCards(notes, cue) {
    const people = cueEntities(notes, cue).filter((e) => e.kind === "person");
    const shown = new Set();
    const cards = [];
    for (const person of people) {
      const links = [];
      notes.relationships.forEach((r, i) => {
        if (shown.has(i) || (r.fromId !== person.id && r.toId !== person.id)) return;
        const other = notes.byId.get(r.fromId === person.id ? r.toId : r.fromId);
        if (other.kind !== "person" || !knownBy(other, cue.atMs)) return;
        shown.add(i);
        links.push({
          label: text(r.label),
          other,
          // Reads as "from label to": "Edward son of Alfred".
          from: notes.byId.get(r.fromId),
          to: notes.byId.get(r.toId),
        });
      });
      if (links.length) cards.push({ person, links });
    }
    return cards;
  }

  // Timeline: the Cue's Events among earlier dated Events, in date order.
  function timelineModel(notes, cue) {
    const current = cueEntities(notes, cue).filter((e) => e.kind === "event");
    if (!current.length) return null;
    const ids = new Set(current.map((e) => e.id));
    const earlier = earlierOfKind(notes, cue, "event", ids).filter((e) => e.date).slice(0, MAX_EARLIER);
    const items = [...current.map((e) => ({ entity: e, current: true })), ...earlier.map((e) => ({ entity: e, current: false }))]
      .map((item) => ({ ...item, date: item.entity.date ? parseDate(item.entity.date) : null }));
    const placed = items.filter((i) => i.date && i.date.start !== null).sort((a, b) => a.date.start - b.date.start || a.date.end - b.date.end);
    const unplaced = items.filter((i) => !i.date || i.date.start === null);
    const min = placed.length ? Math.min(...placed.map((i) => i.date.start)) : null;
    const max = placed.length ? Math.max(...placed.map((i) => i.date.end)) : null;
    return { placed, unplaced, min, max };
  }

  // The cautious category a Place is drawn as, from the glossary:
  //   located    -> Located place, a pin (needs a known position)
  //   uncertain  -> Uncertain place, an approximate shaded area, never a pin
  //   unmappable -> Unmappable place, a labelled schematic sketch, never on the map
  //   unplaced   -> a position was claimed but none came with it; listed only
  function placeCategory(place) {
    const placement = place?.placement;
    const hasPosition = isFiniteNumber(place?.latitude) && isFiniteNumber(place?.longitude);
    if (placement === "unmappable") return "unmappable";
    if (placement === "located" && hasPosition) return "located";
    if (placement === "uncertain" && hasPosition) return "uncertain";
    return "unplaced";
  }

  const PLACE_LABELS = Object.freeze({
    located: "Located place",
    uncertain: "Uncertain place",
    unmappable: "Unmappable place",
    unplaced: "Position not given",
  });

  // An Uncertain place with no stated approxRadiusKm is drawn deliberately
  // large: vagueness, not a claim.
  const DEFAULT_UNCERTAIN_RADIUS_KM = 100;

  // Map: the Cue's Places among earlier Places (plus those an Unmappable
  // place is known relative to), each labelled with when it mattered.
  //   pins / areas  real places for the tile map, with latitude/longitude
  //                 (areas also radiusKm); fitting and projection are the
  //                 renderer's job (src/map-tiles.js)
  //   sketches      Unmappable places, drawn in the schematic sketch beneath
  function mapModel(notes, cue) {
    const current = cueEntities(notes, cue).filter((e) => e.kind === "place");
    if (!current.length) return null;
    const ids = new Set(current.map((e) => e.id));
    const relative = current
      .flatMap((e) => e.place?.relativeToIds ?? [])
      .map((id) => notes.byId.get(id))
      .filter((e) => e && e.kind === "place" && !ids.has(e.id) && knownBy(e, cue.atMs));
    relative.forEach((e) => ids.add(e.id));
    const earlier = earlierOfKind(notes, cue, "place", ids).slice(0, MAX_EARLIER);
    const places = [
      ...current.map((e) => ({ entity: e, current: true })),
      ...relative.map((e) => ({ entity: e, current: false })),
      ...earlier.map((e) => ({ entity: e, current: false })),
    ].map((p) => ({ ...p, category: placeCategory(p.entity.place), mattersAtMs: p.entity.firstMentionMs }));

    const withPosition = (p) => ({ ...p, latitude: p.entity.place.latitude, longitude: p.entity.place.longitude });
    const pins = places.filter((p) => p.category === "located").map(withPosition);
    const areas = places
      .filter((p) => p.category === "uncertain")
      .map((p) => {
        const stated = isFiniteNumber(p.entity.place.approxRadiusKm) && p.entity.place.approxRadiusKm > 0;
        return { ...withPosition(p), radiusKm: stated ? p.entity.place.approxRadiusKm : DEFAULT_UNCERTAIN_RADIUS_KM, radiusStated: stated };
      });
    const sketches = places
      .filter((p) => p.category === "unmappable" && p.current)
      .map((p) => ({
        place: p,
        relativeTo: (p.entity.place.relativeToIds ?? [])
          .map((id) => notes.byId.get(id))
          .filter((e) => e && knownBy(e, cue.atMs)),
      }));
    return {
      pins,
      areas,
      sketches,
      // Earlier Unmappable places and Places with no position: listed, not drawn.
      listed: places.filter((p) => p.category === "unplaced" || (p.category === "unmappable" && !p.current)),
      places,
    };
  }

  // ---------------------------------------------------------------------------
  // Whole view

  function describeCue(notes, cue, full) {
    const entities = cueEntities(notes, cue);
    const callback = callbackEntity(notes, cue);
    const base = {
      cue,
      entities,
      callback: callback ? { entity: callback, firstMentionMs: callback.firstMentionMs } : null,
    };
    if (!full) return base;
    return { ...base, relationshipCards: relationshipCards(notes, cue), timeline: timelineModel(notes, cue), map: mapModel(notes, cue) };
  }

  function buildView(notes, playheadMs, returnToMs = null) {
    if (!notes) return null;
    const { current, earlier } = selectCues(notes.cues, playheadMs);
    return {
      key: `${current?.id ?? ""}|${earlier.length}|${returnToMs ?? ""}`,
      cueCount: notes.cues.length,
      returnToMs,
      current: current ? describeCue(notes, current, true) : null,
      earlier: earlier.map((cue) => describeCue(notes, cue, false)),
    };
  }

  // ---------------------------------------------------------------------------
  // Cue editor: what the edit form offers for one Cue (or a new one).
  //   editing: { cueId } for an existing Cue, or { atMs } for a new user Cue;
  //   optional values (form contents to restore) and error.
  // Only Entities introduced by the playhead (or the Cue's own time) are
  // offered, so editing never reveals what comes later.

  function cueEditorModel(notes, editing, playheadMs) {
    if (!notes || !editing) return null;
    const cue = editing.cueId ? notes.cues.find((c) => c.id === editing.cueId) : null;
    if (editing.cueId && !cue) return null;
    const saved = cue
      ? { kind: cue.kind, atMs: cue.atMs, entityIds: cue.entityIds, fromVideo: cue.fromVideo, outsideKnowledge: cue.outsideKnowledge ?? "" }
      : { kind: "gap", atMs: isFiniteNumber(editing.atMs) ? editing.atMs : 0, entityIds: [], fromVideo: "", outsideKnowledge: "" };
    const values = { ...saved, ...(editing.values ?? {}) };
    values.entityIds = (values.entityIds ?? []).filter((id) => notes.byId.has(id));
    if (!isFiniteNumber(values.atMs)) values.atMs = saved.atMs;
    const limit = Math.max(isFiniteNumber(playheadMs) ? playheadMs : 0, saved.atMs);
    const byFirstMention = (a, b) => (a.firstMentionMs ?? Infinity) - (b.firstMentionMs ?? Infinity);
    const choices = notes.entities
      .filter((e) => knownBy(e, limit) || values.entityIds.includes(e.id) || cue?.entityIds.includes(e.id))
      .sort(byFirstMention);
    const entityTools = cue
      ? linkedEntities(notes, cue).map((entity) => ({
          entity,
          mergeTargets: notes.entities.filter((o) => o.id !== entity.id && o.kind === entity.kind && knownBy(o, limit)).sort(byFirstMention),
          mentionsMs: entity.mentionsMs,
        }))
      : [];
    // Chosen or offered Entities first mentioned after the Cue's time: kept if
    // chosen, but never shown at this Cue (no spoilers), so the form says so.
    const notShownIds = choices.filter((e) => !shownAtCue(e, values.atMs)).map((e) => e.id);
    return {
      cueId: cue?.id ?? null,
      isNew: !cue,
      origin: cue?.origin ?? "user",
      edited: cue?.edited ?? false,
      values,
      choices,
      notShownIds,
      entityTools,
      error: editing.error ?? "",
    };
  }

  const CUE_KIND_LABELS = Object.freeze({ callback: "Callback", gap: "Gap" });
  const ENTITY_KIND_LABELS = Object.freeze({ person: "Person", place: "Place", event: "Event" });

  const api = {
    CUE_KIND_LABELS,
    ENTITY_KIND_LABELS,
    PLACE_LABELS,
    formatTimestamp,
    parseTimestamp,
    normalizeDraft,
    selectCues,
    shownAtCue,
    cueEntities,
    callbackEntity,
    createJumpBack,
    parseDate,
    relationshipCards,
    timelineModel,
    placeCategory,
    mapModel,
    buildView,
    cueEditorModel,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueView ??= Object.freeze(api);
})();
