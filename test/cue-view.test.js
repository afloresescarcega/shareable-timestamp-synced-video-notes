// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const view = require("../src/cue-view.js");
const { renderCueView } = require("../src/cue-render.js");

// ---------------------------------------------------------------------------
// Fixtures: a Draft in src/draft.js's shape.

const person = (id, name, firstMs, summary = `${name}.`) => ({
  id, kind: "person", name, summary, firstMentionMs: firstMs, mentionsMs: [firstMs], place: null, date: null,
});
const event = (id, name, firstMs, date) => ({
  id, kind: "event", name, summary: `${name}.`, firstMentionMs: firstMs, mentionsMs: [firstMs], place: null, date,
});
const place = (id, name, firstMs, p) => ({
  id, kind: "place", name, summary: `${name}.`, firstMentionMs: firstMs, mentionsMs: [firstMs],
  place: { latitude: null, longitude: null, approxRadiusKm: null, relativeToIds: [], ...p }, date: null,
});
const cue = (id, atMs, kind, entityIds, extra = {}) => ({ id, kind, atMs, entityIds, fromVideo: `About ${entityIds.join(", ")}.`, outsideKnowledge: null, ...extra });

function draft() {
  return {
    type: "draft",
    version: 1,
    videoId: "abcdefghijk",
    entities: [
      person("p-alfred", "Alfred", 4000),
      person("p-edward", "Edward", 60000),
      person("p-guthrum", "Guthrum", 500000), // introduced after every Cue below except the last
      event("e-edington", "Battle of Edington", 30000, "May 878"),
      event("e-reign", "Alfred's reign", 10000, "871–899"),
      event("e-raids", "Viking raids", 20000, "the late 8th century"),
      event("e-later", "Later battle", 700000, "910"),
      place("pl-winchester", "Winchester", 8000, { placement: "located", latitude: 51.06, longitude: -1.31 }),
      place("pl-brunanburh", "Brunanburh", 90000, { placement: "uncertain", latitude: 53.3, longitude: -2.9, approxRadiusKm: 80 }),
      place("pl-avalon", "Avalon", 120000, { placement: "unmappable", relativeToIds: ["pl-winchester", "pl-brunanburh"] }),
      place("pl-lost", "Lost hall", 15000, { placement: "located" }), // claimed located, no position
    ],
    relationships: [
      { fromId: "p-edward", toId: "p-alfred", label: "son of" },
      { fromId: "p-guthrum", toId: "p-edward", label: "fought" },
    ],
    cues: [
      cue("cue-1", 8000, "gap", ["pl-winchester"], { outsideKnowledge: "Capital of Wessex." }),
      cue("cue-2", 60000, "callback", ["p-edward", "p-alfred"]),
      cue("cue-3", 90000, "gap", ["pl-brunanburh"]),
      cue("cue-4", 120000, "gap", ["pl-avalon"]),
      cue("cue-5", 150000, "callback", ["e-edington"]),
      cue("cue-6", 600000, "gap", ["p-guthrum"]),
    ],
  };
}

const notes = () => view.normalizeDraft(draft());

// ---------------------------------------------------------------------------
// Timestamps

test("formatTimestamp matches YouTube's m:ss / h:mm:ss", () => {
  assert.equal(view.formatTimestamp(0), "0:00");
  assert.equal(view.formatTimestamp(5999), "0:05");
  assert.equal(view.formatTimestamp(65000), "1:05");
  assert.equal(view.formatTimestamp(600000), "10:00");
  assert.equal(view.formatTimestamp(3723000), "1:02:03");
  assert.equal(view.formatTimestamp(-5), "0:00");
  assert.equal(view.formatTimestamp(null), "0:00");
});

// ---------------------------------------------------------------------------
// Cue selection

