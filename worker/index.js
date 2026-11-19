/* SatPass Worker: static site, push subscription API, and the pass-alert cron.
   The VAPID private key is env.VAPID_PRIVATE_KEY, set with `wrangler secret put`. */
import { loadSatCore } from './core-loader.js';
import { loadVapid, publicKeyFromPrivateJwk, sendPush } from './vapid.js';
import { validateSubscription, subscriptionId, duePasses, dueWindowMs, pruneSent, alertPayload, testAlertPayload, CRON_WINDOW_MS } from './alerts.js';

/* CelesTrak publishes a new GP set about every 2 hours and asks callers not to
   refetch a successful copy sooner than that. Their edge-client note also asks
   for a contact in the User-Agent. Workers' fetch sends no User-Agent unless
   we set one, and an 8s abort was being stored like a 404 for the full 2 hours. */
const TLE_FRESH_MS = 2 * 3600 * 1000;
const TLE_FRESH_SEC = Math.round(TLE_FRESH_MS / 1000);
const TLE_STALE_MAX_MS = 3 * 24 * 3600 * 1000;
const TLE_STALE_SEC = Math.round(TLE_STALE_MAX_MS / 1000);
const FETCH_TIMEOUT_MS = 20 * 1000;
const FETCH_BUDGET_MS = 45 * 1000;
const FETCH_CONCURRENCY = 4;
const BACKOFF_STEPS_MS = [4 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000, 60 * 60 * 1000];
const TEST_PUSH_MS = 60 * 1000;
const SUB_LIMIT = 20;
const EXTRA_FETCH_CAP = 8;
const JSON_HDR = { 'content-type': 'application/json; charset=utf-8' };
const CELESTRAK_CONTACT = 'mailto:satpass@lukedw09.workers.dev';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HDR });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function publicKey(env) {
  const vapid = await loadVapid(env);
  if (!vapid) return null;
  return { publicKey: publicKeyFromPrivateJwk(vapid.jwk), dev: vapid.dev };
}

async function putSub(env, value, sent) {
  const id = await subscriptionId(value.endpoint);
  const prev = await env.ALERTS.get('sub:' + id, 'json');
  const record = {
    ...value,
    sent: pruneSent(sent || (prev && prev.sent) || {}, Date.now()),
    updatedAt: Date.now()
  };
  await env.ALERTS.put('sub:' + id, JSON.stringify(record));
  return id;
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/api/push/key') {
    const key = await publicKey(env);
    if (!key) return json({ error: 'Push is not configured' }, 503);
    return json(key);
  }
  if (request.method === 'POST' && path === '/api/push/subscribe') {
    const parsed = validateSubscription(await readJson(request));
    if (parsed.error) return json({ error: parsed.error }, 400);
    if (!await publicKey(env)) return json({ error: 'Push is not configured' }, 503);
    const id = await putSub(env, parsed.value);
    return json({ ok: true, id, lat: parsed.value.lat, lon: parsed.value.lon });
  }
  if (request.method === 'POST' && path === '/api/push/update') {
    const parsed = validateSubscription(await readJson(request));
    if (parsed.error) return json({ error: parsed.error }, 400);
    const id = await subscriptionId(parsed.value.endpoint);
    const prev = await env.ALERTS.get('sub:' + id, 'json');
    if (!prev) return json({ error: 'No subscription stored for that browser' }, 404);
    // parsed.value carries the new rounded place. sent history stays on the record.
    await putSub(env, parsed.value, prev.sent);
    return json({ ok: true, id, lat: parsed.value.lat, lon: parsed.value.lon });
  }
  if (request.method === 'POST' && path === '/api/push/unsubscribe') {
    const body = await readJson(request);
    if (!body || typeof body.endpoint !== 'string') return json({ error: 'Missing endpoint' }, 400);
    const id = await subscriptionId(body.endpoint);
    await env.ALERTS.delete('sub:' + id);
    return json({ ok: true });
  }
  if (request.method === 'POST' && path === '/api/push/test') {
    const body = await readJson(request);
    if (!body || typeof body.endpoint !== 'string') return json({ error: 'Missing endpoint' }, 400);
    const id = await subscriptionId(body.endpoint);
    const rec = await env.ALERTS.get('sub:' + id, 'json');
    // The body only selects the caller's stored subscription. Nothing else is pushed.
    if (!rec || rec.endpoint !== body.endpoint) return json({ error: 'Subscribe before sending a test' }, 404);
    const gate = 'test:' + id;
    const prev = Number(await env.ALERTS.get(gate));
    const now = Date.now();
    if (Number.isFinite(prev) && prev > 0 && now - prev < TEST_PUSH_MS) {
      return json({ error: 'Wait a minute before another test push' }, 429);
    }
    await env.ALERTS.put(gate, String(now), { expirationTtl: 120 });
    const payload = testAlertPayload();
    const res = await sendPush(env, { endpoint: rec.endpoint, keys: rec.keys }, payload);
    logPush(null, res.status);
    if (res.status === 404 || res.status === 410) {
      await env.ALERTS.delete('sub:' + id);
      return json({ error: 'The browser dropped this subscription' }, 410);
    }
    if (!res.ok) return json({ error: 'Push service returned ' + res.status }, 502);
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}

