/* Push subscription, alert window, and payload text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubscription, duePasses, dueWindowMs, formatAlertText, alertPayload, testAlertPayload, CRON_WINDOW_MS, MAX_LOOKBACK_MS } from '../worker/alerts.js';

const sub = {
  endpoint: 'https://push.example/send/abc',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1', auth: 'tBHItJI5svbpez7K' }
};

test('subscription validation rounds location and rejects bad input', async () => {
  const ok = validateSubscription({
    subscription: sub, lat: 34.0523, lon: -118.2537,
    norads: [25544, 25544, 20580], leadMin: 10, visOnly: true, minMag: 3
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.lat, 34.05);
  assert.equal(ok.value.lon, -118.25);
  assert.deepEqual(ok.value.norads, [25544, 20580]);
  assert.equal(ok.value.minMag, 3);
  assert.equal(validateSubscription({ subscription: { endpoint: 'http://x', keys: sub.keys } }).error.includes('https'), true);
  assert.equal(validateSubscription({ subscription: sub, lat: 0, lon: 0, norads: [], leadMin: 10 }).error, 'Choose at least one satellite');
  assert.equal(validateSubscription({ subscription: sub, lat: 0, lon: 0, norads: [1], leadMin: 7 }).error.includes('Lead'), true);
  assert.equal(validateSubscription({ subscription: sub, lat: 91, lon: 0, norads: [1], leadMin: 10 }).error.includes('Location'), true);
});

test('a pass alerts once when its lead time falls in the cron window', () => {
  const now = Date.parse('2026-11-15T23:00:00Z');
  const start = now + 8 * 60000;
  const pass = {
    norad: 25544, name: 'ISS (ZARYA)', peakMag: -3.14,
    rise: { t: start, az: 315 }, max: { el: 54, az: 10 },
    visible: { start: { t: start, az: 315 }, max: { el: 54, az: 10 }, end: { t: start + 60000 } }
  };
  const late = { ...pass, norad: 20580, visible: { ...pass.visible, start: { t: now + 30 * 60000, az: 10 } } };
  const first = duePasses([pass, late], { now, leadMin: 10, windowMs: CRON_WINDOW_MS, sent: {}, visOnly: true, minMag: null });
  assert.equal(first.length, 1);
  assert.equal(first[0].key, `25544:${Math.round(start / 60000)}`);
  const again = duePasses([pass], { now, leadMin: 10, windowMs: CRON_WINDOW_MS, sent: { [first[0].key]: now }, visOnly: true, minMag: null });
  assert.equal(again.length, 0);
  const faint = duePasses([pass], { now, leadMin: 10, sent: {}, visOnly: true, minMag: -4 });
  assert.equal(faint.length, 0);
  const daylight = duePasses([{ ...pass, visible: null }], { now, leadMin: 10, sent: {}, visOnly: true, minMag: null });
  assert.equal(daylight.length, 0);
});

test('payload text matches the pass line and opens that pass', () => {
  const eventT = Date.parse('2026-11-15T23:42:00Z');
  const text = formatAlertText({
    name: 'ISS (ZARYA)', leadMin: 10, az: 315, eventT, maxEl: 54.2, peakMag: -3.14
  });
  assert.equal(text, 'ISS in 10 min, rises NW 6:42 PM, max 54 deg, mag -3.1');
  const item = {
    key: '25544:1', eventT,
    pass: {
      norad: 25544, name: 'ISS (ZARYA)', peakMag: -3.14,
      rise: { t: eventT, az: 315 }, max: { el: 54.2 },
      visible: { start: { t: eventT, az: 315 }, max: { el: 54.2 } }
    }
  };
  const payload = alertPayload(item, 10);
  assert.equal(payload.body, text);
  assert.equal(payload.url, `/?norad=25544&rise=${Math.round(eventT / 60000)}`);
  assert.equal(payload.tag, '25544:1');
  const noMag = formatAlertText({ name: 'HST', leadMin: 5, az: 90, eventT, maxEl: 12, peakMag: null });
  assert.equal(noMag.includes('mag'), false);
  assert.equal(noMag.startsWith('HST in 5 min, rises E '), true);
});

test('due window after a skipped run reaches the previous cron and stays capped', () => {
  const now = Date.parse('2026-11-18T23:34:00Z');
  const lastRun = now - 12 * 60 * 1000;
  const windowMs = dueWindowMs(lastRun, now);
  assert.equal(windowMs, 12 * 60 * 1000);
  const leadMin = 10;
  const passAt = (fireAt) => {
    const eventT = fireAt + leadMin * 60000;
    return {
      norad: 101292, name: 'DEMO-101292', peakMag: 2,
      rise: { t: eventT, az: 180 }, max: { el: 40, az: 90 },
      visible: { start: { t: eventT, az: 180 }, max: { el: 40, az: 90 }, end: { t: eventT + 60000 } }
    };
  };
  // Fire time is 8 minutes ago: inside a 12-minute gap, outside the old 5-minute window.
  const late = passAt(now - 8 * 60 * 1000);
  const hit = duePasses([late], { now, leadMin, windowMs, sent: {}, visOnly: true, minMag: null });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].pass.norad, 101292);
  const fixed = duePasses([late], { now, leadMin, windowMs: CRON_WINDOW_MS, sent: {}, visOnly: true, minMag: null });
  assert.equal(fixed.length, 0);
  // (lastRun, now] is open on the left, so the pass that fired exactly at lastRun is not due again.
  const edge = duePasses([passAt(lastRun)], { now, leadMin, windowMs, sent: {}, visOnly: true, minMag: null });
  assert.equal(edge.length, 0);
  assert.equal(dueWindowMs(now - 2 * 60 * 60 * 1000, now), MAX_LOOKBACK_MS);
  assert.equal(dueWindowMs(null, now), MAX_LOOKBACK_MS);
  const tooOld = duePasses([passAt(now - 40 * 60 * 1000)], {
    now, leadMin, windowMs: MAX_LOOKBACK_MS, sent: {}, visOnly: true, minMag: null
  });
  assert.equal(tooOld.length, 0);
  const again = duePasses([late], { now, leadMin, windowMs, sent: { [hit[0].key]: now }, visOnly: true, minMag: null });
  assert.equal(again.length, 0);
});

test('test push payload says it is a test', () => {
  const payload = testAlertPayload();
  assert.equal(payload.title, 'SatPass test');
  assert.match(payload.body, /test/i);
  assert.equal(/ISS|rises|mag/i.test(payload.body), false);
  assert.equal(payload.tag, 'test');
});