test("selectCues shows the latest reached Cue and never a later one", () => {
  const { cues } = notes();
  assert.deepEqual(view.selectCues(cues, 7999), { current: null, earlier: [] });
  assert.equal(view.selectCues(cues, 8000).current.id, "cue-1");
  const mid = view.selectCues(cues, 100000);
  assert.equal(mid.current.id, "cue-3");
  assert.deepEqual(mid.earlier.map((c) => c.id), ["cue-2", "cue-1"]);
  for (const ms of [0, 8000, 59999, 60000, 119999, 1e7]) {
    const { current, earlier } = view.selectCues(cues, ms);
    for (const c of [current, ...earlier].filter(Boolean)) assert.ok(c.atMs <= ms, `${c.id} at ${c.atMs} shown at ${ms}`);
  }
  assert.equal(view.selectCues(cues, null).current, null);
  assert.equal(view.selectCues(cues, NaN).current, null);
});

test("seeking backwards moves the current Cue back and shrinks the feed", () => {
  const n = notes();
  assert.equal(view.buildView(n, 160000).current.cue.id, "cue-5");
  const back = view.buildView(n, 61000);
  assert.equal(back.current.cue.id, "cue-2");
  assert.deepEqual(back.earlier.map((e) => e.cue.id), ["cue-1"]);
  assert.notEqual(back.key, view.buildView(n, 160000).key);
  assert.equal(view.buildView(n, 61000).key, view.buildView(n, 89999).key, "no re-render between Cues");
});

test("normalizeDraft sorts Cues, drops unknown Entities, and tolerates missing fields", () => {
  const n = view.normalizeDraft({
    entities: [{ id: "a", kind: "person", name: "A", mentionsMs: [9, 3] }, { name: "no id" }],
    cues: [{ atMs: 50, kind: "gap", entityIds: ["a", "nope"] }, { atMs: 10, kind: "callback" }, { kind: "gap" }],
    relationships: [{ fromId: "a", toId: "ghost", label: "x" }],
  });
  assert.deepEqual(n.cues.map((c) => c.atMs), [10, 50]);
  assert.deepEqual(n.cues[1].entityIds, ["a"]);
  assert.equal(n.byId.get("a").firstMentionMs, 3);
  assert.deepEqual(n.relationships, []);
  assert.equal(view.normalizeDraft(null), null);
});

// ---------------------------------------------------------------------------
// Callbacks and jump-back

test("a Callback points at the Entity's First mention", () => {
  const n = notes();
  const current = view.buildView(n, 61000).current;
  assert.equal(current.callback.entity.id, "p-alfred"); // Edward is introduced at this Cue
  assert.equal(current.callback.firstMentionMs, 4000);
  assert.equal(view.buildView(n, 8000).current.callback, null, "a Gap has no jump-back");
});

test("jump-back shows Return until clicked", () => {
  const jb = view.createJumpBack();
  assert.equal(jb.jump(61000, 4000), true);
  assert.equal(jb.returnToMs, 61000);
  jb.onTime(61200); // stale update from before the seek landed
  assert.equal(jb.returnToMs, 61000);
  jb.onTime(4000);
  jb.onTime(30000);
  assert.equal(jb.returnToMs, 61000);
  assert.equal(jb.takeReturn(), 61000);
  assert.equal(jb.returnToMs, null);
  assert.equal(jb.takeReturn(), null);
});

test("jump-back clears once playback passes the Return point", () => {
  const jb = view.createJumpBack();
  jb.jump(61000, 4000);
  jb.onTime(4100);
  jb.onTime(60999);
  assert.equal(jb.returnToMs, 61000);
  jb.onTime(61000);
  assert.equal(jb.returnToMs, null);
});

test("repeated jump-backs keep the furthest Return point; forward jumps are ignored", () => {
  const jb = view.createJumpBack();
  assert.equal(jb.jump(4000, 9000), false);
  assert.equal(jb.returnToMs, null);
  jb.jump(150000, 30000);
  jb.onTime(30000);
  jb.jump(31000, 10000);
  assert.equal(jb.returnToMs, 150000);
  jb.clear();
  assert.equal(jb.returnToMs, null);
});

