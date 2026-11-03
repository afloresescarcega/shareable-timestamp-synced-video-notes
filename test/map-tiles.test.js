// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../src/map-tiles.js");

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("lon/lat to world pixel: origin, equator and dateline", () => {
  const p0 = t.lonLatToPixel(-180, t.pixelToLonLat(0, 0, 0).lat, 0);
  near(p0.x, 0);
  near(p0.y, 0, 1e-4);
  const mid = t.lonLatToPixel(0, 0, 3);
  near(mid.x, 1024);
  near(mid.y, 1024);
  near(t.lonLatToPixel(180, 0, 2).x, 1024);
});

test("lon/lat <-> pixel round-trips", () => {
  for (const [lon, lat, z] of [[-1.31, 51.06, 10], [139.69, 35.68, 14], [-74, 40.7, 5]]) {
    const p = t.lonLatToPixel(lon, lat, z);
    const back = t.pixelToLonLat(p.x, p.y, z);
    near(back.lon, lon, 1e-9);
    near(back.lat, lat, 1e-9);
  }
});

test("lon/lat to tile uses the standard slippy-map scheme", () => {
  // Known values from the OSM wiki: London-ish at z10 is 511/340; Winchester 51.06,-1.31.
  assert.deepEqual(t.lonLatToTile(0, 0, 1), { x: 1, y: 1, z: 1 });
  assert.deepEqual(t.lonLatToTile(-0.1276, 51.5072, 10), { x: 511, y: 340, z: 10 });
  assert.deepEqual(t.lonLatToTile(-180, 0, 3), { x: 0, y: 4, z: 3 });
  assert.deepEqual(t.lonLatToTile(179.99, -89, 2), { x: 3, y: 3, z: 2 });
});

test("tile URLs point at tile.openstreetmap.org, wrap longitude, and reject rows off the world", () => {
  assert.equal(t.tileUrl(10, 511, 340), "https://tile.openstreetmap.org/10/511/340.png");
  assert.equal(t.tileUrl(2, -1, 1), "https://tile.openstreetmap.org/2/3/1.png");
  assert.equal(t.tileUrl(2, 4, 1), "https://tile.openstreetmap.org/2/0/1.png");
  assert.equal(t.tileUrl(2, 0, -1), null);
  assert.equal(t.tileUrl(2, 0, 4), null);
  assert.equal(t.ATTRIBUTION, "© OpenStreetMap contributors");
});

test("metres per pixel and radius scaling halve per zoom level and shrink with latitude", () => {
  near(t.metersPerPixel(0, 0), 156543.03392, 1e-5);
  near(t.metersPerPixel(0, 5), 156543.03392 / 32, 1e-6);
  near(t.metersPerPixel(60, 3) / t.metersPerPixel(0, 3), 0.5, 1e-9);
  // 100 km at the equator, z8 (611.5 m/px) is ~163.5px
  near(t.kmToPixels(100, 0, 8), 100000 / (156543.03392 / 256), 1e-6);
  near(t.kmToPixels(50, 40, 9) * 2, t.kmToPixels(100, 40, 9), 1e-9);
  near(t.kmToPixels(100, 40, 10), t.kmToPixels(100, 40, 9) * 2, 1e-9);
});

const size = { width: 320, height: 220, padding: 24 };

test("fitView: one point zooms to the cap and centres on it", () => {
  const v = t.fitView([{ latitude: 51.06, longitude: -1.31 }], size);
  assert.equal(v.zoom, 10);
  near(v.lat, 51.06, 1e-9);
  near(v.lon, -1.31, 1e-9);
  assert.equal(t.fitView([], size), null);
});

test("fitView: every Place shown lies inside the padded viewport", () => {
  const items = [{ latitude: 51.06, longitude: -1.31 }, { latitude: 55.95, longitude: -3.19 }, { latitude: 48.85, longitude: 2.35 }];
  const v = t.fitView(items, size);
  for (const i of items) {
    const p = t.project(v, size.width, size.height, i.longitude, i.latitude);
    assert.ok(p.x >= size.padding - 1e-6 && p.x <= size.width - size.padding + 1e-6, `x ${p.x}`);
    assert.ok(p.y >= size.padding - 1e-6 && p.y <= size.height - size.padding + 1e-6, `y ${p.y}`);
  }
  // one level closer would not fit
  const closer = { ...v, zoom: v.zoom + 1 };
  const xs = items.map((i) => t.project(closer, size.width, size.height, i.longitude, i.latitude));
  assert.ok(xs.some((p) => p.x < size.padding || p.x > size.width - size.padding || p.y < size.padding || p.y > size.height - size.padding));
});

test("fitView: an approximate radius widens the fit and the drawn circle stays inside", () => {
  const point = t.fitView([{ latitude: 53.3, longitude: -2.9 }], size);
  const area = t.fitView([{ latitude: 53.3, longitude: -2.9, radiusKm: 80 }], size);
  assert.ok(area.zoom < point.zoom);
  const r = t.kmToPixels(80, 53.3, area.zoom);
  assert.ok(r <= (size.height - 2 * size.padding) / 2 + 1, `radius ${r}px`);
  assert.ok(r >= (size.height - 2 * size.padding) / 4, "and not wastefully small");
  const bigger = t.fitView([{ latitude: 53.3, longitude: -2.9, radiusKm: 800 }], size);
  assert.ok(bigger.zoom < area.zoom);
});

