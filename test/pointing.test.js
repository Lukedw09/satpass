/* Pointing math for the Find it view. Run: node --test test/pointing.test.js */
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
vm.runInContext(fs.readFileSync(join(root, 'js/core.js'), 'utf8'), ctx);
const C = ctx.SatCore;

test('azimuth offset wraps across 0 and 360', () => {
  const right = C.pointingOffset(350, 20, 10, 20);
  assert.ok(Math.abs(right.dAz - 20) < 1e-9);
  assert.equal(C.pointingCue(right.dAz, 0), 'Turn right 20°');
  const left = C.pointingOffset(10, 20, 350, 20);
  assert.ok(Math.abs(left.dAz - (-20)) < 1e-9);
  assert.equal(C.pointingCue(left.dAz, 0), 'Turn left 20°');
  assert.equal(C.wrapSigned(180), 180);
  assert.equal(C.wrapSigned(-180), 180);
  assert.ok(Math.abs(C.wrapSigned(360)) < 1e-9);
});

test('elevation offset and the on-target cone', () => {
  const off = C.pointingOffset(90, 25, 130, 40);
  assert.ok(Math.abs(off.dAz - 40) < 1e-9);
  assert.ok(Math.abs(off.dEl - 15) < 1e-9);
  assert.equal(C.pointingCue(off.dAz, off.dEl), 'Turn right 40° · tilt up 15°');
  assert.equal(off.onTarget, false);
  const near = C.pointingOffset(10, 30, 12, 32);
  assert.ok(near.separation < 5);
  assert.equal(near.onTarget, true);
  assert.equal(C.ON_TARGET_DEG, 5);
  const down = C.pointingOffset(10, -40, 10, -40);
  assert.ok(down.separation < 1e-6);
  assert.equal(down.onTarget, false);
});

test('phone look matches the upright, tilted, and zenith cases', () => {
  const horizon = C.phoneLook(0, 90, 0);
  assert.ok(Math.abs(horizon.az) < 1e-6);
  assert.ok(Math.abs(horizon.el) < 1e-6);
  const up = C.phoneLook(0, 135, 0);
  assert.ok(Math.abs(up.az) < 1e-6);
  assert.ok(Math.abs(up.el - 45) < 1e-6);
  const zenith = C.phoneLook(0, 180, 0);
  assert.ok(Math.abs(zenith.el - 90) < 1e-6);
  // gamma = 0 makes the W3C heading equal to -alpha. alpha 90° looks west.
  const west = C.phoneLook(90, 90, 0);
  assert.ok(Math.abs(west.az - 270) < 1e-6);
  assert.ok(Math.abs(west.el) < 1e-6);
});

test('an aim can be inverted back to the same az/el', () => {
  for (const [az, el] of [[0, 0], [40, 15], [200, 60], [350, -20]]) {
    const o = C.aimOrientation(az, el);
    const back = C.phoneLook(o.alpha, o.beta, o.gamma);
    assert.ok(Math.abs(C.wrapSigned(back.az - az)) < 1e-6, `az ${az}`);
    assert.ok(Math.abs(back.el - el) < 1e-6, `el ${el}`);
  }
});

test('screen orientation rotates device up and right into the viewport', () => {
  const up = C.deviceToScreen(0, 1, 0);
  assert.ok(Math.abs(up.x) < 1e-9 && Math.abs(up.y - 1) < 1e-9);
  const right = C.deviceToScreen(1, 0, 0);
  assert.ok(Math.abs(right.x - 1) < 1e-9 && Math.abs(right.y) < 1e-9);
  // 90° clockwise: the top of the phone is at the left of the screen.
  const land = C.deviceToScreen(0, 1, 90);
  assert.ok(Math.abs(land.x - (-1)) < 1e-9 && Math.abs(land.y) < 1e-9);
  const landRight = C.deviceToScreen(1, 0, 90);
  assert.ok(Math.abs(landRight.x) < 1e-9 && Math.abs(landRight.y - 1) < 1e-9);
  const flip = C.deviceToScreen(0, 1, 180);
  assert.ok(Math.abs(flip.x) < 1e-9 && Math.abs(flip.y - (-1)) < 1e-9);
  const other = C.deviceToScreen(0, 1, -90);
  assert.ok(Math.abs(other.x - 1) < 1e-9 && Math.abs(other.y) < 1e-9);
});

test('magnetic heading plus east-positive declination wraps to true azimuth', () => {
  assert.ok(Math.abs(C.trueAzimuth(350, 20) - 10) < 1e-9);
  assert.ok(Math.abs(C.trueAzimuth(10, -20) - 350) < 1e-9);
});

test('declination near downtown Los Angeles is about 11° east', () => {
  // WMM2025 puts downtown Los Angeles near +11° (east) in late 2026. The degree-6
  // truncation should land within a degree of that.
  const d = C.magneticDeclination(34.05, -118.25, 2026.87);
  assert.ok(d > 10 && d < 12.5, `declination ${d}`);
  assert.ok(C.magneticDeclination(-33.87, 151.21, 2026.87) > 0);
});
