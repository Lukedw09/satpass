/* Worker alert lookup, per-satellite isolation, and the test-push limit.
   Fetch and CelesTrak are mocked. No network and no secrets. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { tleFor, alertOne, runCron } from '../worker/index.js';
import { loadSatCore } from '../worker/core-loader.js';
import { subscriptionId, dueWindowMs, CRON_WINDOW_MS } from '../worker/alerts.js';

const OMM_101292 = {
  OBJECT_NAME: 'DEMO-101292',
  OBJECT_ID: '2026-001A',
  EPOCH: '2026-11-08T20:27:37.448064',
  MEAN_MOTION: 15.49281775,
  ECCENTRICITY: 0.0007289,
  INCLINATION: 51.6322,
  RA_OF_ASC_NODE: 299.2609,
  ARG_OF_PERICENTER: 7.6181,
  MEAN_ANOMALY: 352.4917,
  EPHEMERIS_TYPE: 0,
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 101292,
  ELEMENT_SET_NO: 999,
  REV_AT_EPOCH: 59433,
  BSTAR: 0.00015976,
  MEAN_MOTION_DOT: 0.00008451,
  MEAN_MOTION_DDOT: 0
};

const ONE_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26313.85251676  .00008451  00000+0  15976-3 0  9993',
  '2 25544  51.6322 299.2609 0007289   7.6181 352.4917 15.49281775594331'
].join('\n');
const BUNDLE = Array.from({ length: 5 }, () => ONE_TLE).join('\n');

function memoryKv() {
  const store = new Map();
  const puts = [];
  return {
    puts,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value, opts) {
      store.set(key, String(value));
      puts.push({ key, opts: opts || null });
    },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      const keys = [...store.keys()].filter(k => !prefix || k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true, cursor: '' };
    }
  };
}

function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fakeSub(endpoint = 'https://push.test/demo') {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { endpoint, keys: { p256dh: bytesToB64url(raw), auth: bytesToB64url(auth) } };
}

async function fakeVapid() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  return crypto.subtle.exportKey('jwk', pair.privateKey);
}

function parsed(logs) {
  return logs.flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function withMocks(fetchImpl, fn) {
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const calls = [];
  const logs = [];
  globalThis.fetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : (url && url.url) || String(url);
    calls.push(u);
    return fetchImpl(u, opts, calls.length);
  };
  console.log = (...args) => { logs.push(args.map(a => String(a)).join(' ')); };
  try { return await fn({ calls, logs }); }
  finally {
    globalThis.fetch = prevFetch;
    console.log = prevLog;
  }
}

function passFor(sat, eventT) {
  return {
    norad: sat.norad, name: sat.name, peakMag: 1.2,
    rise: { t: eventT, az: 90 }, max: { el: 30, az: 180 },
    visible: { start: { t: eventT, az: 90 }, max: { el: 30, az: 180 }, end: { t: eventT + 60000 } }
  };
}

describe('worker push alerts', { concurrency: false }, () => {
  test('a 6-digit NORAD id loads from OMM JSON and stays cached', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    await withMocks((url, opts) => {
      assert.match(url, /CATNR=101292/);
      assert.match(url, /FORMAT=json/);
      assert.equal(url.includes('FORMAT=tle'), false);
      const ua = opts && opts.headers && opts.headers['User-Agent'];
      assert.match(ua, /SatPass\/1\.0/);
      assert.match(ua, /mailto:satpass@lukedw09.workers.dev/);
      assert.equal(opts.cache, 'no-store');
      return Response.json([OMM_101292]);
    }, async ({ calls }) => {
      const bundled = new Map([[101292, { norad: 101292, name: 'from bundle', l1: '1 x', l2: '2 x' }]]);
      await tleFor(env, core, bundled, 101292);
      assert.equal(calls.length, 0);
      assert.equal(bundled.get(101292).name, 'from bundle');

      const catalog = new Map();
      await tleFor(env, core, catalog, 101292);
      const sat = catalog.get(101292);
      assert.equal(sat.norad, 101292);
      assert.equal(String(sat.satrec.satnum), '101292');
      assert.equal(sat.name, 'DEMO-101292');
      assert.equal(calls.length, 1);
      const put = kv.puts.find(p => p.key === 'tle:sat:101292');
      assert.equal(put.opts.expirationTtl, 3 * 24 * 3600);
      const cached = await kv.get('tle:sat:101292', 'json');
      assert.equal(cached.ok, true);
      assert.equal(cached.omm.NORAD_CAT_ID, 101292);

      const again = new Map();
      await tleFor(env, core, again, 101292);
      assert.equal(calls.length, 1);
      assert.equal(again.get(101292).norad, 101292);
      assert.equal(String(again.get(101292).satrec.satnum), '101292');

      const stored = await kv.get('tle:sat:101292', 'json');
      stored.goodMs = Date.now() - 3 * 3600 * 1000;
      stored.fetchedMs = stored.goodMs;
      await kv.put('tle:sat:101292', JSON.stringify(stored));
      const refresh = new Map();
      await tleFor(env, core, refresh, 101292);
      assert.equal(calls.length, 2);
      assert.equal(refresh.get(101292).norad, 101292);
    });
  });

  test('a 404 is negative-cached for 2 hours', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    await withMocks(() => new Response('No GP data found', { status: 404 }), async ({ calls }) => {
      const catalog = new Map();
      await tleFor(env, core, catalog, 101292);
      assert.equal(catalog.get(101292).miss, true);
      assert.equal(calls.length, 1);
      const cached = await kv.get('tle:sat:101292', 'json');
      assert.equal(cached.ok, false);
      assert.equal(cached.reason, 'not-found');
      assert.equal(cached.status, 404);
      assert.equal(cached.omm, undefined);
      assert.equal(kv.puts.find(p => p.key === 'tle:sat:101292').opts.expirationTtl, 2 * 3600);

      const later = new Map();
      await tleFor(env, core, later, 101292);
      assert.equal(calls.length, 1);
      assert.equal(later.get(101292).miss, true);
    });
  });

  test('one satellite throwing does not stop another alert', async () => {
    const sub = await fakeSub();
    const kv = memoryKv();
    const env = { ALERTS: kv, SATPASS_DEV: '1', VAPID_SUBJECT: 'mailto:demo@example.com' };
    const now = Date.parse('2026-11-18T23:34:00Z');
    const eventT = now + 9 * 60 * 1000;
    const core = {
      standardMagnitude() { return null; },
      makeSat() { throw new Error('legacy TLE should not be used'); },
      makeSatFromOmm(omm) {
        return { norad: +omm.NORAD_CAT_ID, name: omm.OBJECT_NAME, satrec: { ok: true } };
      },
      findPasses(sat) {
        if (sat.norad === 101292) throw new Error('propagation failed');
        return [passFor(sat, eventT)];
      }
    };
    let releaseSlow = () => {};
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    try {
      await withMocks(async (url) => {
        if (url.includes('CATNR=101292')) {
          await slow;
          throw new Error('The operation was aborted due to timeout');
        }
        if (url.includes('CATNR=25544')) return Response.json([{ NORAD_CAT_ID: 25544, OBJECT_NAME: 'ISS (ZARYA)' }]);
        if (url.startsWith('https://push.test/')) return new Response(null, { status: 201 });
        throw new Error('unexpected fetch ' + url);
      }, async ({ calls, logs }) => {
        const rec = {
          endpoint: sub.endpoint, keys: sub.keys,
          lat: 0, lon: 0, norads: [101292, 25544],
          leadMin: 10, visOnly: true, minMag: null, sent: {}
        };
        const pending = alertOne(env, core, new Map(), rec, 'sub:demo', now, CRON_WINDOW_MS);
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(calls.some(u => u.includes('CATNR=25544')));
        releaseSlow();
        await pending;
        const rows = parsed(logs);
        const satErr = rows.find(r => r.kind === 'sat-error');
        assert.equal(satErr.norad, 101292);
        assert.match(satErr.error, /timeout/);
        assert.equal(satErr.failure, 'transient');
        assert.equal(satErr.stale, false);
        const push = rows.find(r => r.kind === 'push');
        assert.deepEqual(push, { kind: 'push', norad: 25544, status: 201 });
        assert.equal(calls.filter(u => u.startsWith('https://push.test/')).length, 1);
        assert.ok(rec.sent[`25544:${Math.round(eventT / 60000)}`]);
        const miss = await kv.get('tle:sat:101292', 'json');
        assert.equal(miss.ok, false);
        assert.equal(miss.reason, 'transient');
        assert.equal(miss.status, 0);
        assert.notEqual(kv.puts.find(p => p.key === 'tle:sat:101292').opts.expirationTtl, 2 * 3600);
      });
    } finally {
      releaseSlow();
    }
  });

  test('a skipped cron still alerts, and a 5-minute window does not', async () => {
    const sub = await fakeSub();
    const env = { ALERTS: memoryKv(), SATPASS_DEV: '1', VAPID_SUBJECT: 'mailto:demo@example.com' };
    const now = Date.parse('2026-11-18T23:34:00Z');
    const fireAt = now - 8 * 60 * 1000;
    const eventT = fireAt + 10 * 60 * 1000;
    const core = {
      standardMagnitude() { return null; },
      makeSat() { throw new Error('not a TLE'); },
      findPasses(sat) { return [passFor(sat, eventT)]; }
    };
    const entry = { norad: 101292, name: 'DEMO-101292', satrec: { ok: true } };
    const rec = () => ({
      endpoint: sub.endpoint, keys: sub.keys,
      lat: 0, lon: 0, norads: [101292],
      leadMin: 10, visOnly: true, minMag: null, sent: {}
    });
    await withMocks(() => new Response(null, { status: 201 }), async ({ calls, logs }) => {
      const late = rec();
      await alertOne(env, core, new Map([[101292, entry]]), late, 'sub:late', now, dueWindowMs(now - 12 * 60 * 1000, now));
      assert.equal(calls.length, 1);
      assert.equal(parsed(logs).some(r => r.kind === 'push' && r.norad === 101292 && r.status === 201), true);
      const narrow = rec();
      const before = calls.length;
      await alertOne(env, core, new Map([[101292, entry]]), narrow, 'sub:narrow', now, CRON_WINDOW_MS);
      assert.equal(calls.length, before);
      assert.equal(narrow.sent && Object.keys(narrow.sent).length, 0);
    });
  });

  test('non-OK push statuses are logged, and 410 deletes the subscription', async () => {
    const sub = await fakeSub();
    const kv = memoryKv();
    const env = { ALERTS: kv, SATPASS_DEV: '1', VAPID_SUBJECT: 'mailto:demo@example.com' };
    const now = Date.parse('2026-11-18T23:34:00Z');
    const eventT = now + 9 * 60 * 1000;
    const core = {
      standardMagnitude() { return null; },
      findPasses(sat) { return [passFor(sat, eventT)]; }
    };
    const entry = { norad: 101292, name: 'DEMO-101292', satrec: { ok: true } };
    const statuses = [403, 429, 410];
    await withMocks(() => new Response(null, { status: statuses.shift() }), async ({ logs }) => {
      const base = {
        endpoint: sub.endpoint, keys: sub.keys,
        lat: 0, lon: 0, norads: [101292], leadMin: 10, visOnly: true, minMag: null, sent: {}
      };
      await alertOne(env, core, new Map([[101292, entry]]), { ...base }, 'sub:vapid', now);
      await alertOne(env, core, new Map([[101292, entry]]), { ...base, sent: {} }, 'sub:rate', now);
      await kv.put('sub:gone', JSON.stringify(base));
      await alertOne(env, core, new Map([[101292, entry]]), { ...base, sent: {} }, 'sub:gone', now);
      const pushes = parsed(logs).filter(r => r.kind === 'push');
      assert.deepEqual(pushes[0], { kind: 'push', norad: 101292, status: 403, error: 'VAPID' });
      assert.deepEqual(pushes[1], { kind: 'push', norad: 101292, status: 429, error: 'rate-limited' });
      assert.deepEqual(pushes[2], { kind: 'push', norad: 101292, status: 410, error: 'push-failed' });
      assert.equal(await kv.get('sub:gone'), null);
    });
  });

  test('test push works without dev mode and is limited to about one a minute', async () => {
    const jwk = await fakeVapid();
    const sub = await fakeSub('https://push.test/caller');
    const kv = memoryKv();
    const id = await subscriptionId(sub.endpoint);
    await kv.put('sub:' + id, JSON.stringify({
      endpoint: sub.endpoint, keys: sub.keys,
      lat: 0, lon: 0, norads: [101292], leadMin: 10, visOnly: true, minMag: null, sent: {}
    }));
    const env = {
      ALERTS: kv,
      VAPID_PRIVATE_KEY: JSON.stringify(jwk),
      VAPID_SUBJECT: 'mailto:demo@example.com'
    };
    assert.equal(env.SATPASS_DEV, undefined);
    const post = () => worker.fetch(new Request('https://satpass.test/api/push/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint })
    }), env);
    await withMocks(() => new Response(null, { status: 201 }), async ({ calls, logs }) => {
      const first = await post();
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { ok: true });
      const second = await post();
      assert.equal(second.status, 429);
      assert.match((await second.json()).error, /minute/);
      assert.equal(calls.length, 1);
      assert.deepEqual(parsed(logs).filter(r => r.kind === 'push'), [{ kind: 'push', norad: null, status: 201 }]);
      await kv.put('test:' + id, String(Date.now() - 61 * 1000));
      const third = await post();
      assert.equal(third.status, 200);
      assert.equal(calls.length, 2);
    });
  });

  test('update stores a new rounded location and keeps sent passes', async () => {
    const jwk = await fakeVapid();
    const sub = await fakeSub('https://push.test/move');
    const kv = memoryKv();
    const env = {
      ALERTS: kv,
      VAPID_PRIVATE_KEY: JSON.stringify(jwk),
      VAPID_SUBJECT: 'mailto:demo@example.com'
    };
    const post = (path, extra) => worker.fetch(new Request('https://satpass.test' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscription: sub,
        lat: 30.5884,
        lon: -84.2439,
        norads: [25544],
        leadMin: 10,
        visOnly: true,
        minMag: null,
        ...extra
      })
    }), env);

    const missing = await post('/api/push/update', { lat: 40, lon: -75 });
    assert.equal(missing.status, 404);
    assert.equal([...kv.puts].some(p => String(p.key).startsWith('sub:')), false);

    const created = await post('/api/push/subscribe');
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.lat, 30.59);
    assert.equal(createdBody.lon, -84.24);
    const id = await subscriptionId(sub.endpoint);
    const stored = await kv.get('sub:' + id, 'json');
    const sentAt = Date.now();
    stored.sent = { '25544:100': sentAt };
    await kv.put('sub:' + id, JSON.stringify(stored));

    const updated = await post('/api/push/update', { lat: 40.7128, lon: -74.006 });
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.equal(body.ok, true);
    assert.equal(body.lat, 40.71);
    assert.equal(body.lon, -74.01);
    const after = await kv.get('sub:' + id, 'json');
    assert.equal(after.lat, 40.71);
    assert.equal(after.lon, -74.01);
    assert.equal(after.sent['25544:100'], sentAt);
    assert.equal(after.endpoint, sub.endpoint);
    assert.equal(after.norads[0], 25544);
    assert.equal(after.lat, Math.round(40.7128 * 100) / 100);
    assert.equal(after.lon, Math.round(-74.006 * 100) / 100);

    const rejected = await post('/api/push/update', { lat: 91, lon: 0 });
    assert.equal(rejected.status, 400);
    const kept = await kv.get('sub:' + id, 'json');
    assert.equal(kept.lat, 40.71);
    assert.equal(kept.lon, -74.01);
    assert.equal(kept.sent['25544:100'], sentAt);
  });

  test('a timeout is retried on the next tick and is not a 2-hour miss', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv, VAPID_SUBJECT: 'mailto:satpass@lukedw09.workers.dev' };
    const clock = { t: Date.parse('2026-11-18T22:10:00Z') };
    const prevNow = Date.now;
    Date.now = () => clock.t;
    let mode = 'timeout';
    try {
      await withMocks((url, opts) => {
        assert.match(opts.headers['User-Agent'], /SatPass\/1\.0 \(mailto:satpass@lukedw09.workers.dev\)/);
        if (mode === 'timeout') throw new Error('The operation was aborted due to timeout');
        assert.match(url, /CATNR=101292/);
        return Response.json([OMM_101292]);
      }, async ({ calls }) => {
        const first = new Map();
        await tleFor(env, core, first, 101292);
        assert.equal(first.get(101292).miss, true);
        assert.equal(calls.length, 1);
        const failed = await kv.get('tle:sat:101292', 'json');
        assert.equal(failed.reason, 'transient');
        assert.equal(failed.status, 0);
        assert.equal(failed.ok, false);
        assert.ok(failed.retryAt > clock.t);
        assert.ok(failed.retryAt <= clock.t + 5 * 60 * 1000);
        assert.equal(kv.puts.find(p => p.key === 'tle:sat:101292').opts.expirationTtl, 3 * 24 * 3600);

        const immediate = new Map();
        await tleFor(env, core, immediate, 101292);
        assert.equal(calls.length, 1);
        assert.equal(immediate.get(101292).miss, true);

        clock.t += 5 * 60 * 1000;
        mode = 'ok';
        const next = new Map();
        await tleFor(env, core, next, 101292);
        assert.equal(calls.length, 2);
        assert.equal(next.get(101292).norad, 101292);
        assert.equal(String(next.get(101292).satrec.satnum), '101292');
        const saved = await kv.get('tle:sat:101292', 'json');
        assert.equal(saved.ok, true);
        assert.equal(saved.reason, 'ok');
        assert.equal(saved.omm.NORAD_CAT_ID, 101292);
      });
    } finally {
      Date.now = prevNow;
    }
  });

  test('an old timeout miss is fetched again instead of blocking the satellite', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    await kv.put('tle:sat:101292', JSON.stringify({
      ok: false, status: 0, fetchedMs: Date.now() - 60 * 1000
    }));
    await withMocks(() => Response.json([OMM_101292]), async ({ calls }) => {
      const catalog = new Map();
      await tleFor(env, core, catalog, 101292);
      assert.equal(calls.length, 1);
      assert.equal(catalog.get(101292).norad, 101292);
      const saved = await kv.get('tle:sat:101292', 'json');
      assert.equal(saved.reason, 'ok');
      assert.equal(saved.ok, true);
    });
  });

  test('HTTP 503 and 429 are retried with backoff, not cached as not-found', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    const clock = { t: Date.parse('2026-11-18T22:10:00Z') };
    const prevNow = Date.now;
    Date.now = () => clock.t;
    let status = 503;
    try {
      await withMocks(() => new Response('busy', {
        status,
        headers: status === 429 ? { 'retry-after': '1800' } : {}
      }), async ({ calls }) => {
        await tleFor(env, core, new Map(), 101292);
        const failed = await kv.get('tle:sat:101292', 'json');
        assert.equal(failed.reason, 'transient');
        assert.equal(failed.status, 503);
        assert.notEqual(kv.puts.find(p => p.key === 'tle:sat:101292').opts.expirationTtl, 2 * 3600);
        clock.t += 5 * 60 * 1000;
        await tleFor(env, core, new Map(), 101292);
        assert.equal(calls.length, 2);

        status = 429;
        clock.t += 3 * 3600 * 1000;
        await tleFor(env, core, new Map(), 101292);
        const limited = await kv.get('tle:sat:101292', 'json');
        assert.equal(limited.reason, 'transient');
        assert.equal(limited.status, 429);
        assert.ok(limited.retryAt >= clock.t + 1800 * 1000);
        const before = calls.length;
        clock.t += 5 * 60 * 1000;
        await tleFor(env, core, new Map(), 101292);
        assert.equal(calls.length, before);
        clock.t = limited.retryAt + 1000;
        await tleFor(env, core, new Map(), 101292);
        assert.equal(calls.length, before + 1);
      });
    } finally {
      Date.now = prevNow;
    }
  });

  test('a timeout with stale elements still sends the alert', async () => {
    const sub = await fakeSub();
    const kv = memoryKv();
    const env = { ALERTS: kv, SATPASS_DEV: '1', VAPID_SUBJECT: 'mailto:demo@example.com' };
    const now = Date.parse('2026-11-18T22:10:00Z');
    const eventT = now + 9 * 60 * 1000;
    const prevNow = Date.now;
    Date.now = () => now;
    await kv.put('tle:sat:101292', JSON.stringify({
      ok: true,
      reason: 'ok',
      omm: OMM_101292,
      fetchedMs: now - 3 * 3600 * 1000,
      goodMs: now - 3 * 3600 * 1000,
      failures: 0
    }));
    const core = {
      standardMagnitude() { return null; },
      makeSat() { throw new Error('bundle TLE should not be required'); },
      makeSatFromOmm(omm) {
        return { norad: +omm.NORAD_CAT_ID, name: omm.OBJECT_NAME, satrec: { ok: true } };
      },
      findPasses(sat) { return [passFor(sat, eventT)]; }
    };
    try {
      await withMocks((url) => {
        if (url.includes('celestrak.org')) throw new Error('The operation was aborted due to timeout');
        if (url.startsWith('https://push.test/')) return new Response(null, { status: 201 });
        throw new Error('unexpected fetch ' + url);
      }, async ({ calls, logs }) => {
        const rec = {
          endpoint: sub.endpoint, keys: sub.keys,
          lat: 0, lon: 0, norads: [101292],
          leadMin: 10, visOnly: true, minMag: null, sent: {}
        };
        await alertOne(env, core, new Map(), rec, 'sub:stale', now, CRON_WINDOW_MS);
        const rows = parsed(logs);
        const satErr = rows.find(r => r.kind === 'sat-error');
        assert.equal(satErr.norad, 101292);
        assert.equal(satErr.failure, 'transient');
        assert.equal(satErr.stale, true);
        assert.match(satErr.error, /timeout/);
        assert.deepEqual(rows.find(r => r.kind === 'push'), { kind: 'push', norad: 101292, status: 201 });
        assert.equal(calls.filter(u => u.startsWith('https://push.test/')).length, 1);
        assert.ok(rec.sent[`101292:${Math.round(eventT / 60000)}`]);
        const saved = await kv.get('tle:sat:101292', 'json');
        assert.equal(saved.reason, 'transient');
        assert.equal(saved.omm.NORAD_CAT_ID, 101292);
        assert.equal(saved.goodMs, now - 3 * 3600 * 1000);
        assert.ok(saved.retryAt > now);
      });
    } finally {
      Date.now = prevNow;
    }
  });

  test('a timeout falls back to the cached group bundle', async () => {
    const sub = await fakeSub();
    const kv = memoryKv();
    const env = { ALERTS: kv, SATPASS_DEV: '1', VAPID_SUBJECT: 'mailto:demo@example.com' };
    const now = Date.parse('2026-11-18T22:10:00Z');
    const eventT = now + 9 * 60 * 1000;
    await kv.put('tle:bundle', JSON.stringify({ fetchedMs: Date.now() - 60 * 1000, text: ONE_TLE }));
    const core = {
      standardMagnitude() { return null; },
      makeSatFromOmm() { throw new Error('no per-satellite elements'); },
      parseTLE(text) {
        assert.match(text, /ISS/);
        return [{ norad: 25544, name: 'ISS (ZARYA)', l1: '1', l2: '2' }];
      },
      makeSat(rec) { return { norad: rec.norad, name: rec.name, satrec: { ok: true } }; },
      findPasses(sat) { return [passFor(sat, eventT)]; }
    };
    await withMocks((url) => {
      if (url.includes('celestrak.org')) throw new Error('The operation was aborted due to timeout');
      if (url.startsWith('https://push.test/')) return new Response(null, { status: 201 });
      throw new Error('unexpected fetch ' + url);
    }, async ({ logs }) => {
      const rec = {
        endpoint: sub.endpoint, keys: sub.keys,
        lat: 0, lon: 0, norads: [25544],
        leadMin: 10, visOnly: true, minMag: null, sent: {}
      };
      await alertOne(env, core, new Map(), rec, 'sub:bundle', now, CRON_WINDOW_MS);
      const rows = parsed(logs);
      const satErr = rows.find(r => r.kind === 'sat-error');
      assert.equal(satErr.norad, 25544);
      assert.equal(satErr.failure, 'transient');
      assert.equal(satErr.stale, true);
      assert.deepEqual(rows.find(r => r.kind === 'push'), { kind: 'push', norad: 25544, status: 201 });
      assert.ok(rec.sent[`25544:${Math.round(eventT / 60000)}`]);
    });
  });

  test('elements older than 3 days are not used after a timeout', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    const now = Date.parse('2026-11-18T22:10:00Z');
    const prevNow = Date.now;
    Date.now = () => now;
    await kv.put('tle:sat:101292', JSON.stringify({
      ok: true, reason: 'ok', omm: OMM_101292,
      fetchedMs: now - 4 * 24 * 3600 * 1000,
      goodMs: now - 4 * 24 * 3600 * 1000
    }));
    await kv.put('tle:bundle', JSON.stringify({ fetchedMs: now - 4 * 24 * 3600 * 1000, text: ONE_TLE }));
    try {
      await withMocks(() => { throw new Error('The operation was aborted due to timeout'); }, async ({ logs }) => {
        const catalog = new Map();
        await tleFor(env, core, catalog, 101292);
        assert.equal(catalog.get(101292).miss, true);
        const row = parsed(logs).find(r => r.kind === 'sat-error');
        assert.equal(row.failure, 'transient');
        assert.equal(row.stale, false);
        const saved = await kv.get('tle:sat:101292', 'json');
        assert.equal(saved.omm, undefined);
      });
    } finally {
      Date.now = prevNow;
    }
  });

  test('a 404 replaces a stale copy and stays cached', async () => {
    const core = await loadSatCore();
    const kv = memoryKv();
    const env = { ALERTS: kv };
    const now = Date.parse('2026-11-18T22:10:00Z');
    const prevNow = Date.now;
    Date.now = () => now;
    await kv.put('tle:sat:101292', JSON.stringify({
      ok: true, reason: 'ok', omm: OMM_101292,
      fetchedMs: now - 3 * 3600 * 1000,
      goodMs: now - 3 * 3600 * 1000
    }));
    try {
      await withMocks(() => new Response('No GP data found', { status: 404 }), async ({ calls }) => {
        const catalog = new Map();
        await tleFor(env, core, catalog, 101292);
        assert.equal(calls.length, 1);
        assert.equal(catalog.get(101292).miss, true);
        const cached = await kv.get('tle:sat:101292', 'json');
        assert.equal(cached.reason, 'not-found');
        assert.equal(cached.omm, undefined);
        await tleFor(env, core, new Map(), 101292);
        assert.equal(calls.length, 1);
      });
    } finally {
      Date.now = prevNow;
    }
  });

  test('a failed bundle refresh keeps the previous elements and backs off', async () => {
    const kv = memoryKv();
    const env = { ALERTS: kv };
    const old = Date.now() - 3 * 3600 * 1000;
    await kv.put('tle:bundle', JSON.stringify({ fetchedMs: old, text: BUNDLE }));
    await withMocks(() => new Response('down', { status: 503 }), async ({ calls, logs }) => {
      await runCron(env);
      assert.equal(calls.length, 2);
      const saved = await kv.get('tle:bundle', 'json');
      assert.equal(saved.text, BUNDLE);
      assert.equal(saved.fetchedMs, old);
      assert.ok(saved.retryAt > Date.now());
      const row = parsed(logs).find(r => r.kind === 'tle-refresh-failed');
      assert.equal(row.failure, 'transient');
      assert.equal(row.stale, true);
      assert.ok(Number(await kv.get('meta:lastRun')) > 0);
      const afterFail = calls.length;
      await runCron(env);
      assert.equal(calls.length, afterFail);
    });
  });

  test('cron records its run time and does not move it when elements are unavailable', async () => {
    const kv = memoryKv();
    const env = { ALERTS: kv };
    await withMocks(() => new Response('down', { status: 503 }), async () => {
      await runCron(env);
      assert.equal(await kv.get('meta:lastRun'), null);
    });
    const previous = Date.now() - 12 * 60 * 1000;
    await kv.put('meta:lastRun', String(previous));
    await withMocks(() => new Response(BUNDLE, { status: 200, headers: { 'content-type': 'text/plain' } }), async () => {
      await runCron(env);
      const stamp = Number(await kv.get('meta:lastRun'));
      assert.ok(stamp > previous);
      assert.ok(Date.now() - stamp < 60 * 1000);
    });
  });
});