test("rendered Callback jump link and Return button call their handlers", () => {
  const calls = [];
  const n = notes();
  const root = renderCueView(fakeDocument(), view.buildView(n, 61000, 150000), {
    onJumpBack: (e) => calls.push(["jump", e.id]),
    onReturn: () => calls.push(["return"]),
  });
  const jump = find(root, (x) => hasClass(x, "cue-callback__jump"));
  assert.equal(jump.textContent, "First mention: 0:04");
  jump.click();
  const ret = find(root, (x) => hasClass(x, "cue-return"));
  assert.equal(ret.textContent, "Return to 2:30");
  ret.click();
  assert.deepEqual(calls, [["jump", "p-alfred"], ["return"]]);
  assert.equal(findAll(renderCueView(fakeDocument(), view.buildView(n, 61000)), (x) => hasClass(x, "cue-return")).length, 0);
});

// ---------------------------------------------------------------------------
// Relationship card

test("Relationship card links the current Person only to People already introduced", () => {
  const n = notes();
  const cards = view.buildView(n, 61000).current.relationshipCards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].person.id, "p-edward");
  assert.deepEqual(cards[0].links.map((l) => [l.from.name, l.label, l.to.name]), [["Edward", "son of", "Alfred"]]);
  // Guthrum's "fought" link only appears once Guthrum has been introduced.
  const later = view.buildView(n, 600000).current.relationshipCards;
  assert.deepEqual(later[0].links.map((l) => l.label), ["fought"]);
});

// ---------------------------------------------------------------------------
// Dates and Timeline

test("parseDate keeps the Transcript's wording and never invents precision", () => {
  const cases = [
    ["878", "exact", 878, 878],
    ["12 May 878", "exact", 878, 878],
    ["May 12, 878", "exact", 878, 878],
    ["AD 43", "exact", 43, 43],
    ["871–899", "range", 871, 899],
    ["871-99", "range", 871, 899],
    ["from 871 to 899", "range", 871, 899],
    ["50–44 BC", "range", -50, -44],
    ["100 BC – AD 50", "range", -100, 50],
    ["c. 850", "approximate", 850, 850],
    ["around 900", "approximate", 900, 900],
    ["878 or 879", "approximate", 878, 879],
    ["the 880s", "approximate", 880, 889],
    ["the late 9th century", "approximate", 801, 900],
    ["5th century BC", "approximate", -500, -401],
    ["in the time of the old kings", "approximate", null, null],
  ];
  for (const [text, kind, start, end] of cases) {
    assert.deepEqual(view.parseDate(text), { text, kind, start, end }, text);
  }
});

test("Timeline places the current Event among earlier dated Events, in date order", () => {
  const n = notes();
  const t = view.buildView(n, 150000).current.timeline;
  assert.deepEqual(t.placed.map((i) => i.entity.id), ["e-raids", "e-reign", "e-edington"]);
  assert.deepEqual(t.placed.map((i) => i.current), [false, false, true]);
  assert.ok(!t.placed.some((i) => i.entity.id === "e-later"), "an Event not yet introduced is never shown");

  const root = renderCueView(fakeDocument(), view.buildView(n, 150000));
  const dates = findAll(root, (x) => hasClass(x, "cue-timeline__date")).map((x) => x.textContent);
  assert.deepEqual(dates, ["the late 8th century", "871–899", "May 878"]);
  const kinds = findAll(root, (x) => x.tagName === "g" && x.getAttribute("data-date-kind")).map((x) => x.getAttribute("data-date-kind"));
  assert.deepEqual(kinds, ["approximate", "range", "exact"]);
});

test("an Event with no date is listed, not placed", () => {
  const d = draft();
  d.entities.find((e) => e.id === "e-edington").date = null;
  const t = view.buildView(view.normalizeDraft(d), 150000).current.timeline;
  assert.deepEqual(t.unplaced.map((i) => i.entity.id), ["e-edington"]);
  const root = renderCueView(fakeDocument(), view.buildView(view.normalizeDraft(d), 150000));
  assert.ok(findAll(root, (x) => x.textContent === "no date given in the Video").length === 1);
});

// ---------------------------------------------------------------------------
// Map categories