test("visibleTiles cover the viewport with correct offsets", () => {
  const v = { lat: 51.5072, lon: -0.1276, zoom: 10 };
  const tiles = t.visibleTiles(v, 320, 220);
  const o = t.viewOrigin(v, 320, 220);
  assert.ok(tiles.length >= 2);
  for (const tile of tiles) assert.ok(tile.url.startsWith("https://tile.openstreetmap.org/10/"));
  assert.ok(Math.min(...tiles.map((x) => x.left)) <= 0 && Math.max(...tiles.map((x) => x.left)) + 256 >= 320);
  assert.ok(Math.min(...tiles.map((x) => x.top)) <= 0 && Math.max(...tiles.map((x) => x.top)) + 256 >= 220);
  assert.ok(tiles.some((x) => x.url.endsWith("/10/511/340.png")));
  near(tiles.find((x) => x.url.endsWith("/10/511/340.png")).left, 511 * 256 - o.x, 1e-9);
});

test("panBy moves the map with the drag; zoomTo keeps the anchor fixed and clamps", () => {
  const v = { lat: 40, lon: 10, zoom: 8 };
  const panned = t.panBy(v, 100, 0); // drag right: centre moves west
  assert.ok(panned.lon < v.lon);
  near(panned.lat, v.lat, 1e-9);
  const back = t.panBy(panned, -100, 0);
  near(back.lon, v.lon, 1e-9);

  const before = t.pixelToLonLat(t.viewOrigin(v, 320, 220).x + 250, t.viewOrigin(v, 320, 220).y + 50, 8);
  const z = t.zoomTo(v, 9, 320, 220, 250, 50);
  assert.equal(z.zoom, 9);
  const at = t.project(z, 320, 220, before.lon, before.lat);
  near(at.x, 250, 1e-6);
  near(at.y, 50, 1e-6);
  assert.equal(t.zoomTo(v, 99, 320, 220).zoom, t.MAX_ZOOM);
  assert.equal(t.zoomTo(v, -5, 320, 220).zoom, t.MIN_ZOOM);
});

test("fitView fits Places either side of the antimeridian across it, not across the world", () => {
  const items = [
    { latitude: -17.7, longitude: 178.4 }, // Fiji
    { latitude: -13.8, longitude: -172.1 }, // Samoa
    { latitude: -21.1, longitude: -175.2, radiusKm: 50 }, // Tonga, approximate
  ];
  const v = t.fitView(items, size);
  assert.ok(v.zoom >= 4, `zoom ${v.zoom}: fitted across the whole world`);
  assert.ok(v.lon >= -180 && v.lon < 180, `lon ${v.lon}`);
  assert.ok(Math.abs(v.lon) > 170, `centred near the antimeridian, not ${v.lon}`);
  for (const i of items) {
    const p = t.project(v, size.width, size.height, i.longitude, i.latitude);
    assert.ok(p.x >= size.padding - 1e-6 && p.x <= size.width - size.padding + 1e-6, `x ${p.x}`);
    assert.ok(p.y >= size.padding - 1e-6 && p.y <= size.height - size.padding + 1e-6, `y ${p.y}`);
  }
  // The same Places listed in any order, or with longitudes written past ±180, fit the same.
  const shuffled = [items[2], { ...items[1], longitude: items[1].longitude + 360 }, items[0]];
  assert.deepEqual(t.fitView(shuffled, size), v);
  // Places that don't straddle it are unchanged by the wrap logic.
  const europe = t.fitView([{ latitude: 51.06, longitude: -1.31 }, { latitude: 48.85, longitude: 2.35 }], size);
  near(europe.lon, (-1.31 + 2.35) / 2, 0.01);
});

test("project shows a Place beside a centre across the antimeridian", () => {
  const v = { lat: -17, lon: 179.5, zoom: 6 };
  const east = t.project(v, 320, 220, -179.5, -17);
  const west = t.project(v, 320, 220, 178.5, -17);
  assert.ok(east.x > 160 && east.x < 320, `east x ${east.x}`);
  assert.ok(west.x < 160 && west.x > 0, `west x ${west.x}`);
});

test("zoomTo and panBy always return a longitude in [-180, 180)", () => {
  const v = { lat: 0, lon: 179, zoom: 2 };
  const zoomed = t.zoomTo(v, 3, 320, 220, 320, 110); // anchored at the right edge, past 180°
  assert.ok(zoomed.lon >= -180 && zoomed.lon < 180, `lon ${zoomed.lon}`);
  const out = t.zoomTo({ lat: 0, lon: -179, zoom: 3 }, 2, 320, 220, 0, 110);
  assert.ok(out.lon >= -180 && out.lon < 180, `lon ${out.lon}`);
  // The anchor stays put even when wrapped.
  const o = t.viewOrigin(v, 320, 220);
  const anchor = t.pixelToLonLat(o.x + 320, o.y + 110, 2);
  const at = t.project(zoomed, 320, 220, t.normalizeLongitude(anchor.lon), anchor.lat);
  near(at.x, 320, 1e-6);
  near(at.y, 110, 1e-6);
  const panned = t.panBy({ lat: 0, lon: 179, zoom: 4 }, -500, 0);
  assert.ok(panned.lon >= -180 && panned.lon < 180);
  assert.equal(t.normalizeLongitude(180), -180);
  assert.equal(t.normalizeLongitude(-540), -180);
  near(t.normalizeLongitude(190), -170, 1e-9);
});
