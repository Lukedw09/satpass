/* Pure Web Push alert rules. No network, no secrets. */
const LEADS = new Set([5, 10, 15]);
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const CRON_WINDOW_MS = 5 * 60 * 1000;

export function compass16(azDeg) {
  return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

function b64urlOk(s) {
  return typeof s === 'string' && s.length >= 8 && s.length < 400 && /^[A-Za-z0-9_-]+$/.test(s);
}

/** Round to 0.01° (~1 km) and check the push subscription body. */
export function validateSubscription(body) {
  if (!body || typeof body !== 'object') return { error: 'Missing body' };
  const sub = body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//i.test(sub.endpoint)) return { error: 'Subscription endpoint must be an https URL' };
  if (sub.endpoint.length > 2000) return { error: 'Endpoint is too long' };
  const keys = sub.keys || {};
  if (!b64urlOk(keys.p256dh) || !b64urlOk(keys.auth)) return { error: 'Subscription keys are missing' };
  const lat = Number(body.lat), lon = Number(body.lon);
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return { error: 'Location is out of range' };
  const norads = [...new Set((Array.isArray(body.norads) ? body.norads : []).map(n => +n).filter(n => Number.isInteger(n) && n > 0 && n < 1e9))].slice(0, 12);
  if (!norads.length) return { error: 'Choose at least one satellite' };
  const leadMin = +body.leadMin;
  if (!LEADS.has(leadMin)) return { error: 'Lead time must be 5, 10, or 15 minutes' };
  let minMag = null;
  if (body.minMag != null && body.minMag !== '') {
    minMag = Number(body.minMag);
    if (!Number.isFinite(minMag) || minMag < -6 || minMag > 12) return { error: 'Minimum magnitude is out of range' };
  }
  return {
    value: {
      endpoint: sub.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      lat: Math.round(lat * 100) / 100,
      lon: Math.round(lon * 100) / 100,
      norads,
      leadMin,
      visOnly: body.visOnly !== false,
      minMag
    }
  };
}

export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/**
 * A pass is due when (start − lead) is inside (now − window, now].
 * visOnly keeps naked-eye passes. minMag matches the page filter: the
 * one-decimal magnitude must be brighter than that limit. Unknown magnitudes
 * do not pass a magnitude limit.
 */
export function duePasses(passes, { now, leadMin, windowMs = CRON_WINDOW_MS, sent, visOnly, minMag }) {
  const out = [];
  for (const p of passes) {
    if (visOnly && !p.visible) continue;
    if (minMag != null) {
      if (p.peakMag == null) continue;
      const shown = Math.round(p.peakMag * 10) / 10;
      if (!(shown < minMag)) continue;
    }
    const eventT = p.visible ? p.visible.start.t : p.rise.t;
    const fireAt = eventT - leadMin * 60000;
    if (!(fireAt <= now && fireAt > now - windowMs)) continue;
    const key = `${p.norad}:${Math.round(eventT / 60000)}`;
    if (sent && sent[key]) continue;
    out.push({ pass: p, eventT, key });
  }
  return out;
}

export function pruneSent(sent, now) {
  const keep = {};
  const cutoff = now - 2 * 86400000;
  for (const [k, t] of Object.entries(sent || {})) if (t > cutoff) keep[k] = t;
  return keep;
}

function shortName(name) {
  return String(name || 'Satellite').replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Satellite';
}

function magText(peakMag) {
  if (peakMag == null || Number.isNaN(+peakMag)) return '';
  const n = Math.round(+peakMag * 10) / 10;
  return `, mag ${n.toFixed(1)}`;
}

/** 'ISS in 10 min, rises NW 6:42 PM, max 54 deg, mag -3.1' */
export function formatAlertText({ name, leadMin, az, eventT, maxEl, peakMag }) {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
  }).format(new Date(eventT));
  return `${shortName(name)} in ${leadMin} min, rises ${compass16(az)} ${when}, max ${Math.round(maxEl)} deg${magText(peakMag)}`;
}

export function alertPayload(item, leadMin) {
  const p = item.pass;
  const az = p.visible ? p.visible.start.az : p.rise.az;
  const maxEl = p.visible ? p.visible.max.el : p.max.el;
  const text = formatAlertText({
    name: p.name, leadMin, az, eventT: item.eventT, maxEl, peakMag: p.peakMag
  });
  const url = `/?norad=${p.norad}&rise=${Math.round(item.eventT / 60000)}`;
  return { title: shortName(p.name), body: text, url, tag: item.key };
}