test("placeCategory follows the glossary and needs a position to draw", () => {
  assert.equal(view.placeCategory({ placement: "located", latitude: 1, longitude: 2 }), "located");
  assert.equal(view.placeCategory({ placement: "located", latitude: null, longitude: null }), "unplaced");
  assert.equal(view.placeCategory({ placement: "uncertain", latitude: 1, longitude: 2 }), "uncertain");
  assert.equal(view.placeCategory({ placement: "uncertain", latitude: null, longitude: 2 }), "unplaced");
  assert.equal(view.placeCategory({ placement: "unmappable", latitude: 1, longitude: 2 }), "unmappable");
  assert.equal(view.placeCategory(null), "unplaced");
  assert.equal(view.PLACE_LABELS.located, "Located place");
  assert.equal(view.PLACE_LABELS.uncertain, "Uncertain place");
  assert.equal(view.PLACE_LABELS.unmappable, "Unmappable place");
});

test("a Located place renders as a pin", () => {
  const root = renderCueView(fakeDocument(), view.buildView(notes(), 8000));
  const pins = findAll(root, (x) => hasClass(x, "cue-map__pin"));
  assert.equal(pins.length, 1);
  assert.equal(pins[0].getAttribute("data-category"), "located");
  assert.equal(findAll(root, (x) => hasClass(x, "cue-map__area")).length, 0);
});

test("an Uncertain place renders as a shaded area, never a pin", () => {
  const m = view.buildView(notes(), 90000).current.map;
  assert.deepEqual(m.areas.map((a) => a.entity.id), ["pl-brunanburh"]);
  assert.ok(!m.pins.some((p) => p.entity.id === "pl-brunanburh"));
  assert.equal(m.areas[0].radiusKm, 80);
  assert.equal(m.areas[0].radiusStated, true);

  const root = renderCueView(fakeDocument(), view.buildView(notes(), 90000));
  const area = find(root, (x) => hasClass(x, "cue-map__area"));
  assert.equal(area.getAttribute("data-category"), "uncertain");
  assert.ok(area.children.some((c) => c.tagName === "circle"));
  assert.ok(!area.children.some((c) => c.tagName === "path"), "no pin shape in an area");
  // Earlier Winchester is still a pin; the claimed-located Place with no position is only listed.
  const pins = findAll(root, (x) => hasClass(x, "cue-map__pin"));
  assert.equal(pins.length, 1);
  const legend = findAll(root, (x) => hasClass(x, "cue-map__legend-item")).map((x) => x.getAttribute("data-category"));
  assert.deepEqual(legend.sort(), ["located", "uncertain", "unplaced"]);
});

test("an Unmappable place renders as a schematic sketch, never on the map", () => {
  const m = view.buildView(notes(), 120000).current.map;
  assert.ok(!m.pins.concat(m.areas).some((p) => p.entity.id === "pl-avalon"));
  assert.deepEqual(m.sketches.map((s) => s.place.entity.id), ["pl-avalon"]);
  assert.deepEqual(m.sketches[0].relativeTo.map((e) => e.name), ["Winchester", "Brunanburh"]);

  const root = renderCueView(fakeDocument(), view.buildView(notes(), 120000));
  const sketch = find(root, (x) => hasClass(x, "cue-map__sketch"));
  assert.equal(sketch.getAttribute("data-category"), "unmappable");
  assert.match(sketch.getAttribute("aria-label"), /not a real map/);
  const frame = find(root, (x) => hasClass(x, "cue-map__frame"));
  assert.ok(!findAll(frame, (x) => x.textContent.includes("Avalon")).length, "Avalon is not drawn on the map frame");
  assert.ok(findAll(root, (x) => x.textContent.includes("Unmappable place: schematic sketch")).length);
});

