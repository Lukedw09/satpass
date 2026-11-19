/* When a closed-tab alert should pick up a new observer place, and how that is shown.
   Rounding must stay the Worker's 0.01° (~1 km). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../js/push-location.js';
import { validateSubscription } from '../worker/alerts.js';

const Loc = globalThis.SatPassLocation;
const sub = {
  endpoint: 'https://push.example/send/abc',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1', auth: 'tBHItJI5svbpez7K' }
};

test('client rounding matches the worker, at 0.01 degree', () => {
  const samples = [
    [34.0523, -118.2537],
    [34.05, -118.25],
    [40.7128, -74.006],
    [0, 0],
    [-90, -180],
    [90, 180],
    [1.005, -1.005],
    [-33.8688, 151.2093]
  ];
  for (const [lat, lon] of samples) {
    const got = validateSubscription({ subscription: sub, lat, lon, norads: [25544], leadMin: 10 });
    const rounded = Loc.roundObs(lat, lon);
    assert.equal(got.error, undefined);
    assert.equal(got.value.lat, rounded.lat);
    assert.equal(got.value.lon, rounded.lon);
    assert.equal(got.value.lat, Math.round(lat * 100) / 100);
    assert.equal(got.value.lon, Math.round(lon * 100) / 100);
  }
  assert.equal(Loc.roundObs(91, 0), null);
  assert.equal(Loc.roundObs(0, 181), null);
  assert.equal(Loc.roundObs('', 1), null);
});

test('a push sync is needed only when the rounded place differs', () => {
  const here = { lat: 34.0523, lon: -118.2537 };
  const stored = { lat: 34.05, lon: -118.25 };
  assert.equal(Loc.locationNeedsSync(false, { lat: 40, lon: -75 }, stored), false);
  assert.equal(Loc.locationNeedsSync(true, here, stored), false);
  assert.equal(Loc.locationNeedsSync(true, { lat: 34.054, lon: -118.246 }, stored), false);
  assert.equal(Loc.locationNeedsSync(true, { lat: 40.7128, lon: -74.006 }, stored), true);
  assert.equal(Loc.locationNeedsSync(true, here, null), true);
  assert.equal(Loc.locationNeedsSync(true, here, {}), true);
  assert.equal(Loc.locationNeedsSync(true, { lat: 91, lon: 0 }, null), false);
});

test('the accepted place prefers the server coordinates and stays rounded', () => {
  const fromServer = Loc.acceptedPlace(40.71, -74.01, 40.7128, -74.006);
  assert.deepEqual(fromServer, { lat: 40.71, lon: -74.01 });
  const fromSent = Loc.acceptedPlace(undefined, undefined, 34.0523, -118.2537);
  assert.deepEqual(fromSent, { lat: 34.05, lon: -118.25 });
  assert.deepEqual(Loc.acceptedPlace('', '', 0, 0), { lat: 0, lon: 0 });
  assert.equal(Loc.acceptedPlace(undefined, undefined, 91, 0), null);
});

test('alert status shows the rounded place, and a failed sync keeps the old one', () => {
  const synced = { lat: 34.05, lon: -118.25 };
  const obs = { lat: 34.0523, lon: -118.2537 };
  const moved = { lat: 40.7128, lon: -74.006 };
  const quiet = Loc.alertLocationStatus({ on: false, synced, obs: moved, failed: true });
  assert.deepEqual(quiet, { text: '', err: false });

  const current = Loc.alertLocationStatus({ on: true, synced, obs, failed: false });
  assert.equal(current.err, false);
  assert.equal(current.text, 'Closed-tab alerts use 34.05°, -118.25°.');
  assert.equal(current.text.includes('34.052'), false);
  assert.equal(/\d+\.\d{3}/.test(current.text), false);

  const pending = Loc.alertLocationStatus({ on: true, synced, obs: moved, failed: false });
  assert.equal(pending.err, false);
  assert.equal(pending.text, 'Closed-tab alerts use 34.05°, -118.25°.');
  assert.equal(pending.text.includes('40.71'), false);

  const failed = Loc.alertLocationStatus({ on: true, synced, obs: moved, failed: true });
  assert.equal(failed.err, true);
  assert.equal(failed.text, 'Closed-tab alerts are still using 34.05°, -118.25°.');
  assert.equal(failed.text.includes('40.71'), false);
  assert.equal(/\d+\.\d{3}/.test(failed.text), false);

  const unknown = Loc.alertLocationStatus({ on: true, synced: null, obs: moved, failed: true });
  assert.equal(unknown.err, true);
  assert.match(unknown.text, /still using the previous location/);
  assert.equal(/\d/.test(unknown.text), false);

  const whole = Loc.alertLocationStatus({
    on: true, synced: { lat: 40, lon: -75 }, obs: { lat: 40, lon: -75 }, failed: false
  });
  assert.equal(whole.text, 'Closed-tab alerts use 40.00°, -75.00°.');
});
