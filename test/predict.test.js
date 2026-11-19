/* Unit tests for phase angle, visual magnitude, trains, and cloud lookup.
   Run: node --test test/predict.test.js
   There is no older test suite in this repo; this file is the suite. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { console, Math, Date, Intl, Number, String, Object, Array, Map, Set, Infinity, NaN, isNaN };
ctx.globalThis = ctx;
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(join(root, 'vendor/satellite.min.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(join(root, 'data/fallback-tle.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(join(root, 'js/core.js'), 'utf8'), ctx);
const C = ctx.SatCore;

test('phase angle is 0 when the Sun is behind the observer', () => {
  // sat→Sun and sat→observer are the same direction: full phase.
  const sat = { x: 7000, y: 0, z: 0 };
  const sun = { x: 7000 + 1.5e8, y: 0, z: 0 };
  const obs = { x: 7000 + 800, y: 0, z: 0 };
  assert.ok(Math.abs(C.phaseAngle(sat, sun, obs)) < 1e-12);
});

test('phase angle is 90° and 180° for perpendicular and opposite observers', () => {
  const sat = { x: 0, y: 0, z: 0 };
  const sun = { x: 1, y: 0, z: 0 };
  const right = C.phaseAngle(sat, sun, { x: 0, y: 4, z: 0 });
  const back = C.phaseAngle(sat, sun, { x: -2, y: 0, z: 0 });
  assert.ok(Math.abs(right - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(back - Math.PI) < 1e-12);
});

test('phase angle of a 45° geometry is pi/4', () => {
  // toSun = (1,0,0), toObs = (1,1,0), cos = 1/sqrt(2).
  const phi = C.phaseAngle({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 });
  assert.ok(Math.abs(phi - Math.PI / 4) < 1e-12);
});

test('magnitude formula at 90° phase has a zero phase term', () => {
  // m_std = 0, r = 1000 km, phi = 90°, el = 90°.
  // sin(pi/2) + (pi - pi/2)*cos(pi/2) = 1, so -2.5 log10(1) = 0.
  // 5 log10(1) = 0. Airmass = 1, extinction = 0.2. m = 0.2.
  const m = C.visualMagnitude(0, 1000, Math.PI / 2, 90);
  assert.ok(Math.abs(m - 0.2) < 1e-9);
});

test('magnitude formula matches a hand evaluation at full phase', () => {
  // phi = 0, r = 1000, m_std = 0, el = 90°.
  // phase function = pi, -2.5 log10(pi) = -1.2428746817353346
  // plus extinction 0.2 → -1.0428746817353346
  const m = C.visualMagnitude(0, 1000, 0, 90);
  assert.ok(Math.abs(m - (-1.0428746817353346)) < 1e-9);
});

test('magnitude formula matches a hand evaluation at half range and 30° elevation', () => {
  // m_std = 2, r = 500, phi = 90°, el = 30°.
  // 5 log10(0.5) = -1.505149978319906
  // phase term = 0, airmass = 1/sin(30°) = 2, extinction = 0.4
  // m = 2 - 1.505149978319906 + 0.4 = 0.894850021680094
  const m = C.visualMagnitude(2, 500, Math.PI / 2, 30);
  assert.ok(Math.abs(m - 0.894850021680094) < 1e-9);
});

test('airmass is capped at 5° elevation', () => {
  assert.equal(C.airmass(1), C.airmass(5));
  assert.ok(C.airmass(0) > C.airmass(30));
  // 1/sin(5°) = 11.473713245669965, times 0.2 mag.
  const m = C.visualMagnitude(0, 1000, Math.PI / 2, 1);
  assert.ok(Math.abs(m - 2.294742649133993) < 1e-9);
  assert.equal(C.visualMagnitude(0, 1000, Math.PI / 2, 0), null);
  assert.equal(C.visualMagnitude(0, 1000, Math.PI, 40), null);
});

test('unknown objects have no standard magnitude', () => {
  assert.equal(C.standardMagnitude(99999, 'SOMETHING ELSE'), null);
  assert.equal(C.standardMagnitude(25544, 'ISS (ZARYA)').m, -1.8);
  assert.equal(C.standardMagnitude(20580, 'HST').m, 2.2);
  assert.equal(C.standardMagnitude(48274, 'CSS (TIANHE)').m, 0);
  assert.equal(C.standardMagnitude(27386, 'ENVISAT').m, 3.7);
  assert.equal(C.standardMagnitude(16182, 'SL-16 R/B').m, 3.2);
  assert.equal(C.standardMagnitude(25407, 'SL-16 R/B').m, 2.7);
  const sl = C.standardMagnitude(1, 'STARLINK-100');
  assert.equal(sl.m, 5);
  assert.equal(sl.approx, true);
  assert.equal(C.standardMagnitude(1, 'STARLINK DEB'), null);
});

test('observer range from ECI positions matches satellite.js slant range', () => {
  const fb = ctx.SATPASS_FALLBACK;
  const rec = C.parseTLE(fb.tle).find(r => r.norad === 25544);
  const sat = C.makeSat(rec);
  const when = new Date('2026-11-15T23:30:00Z');
  const gd = C.observerGd({ lat: 34.05, lon: -118.25, elev: 90 });
  const look = C.look(sat, when, gd);
  const obs = C.observerEci(gd, look.gmst);
  const range = Math.hypot(look.eci.x - obs.x, look.eci.y - obs.y, look.eci.z - obs.z);
  assert.ok(Math.abs(range - look.range) < 1, `vector ${range} vs look ${look.range}`);
  const phi = C.phaseAngle(look.eci, { x: 1, y: 0, z: 0 }, obs);
  assert.ok(phi >= 0 && phi <= Math.PI);
});

test('train spread is 8 minutes for a 30° arc at 15 rev/day', () => {
  // Mean anomalies 10°, 20°, 30°, 40°. Largest gap is 330°, so the arc is 30°.
  // Period = 1440/15 = 96 min. Spread = 30/360*96 = 8 min. Lead is mean anomaly 40°.
  const members = [10, 20, 30, 40].map((ma, i) => ({
    name: 'STARLINK-' + (100 + i),
    norad: 100 + i,
    objectId: '2026-100' + String.fromCharCode(65 + i),
    meanMotion: 15,
    meanAnomaly: ma,
    launchDate: '2026-11-12'
  }));
  const trains = C.detectTrains(members, new Date('2026-11-15T12:00:00Z'));
  assert.equal(trains.length, 1);
  assert.equal(trains[0].lead.meanAnomaly, 40);
  assert.ok(Math.abs(trains[0].spreadMin - 8) < 1e-9);
  assert.equal(trains[0].label, 'Starlink train (Group 2026-100, launched Nov 12)');
  assert.equal(trains[0].count, 4);
});

test('trains ignore old launches, non-Starlinks, and objects far apart in mean motion', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const base = (over) => ({
    name: 'STARLINK-1', norad: 1, objectId: '2026-100A', meanMotion: 15, meanAnomaly: 10, launchDate: '2026-11-14', ...over
  });
  const young = [0, 1, 2].map(i => base({
    norad: i + 1, name: 'STARLINK-' + i, objectId: '2026-100' + String.fromCharCode(65 + i), meanAnomaly: 10 + i
  }));
  assert.equal(C.detectTrains(young.map(o => ({ ...o, launchDate: '2026-10-01' })), now).length, 0);
  assert.equal(C.detectTrains(young.map(o => ({ ...o, name: 'HULIANWANG ' + o.norad })), now).length, 0);
  const split = [
    ...young,
    ...[0, 1, 2].map(i => base({
      norad: 10 + i, name: 'STARLINK-9' + i, objectId: '2026-100' + String.fromCharCode(68 + i),
      meanMotion: 15.2, meanAnomaly: 40 + i
    }))
  ];
  const two = C.detectTrains(split, now);
  assert.equal(two.length, 2);
  assert.ok(two.every(t => t.count === 3));
  const withIds = C.detectTrains(young.map(o => ({ ...o, name: 'OBJECT ' + o.norad })), now, { starlinkIds: new Set([1, 2, 3]) });
  assert.equal(withIds.length, 1);
});

test('cloud cover uses the nearest hour and refuses times outside the forecast', () => {
  const samples = [
    { t: 0, total: 10, low: 1, mid: 2, high: 7 },
    { t: 3600000, total: 40, low: 10, mid: 20, high: 10 },
    { t: 7200000, total: 80, low: 30, mid: 30, high: 20 }
  ];
  assert.equal(C.nearestCloud(samples, -1).forecast, false);
  assert.equal(C.nearestCloud(samples, 7200001).forecast, false);
  const early = C.nearestCloud(samples, 10 * 60000);
  assert.equal(early.total, 10);
  assert.equal(early.kind, 'clear');
  // 3_000_000 ms is closer to the 40% hour than to 10%.
  const mid = C.nearestCloud(samples, 3000000);
  assert.equal(mid.total, 40);
  assert.equal(mid.kind, 'partly');
  assert.equal(C.nearestCloud(samples, 7200000).kind, 'cloudy');
  assert.equal(C.cloudKind(24.9), 'clear');
  assert.equal(C.cloudKind(25), 'partly');
  assert.equal(C.cloudKind(70), 'partly');
  assert.equal(C.cloudKind(70.1), 'cloudy');
});