test("Located place: a pin on OpenStreetMap tiles with attribution, not a relative-position plot", () => {
  const root = renderCueView(fakeDocument(), view.buildView(notes(), 8000));
  const tiles = findAll(root, (x) => hasClass(x, "cue-map__tile"));
  assert.ok(tiles.length >= 1);
  for (const t of tiles) assert.match(t.getAttribute("src"), /^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);
  assert.equal(find(root, (x) => hasClass(x, "cue-map__attribution")).textContent, "© OpenStreetMap contributors");
  assert.ok(findAll(root, (x) => x.getAttribute?.("aria-label") === "Zoom in").length === 1);
  assert.ok(findAll(root, (x) => x.getAttribute?.("aria-label") === "Zoom out").length === 1);
  assert.ok(!findAll(root, (x) => x.textContent.includes("No basemap")).length);
});

test("an Uncertain place alone is a shaded circle on tiles, with no pin", () => {
  const d = draft();
  d.entities = d.entities.filter((e) => e.id !== "pl-winchester");
  const root = renderCueView(fakeDocument(), view.buildView(view.normalizeDraft(d), 90000));
  assert.ok(findAll(root, (x) => hasClass(x, "cue-map__tile")).length >= 1);
  assert.equal(findAll(root, (x) => hasClass(x, "cue-map__pin")).length, 0);
  assert.equal(findAll(root, (x) => x.tagName === "path").length, 0);
  assert.equal(findAll(root, (x) => hasClass(x, "cue-map__area")).length, 1);
});

test("an Uncertain place without a stated radius gets a deliberately large default", () => {
  const d = draft();
  d.entities.find((e) => e.id === "pl-brunanburh").place.approxRadiusKm = null;
  const area = view.buildView(view.normalizeDraft(d), 90000).current.map.areas[0];
  assert.equal(area.radiusStated, false);
  assert.ok(area.radiusKm >= 50);
});

test("Unmappable alone has a labelled sketch and no tile map", () => {
  const d = draft();
  d.entities = d.entities.filter((e) => e.id !== "pl-winchester" && e.id !== "pl-brunanburh");
  d.entities.find((e) => e.id === "pl-avalon").place.relativeToIds = [];
  const root = renderCueView(fakeDocument(), view.buildView(view.normalizeDraft(d), 120000));
  assert.equal(findAll(root, (x) => hasClass(x, "cue-map__tile")).length, 0);
  assert.equal(findAll(root, (x) => hasClass(x, "cue-map__attribution")).length, 0);
  assert.equal(find(root, (x) => hasClass(x, "cue-map__sketch-label")).textContent, "Sketch, not a real map: Avalon");
});

test("mixed categories: real Places on the tile map, the Unmappable place in the sketch beneath it", () => {
  const root = renderCueView(fakeDocument(), view.buildView(notes(), 120000));
  const box = find(root, (x) => hasClass(x, "cue-map"));
  const order = box.children.map((c) => (hasClass(c, "cue-map__tiles") ? "tiles" : hasClass(c, "cue-map__sketch") ? "sketch" : ""));
  assert.ok(order.indexOf("tiles") !== -1 && order.indexOf("tiles") < order.indexOf("sketch"));
  const frame = find(root, (x) => hasClass(x, "cue-map__frame"));
  assert.equal(findAll(frame, (x) => hasClass(x, "cue-map__pin")).length, 1); // Winchester, relative to Avalon
  assert.equal(findAll(frame, (x) => hasClass(x, "cue-map__area")).length, 1); // Brunanburh
  assert.equal(findAll(frame, (x) => x.textContent.includes("Avalon")).length, 0);
});

test("Map labels each Place with when it mattered and omits Places not yet introduced", () => {
  const m = view.buildView(notes(), 8000).current.map;
  assert.deepEqual(m.places.map((p) => [p.entity.id, p.mattersAtMs]), [["pl-winchester", 8000]]);
  const root = renderCueView(fakeDocument(), view.buildView(notes(), 8000));
  assert.ok(findAll(root, (x) => x.textContent === "Winchester · 0:08").length === 1);
});

// ---------------------------------------------------------------------------
// Outside knowledge and feed