function celestrakHeaders(env) {
  const subject = env && typeof env.VAPID_SUBJECT === 'string' ? env.VAPID_SUBJECT.trim() : '';
  const contact = /^mailto:[^\s@]+@[^\s@]+$/i.test(subject) ? subject : CELESTRAK_CONTACT;
  return {
    'User-Agent': `SatPass/1.0 (${contact})`,
    Accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
  };
}

function celestrakFetch(env, url) {
  return fetch(url, {
    headers: celestrakHeaders(env),
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
}

function backoffMs(failures, status) {
  if (status === 403) return TLE_FRESH_MS;
  const step = Math.min(Math.max(failures, 1), BACKOFF_STEPS_MS.length) - 1;
  return BACKOFF_STEPS_MS[step];
}

function retryAfterMs(res, now) {
  if (!res || !res.headers || typeof res.headers.get !== 'function') return 0;
  const raw = res.headers.get('retry-after');
  if (!raw) return 0;
  const secs = Number(raw);
  let ms = 0;
  if (Number.isFinite(secs) && secs >= 0) ms = secs * 1000;
  else {
    const when = Date.parse(raw);
    if (Number.isFinite(when)) ms = when - now;
  }
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, 60 * 60 * 1000);
}

function reasonOf(cached) {
  if (cached.reason === 'ok' || cached.reason === 'not-found' || cached.reason === 'transient') return cached.reason;
  if (cached.ok === true && cached.omm) return 'ok';
  if (cached.status === 404) return 'not-found';
  // Older builds stored a timeout as {ok:false,status:0} for 2 hours. That is a
  // transient failure, not a miss, so the next tick may try again.
  return 'transient';
}

function decideCache(cached, now) {
  if (!cached || !Number.isFinite(cached.fetchedMs)) return { kind: 'fetch', failures: 0 };
  const reason = reasonOf(cached);
  const goodMs = Number.isFinite(cached.goodMs) ? cached.goodMs : (cached.omm ? cached.fetchedMs : NaN);
  const age = Number.isFinite(goodMs) ? now - goodMs : Infinity;
  const omm = cached.omm && age >= 0 && age < TLE_STALE_MAX_MS ? cached.omm : null;
  if (reason === 'not-found') {
    if (now - cached.fetchedMs < TLE_FRESH_MS) return { kind: 'miss' };
    return { kind: 'fetch', failures: 0 };
  }
  if (reason === 'ok' && omm && age < TLE_FRESH_MS) return { kind: 'fresh', omm, goodMs };
  if (reason === 'transient' && Number.isFinite(cached.retryAt) && now < cached.retryAt) {
    return { kind: 'backoff', omm, goodMs: omm ? goodMs : null, failures: cached.failures || 1 };
  }
  return {
    kind: 'fetch',
    omm,
    goodMs: omm ? goodMs : null,
    failures: reason === 'transient' ? (cached.failures || 0) : 0
  };
}

function createGate(now = Date.now()) {
  let active = 0;
  const waiters = [];
  const gate = {
    deadline: now + FETCH_BUDGET_MS,
    inflight: new Map(),
    bundlePromise: null,
    async acquire() {
      while (active >= FETCH_CONCURRENCY) {
        if (Date.now() >= gate.deadline) {
          const wake = waiters.shift();
          if (wake) wake();
          return false;
        }
        await new Promise(resolve => { waiters.push(resolve); });
      }
      if (Date.now() >= gate.deadline) return false;
      active += 1;
      return true;
    },
    release() {
      active = Math.max(0, active - 1);
      const wake = waiters.shift();
      if (wake) wake();
    }
  };
  return gate;
}

async function downloadBundle(env, core) {
  const groups = ['stations', 'visual'];
  const parts = await Promise.all(groups.map(async (g) => {
    const res = await celestrakFetch(env, `https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
    if (!res.ok) {
      const status = res.status;
      await res.body?.cancel();
      const err = new Error('CelesTrak ' + g + ' HTTP ' + status);
      err.status = status;
      throw err;
    }
    return res.text();
  }));
  const text = parts.join('\n');
  if (core.parseTLE(text).length < 5) {
    const err = new Error('CelesTrak response was not element sets');
    err.status = 0;
    throw err;
  }
  return text;
}

async function ensureTles(env, core) {
  const cached = await env.ALERTS.get('tle:bundle', 'json');
  const now = Date.now();
  if (cached && cached.text && now - cached.fetchedMs < TLE_FRESH_MS) return cached.text;
  if (cached && cached.text && Number.isFinite(cached.retryAt) && now < cached.retryAt) return cached.text;
  try {
    const text = await downloadBundle(env, core);
    await env.ALERTS.put('tle:bundle', JSON.stringify({ fetchedMs: now, text, failures: 0 }));
    return text;
  } catch (err) {
    if (cached && cached.text) {
      const failures = (cached.failures || 0) + 1;
      const retryAt = now + backoffMs(failures, err && err.status);
      try {
        await env.ALERTS.put('tle:bundle', JSON.stringify({
          fetchedMs: cached.fetchedMs,
          text: cached.text,
          failures,
          retryAt
        }));
      } catch { /* the copy already in hand is still usable */ }
    }
    throw err;
  }
}

function satCacheKey(norad) {
  return 'tle:sat:' + norad;
}

async function writeSatRecord(env, norad, record, ttlSec) {
  await env.ALERTS.put(satCacheKey(norad), JSON.stringify(record), { expirationTtl: ttlSec });
}

function putSat(catalog, norad, sat) {
  catalog.set(sat.norad, sat);
  if (sat.norad !== norad) catalog.set(norad, sat);
}

function logSatFailure(norad, outcome) {
  if (!outcome || !outcome.failure) return;
  console.log(JSON.stringify({
    kind: 'sat-error',
    norad,
    error: outcome.error,
    failure: outcome.failure,
    stale: outcome.stale === true
  }));
}

async function readBundleMap(env, core) {
  try {
    const cached = await env.ALERTS.get('tle:bundle', 'json');
    if (!cached || !cached.text || !Number.isFinite(cached.fetchedMs)) return null;
    if (Date.now() - cached.fetchedMs > TLE_STALE_MAX_MS) return null;
    const map = new Map();
    for (const rec of core.parseTLE(cached.text)) if (!map.has(rec.norad)) map.set(rec.norad, rec);
    return map;
  } catch {
    return null;
  }
}

async function satFromBundle(env, core, norad, memo) {
  if (!memo.bundlePromise) memo.bundlePromise = readBundleMap(env, core);
  const map = await memo.bundlePromise;
  const rec = map && map.get(norad);
  if (!rec) return null;
  try { return core.makeSat(rec); }
  catch { return null; }
}

async function installFallback(env, core, norad, memo, omm) {
  if (omm) {
    try { return core.makeSatFromOmm(omm); }
    catch { /* the saved OMM no longer parses; try the group bundle */ }
  }
  return satFromBundle(env, core, norad, memo);
}

async function rememberTransient(env, core, catalog, norad, memo, decision, status, error, now, extraWait) {
  const failures = (decision.failures || 0) + 1;
  const wait = status === 403 ? TLE_FRESH_MS : Math.max(backoffMs(failures, status), extraWait || 0);
  const record = {
    ok: false,
    reason: 'transient',
    status,
    failures,
    fetchedMs: now,
    retryAt: now + wait
  };
  const sat = await installFallback(env, core, norad, memo, decision.omm);
  const outcome = { failure: 'transient', stale: false, error };
  if (sat) {
    if (decision.omm) {
      record.omm = decision.omm;
      record.goodMs = decision.goodMs;
    }
    putSat(catalog, norad, sat);
    outcome.stale = true;
  } else {
    catalog.set(norad, { miss: true });
  }
  try { await writeSatRecord(env, norad, record, TLE_STALE_SEC); }
  catch { /* the in-memory elements, if any, still cover this tick */ }
  logSatFailure(norad, outcome);
  return outcome;
}

async function rememberNotFound(env, catalog, norad, status, now) {
  catalog.set(norad, { miss: true });
  const outcome = { failure: 'not-found', stale: false, error: 'CelesTrak HTTP ' + status };
  try {
    await writeSatRecord(env, norad, {
      ok: false, reason: 'not-found', status, fetchedMs: now
    }, TLE_FRESH_SEC);
  } catch { /* a missed write just means the next tick asks again */ }
  logSatFailure(norad, outcome);
  return outcome;
}

/**
 * Catalog numbers missing from the station/visual bundle. Legacy TLE cannot
 * hold a 6-digit NORAD id, so this uses OMM JSON and the same makeSatFromOmm
 * path as the page. A successful copy is kept for up to 3 days and is not
 * refetched for 2 hours. Only an HTTP 404 is cached as a miss. A timeout,
 * network error, 403, 429, or 5xx keeps the last good elements (or the cached
 * group bundle) and retries on a later tick.
 */
async function tleFor(env, core, catalog, norad, gate, allowNetwork = true) {
  if (catalog.has(norad)) return null;
  if (gate && allowNetwork !== false) {
    const pending = gate.inflight.get(norad);
    if (pending) return pending;
    let settle;
    const job = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    gate.inflight.set(norad, job);
    loadSat(env, core, catalog, norad, gate, allowNetwork).then(settle.resolve, settle.reject).finally(() => {
      if (gate.inflight.get(norad) === job) gate.inflight.delete(norad);
    });
    return job;
  }
  return loadSat(env, core, catalog, norad, null, allowNetwork);
}

async function loadSat(env, core, catalog, norad, gate, allowNetwork = true) {
  if (catalog.has(norad)) return null;
  const memo = gate || {};
  const now = Date.now();
  let cached = null;
  try { cached = await env.ALERTS.get(satCacheKey(norad), 'json'); }
  catch { cached = null; }
  if (catalog.has(norad)) return null;
  const decision = decideCache(cached, now);
  if (decision.kind === 'miss') {
    catalog.set(norad, { miss: true });
    return null;
  }
  if (decision.kind === 'fresh' || decision.kind === 'backoff') {
    const sat = await installFallback(env, core, norad, memo, decision.omm);
    if (sat) {
      putSat(catalog, norad, sat);
      return null;
    }
    if (decision.kind === 'backoff') {
      catalog.set(norad, { miss: true });
      return null;
    }
  }
  if (allowNetwork === false) {
    const sat = await installFallback(env, core, norad, memo, decision.omm);
    if (catalog.has(norad)) return null;
    if (sat) putSat(catalog, norad, sat);
    else catalog.set(norad, { miss: true });
    return null;
  }

  let slot = false;
  try {
    if (gate) {
      slot = await gate.acquire();
      if (!slot) {
        const sat = await installFallback(env, core, norad, memo, decision.omm);
        const outcome = {
          failure: 'transient',
          stale: false,
          error: 'CelesTrak fetch skipped to stay inside the cron budget'
        };
        if (sat) {
          putSat(catalog, norad, sat);
          outcome.stale = true;
        } else {
          catalog.set(norad, { miss: true });
        }
        logSatFailure(norad, outcome);
        return outcome;
      }
    }
    let res;
    try {
      res = await celestrakFetch(env, `https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=json`);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return await rememberTransient(env, core, catalog, norad, memo, decision, 0, message, now, 0);
    }
    if (!res.ok) {
      const extraWait = retryAfterMs(res, now);
      await res.body?.cancel();
      if (res.status === 404) return await rememberNotFound(env, catalog, norad, res.status, now);
      return await rememberTransient(env, core, catalog, norad, memo, decision, res.status, 'CelesTrak HTTP ' + res.status, now, extraWait);
    }
    let omm = null;
    try {
      const data = await res.json();
      omm = Array.isArray(data) ? data[0] : data;
    } catch (err) {
      const message = err && err.message ? err.message : 'CelesTrak response was not JSON';
      return await rememberTransient(env, core, catalog, norad, memo, decision, res.status || 0, message, now, 0);
    }
    if (!omm || omm.NORAD_CAT_ID == null) {
      return await rememberTransient(env, core, catalog, norad, memo, decision, res.status || 0, 'CelesTrak response had no elements', now, 0);
    }
    let sat;
    try { sat = core.makeSatFromOmm(omm); }
    catch (err) {
      const message = err && err.message ? err.message : 'Bad elements';
      return await rememberTransient(env, core, catalog, norad, memo, decision, res.status || 0, message, now, 0);
    }
    putSat(catalog, norad, sat);
    try {
      await writeSatRecord(env, norad, {
        ok: true, reason: 'ok', status: res.status, omm, fetchedMs: now, goodMs: now, failures: 0
      }, TLE_STALE_SEC);
    } catch { /* this tick can still propagate the elements it already parsed */ }
    return null;
  } finally {
    if (slot) gate.release();
  }
}

function asSat(core, entry) {
  if (!entry || entry.miss) return null;
  if (entry.satrec) return entry;
  if (entry.l1) return core.makeSat(entry);
  if (entry.omm) return core.makeSatFromOmm(entry.omm);
  return null;
}

export function logPush(norad, status) {
  const row = { kind: 'push', norad, status };
  if (status === 401 || status === 403) row.error = 'VAPID';
  else if (status === 429) row.error = 'rate-limited';
  else if (!(status >= 200 && status < 300)) row.error = 'push-failed';
  console.log(JSON.stringify(row));
}

async function alertOne(env, core, catalog, rec, keyName, now, windowMs = CRON_WINDOW_MS, gate) {
  const obs = { lat: rec.lat, lon: rec.lon, elev: 0 };
  const start = new Date(now - 60 * 1000);
  const end = new Date(now + (rec.leadMin + 10) * 60000);
  const ownedGate = gate || createGate();
  const sent = { ...(rec.sent || {}) };
  let extras = 0;
  let removed = false;
  let anyDue = false;
  const tasks = [];
  for (const norad of rec.norads || []) {
    let allowNetwork = true;
    if (!catalog.has(norad)) {
      if (extras >= EXTRA_FETCH_CAP) allowNetwork = false;
      else extras += 1;
    }
    tasks.push((async () => {
      try {
        if (!catalog.has(norad)) await tleFor(env, core, catalog, norad, ownedGate, allowNetwork);
        if (removed) return;
        const sat = asSat(core, catalog.get(norad));
        if (!sat) return;
        const std = core.standardMagnitude(sat.norad, sat.name);
        sat.mStd = std ? std.m : null;
        const found = core.findPasses(sat, obs, start, end, { minEl: 10, sunMax: -6, visMinEl: 10 });
        const due = duePasses(found, {
          now, leadMin: rec.leadMin, windowMs,
          sent, visOnly: rec.visOnly, minMag: rec.minMag
        });
        if (!due.length) return;
        anyDue = true;
        for (const item of due) {
          if (removed) return;
          const payload = alertPayload(item, rec.leadMin);
          const res = await sendPush(env, { endpoint: rec.endpoint, keys: rec.keys }, payload);
          logPush(item.pass.norad, res.status);
          if (res.status === 404 || res.status === 410) {
            removed = true;
            await env.ALERTS.delete(keyName);
            return;
          }
          if (res.ok) sent[item.key] = now;
        }
      } catch (err) {
        console.log(JSON.stringify({ kind: 'sat-error', norad, error: err && err.message ? err.message : String(err) }));
      }
    })());
  }
  await Promise.all(tasks);
  if (removed || !anyDue) return;
  rec.sent = pruneSent(sent, now);
  await env.ALERTS.put(keyName, JSON.stringify(rec));
}

async function runCron(env) {
  const core = await loadSatCore();
  let text;
  try { text = await ensureTles(env, core); }
  catch (err) {
    const cached = await env.ALERTS.get('tle:bundle', 'json');
    const stale = !!(cached && cached.text);
    console.log(JSON.stringify({
      kind: 'tle-refresh-failed',
      message: err && err.message ? err.message : String(err),
      failure: 'transient',
      stale
    }));
    if (!stale) return;
    text = cached.text;
  }
  const catalog = new Map();
  for (const rec of core.parseTLE(text)) if (!catalog.has(rec.norad)) catalog.set(rec.norad, rec);
  const cursor = await env.ALERTS.get('meta:cursor');
  const page = await env.ALERTS.list({ prefix: 'sub:', limit: SUB_LIMIT, cursor: cursor || undefined });
  const now = Date.now();
  const lastRun = Number(await env.ALERTS.get('meta:lastRun'));
  const windowMs = dueWindowMs(lastRun, now);
  const gate = createGate();
  const loaded = await Promise.all(page.keys.map(async (key) => ({
    key,
    rec: await env.ALERTS.get(key.name, 'json')
  })));
  await Promise.all(loaded.map(async ({ key, rec }) => {
    if (!rec || !rec.endpoint) return;
    try { await alertOne(env, core, catalog, rec, key.name, now, windowMs, gate); }
    catch (err) { console.log(JSON.stringify({ kind: 'subscriber-failed', message: err && err.message ? err.message : String(err) })); }
  }));
  await env.ALERTS.put('meta:cursor', page.list_complete ? '' : (page.cursor || ''));
  await env.ALERTS.put('meta:lastRun', String(now));
}

export { tleFor, alertOne, runCron };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(request, env); }
      catch (err) {
        console.log(JSON.stringify({ kind: 'api-error', message: err.message }));
        return json({ error: 'Server error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  }
};
