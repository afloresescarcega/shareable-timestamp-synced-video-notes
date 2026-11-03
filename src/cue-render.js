// Builds the Cue view's DOM from CueView view models. Dependency-free DOM and
// inline SVG; the Map's only remote content is OpenStreetMap tile images
// (<img>, no remote code). The document is passed in so tests can render into
// a minimal fake.
//
//   CueRender.renderCueView(document, view, handlers, editor)
//
// handlers: { onJumpBack(entity), onReturn() } for reading, plus, when the
// Cues are editable:
//   onAdd()                         open the editor for a user Cue at the playhead
//   onEdit(cueId)                   open the editor for a Cue
//   onCancelEdit()
//   onSave(values) -> error | null  values: { kind, atMs, entityIds, fromVideo, outsideKnowledge }
//   onDelete(cueId)
//   onUsePlayhead() -> ms | null
//   onMergeEntities(keepId, mergeId, values) -> error | null
//   onSplitEntity(entityId, { name, mentionsMs }, values) -> error | null
// editor: CueView.cueEditorModel(...) or null.
//
// Saving, deleting, merging and splitting change the Notes, so they only
// respond to the user's own clicks and key presses, never to a script in the
// page clicking the panel's buttons (src/user-action.js).
(() => {
  "use strict";

  const load = (path, name) =>
    typeof module === "object" && module.exports ? require(path) : globalThis[name];
  const cueView = load("./cue-view.js", "CueView");
  const mapTiles = load("./map-tiles.js", "MapTiles");
  const { userOnly, isUserAction: userAction } = load("./user-action.js", "CueUserAction");
  const { formatTimestamp, parseTimestamp, CUE_KIND_LABELS, ENTITY_KIND_LABELS, PLACE_LABELS } = cueView;

  const SVG_NS = "http://www.w3.org/2000/svg";

  function el(doc, tag, className, content) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function svg(doc, tag, attrs = {}, content) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (content !== undefined) node.textContent = content;
    return node;
  }

  function button(doc, text, className, onClick) {
    const b = el(doc, "button", `cue-panel__button ${className}`, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  const names = (entities) => entities.map((e) => e.name).join(", ");

  // Outside knowledge is always set apart and labelled (glossary: less trustworthy).
  function outsideKnowledge(doc, value) {
    const box = el(doc, "div", "cue-outside");
    box.append(el(doc, "span", "cue-outside__label", "Outside knowledge"), el(doc, "span", "cue-outside__note", " · not from this Video"));
    box.append(el(doc, "p", "cue-outside__text", value));
    return box;
  }

  const ORIGIN_LABELS = Object.freeze({ user: "Added by you", edited: "Edited" });

  function cueHeader(doc, cue, handlers = {}) {
    const header = el(doc, "div", "cue-card__meta");
    const kind = el(doc, "span", "cue-card__kind", CUE_KIND_LABELS[cue.kind]);
    kind.setAttribute("data-kind", cue.kind);
    header.append(kind, el(doc, "span", "cue-card__time", ` · ${formatTimestamp(cue.atMs)}`));
    const marker = cue.origin === "user" ? "user" : cue.edited ? "edited" : null;
    if (marker) {
      const tag = el(doc, "span", "cue-card__origin", ` · ${ORIGIN_LABELS[marker]}`);
      tag.setAttribute("data-origin", marker);
      header.append(tag);
    }
    if (handlers.onEdit) {
      const edit = button(doc, "Edit", "cue-card__edit", () => handlers.onEdit(cue.id));
      edit.setAttribute("aria-label", `Edit the ${CUE_KIND_LABELS[cue.kind]} at ${formatTimestamp(cue.atMs)}`);
      header.append(edit);
    }
    return header;
  }

  // ---------------------------------------------------------------------------
  // Cue editor. Inputs sit inside their <label>s, so no ids are needed.

  function labelled(doc, text, control, className = "", note = null) {
    const label = el(doc, "label", `cue-editor__field ${className}`.trim());
    const caption = el(doc, "span", "cue-editor__label", text);
    if (note) caption.append(el(doc, "span", "cue-outside__note", note));
    label.append(caption, control);
    return label;
  }

  function input(doc, type, className, value) {
    const node = el(doc, type === "textarea" ? "textarea" : "input", className);
    if (type !== "textarea") node.type = type;
    node.value = value;
    return node;
  }

  function checkbox(doc, value, checked, text, className) {
    const box = input(doc, "checkbox", className, value);
    box.checked = checked;
    const label = el(doc, "label", "cue-editor__check");
    label.append(box, doc.createTextNode(` ${text}`));
    return { box, label };
  }

  function cueEditor(doc, model, handlers) {
    const v = model.values;
    const root = el(doc, "div", "cue-editor");
    root.setAttribute("data-cue-id", model.cueId ?? "");
    // Typing here must not trigger YouTube's keyboard shortcuts.
    root.addEventListener("keydown", (event) => event.stopPropagation());

    const form = el(doc, "form", "cue-editor__form");
    form.setAttribute("aria-label", model.isNew ? "Add Cue" : "Edit Cue");
    form.append(el(doc, "h3", "cue-editor__title", model.isNew ? "Add Cue" : "Edit Cue"));

    const kind = el(doc, "select", "cue-editor__kind");
    for (const k of Object.keys(CUE_KIND_LABELS)) {
      const option = el(doc, "option", null, CUE_KIND_LABELS[k]);
      option.value = k;
      option.selected = k === v.kind;
      kind.append(option);
    }
    kind.value = v.kind;

    // Typed times are whole seconds; keep the exact time unless it's changed.
    let atMs = v.atMs;
    let atText = formatTimestamp(atMs);
    const at = input(doc, "text", "cue-editor__at", atText);
    at.setAttribute("inputmode", "numeric");
    at.setAttribute("autocomplete", "off");
    at.setAttribute("placeholder", "m:ss");
    const usePlayhead = button(doc, "Use playhead", "cue-editor__playhead", () => {
      const ms = handlers.onUsePlayhead?.();
      if (typeof ms !== "number" || !Number.isFinite(ms)) return;
      atMs = Math.round(ms);
      atText = formatTimestamp(atMs);
      at.value = atText;
    });
    const timeRow = el(doc, "div", "cue-editor__row");
    timeRow.append(labelled(doc, "Kind", kind), labelled(doc, "At", at, "cue-editor__field--time"), usePlayhead);

    const entityBoxes = [];
    const entities = el(doc, "fieldset", "cue-editor__entities");
    entities.append(el(doc, "legend", "cue-editor__label", "Entities"));
    const notShown = new Set(model.notShownIds ?? []);
    for (const e of model.choices) {
      const { box, label } = checkbox(doc, e.id, v.entityIds.includes(e.id), `${e.name} (${ENTITY_KIND_LABELS[e.kind]})`, "cue-editor__entity");
      if (notShown.has(e.id)) {
        // Kept if chosen, but the Cue never shows an Entity before its First mention.
        label.append(el(doc, "span", "cue-editor__not-shown", ` · first mentioned at ${formatTimestamp(e.firstMentionMs)}, so not shown at this Cue`));
      }
      entityBoxes.push(box);
      entities.append(label);
    }
    if (!model.choices.length) entities.append(el(doc, "p", "cue-editor__hint", "No Entities introduced yet."));

    const fromVideo = input(doc, "textarea", "cue-editor__from-video", v.fromVideo ?? "");
    fromVideo.rows = 2;
    const outside = input(doc, "textarea", "cue-editor__outside", v.outsideKnowledge ?? "");
    outside.rows = 2;
    const outsideField = labelled(doc, "Outside knowledge", outside, "cue-editor__field--outside", " · not from this Video");

    const error = el(doc, "p", "cue-editor__error", model.error);
    error.setAttribute("role", "alert");

    const values = () => ({
      kind: kind.value,
      atMs: at.value.trim() === atText ? atMs : parseTimestamp(at.value),
      entityIds: entityBoxes.filter((b) => b.checked).map((b) => b.value),
      fromVideo: fromVideo.value,
      outsideKnowledge: outside.value,
    });
    const report = (message) => {
      if (message) error.textContent = message;
    };

    const save = el(doc, "button", "cue-panel__button cue-editor__save", model.isNew ? "Add Cue" : "Save");
    save.type = "submit";
    const actions = el(doc, "div", "cue-editor__actions");
    actions.append(save, button(doc, "Cancel", "cue-editor__cancel", () => handlers.onCancelEdit?.()));
    if (!model.isNew) {
      // Two steps, since a deleted Cue can't be brought back.
      const del = button(doc, "Delete Cue", "cue-editor__delete", userOnly(() => {
        if (del.getAttribute("data-confirm") === "true") return handlers.onDelete?.(model.cueId);
        del.setAttribute("data-confirm", "true");
        del.textContent = "Confirm delete";
      }));
      actions.append(del);
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault?.();
      if (!userAction(event)) return;
      report(handlers.onSave?.(values()));
    });
    form.append(
      timeRow,
      entities,
      labelled(doc, "From the Video", fromVideo),
      outsideField,
      error,
      actions
    );
    root.append(form);
    if (model.entityTools.length) root.append(entityTools(doc, model, handlers, values, report));
    return root;
  }

  // Merge or split the Cue's Entities: corrects which Entity a Mention refers to.
  function entityTools(doc, model, handlers, values, report) {
    const details = el(doc, "details", "cue-entity-tools");
    details.append(el(doc, "summary", "cue-entity-tools__summary", "Merge or split Entities"));
    details.append(el(doc, "p", "cue-editor__hint", "Applies right away to every Cue."));
    for (const tool of model.entityTools) {
      const { entity } = tool;
      const box = el(doc, "div", "cue-entity-tool");
      box.setAttribute("data-entity-id", entity.id);
      box.append(el(doc, "p", "cue-entity-tool__name", `${entity.name} (${ENTITY_KIND_LABELS[entity.kind]})`));

      if (tool.mergeTargets.length) {
        const target = el(doc, "select", "cue-entity-tool__target");
        for (const other of tool.mergeTargets) {
          const option = el(doc, "option", null, other.firstMentionMs === null ? other.name : `${other.name} · ${formatTimestamp(other.firstMentionMs)}`);
          option.value = other.id;
          target.append(option);
        }
        target.value = tool.mergeTargets[0].id;
        const merge = button(doc, "Merge", "cue-entity-tool__merge", userOnly(() =>
          report(handlers.onMergeEntities?.(target.value, entity.id, values()))
        ));
        merge.setAttribute("aria-label", `Merge ${entity.name} into the chosen Entity`);
        const row = el(doc, "div", "cue-editor__row");
        row.append(labelled(doc, `Merge ${entity.name} into`, target), merge);
        box.append(row);
      }

      if (tool.mentionsMs.length > 1) {
        const name = input(doc, "text", "cue-entity-tool__split-name", "");
        name.setAttribute("autocomplete", "off");
        const mentions = el(doc, "fieldset", "cue-entity-tool__mentions");
        mentions.append(el(doc, "legend", "cue-editor__label", "Mentions for the new Entity"));
        const boxes = tool.mentionsMs.map((ms) => {
          const { box: b, label } = checkbox(doc, String(ms), false, formatTimestamp(ms), "cue-entity-tool__mention");
          mentions.append(label);
          return b;
        });
        const split = button(doc, "Split", "cue-entity-tool__split", userOnly(() =>
          report(handlers.onSplitEntity?.(entity.id, { name: name.value, mentionsMs: boxes.filter((b) => b.checked).map((b) => Number(b.value)) }, values()))
        ));
        split.setAttribute("aria-label", `Split ${entity.name} into a new Entity`);
        box.append(labelled(doc, "New Entity name", name), mentions, split);
      }
      details.append(box);
    }
    return details;
  }

  // ---------------------------------------------------------------------------
  // Relationship card

  function relationshipCard(doc, card) {
    const box = el(doc, "div", "cue-relationships");
    box.setAttribute("aria-label", `Relationship card for ${card.person.name}`);
    box.append(el(doc, "div", "cue-relationships__person", card.person.name));
    const list = el(doc, "ul", "cue-relationships__links");
    for (const link of card.links) {
      const row = el(doc, "li", "cue-relationships__link");
      const name = (entity) => el(doc, "span", entity === card.person ? "cue-relationships__self" : "cue-relationships__other", entity.name);
      row.append(name(link.from), el(doc, "span", "cue-relationships__label", ` ${link.label} `), name(link.to));
      list.append(row);
    }
    box.append(list);
    return box;
  }

  // ---------------------------------------------------------------------------
  // Timeline

  const DATE_KIND_LABELS = Object.freeze({ exact: "exact", range: "range", approximate: "approximate" });

  function timeline(doc, model) {
    const box = el(doc, "div", "cue-timeline");
    const W = 320;
    const H = 44;
    const PAD = 14;
    if (model.placed.length) {
      const span = model.max - model.min;
      const x = (year) => (span > 0 ? PAD + ((year - model.min) / span) * (W - 2 * PAD) : W / 2);
      const strip = svg(doc, "svg", { viewBox: `0 0 ${W} ${H}`, class: "cue-timeline__strip", role: "img", "aria-label": "Timeline" });
      strip.append(svg(doc, "line", { x1: PAD, y1: H / 2, x2: W - PAD, y2: H / 2, class: "cue-timeline__axis" }));
      model.placed.forEach((item, i) => {
        const { kind, start, end } = item.date;
        const cls = `cue-timeline__mark cue-timeline__mark--${kind}${item.current ? " is-current" : ""}`;
        const y = H / 2;
        const g = svg(doc, "g", { class: cls, "data-date-kind": kind });
        if (start === end && kind !== "approximate") {
          g.append(svg(doc, "circle", { cx: x(start), cy: y, r: 5 }));
        } else if (start === end) {
          // Approximate single year: a hollow, wider mark, not a precise dot.
          g.append(svg(doc, "circle", { cx: x(start), cy: y, r: 8, class: "cue-timeline__fuzzy" }));
        } else {
          const x1 = x(start);
          const x2 = Math.max(x(end), x1 + 4);
          g.append(svg(doc, "rect", { x: x1, y: y - 4, width: x2 - x1, height: 8, rx: 4, class: kind === "approximate" ? "cue-timeline__fuzzy" : "" }));
        }
        g.append(svg(doc, "text", { x: x(start), y: y - 10, "text-anchor": "middle", class: "cue-timeline__num" }, String(i + 1)));
        g.append(svg(doc, "title", {}, `${item.entity.name}: ${item.date.text}`));
        strip.append(g);
      });
      box.append(strip);
    }
    const list = el(doc, "ol", "cue-timeline__list");
    const row = (item, n) => {
      const li = el(doc, "li", `cue-timeline__item${item.current ? " is-current" : ""}`);
      if (n) li.append(el(doc, "span", "cue-timeline__n", `${n}. `));
      li.append(el(doc, "span", "cue-timeline__name", item.entity.name), doc.createTextNode(" — "));
      if (item.date) {
        // Exactly as the Transcript said it.
        li.append(el(doc, "span", "cue-timeline__date", item.date.text));
        const tag = el(doc, "span", "cue-timeline__kind", ` (${DATE_KIND_LABELS[item.date.kind]})`);
        tag.setAttribute("data-date-kind", item.date.kind);
        li.append(tag);
      } else {
        li.append(el(doc, "span", "cue-timeline__date cue-timeline__date--none", "no date given in the Video"));
      }
      return li;
    };
    model.placed.forEach((item, i) => list.append(row(item, i + 1)));
    model.unplaced.forEach((item) => list.append(row(item, 0)));
    box.append(list);
    return box;
  }

  // ---------------------------------------------------------------------------
  // Map

  const whenLabel = (place) => (place.mattersAtMs === null ? "" : ` · ${formatTimestamp(place.mattersAtMs)}`);

  const MAP_WIDTH = 320;
  const MAP_HEIGHT = 220;
  const MAP_PADDING = 32;
  const MIN_AREA_RADIUS_PX = 8;

  // The real Places on OpenStreetMap tiles: a pin per Located place, a shaded
  // circle (sized from approxRadiusKm) per Uncertain place. Fitted to every
  // real Place shown; drag / wheel / +/- buttons pan and zoom.
  function mapFrame(doc, model) {
    const { TILE_SIZE } = mapTiles;
    const w = MAP_WIDTH;
    const h = MAP_HEIGHT;
    const real = [
      ...model.areas.map((a) => ({ ...a, kind: "area" })),
      ...model.pins.map((p) => ({ ...p, kind: "pin" })),
    ];
    const fitted = mapTiles.fitView(
      real.map((p) => ({ latitude: p.latitude, longitude: p.longitude, radiusKm: p.kind === "area" ? p.radiusKm : 0 })),
      { width: w, height: h, padding: MAP_PADDING }
    );
    let view = fitted;

    const box = el(doc, "div", "cue-map__tiles");
    box.setAttribute("style", `position:relative;width:${w}px;max-width:100%;height:${h}px;overflow:hidden;touch-action:none;cursor:grab;`);
    box.setAttribute("role", "application");
    box.setAttribute("aria-label", "Map of Places on OpenStreetMap. Drag to pan, scroll or use the zoom buttons to zoom.");
    const layer = el(doc, "div", "cue-map__tile-layer");
    const overlay = svg(doc, "svg", {
      viewBox: `0 0 ${w} ${h}`,
      class: "cue-map__frame",
      role: "img",
      "aria-label": "Located places as pins and Uncertain places as shaded areas",
      width: w,
      height: h,
    });
    overlay.setAttribute("style", "position:absolute;left:0;top:0;pointer-events:none;");

    function draw() {
      layer.textContent = "";
      for (const t of mapTiles.visibleTiles(view, w, h)) {
        if (!t.url) continue;
        const img = el(doc, "img", "cue-map__tile");
        img.setAttribute("alt", "");
        img.setAttribute("draggable", "false");
        img.setAttribute("src", t.url);
        img.setAttribute("style", `position:absolute;left:${Math.round(t.left)}px;top:${Math.round(t.top)}px;width:${TILE_SIZE}px;height:${TILE_SIZE}px;max-width:none;user-select:none;`);
        layer.append(img);
      }
      overlay.textContent = "";
      for (const area of model.areas) {
        const at = mapTiles.project(view, w, h, area.longitude, area.latitude);
        const r = Math.max(mapTiles.kmToPixels(area.radiusKm, area.latitude, view.zoom), MIN_AREA_RADIUS_PX);
        const g = svg(doc, "g", { class: `cue-map__area${area.current ? " is-current" : ""}`, "data-category": "uncertain" });
        g.append(svg(doc, "circle", { cx: at.x, cy: at.y, r }));
        g.append(svg(doc, "text", { x: at.x, y: at.y + 4, "text-anchor": "middle" }, `${area.entity.name}${whenLabel(area)}`));
        g.append(svg(doc, "title", {}, `${area.entity.name}: ${PLACE_LABELS.uncertain}, approximate area`));
        overlay.append(g);
      }
      for (const pin of model.pins) {
        const at = mapTiles.project(view, w, h, pin.longitude, pin.latitude);
        const g = svg(doc, "g", { class: `cue-map__pin${pin.current ? " is-current" : ""}`, "data-category": "located" });
        g.append(svg(doc, "path", { d: `M${at.x} ${at.y} l-5 -10 a6 6 0 1 1 10 0 z` }));
        g.append(svg(doc, "text", { x: at.x + 8, y: at.y - 6 }, `${pin.entity.name}${whenLabel(pin)}`));
        g.append(svg(doc, "title", {}, `${pin.entity.name}: ${PLACE_LABELS.located}`));
        overlay.append(g);
      }
    }

    const zoomBy = (delta, ax, ay) => {
      view = mapTiles.zoomTo(view, view.zoom + delta, w, h, ax, ay);
      draw();
    };

    // Drag to pan.
    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      if (e.button) return;
      drag = { x: e.clientX, y: e.clientY };
      box.setPointerCapture?.(e.pointerId);
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      view = mapTiles.panBy(view, e.clientX - drag.x, e.clientY - drag.y);
      drag = { x: e.clientX, y: e.clientY };
      draw();
    });
    const endDrag = () => {
      drag = null;
    };
    box.addEventListener("pointerup", endDrag);
    box.addEventListener("pointercancel", endDrag);
    // Wheel to zoom about the pointer (one level per gesture burst).
    let lastWheel = 0;
    box.addEventListener("wheel", (e) => {
      e.preventDefault?.();
      const now = Date.now();
      if (now - lastWheel < 120) return;
      lastWheel = now;
      const rect = box.getBoundingClientRect?.();
      zoomBy(e.deltaY < 0 ? 1 : -1, rect ? e.clientX - rect.left : undefined, rect ? e.clientY - rect.top : undefined);
    });

    const controls = el(doc, "div", "cue-map__zoom");
    controls.setAttribute("style", "position:absolute;top:6px;right:6px;display:flex;flex-direction:column;gap:2px;");
    for (const [label, aria, delta] of [["+", "Zoom in", 1], ["−", "Zoom out", -1]]) {
      const b = button(doc, label, "cue-map__zoom-button", () => zoomBy(delta));
      b.setAttribute("aria-label", aria);
      controls.append(b);
    }
    const attribution = el(doc, "a", "cue-map__attribution", mapTiles.ATTRIBUTION);
    attribution.setAttribute("href", mapTiles.ATTRIBUTION_URL);
    attribution.setAttribute("target", "_blank");
    attribution.setAttribute("rel", "noopener noreferrer");

    draw();
    box.append(layer, overlay, controls, attribution);
    return box;
  }

  // An Unmappable place: a labelled schematic sketch, never drawn on the map.
  function sketch(doc, { place, relativeTo }) {
    const W = 320;
    const H = 120;
    const box = svg(doc, "svg", {
      viewBox: `0 0 ${W} ${H}`,
      class: "cue-map__sketch",
      role: "img",
      "aria-label": `Schematic sketch of ${place.entity.name}, not a real map`,
      "data-category": "unmappable",
    });
    const cx = W / 2;
    const cy = H / 2;
    relativeTo.forEach((other, i) => {
      const angle = (2 * Math.PI * i) / relativeTo.length - Math.PI / 2;
      const ox = cx + Math.cos(angle) * 110;
      const oy = cy + Math.sin(angle) * 40;
      box.append(svg(doc, "line", { x1: cx, y1: cy, x2: ox, y2: oy, class: "cue-map__sketch-link" }));
      box.append(svg(doc, "text", { x: ox, y: oy + 4, "text-anchor": "middle", class: "cue-map__sketch-other" }, other.name));
    });
    box.append(svg(doc, "rect", { x: cx - 60, y: cy - 12, width: 120, height: 24, rx: 12, class: "cue-map__sketch-node" }));
    box.append(svg(doc, "text", { x: cx, y: cy + 4, "text-anchor": "middle" }, place.entity.name));
    return box;
  }

  function map(doc, model) {
    const box = el(doc, "div", "cue-map");
    if (model.pins.length || model.areas.length) {
      box.append(mapFrame(doc, model));
      box.append(el(doc, "p", "cue-map__note", "Pins mark Located places. Shaded circles are Uncertain places: the area is approximate."));
    }
    for (const s of model.sketches) {
      box.append(el(doc, "p", "cue-map__sketch-label", `Sketch, not a real map: ${s.place.entity.name}`));
      box.append(sketch(doc, s));
      const rel = s.relativeTo.length ? ` Known only relative to ${names(s.relativeTo)}.` : "";
      box.append(el(doc, "p", "cue-map__note", `${PLACE_LABELS.unmappable}: schematic sketch, not to scale and not a real map.${rel}`));
    }
    const legend = el(doc, "ul", "cue-map__legend");
    for (const p of model.places) {
      const li = el(doc, "li", `cue-map__legend-item${p.current ? " is-current" : ""}`);
      li.setAttribute("data-category", p.category);
      li.append(el(doc, "span", "cue-map__name", p.entity.name), doc.createTextNode(` — ${PLACE_LABELS[p.category]}`));
      if (p.mattersAtMs !== null) li.append(doc.createTextNode(`, first mentioned ${formatTimestamp(p.mattersAtMs)}`));
      legend.append(li);
    }
    box.append(legend);
    return box;
  }

  // ---------------------------------------------------------------------------
  // Cues

  function visual(doc, title, content) {
    const section = el(doc, "section", "cue-visual");
    section.append(el(doc, "h4", "cue-visual__title", title), content);
    return section;
  }

  function currentCue(doc, item, handlers, editor) {
    const { cue, entities, callback } = item;
    const card = el(doc, "article", "cue-card cue-card--current");
    card.setAttribute("data-cue-id", cue.id);
    if (editor?.cueId === cue.id) {
      card.append(cueEditor(doc, editor, handlers));
      return card;
    }
    card.append(cueHeader(doc, cue, handlers));
    if (entities.length) card.append(el(doc, "h3", "cue-card__title", names(entities)));
    if (cue.fromVideo) card.append(el(doc, "p", "cue-card__from-video", cue.fromVideo));

    if (callback) {
      const back = el(doc, "div", "cue-callback");
      const { entity } = callback;
      back.append(el(doc, "p", "cue-callback__entity", entity.summary ? `${entity.name}: ${entity.summary}` : entity.name));
      const jump = button(doc, `First mention: ${formatTimestamp(callback.firstMentionMs)}`, "cue-callback__jump", () => handlers.onJumpBack(entity));
      jump.setAttribute("aria-label", `Jump back to the First mention of ${entity.name} at ${formatTimestamp(callback.firstMentionMs)}`);
      back.append(jump);
      card.append(back);
    }

    for (const entity of entities) {
      if (entity === callback?.entity || !entity.summary) continue;
      card.append(el(doc, "p", "cue-card__entity", `${entity.name}: ${entity.summary}`));
    }
    if (cue.outsideKnowledge) card.append(outsideKnowledge(doc, cue.outsideKnowledge));

    for (const rc of item.relationshipCards) card.append(visual(doc, "Relationship card", relationshipCard(doc, rc)));
    if (item.map) card.append(visual(doc, "Map", map(doc, item.map)));
    if (item.timeline) card.append(visual(doc, "Timeline", timeline(doc, item.timeline)));
    return card;
  }

  function feedItem(doc, item, handlers, editor) {
    const { cue, entities } = item;
    const li = el(doc, "li", "cue-card cue-card--earlier");
    li.setAttribute("data-cue-id", cue.id);
    if (editor?.cueId === cue.id) {
      li.append(cueEditor(doc, editor, handlers));
      return li;
    }
    li.append(cueHeader(doc, cue, handlers));
    if (entities.length) li.append(el(doc, "p", "cue-card__names", names(entities)));
    if (cue.fromVideo) li.append(el(doc, "p", "cue-card__from-video", cue.fromVideo));
    if (cue.outsideKnowledge) li.append(outsideKnowledge(doc, cue.outsideKnowledge));
    return li;
  }

  function renderCueView(doc, view, handlers = {}, editor = null) {
    const root = el(doc, "div", "cue-view__content");
    if (view.returnToMs !== null) {
      root.append(button(doc, `Return to ${formatTimestamp(view.returnToMs)}`, "cue-return", () => handlers.onReturn?.()));
    }
    // A new Cue, or one being edited that isn't on screen, is edited up top.
    const shownIds = [view.current, ...view.earlier].filter(Boolean).map((item) => item.cue.id);
    if (editor && (editor.isNew || !shownIds.includes(editor.cueId))) {
      root.append(cueEditor(doc, editor, handlers));
    } else if (handlers.onAdd && !editor) {
      const add = button(doc, "Add Cue here", "cue-add", () => handlers.onAdd());
      add.setAttribute("aria-label", "Add a Cue at the current playhead");
      root.append(add);
    }
    if (!view.cueCount) {
      root.append(el(doc, "p", "cue-view__empty", "The Draft has no Cues for this Video."));
      return root;
    }
    if (!view.current) {
      root.append(el(doc, "p", "cue-view__empty", "No Cue yet. Cues appear as the Video reaches them."));
      return root;
    }
    root.append(currentCue(doc, view.current, handlers, editor));
    if (view.earlier.length) {
      const feed = el(doc, "ol", "cue-feed");
      feed.setAttribute("aria-label", "Earlier Cues");
      view.earlier.forEach((item) => feed.append(feedItem(doc, item, handlers, editor)));
      root.append(feed);
    }
    return root;
  }

  const api = { renderCueView };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.CueRender ??= Object.freeze(api);
})();
