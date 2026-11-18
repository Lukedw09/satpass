/* SatPass Worker: static site, push subscription API, and the pass-alert cron.
   The VAPID private key is env.VAPID_PRIVATE_KEY, set with `wrangler secret put`. */
import { loadSatCore } from './core-loader.js';
import { loadVapid, publicKeyFromPrivateJwk, sendPush } from './vapid.js';
import { validateSubscription, subscriptionId, duePasses, dueWindowMs, pruneSent, alertPayload, testAlertPayload, CRON_WINDOW_MS } from './alerts.js';

const TLE_TTL_MS = 2 * 3600 * 1000;
const TLE_TTL_SEC = Math.round(TLE_TTL_MS / 1000);
const TEST_PUSH_MS = 60 * 1000;
const SUB_LIMIT = 20;
const EXTRA_FETCH_CAP = 8;
const JSON_HDR = { 'content-type': 'application/json; charset=utf-8' };

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
    return json({ ok: true, id });
  }
  if (request.method === 'POST' && path === '/api/push/update') {
    const parsed = validateSubscription(await readJson(request));
    if (parsed.error) return json({ error: parsed.error }, 400);
    const id = await subscriptionId(parsed.value.endpoint);
    const prev = await env.ALERTS.get('sub:' + id, 'json');
    if (!prev) return json({ error: 'No subscription stored for that browser' }, 404);
    await putSub(env, parsed.value, prev.sent);
    return json({ ok: true, id });
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

async function ensureTles(env, core) {
  const cached = await env.ALERTS.get('tle:bundle', 'json');
  if (cached && Date.now() - cached.fetchedMs < TLE_TTL_MS && cached.text) return cached.text;
  const groups = ['stations', 'visual'];
  const parts = [];
  for (const g of groups) {
    const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('CelesTrak ' + g + ' HTTP ' + res.status);
    parts.push(await res.text());
  }
  const text = parts.join('\n');
  if (core.parseTLE(text).length < 5) throw new Error('CelesTrak response was not element sets');
  await env.ALERTS.put('tle:bundle', JSON.stringify({ fetchedMs: Date.now(), text }));
  return text;
}

function satCacheKey(norad) {
  return 'tle:sat:' + norad;
}

async function readSatCache(env, norad) {
  const cached = await env.ALERTS.get(satCacheKey(norad), 'json');
  if (!cached || !Number.isFinite(cached.fetchedMs)) return null;
  if (Date.now() - cached.fetchedMs >= TLE_TTL_MS) return null;
  return cached;
}

async function writeSatCache(env, norad, value) {
  const record = { ...value, fetchedMs: Date.now() };
  await env.ALERTS.put(satCacheKey(norad), JSON.stringify(record), { expirationTtl: TLE_TTL_SEC });
}

async function rememberMiss(env, catalog, norad, status) {
  try { await writeSatCache(env, norad, { ok: false, status }); }
  catch { /* a cache write failure still leaves the lookup error for the caller */ }
  catalog.set(norad, { miss: true });
}

/**
 * Catalog numbers missing from the station/visual bundle. Legacy TLE cannot
 * hold a 6-digit NORAD id (CelesTrak returns 404), so this always uses OMM
 * JSON and the same makeSatFromOmm path as the page. Hits and misses stay
 * in KV for 2 hours, which is CelesTrak's minimum refetch gap.
 */
async function tleFor(env, core, catalog, norad) {
  if (catalog.has(norad)) return;
  const cached = await readSatCache(env, norad);
  if (cached) {
    if (!cached.ok || !cached.omm) {
      catalog.set(norad, { miss: true });
      return;
    }
    try { catalog.set(norad, core.makeSatFromOmm(cached.omm)); }
    catch (err) {
      catalog.set(norad, { miss: true });
      throw err;
    }
    return;
  }
  let res;
  try {
    res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=json`, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    await rememberMiss(env, catalog, norad, 0);
    throw err;
  }
  if (!res.ok) {
    await res.body?.cancel();
    await rememberMiss(env, catalog, norad, res.status);
    return;
  }
  let omm = null;
  try {
    const data = await res.json();
    omm = Array.isArray(data) ? data[0] : data;
  } catch (err) {
    await rememberMiss(env, catalog, norad, res.status || 0);
    throw err;
  }
  if (!omm || omm.NORAD_CAT_ID == null) {
    await rememberMiss(env, catalog, norad, res.status);
    return;
  }
  let sat;
  try { sat = core.makeSatFromOmm(omm); }
  catch (err) {
    await rememberMiss(env, catalog, norad, res.status);
    throw err;
  }
  catalog.set(sat.norad, sat);
  if (sat.norad !== norad) catalog.set(norad, sat);
  try { await writeSatCache(env, norad, { ok: true, omm }); }
  catch { /* this tick can still propagate the elements it already parsed */ }
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

async function alertOne(env, core, catalog, rec, keyName, now, windowMs = CRON_WINDOW_MS) {
  const obs = { lat: rec.lat, lon: rec.lon, elev: 0 };
  const start = new Date(now - 60 * 1000);
  const end = new Date(now + (rec.leadMin + 10) * 60000);
  const found = [];
  let extras = 0;
  for (const norad of rec.norads || []) {
    try {
      if (!catalog.has(norad)) {
        if (extras >= EXTRA_FETCH_CAP) continue;
        extras += 1;
        await tleFor(env, core, catalog, norad);
      }
      const sat = asSat(core, catalog.get(norad));
      if (!sat) continue;
      const std = core.standardMagnitude(sat.norad, sat.name);
      sat.mStd = std ? std.m : null;
      found.push(...core.findPasses(sat, obs, start, end, { minEl: 10, sunMax: -6, visMinEl: 10 }));
    } catch (err) {
      console.log(JSON.stringify({ kind: 'sat-error', norad, error: err && err.message ? err.message : String(err) }));
    }
  }
  const due = duePasses(found, {
    now, leadMin: rec.leadMin, windowMs,
    sent: rec.sent, visOnly: rec.visOnly, minMag: rec.minMag
  });
  if (!due.length) return;
  const sent = { ...(rec.sent || {}) };
  for (const item of due) {
    const payload = alertPayload(item, rec.leadMin);
    const res = await sendPush(env, { endpoint: rec.endpoint, keys: rec.keys }, payload);
    logPush(item.pass.norad, res.status);
    if (res.status === 404 || res.status === 410) {
      await env.ALERTS.delete(keyName);
      return;
    }
    if (res.ok) sent[item.key] = now;
  }
  rec.sent = pruneSent(sent, now);
  await env.ALERTS.put(keyName, JSON.stringify(rec));
}

async function runCron(env) {
  const core = await loadSatCore();
  let text;
  try { text = await ensureTles(env, core); }
  catch (err) {
    console.log(JSON.stringify({ kind: 'tle-refresh-failed', message: err.message }));
    const cached = await env.ALERTS.get('tle:bundle', 'json');
    if (!cached || !cached.text) return;
    text = cached.text;
  }
  const catalog = new Map();
  for (const rec of core.parseTLE(text)) if (!catalog.has(rec.norad)) catalog.set(rec.norad, rec);
  const cursor = await env.ALERTS.get('meta:cursor');
  const page = await env.ALERTS.list({ prefix: 'sub:', limit: SUB_LIMIT, cursor: cursor || undefined });
  const now = Date.now();
  const lastRun = Number(await env.ALERTS.get('meta:lastRun'));
  const windowMs = dueWindowMs(lastRun, now);
  for (const key of page.keys) {
    const rec = await env.ALERTS.get(key.name, 'json');
    if (!rec || !rec.endpoint) continue;
    try { await alertOne(env, core, catalog, rec, key.name, now, windowMs); }
    catch (err) { console.log(JSON.stringify({ kind: 'subscriber-failed', message: err.message })); }
  }
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
