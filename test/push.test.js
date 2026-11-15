/* Push subscription, alert window, and payload text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSubscription, duePasses, formatAlertText, alertPayload, CRON_WINDOW_MS } from '../worker/alerts.js';

const sub = {
  endpoint: 'https://push.example/send/abc',
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1', auth: 'tBHItJI5svbpez7K' }
};

test('subscription validation rounds location and rejects bad input', async () => {
  const ok = validateSubscription({
    subscription: sub, lat: 30.5884, lon: -84.2439,
    norads: [25544, 25544, 20580], leadMin: 10, visOnly: true, minMag: 3
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.value.lat, 30.59);
  assert.equal(ok.value.lon, -84.24);
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
