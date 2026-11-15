/* SatPass Worker: static site, push subscription API, and the pass-alert cron.
   The VAPID private key is env.VAPID_PRIVATE_KEY, set with `wrangler secret put`. */
import { loadSatCore } from './core-loader.js';
import { loadVapid, publicKeyFromPrivateJwk, sendPush } from './vapid.js';
import { validateSubscription, subscriptionId, duePasses, pruneSent, alertPayload, CRON_WINDOW_MS } from './alerts.js';

const TLE_TTL_MS = 2 * 3600 * 1000;
const SUB_LIMIT = 20;
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
    if (env.SATPASS_DEV !== '1') return json({ error: 'Not found' }, 404);
    const body = await readJson(request);
    if (!body || typeof body.endpoint !== 'string') return json({ error: 'Missing endpoint' }, 400);
    const id = await subscriptionId(body.endpoint);
    const rec = await env.ALERTS.get('sub:' + id, 'json');
    if (!rec) return json({ error: 'Subscribe before sending a test' }, 404);
    const payload = {
      title: 'SatPass test',
      body: 'ISS in 10 min, rises NW 6:42 PM, max 54 deg, mag -3.1',
      url: '/?norad=25544',
      tag: 'test'
    };
    const res = await sendPush(env, { endpoint: rec.endpoint, keys: rec.keys }, payload);
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

async function tleFor(env, core, catalog, norad) {
  if (catalog.has(norad)) return;
  const extra = await env.ALERTS.get('tle:extra', 'json');
  const bag = extra && Date.now() - extra.fetchedMs < TLE_TTL_MS ? extra.text : '';
  if (bag) {
    for (const rec of core.parseTLE(bag)) catalog.set(rec.norad, rec);
    if (catalog.has(norad)) return;
  }
  const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=tle`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return;
  const text = await res.text();
  const rec = core.parseTLE(text)[0];
  if (!rec) return;
  catalog.set(rec.norad, rec);
  await env.ALERTS.put('tle:extra', JSON.stringify({ fetchedMs: Date.now(), text: (bag ? bag + '\n' : '') + text }));
}

async function alertOne(env, core, catalog, rec, keyName, now) {
  const missing = rec.norads.filter(n => !catalog.has(n)).slice(0, 8);
  for (const n of missing) await tleFor(env, core, catalog, n);
  const obs = { lat: rec.lat, lon: rec.lon, elev: 0 };
  const start = new Date(now - 60 * 1000);
  const end = new Date(now + (rec.leadMin + 10) * 60000);
  const found = [];
  for (const norad of rec.norads) {
    const tle = catalog.get(norad);
    if (!tle) continue;
    let sat;
    try { sat = core.makeSat(tle); } catch { continue; }
    const std = core.standardMagnitude(sat.norad, sat.name);
    sat.mStd = std ? std.m : null;
    try {
      found.push(...core.findPasses(sat, obs, start, end, { minEl: 10, sunMax: -6, visMinEl: 10 }));
    } catch { /* one bad element set should not stop the tick */ }
  }
  const due = duePasses(found, {
    now, leadMin: rec.leadMin, windowMs: CRON_WINDOW_MS,
    sent: rec.sent, visOnly: rec.visOnly, minMag: rec.minMag
  });
  if (!due.length) return;
  const sent = { ...(rec.sent || {}) };
  for (const item of due) {
    const payload = alertPayload(item, rec.leadMin);
    const res = await sendPush(env, { endpoint: rec.endpoint, keys: rec.keys }, payload);
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
  for (const key of page.keys) {
    const rec = await env.ALERTS.get(key.name, 'json');
    if (!rec || !rec.endpoint) continue;
    try { await alertOne(env, core, catalog, rec, key.name, now); }
    catch (err) { console.log(JSON.stringify({ kind: 'subscriber-failed', message: err.message })); }
  }
  await env.ALERTS.put('meta:cursor', page.list_complete ? '' : (page.cursor || ''));
}

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