test("Outside knowledge is labelled distinctly in the current Cue and the feed", () => {
  const n = notes();
  const now = renderCueView(fakeDocument(), view.buildView(n, 8000));
  assert.equal(find(now, (x) => hasClass(x, "cue-outside__label")).textContent, "Outside knowledge");
  assert.equal(find(now, (x) => hasClass(x, "cue-outside__text")).textContent, "Capital of Wessex.");
  assert.ok(!findAll(now, (x) => hasClass(x, "cue-card__from-video") && x.textContent.includes("Wessex")).length);

  const later = renderCueView(fakeDocument(), view.buildView(n, 61000));
  const feed = find(later, (x) => hasClass(x, "cue-feed"));
  assert.equal(feed.children.length, 1);
  assert.equal(find(feed, (x) => hasClass(x, "cue-outside__label")).textContent, "Outside knowledge");
});

test("before the first Cue the view says so without revealing it", () => {
  const root = renderCueView(fakeDocument(), view.buildView(notes(), 1000));
  assert.equal(find(root, (x) => hasClass(x, "cue-view__empty")).textContent, "No Cue yet. Cues appear as the Video reaches them.");
  assert.ok(!findAll(root, (x) => x.textContent.includes("Winchester")).length);
});

// ---------------------------------------------------------------------------
// No spoilers from the Entities a Cue links

// A Cue at 100000 that links Entities first mentioned later (as a Draft or a
// user's edit can): Guthrum (500000), a later battle (700000), a later Place.
function spoilerNotes() {
  const d = draft();
  d.entities.push(place("pl-later", "Later town", 800000, { placement: "located", latitude: 52, longitude: 0 }));
  d.cues.push(cue("cue-spoil", 100000, "callback", ["p-edward", "p-guthrum", "e-later", "pl-later"]));
  return view.normalizeDraft(d);
}

test("a Cue never shows an Entity it links before that Entity's First mention", () => {
  const n = spoilerNotes();
  const v = view.buildView(n, 100000);
  assert.equal(v.current.cue.id, "cue-spoil");
  assert.deepEqual(v.current.entities.map((e) => e.id), ["p-edward"]);
  assert.deepEqual(v.current.cue.entityIds, ["p-edward", "p-guthrum", "e-later", "pl-later"], "kept in the Notes, not deleted");
  // Relationship card: Edward's card exists, but Guthrum ("fought") isn't on it.
  assert.deepEqual(v.current.relationshipCards.map((c) => c.person.id), ["p-edward"]);
  assert.ok(v.current.relationshipCards.every((c) => c.links.every((l) => l.other.id !== "p-guthrum")));
  assert.equal(v.current.timeline, null, "the later Event isn't on a Timeline");
  assert.equal(v.current.map, null, "the later Place isn't on a Map");

  const root = renderCueView(fakeDocument(), v);
  for (const hidden of ["Guthrum", "Later battle", "Later town"]) {
    assert.ok(!root.textContent.includes(hidden), `${hidden} rendered at 1:40`);
  }

  // Further on, in the feed of earlier Cues, it still isn't shown at that Cue.
  const later = view.buildView(n, 900000);
  const feedItem = later.earlier.find((item) => item.cue.id === "cue-spoil");
  assert.deepEqual(feedItem.entities.map((e) => e.id), ["p-edward"]);
  assert.ok(!renderCueView(fakeDocument(), view.buildView(n, 150000)).textContent.includes("Guthrum"));
});

test("an Entity is shown at a Cue from its First mention on, and one with no Mentions is introduced by the Cue", () => {
  const d = draft();
  d.entities.push({ id: "p-nameless", kind: "person", name: "Nameless", summary: "", firstMentionMs: null, mentionsMs: [], place: null, date: null });
  d.cues.push(cue("cue-same", 500000, "gap", ["p-guthrum", "p-nameless"]));
  const v = view.buildView(view.normalizeDraft(d), 500000);
  assert.deepEqual(v.current.entities.map((e) => e.id), ["p-guthrum", "p-nameless"]);
  assert.equal(view.shownAtCue({ firstMentionMs: 500001 }, 500000), false);
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
