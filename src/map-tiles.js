// Slippy-map maths for the Map: longitude/latitude <-> Web Mercator pixels,
// OpenStreetMap tile URLs, fitting a view to the Places shown, and pan/zoom.
// Pure (no DOM, no network); loads under Node for tests. src/cue-render.js
// draws the tiles as <img> elements using these numbers.
(() => {
  "use strict";

  const TILE_SIZE = 256;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 18;
  const MAX_LATITUDE = 85.0511287798; // the Web Mercator limit
  const KM_PER_DEGREE = 111.32;
  const EQUATOR_METERS_PER_PIXEL_AT_Z0 = 156543.03392; // for 256px tiles
  const ATTRIBUTION = "© OpenStreetMap contributors";
  const ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
  const TILE_URL_TEMPLATE = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clampLatitude = (lat) => clamp(lat, -MAX_LATITUDE, MAX_LATITUDE);
  const worldSize = (zoom) => TILE_SIZE * 2 ** zoom;
  // Any longitude into [-180, 180).
  const normalizeLongitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

  // The narrowest run of longitudes holding every item's centre, which may
  // cross the antimeridian: it starts just after the widest gap between
  // neighbouring centres, going round the world. Returns a function giving
  // each longitude inside that run (so values past 180 are possible).
  // Deterministic: of equal gaps, the first in sorted order wins.
  function longitudeUnwrapper(longitudes) {
    const sorted = longitudes.map(normalizeLongitude).sort((a, b) => a - b);
    let start = sorted[0];
    let widest = sorted[0] + 360 - sorted[sorted.length - 1];
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap > widest) {
        widest = gap;
        start = sorted[i];
      }
    }
    return (lon) => start + ((((normalizeLongitude(lon) - start) % 360) + 360) % 360);
  }

  // Longitude/latitude (degrees) -> pixel in the whole world at `zoom`,
  // origin top-left of the world, y down.
  function lonLatToPixel(lon, lat, zoom) {
    const size = worldSize(zoom);
    const sin = Math.sin((clampLatitude(lat) * Math.PI) / 180);
    return {
      x: ((lon + 180) / 360) * size,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
    };
  }

  function pixelToLonLat(x, y, zoom) {
    const size = worldSize(zoom);
    const n = Math.PI - (2 * Math.PI * y) / size;
    return {
      lon: (x / size) * 360 - 180,
      lat: (180 / Math.PI) * Math.atan(Math.sinh(n)),
    };
  }

  // The tile containing a position at an integer zoom.
  function lonLatToTile(lon, lat, zoom) {
    const { x, y } = lonLatToPixel(lon, lat, zoom);
    const max = 2 ** zoom - 1;
    return { x: clamp(Math.floor(x / TILE_SIZE), 0, max), y: clamp(Math.floor(y / TILE_SIZE), 0, max), z: zoom };
  }

  // URL of one tile. Longitude wraps around the world; a tile above or below
  // the world has no URL (null).
  function tileUrl(z, x, y) {
    const n = 2 ** z;
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || y < 0 || y >= n) return null;
    const wrappedX = ((x % n) + n) % n;
    return TILE_URL_TEMPLATE.replace("{z}", z).replace("{x}", wrappedX).replace("{y}", y);
  }

  // Ground distance covered by one pixel at a latitude.
  const metersPerPixel = (lat, zoom) =>
    (EQUATOR_METERS_PER_PIXEL_AT_Z0 * Math.cos((clampLatitude(lat) * Math.PI) / 180)) / 2 ** zoom;

  // Pixels spanned by a radius in km at a latitude (how an Uncertain place's
  // approxRadiusKm is drawn).
  const kmToPixels = (km, lat, zoom) => (km * 1000) / metersPerPixel(lat, zoom);

  // The view (centre and integer zoom) showing every item, each
  // { latitude, longitude, radiusKm? }, inside the width x height viewport
  // with `padding`. The zoom is the largest that fits, capped at
  // `maxFitZoom` so a lone Place isn't zoomed to street level. Places either
  // side of the antimeridian (Fiji and Samoa) are fitted across it, not
  // across the whole world.
  function fitView(items, { width, height, padding = 24, minZoom = MIN_ZOOM, maxZoom = MAX_ZOOM, maxFitZoom = 10 } = {}) {
    if (!items.length) return null;
    const unwrap = longitudeUnwrapper(items.map((item) => item.longitude));
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const item of items) {
      const r = item.radiusKm > 0 ? item.radiusKm : 0;
      const dLat = r / KM_PER_DEGREE;
      const dLon = r / (KM_PER_DEGREE * Math.max(0.01, Math.cos((clampLatitude(item.latitude) * Math.PI) / 180)));
      const lon = unwrap(item.longitude);
      west = Math.min(west, lon - dLon);
      east = Math.max(east, lon + dLon);
      south = Math.min(south, clampLatitude(item.latitude - dLat));
      north = Math.max(north, clampLatitude(item.latitude + dLat));
    }
    const availW = Math.max(1, width - 2 * padding);
    const availH = Math.max(1, height - 2 * padding);
    const limit = Math.min(maxZoom, maxFitZoom);
    let zoom = minZoom;
    for (let z = limit; z >= minZoom; z--) {
      const a = lonLatToPixel(west, north, z);
      const b = lonLatToPixel(east, south, z);
      if (b.x - a.x <= availW && b.y - a.y <= availH) {
        zoom = z;
        break;
      }
    }
    const a = lonLatToPixel(west, north, zoom);
    const b = lonLatToPixel(east, south, zoom);
    const c = pixelToLonLat((a.x + b.x) / 2, (a.y + b.y) / 2, zoom);
    return { lat: c.lat, lon: normalizeLongitude(c.lon), zoom };
  }

  // Top-left of the viewport in world pixels for a view.
  function viewOrigin(view, width, height) {
    const c = lonLatToPixel(view.lon, view.lat, view.zoom);
    return { x: c.x - width / 2, y: c.y - height / 2 };
  }

  // Where a position falls in the viewport (pixels from its top-left). The
  // world repeats sideways, so of a position's copies the one nearest the
  // centre is used: a Place at -179° shows beside a centre at 180°.
  function project(view, width, height, lon, lat) {
    const size = worldSize(view.zoom);
    const c = lonLatToPixel(view.lon, view.lat, view.zoom);
    const p = lonLatToPixel(lon, lat, view.zoom);
    let dx = p.x - c.x;
    dx -= Math.round(dx / size) * size;
    return { x: width / 2 + dx, y: p.y - c.y + height / 2 };
  }

  // Tiles covering the viewport, each with its URL and offset in the viewport.
  function visibleTiles(view, width, height) {
    const o = viewOrigin(view, width, height);
    const n = 2 ** view.zoom;
    const x0 = Math.floor(o.x / TILE_SIZE);
    const x1 = Math.floor((o.x + width - 1) / TILE_SIZE);
    const y0 = Math.max(0, Math.floor(o.y / TILE_SIZE));
    const y1 = Math.min(n - 1, Math.floor((o.y + height - 1) / TILE_SIZE));
    const tiles = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        tiles.push({ url: tileUrl(view.zoom, tx, ty), left: tx * TILE_SIZE - o.x, top: ty * TILE_SIZE - o.y });
      }
    }
    return tiles;
  }

  // Dragging the map by (dx, dy) screen pixels moves the centre the other way.
  function panBy(view, dx, dy) {
    const c = lonLatToPixel(view.lon, view.lat, view.zoom);
    const size = worldSize(view.zoom);
    const moved = pixelToLonLat(c.x - dx, clamp(c.y - dy, 0, size), view.zoom);
    return { ...view, lat: clampLatitude(moved.lat), lon: normalizeLongitude(moved.lon) };
  }

  // Zoom to `zoom`, keeping the position under the viewport point (ax, ay)
  // fixed (the centre when omitted), as wheel-zoom and +/- buttons expect.
  function zoomTo(view, zoom, width, height, ax = width / 2, ay = height / 2) {
    const next = clamp(Math.round(zoom), MIN_ZOOM, MAX_ZOOM);
    if (next === view.zoom) return view;
    const o = viewOrigin(view, width, height);
    const anchor = pixelToLonLat(o.x + ax, o.y + ay, view.zoom);
    const anchorNext = lonLatToPixel(anchor.lon, anchor.lat, next);
    const c = pixelToLonLat(anchorNext.x - (ax - width / 2), anchorNext.y - (ay - height / 2), next);
    return { zoom: next, lat: clampLatitude(c.lat), lon: normalizeLongitude(c.lon) };
  }

  const api = {
    TILE_SIZE,
    MIN_ZOOM,
    MAX_ZOOM,
    ATTRIBUTION,
    ATTRIBUTION_URL,
    TILE_URL_TEMPLATE,
    normalizeLongitude,
    lonLatToPixel,
    pixelToLonLat,
    lonLatToTile,
    tileUrl,
    metersPerPixel,
    kmToPixels,
    fitView,
    viewOrigin,
    project,
    visibleTiles,
    panBy,
    zoomTo,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.MapTiles ??= Object.freeze(api);
})();
