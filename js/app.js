/* SatPass UI. Depends on SatCore (js/core.js), SatPassLocation (js/push-location.js), SATPASS_FALLBACK, SATPASS_LAND. */
(function () {
  'use strict';
  const C = window.SatCore;
  const Loc = window.SatPassLocation;
  const TZ = 'America/New_York';
  const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
  const GROUPS = ['stations', 'visual'];
  const AUTO_REFRESH_MS = 2 * 3600e3;      // CelesTrak updates GP data ~every 2 h; don't poll faster
  const MANUAL_COOLDOWN_MS = 10 * 60e3;
  const LS_TLE = 'satpass.tle.v1', LS_SET = 'satpass.settings.v1', LS_CUSTOM = 'satpass.custom.v1', LS_ALERTS = 'satpass.alerts.v1', LS_CLOUD = 'satpass.clouds.v1', LS_PUSH = 'satpass.push.v1';
  const CLOUD_TTL = 3600e3;
  const CELESTRAK_SATCAT = 'https://celestrak.org/satcat/records.php';
  const HOME = { name: 'Los Angeles', lat: 34.05, lon: -118.25, elev: 90 };
  const ISS_NORAD = 25544;
  const DEFAULT_SATS = [25544, 48274, 20580, 27386, 25407, 22566];
  const PALETTE = ['#ffd166', '#ff7b7b', '#6ea8ff', '#3ddc97', '#c792ea', '#ff9f43', '#4dd0e1', '#f78fb3', '#a3e635', '#e2e8f0'];

  const $ = id => document.getElementById(id);
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } };

  // A place already stored in this browser replaces HOME. Opening the page does not overwrite it.
  const settings = Object.assign({ obs: { ...HOME }, days: 7, minEl: 10, sunMax: -6, visOnly: true, maxMag: null,
    sats: DEFAULT_SATS.map(n => ({ norad: n, on: true })) }, load(LS_SET, {}));
  let custom = load(LS_CUSTOM, {});        // norad -> {name,l1,l2,norad} for objects added by search
  let catalog = new Map();                  // norad -> rec from group downloads
  let satObjs = new Map();                  // norad -> SatCore sat
  let dataMeta = null;
  let passes = [], selKey = null, liveNorad = null, lastFetchMs = 0;
  let recentByNorad = new Map(), recentOmms = [], trains = [], launchDates = {}, starlinkIds = new Set();
  let sortMode = 'time', skyPts = [], skyCursor = null, cloudPack = null;
  let alerts = loadAlerts();
  const alertTimers = new Map();

  // ---------- formatting ----------
  const fmtTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const fmtHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fmtDate = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const fmtFull = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const tzAbbr = d => new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName').value;
  const T = t => fmtTime.format(new Date(t));
  const dur = s => { s = Math.round(s); const m = Math.floor(s / 60); return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
  const ago = ms => { const m = Math.round(ms / 60e3); if (m < 1) return 'just now'; if (m < 90) return `${m} min ago`; const h = ms / 3600e3; return h < 48 ? `${h.toFixed(1)} h ago` : `${(h / 24).toFixed(1)} days ago`; };
  const deg = (v, d = 0) => `${v.toFixed(d)}°`;
  const azTxt = az => `${C.compass(az)} ${Math.round(az)}°`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const colorOf = norad => { const i = settings.sats.findIndex(s => s.norad === norad); return PALETTE[(i < 0 ? 0 : i) % PALETTE.length]; };
  const persist = () => save(LS_SET, settings);

  // ---------- data ----------
  async function fetchText(url, ms = 15000) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally { clearTimeout(t); }
  }

  async function fetchJSON(url, ms = 20000) {
    const data = JSON.parse(await fetchText(url, ms));
    if (!Array.isArray(data)) throw new Error('unexpected response');
    return data;
  }

  function stampMag(sat) {
    const std = C.standardMagnitude(sat.norad, sat.name);
    sat.mStd = std ? std.m : null;
    sat.magApprox = !!(std && std.approx);
    return sat;
  }

  function satFromSetting(s) {
    const rec = recOf(s.norad);
    let sat = null;
    try {
      if (rec && rec.l1) sat = C.makeSat(rec);
      else if (recentByNorad.has(s.norad)) sat = C.makeSatFromOmm(recentByNorad.get(s.norad));
      else if (rec && rec.omm) sat = C.makeSatFromOmm(rec.omm);
    } catch (e) { console.warn(e); return null; }
    if (!sat) return null;
    stampMag(sat);
    if (s.trainKey) {
      const t = trains.find(x => x.key === s.trainKey);
      if (t) { sat.name = t.label; sat.trainSpreadMin = t.spreadMin; sat.trainCount = t.count; }
    }
    return sat;
  }

  function ingest(text) {
    catalog = new Map();
    for (const r of C.parseTLE(text)) if (!catalog.has(r.norad)) catalog.set(r.norad, r);
  }

  async function fetchRecent() {
    // Same 2-hour cache as the station and visual TLEs. Starlink is kept as catalog numbers only.
    const [recent, star, cat] = await Promise.all([
      fetchJSON(`${CELESTRAK}?GROUP=last-30-days&FORMAT=json`).catch(() => null),
      fetchJSON(`${CELESTRAK}?GROUP=starlink&FORMAT=json`, 25000).catch(() => null),
      fetchJSON(`${CELESTRAK_SATCAT}?GROUP=last-30-days&FORMAT=json`).catch(() => null)
    ]);
    const dates = {};
    if (cat) for (const o of cat) {
      const p = C.launchPrefix(o.OBJECT_ID);
      if (p && o.LAUNCH_DATE) dates[p] = String(o.LAUNCH_DATE).slice(0, 10);
    }
    return {
      recent: recent || null,
      starlinkIds: star ? star.map(o => +o.NORAD_CAT_ID).filter(n => n > 0) : null,
      launchDates: Object.keys(dates).length ? dates : null
    };
  }

  function applyRecent(blob) {
    recentOmms = blob && Array.isArray(blob.recent) ? blob.recent : [];
    recentByNorad = new Map(recentOmms.map(o => [+o.NORAD_CAT_ID, o]));
    starlinkIds = new Set((blob && blob.starlinkIds) || []);
    launchDates = (blob && blob.launchDates) || {};
    const objs = recentOmms.map(o => ({
      name: o.OBJECT_NAME, norad: +o.NORAD_CAT_ID, objectId: o.OBJECT_ID,
      meanMotion: o.MEAN_MOTION, meanAnomaly: o.MEAN_ANOMALY,
      launchDate: launchDates[C.launchPrefix(o.OBJECT_ID)] || null
    }));
    trains = C.detectTrains(objs, new Date(), { starlinkIds });
    reconcileTrains();
  }

  function reconcileTrains() {
    const live = new Map(trains.map(t => [t.key, t]));
    settings.sats = settings.sats.filter(s => !s.trainKey || live.has(s.trainKey));
    for (const s of settings.sats) if (s.trainKey && live.has(s.trainKey)) s.norad = live.get(s.trainKey).lead.norad;
  }

  async function loadData(force) {
    const cache = load(LS_TLE, null);
    const fresh = cache && cache.v === 2 && Date.now() - cache.fetchedMs < AUTO_REFRESH_MS;
    if (cache) lastFetchMs = Math.max(lastFetchMs, cache.fetchedMs);
    if (!force && fresh) { ingest(cache.text); applyRecent(cache); dataMeta = { kind: 'cache', fetchedMs: cache.fetchedMs }; }
    else {
      setStatus('Downloading TLEs from CelesTrak…');
      try {
        const texts = await Promise.all(GROUPS.map(g => fetchText(`${CELESTRAK}?GROUP=${g}&FORMAT=tle`)));
        const text = texts.join('\n');
        if (C.parseTLE(text).length < 5) throw new Error('unexpected response');
        ingest(text);
        const extra = await fetchRecent();
        const prev = cache && cache.v === 2 ? cache : null;
        if (!extra.recent && prev) extra.recent = prev.recent;
        if (!extra.starlinkIds && prev) extra.starlinkIds = prev.starlinkIds;
        if (!extra.launchDates && prev) extra.launchDates = prev.launchDates;
        lastFetchMs = Date.now();
        const blob = { v: 2, fetchedMs: lastFetchMs, text, ...extra };
        save(LS_TLE, blob);
        applyRecent(blob);
        dataMeta = { kind: 'live', fetchedMs: lastFetchMs };
        await refreshCustom();
      } catch (e) {
        if (cache && cache.text) { ingest(cache.text); applyRecent(cache); dataMeta = { kind: 'cache', fetchedMs: cache.fetchedMs, err: e.message }; }
        else {
          const fb = window.SATPASS_FALLBACK;
          ingest(fb.tle); applyRecent(null); dataMeta = { kind: 'fallback', fetchedMs: Date.parse(fb.fetchedUtc), err: e.message };
        }
      }
    }
    buildSats(); renderStatus(); renderCatalog(); renderRecent();
  }

  async function refreshCustom() {
    for (const k of Object.keys(custom)) {
      const n = +k; if (catalog.has(n)) continue;
      try { const r = C.parseTLE(await fetchText(`${CELESTRAK}?CATNR=${n}&FORMAT=tle`))[0]; if (r) custom[n] = r; } catch { /* keep old */ }
    }
    save(LS_CUSTOM, custom);
  }

  function recOf(n) { return catalog.get(n) || custom[n] || null; }

  function buildSats() {
    satObjs = new Map();
    for (const s of settings.sats) {
      const sat = satFromSetting(s);
      if (sat) satObjs.set(s.norad, sat);
    }
  }

  function setStatus(html) { $('dataStatus').innerHTML = html; }
  function renderStatus() {
    if (!dataMeta) return;
    const age = Date.now() - dataMeta.fetchedMs, when = `${fmtFull.format(new Date(dataMeta.fetchedMs))} ${tzAbbr(new Date(dataMeta.fetchedMs))}`;
    const stale = age > 3 * 86400e3 ? ' class="stale"' : '';
    const label = { live: 'CelesTrak live', cache: 'CelesTrak (cached in this browser)', fallback: '<span class="stale">Offline: bundled TLE snapshot</span>' }[dataMeta.kind];
    setStatus(`<b>${label}</b> · fetched <span${stale}>${when} (${ago(age)})</span> · ${catalog.size} objects` +
      (dataMeta.err ? ` · <span class="stale">live fetch failed: ${esc(dataMeta.err)}</span>` : ''));
    const wait = MANUAL_COOLDOWN_MS - (Date.now() - lastFetchMs);
    $('refreshBtn').disabled = wait > 0;
    $('refreshBtn').title = wait > 0 ? `CelesTrak asks clients not to re-download often; available in ${Math.ceil(wait / 60e3)} min` : 'Re-download TLEs from CelesTrak';
  }

  function renderCatalog() {
    const dl = $('catalog'); dl.innerHTML = '';
    const items = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const r of items) { const o = document.createElement('option'); o.value = `${r.name} · ${r.norad}`; dl.appendChild(o); }
  }

  // ---------- satellites list ----------
  function renderSatList() {
    const ul = $('satList'); ul.innerHTML = '';
    settings.sats.forEach(s => {
      if (s.recent) return;
      const sat = satObjs.get(s.norad), li = document.createElement('li');
      const ageD = sat ? (Date.now() - sat.epoch.getTime()) / 86400e3 : null;
      li.innerHTML = `<input type="checkbox" ${s.on ? 'checked' : ''} title="include in predictions">
        <span class="sw" style="background:${colorOf(s.norad)}"></span>
        <span class="nm">${esc(sat ? sat.name : 'NORAD ' + s.norad)}
          <small class="${ageD > 5 ? 'stale' : ''}">#${s.norad}${sat ? ` · TLE epoch ${ageD.toFixed(1)} d old` : ' · no TLE found'}</small></span>
        <button class="x" title="remove">✕</button>`;
      li.querySelector('input').onchange = e => { s.on = e.target.checked; persist(); recompute(); };
      li.querySelector('.x').onclick = () => { settings.sats = settings.sats.filter(x => x !== s); delete custom[s.norad]; save(LS_CUSTOM, custom); persist(); buildSats(); renderSatList(); recompute(); };
      ul.appendChild(li);
    });
    const sel = $('liveSat'), cur = liveNorad; sel.innerHTML = '';
    for (const s of settings.sats) {
      if (s.recent && !s.on) continue;
      const sat = satObjs.get(s.norad); if (!sat) continue;
      const o = document.createElement('option'); o.value = s.norad; o.textContent = sat.name; sel.appendChild(o);
    }
    if (cur && satObjs.has(cur)) sel.value = cur; else if (sel.options.length) { liveNorad = +sel.options[0].value; sel.value = liveNorad; }
  }

  function fmtSpread(min) {
    if (!(min >= 0)) return '';
    return min < 10 ? `${min.toFixed(1)} min` : `${Math.round(min)} min`;
  }

  function recentOn(match) { return settings.sats.find(match); }

  function toggleRecent(entry, on) {
    settings.sats = settings.sats.filter(s => entry.trainKey ? s.trainKey !== entry.trainKey : !(s.recent && !s.trainKey && s.norad === entry.norad));
    if (on) {
      settings.sats.push(entry);
      const omm = recentByNorad.get(entry.norad);
      if (omm && !catalog.has(entry.norad)) { custom[entry.norad] = { omm, norad: entry.norad, name: omm.OBJECT_NAME }; save(LS_CUSTOM, custom); }
    }
    persist(); buildSats(); renderSatList(); renderRecent(); recompute();
  }

  function renderRecent() {
    const wrap = $('recentWrap'), ul = $('recentList');
    if (!wrap || !ul) return;
    if (!recentOmms.length) { wrap.hidden = true; ul.innerHTML = ''; return; }
    wrap.hidden = false;
    const members = new Set();
    for (const t of trains) for (const m of t.members) members.add(m.norad);
    ul.innerHTML = '';
    const addRow = (html, on, change) => {
      const li = document.createElement('li');
      li.innerHTML = html;
      const box = li.querySelector('input');
      box.checked = on;
      box.onchange = () => change(box.checked);
      ul.appendChild(li);
    };
    for (const t of trains) {
      const on = !!recentOn(s => s.trainKey === t.key && s.on);
      addRow(`<input type="checkbox" title="include this train">
        <span class="sw" style="background:${colorOf(t.lead.norad)}"></span>
        <span class="nm">${esc(t.label)}
          <small>${t.count} satellites · lead #${t.lead.norad} · spread ${fmtSpread(t.spreadMin)}</small></span>`, on,
        checked => toggleRecent({ norad: t.lead.norad, on: true, recent: true, trainKey: t.key }, checked));
    }
    const rest = recentOmms.filter(o => !members.has(+o.NORAD_CAT_ID)).slice().sort((a, b) => String(a.OBJECT_NAME).localeCompare(String(b.OBJECT_NAME)));
    for (const o of rest) {
      const norad = +o.NORAD_CAT_ID;
      const on = !!recentOn(s => s.recent && !s.trainKey && s.norad === norad && s.on);
      const rawDay = launchDates[C.launchPrefix(o.OBJECT_ID)];
      const day = rawDay ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(rawDay.slice(0, 10) + 'T00:00:00Z')) : '';
      addRow(`<input type="checkbox" title="include this satellite">
        <span class="sw" style="background:${colorOf(norad)}"></span>
        <span class="nm">${esc(o.OBJECT_NAME)}
          <small>#${norad}${day ? ` · launched ${esc(day)}` : ''}</small></span>`, on,
        checked => toggleRecent({ norad, on: true, recent: true }, checked));
    }
  }

  async function addSat(q) {
    const msg = $('addMsg'); msg.className = 'hint'; msg.textContent = '';
    q = q.trim(); if (!q) return;
    let n = null;
    const m = q.match(/·\s*(\d{1,9})\s*$/) || q.match(/^\s*(\d{1,9})\s*$/);
    if (m) n = +m[1];
    let rec = n != null ? recOf(n) : [...catalog.values()].find(r => r.name.toLowerCase() === q.toLowerCase()) || [...catalog.values()].find(r => r.name.toLowerCase().includes(q.toLowerCase()));
    if (!rec) {
      msg.textContent = 'Searching CelesTrak…';
      try {
        const url = n != null ? `${CELESTRAK}?CATNR=${n}&FORMAT=tle` : `${CELESTRAK}?NAME=${encodeURIComponent(q)}&FORMAT=tle`;
        const found = C.parseTLE(await fetchText(url));
        if (!found.length) { msg.className = 'hint err'; msg.textContent = `No current element set found for “${q}”.`; return; }
        rec = found[0];
        if (found.length > 1) msg.textContent = `${found.length} matches; added the first (${rec.name}). Use a NORAD number to pick another.`;
        custom[rec.norad] = rec; save(LS_CUSTOM, custom);
      } catch (e) { msg.className = 'hint err'; msg.textContent = `CelesTrak lookup failed (${e.message}).`; return; }
    }
    if (settings.sats.some(s => s.norad === rec.norad)) { msg.textContent = `${rec.name} is already in the list.`; return; }
    try { C.makeSat(rec); } catch (e) { msg.className = 'hint err'; msg.textContent = e.message; return; }
    settings.sats.push({ norad: rec.norad, on: true }); persist();
    if (!msg.textContent || msg.textContent.startsWith('Searching')) msg.textContent = `Added ${rec.name} (#${rec.norad}).`;
    $('addInput').value = '';
    buildSats(); renderSatList(); recompute();
  }

  // ---------- passes ----------
  let recomputeTimer = null;
  function recompute() {
    clearTimeout(recomputeTimer);
    $('passCount').textContent = 'computing…';
    recomputeTimer = setTimeout(computeNow, 30);
  }
  function computeNow() {
    const now = Date.now(), start = new Date(now - 20 * 60e3), end = new Date(now + settings.days * 86400e3);
    const all = [];
    for (const s of settings.sats) {
      if (!s.on) continue;
      const sat = satObjs.get(s.norad); if (!sat) continue;
      try { all.push(...C.findPasses(sat, settings.obs, start, end, { minEl: settings.minEl, sunMax: settings.sunMax, visMinEl: Math.max(10, 0) })); }
      catch (e) { console.warn('pass search failed', sat.name, e); }
    }
    passes = all.filter(p => p.set.t > now).sort((a, b) => a.rise.t - b.rise.t);
    reconcileAlerts();
    renderTrainBanner();
    renderPasses();
    applyDeepLink();
  }
  let deepLinkDone = false;
  function applyDeepLink() {
    if (deepLinkDone) return;
    const q = new URLSearchParams(location.search);
    const norad = +q.get('norad');
    if (!norad) { deepLinkDone = true; return; }
    if (!passes.length) return;
    deepLinkDone = true;
    const rise = +q.get('rise');
    liveNorad = norad;
    const match = passes.find(p => p.norad === norad && (!rise || Math.abs(Math.round((p.visible ? p.visible.start.t : p.rise.t) / 60000) - rise) <= 2));
    if (match) { selKey = keyOf(match); liveNorad = match.norad; }
    if ($('liveSat') && $('liveSat').querySelector(`option[value="${norad}"]`)) $('liveSat').value = String(norad);
    renderPasses();
  }
  const keyOf = p => `${p.norad}:${Math.round(p.rise.t / 60000)}`;

  // ---------- alerts ----------
  const BELL_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>';
  const CAL_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const ALERT_NOTE = 'Alerts work while SatPass is open (or installed and running). Add to calendar for a phone reminder that still works when this tab is closed.';

  function loadAlerts() {
    const blank = { leadMin: 10, issAll: false, armed: {}, dismissed: {}, fired: {} };
    const v = load(LS_ALERTS, null);
    if (!v || typeof v !== 'object') return blank;
    const lead = [5, 10, 15].includes(+v.leadMin) ? +v.leadMin : 10;
    return {
      leadMin: lead,
      issAll: !!v.issAll,
      armed: v.armed && typeof v.armed === 'object' ? v.armed : {},
      dismissed: v.dismissed && typeof v.dismissed === 'object' ? v.dismissed : {},
      fired: v.fired && typeof v.fired === 'object' ? v.fired : {}
    };
  }
  function saveAlerts() {
    const cutoff = Date.now() - 2 * 86400e3;
    const fired = {};
    for (const [k, t] of Object.entries(alerts.fired || {})) if (t > cutoff) fired[k] = t;
    alerts.fired = fired;
    save(LS_ALERTS, { leadMin: alerts.leadMin, issAll: alerts.issAll, armed: alerts.armed, dismissed: alerts.dismissed, fired });
  }
  function setAlertMsg(text, err) {
    const el = $('alertMsg'); if (!el) return;
    el.className = err ? 'hint err' : 'hint';
    el.textContent = text || '';
  }
  function refreshAlertNote() {
    const el = $('alertNote'); if (!el) return;
    const n = Object.keys(alerts.armed).length;
    el.textContent = (n ? `${n} alert${n === 1 ? '' : 's'} set. ` : '') + ALERT_NOTE;
  }
  function passEvent(p) { return p.visible ? p.visible.start.t : p.rise.t; }
  function describePass(p) {
    if (p.visible) {
      const v = p.visible;
      return `Visible ${T(v.start.t)}–${T(v.end.t)}, max ${deg(v.max.el)} ${C.compass(v.max.az)}. Look ${C.compass(v.start.az)}.`;
    }
    return `Rises ${T(p.rise.t)} ${C.compass(p.rise.az)}, max ${deg(p.max.el)} ${C.compass(p.max.az)}.`;
  }
  function recordFromPass(p, auto) {
    return {
      norad: p.norad, name: p.name, riseT: p.rise.t,
      eventT: passEvent(p), endT: p.visible ? p.visible.end.t : p.set.t,
      leadMin: alerts.leadMin, auto: !!auto, visible: !!p.visible, text: describePass(p)
    };
  }
  function notifyUnavailableMessage() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let standalone = false;
    try { standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; } catch { /* ignore */ }
    if (typeof Notification !== 'function') {
      if (ios && !standalone) return 'On iPhone and iPad, Safari shows alerts only after you add SatPass to your Home Screen and open it from there. Use Add to calendar for a reminder that works while SatPass is closed.';
      return 'This browser cannot show alerts. Use Add to calendar on a pass — that reminder still fires when SatPass is closed.';
    }
    if (Notification.permission === 'denied') return 'Alerts are blocked for this site. Allow notifications in the browser settings, or use Add to calendar.';
    return null;
  }
  async function ensurePermission() {
    const blocked = notifyUnavailableMessage();
    if (blocked) { setAlertMsg(blocked, true); return false; }
    if (Notification.permission === 'granted') return true;
    try {
      const result = await Notification.requestPermission();
      if (result !== 'granted') {
        setAlertMsg('Alerts were not allowed. Use Add to calendar on a pass for a reminder that works when this tab is closed.', true);
        return false;
      }
      return true;
    } catch {
      setAlertMsg('Alerts are not available in this browser. Use Add to calendar instead.', true);
      return false;
    }
  }
  function clearAlertTimer(k) {
    if (!alertTimers.has(k)) return;
    clearTimeout(alertTimers.get(k));
    alertTimers.delete(k);
  }
  function showAlert(k) {
    const rec = alerts.armed[k];
    if (!rec || rec.eventT <= Date.now()) return;
    if (alerts.fired[k] && Date.now() - alerts.fired[k] < 12 * 3600e3) return;
    if (typeof Notification !== 'function' || Notification.permission !== 'granted') return;
    alerts.fired[k] = Date.now();
    saveAlerts();
    const mins = Math.max(0, Math.round((rec.eventT - Date.now()) / 60000));
    const when = mins <= 1 ? 'in about a minute' : `in ${mins} min`;
    const title = `${rec.name} ${when}`;
    const opts = { body: rec.text, tag: 'satpass-' + k, lang: 'en' };
    // Page-constructed Notification throws on Android Chrome. The service
    // worker can still show it; fall back only when that path is unavailable.
    const fallback = () => {
      try {
        const n = new Notification(title, opts);
        n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
      } catch { /* the browser refused to display it */ }
    };
    const sw = navigator.serviceWorker;
    if (!sw || !sw.ready || typeof sw.getRegistration !== 'function') { fallback(); return; }
    sw.getRegistration().then(reg => {
      if (!reg) { fallback(); return null; }
      return sw.ready.then(r => r.showNotification(title, opts));
    }).catch(fallback);
  }
  function scheduleOne(k) {
    clearAlertTimer(k);
    const rec = alerts.armed[k];
    if (!rec) return;
    if (rec.eventT <= Date.now()) { delete alerts.armed[k]; delete alerts.dismissed[k]; return; }
    const fireAt = rec.eventT - (rec.leadMin || alerts.leadMin) * 60000;
    let wait = fireAt - Date.now();
    if (wait < 0) wait = 800;
    const cap = 2147483647;
    const slice = Math.min(wait, cap);
    alertTimers.set(k, setTimeout(() => {
      alertTimers.delete(k);
      if (wait > cap) scheduleOne(k);
      else showAlert(k);
    }, slice));
  }
  function scheduleAll() {
    for (const k of [...alertTimers.keys()]) clearAlertTimer(k);
    for (const k of Object.keys(alerts.armed)) scheduleOne(k);
    saveAlerts();
    refreshAlertNote();
  }
  function reconcileAlerts() {
    const now = Date.now();
    for (const [k, rec] of Object.entries(alerts.armed)) {
      if (!rec || rec.eventT <= now) { delete alerts.armed[k]; delete alerts.dismissed[k]; }
    }
    const byKey = new Map(passes.map(p => [keyOf(p), p]));
    for (const [k, rec] of Object.entries(alerts.armed)) {
      const p = byKey.get(k);
      if (!p) continue;
      const fresh = recordFromPass(p, rec.auto);
      alerts.armed[k] = fresh;
    }
    if (!alerts.issAll) {
      for (const [k, rec] of Object.entries(alerts.armed)) if (rec.auto) delete alerts.armed[k];
    } else if (typeof Notification === 'function' && Notification.permission === 'granted') {
      for (const p of passes) {
        if (p.norad !== ISS_NORAD || !p.visible || passEvent(p) <= now) continue;
        const k = keyOf(p);
        if (alerts.dismissed[k] || alerts.armed[k]) continue;
        alerts.armed[k] = recordFromPass(p, true);
      }
    }
    scheduleAll();
  }
  function alertButtons(p) {
    const k = keyOf(p), on = !!alerts.armed[k];
    const when = p.visible ? 'it becomes visible' : 'rise';
    const bellLabel = on
      ? `Cancel alert for ${p.name}. Set for ${alerts.leadMin} min before ${when}.`
      : `Notify me ${alerts.leadMin} minutes before ${p.name} ${when}`;
    return `<span class="alertbtns"><button type="button" class="iconbtn find" data-act="find" data-key="${k}" aria-label="${esc('Find ' + p.name + ' in the sky')}" title="Find it">Find</button><button type="button" class="iconbtn bell${on ? ' on' : ''}" data-act="bell" data-key="${k}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${esc(bellLabel)}" title="${esc(bellLabel)}">${BELL_SVG}</button><button type="button" class="iconbtn cal" data-act="cal" data-key="${k}" aria-label="${esc('Add ' + p.name + ' to calendar')}" title="Add to calendar">${CAL_SVG}</button></span>`;
  }
  function wireAlertButtons(root, p) {
    root.querySelectorAll('button[data-act]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        if (btn.dataset.act === 'bell') toggleAlert(p);
        else if (btn.dataset.act === 'find') openFinder(p.norad);
        else downloadIcs(p);
      };
    });
  }
  async function toggleAlert(p) {
    const k = keyOf(p);
    selKey = k; liveNorad = p.norad;
    if ($('liveSat').querySelector(`option[value="${p.norad}"]`)) $('liveSat').value = String(p.norad);
    if (alerts.armed[k]) {
      if (alerts.issAll && alerts.armed[k].norad === ISS_NORAD) alerts.dismissed[k] = Date.now();
      delete alerts.armed[k];
      clearAlertTimer(k);
      saveAlerts();
      setAlertMsg('');
      refreshAlertNote();
      renderPasses();
      schedulePushSync();
      return;
    }
    if (passEvent(p) <= Date.now()) { setAlertMsg('That pass has already begun.', true); renderPasses(); return; }
    const ok = await ensurePermission();
    if (!ok) { renderPasses(); return; }
    delete alerts.dismissed[k];
    alerts.armed[k] = recordFromPass(p, false);
    saveAlerts();
    scheduleOne(k);
    refreshAlertNote();
    const soon = passEvent(p) - alerts.leadMin * 60000 <= Date.now();
    setAlertMsg(soon
      ? `${p.name} is already inside the ${alerts.leadMin}-minute window, so the alert rings in a moment.`
      : `Alert set for ${p.name}, ${alerts.leadMin} min before ${p.visible ? 'it becomes visible' : 'rise'}.`);
    renderPasses();
    schedulePushSync();
  }
  function icsEscape(s) { return String(s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;'); }
  function icsStamp(ms) {
    const d = new Date(ms), p2 = n => String(n).padStart(2, '0');
    return d.getUTCFullYear() + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds()) + 'Z';
  }
  function icsFold(line) {
    let s = line, out = '';
    while (s.length > 73) { out += s.slice(0, 73) + '\r\n'; s = ' ' + s.slice(73); }
    return out + s;
  }
  function downloadIcs(p) {
    const start = passEvent(p), end = Math.max(p.visible ? p.visible.end.t : p.set.t, start + 60000);
    const lead = alerts.leadMin;
    const summary = p.visible ? `${p.name} visible pass` : `${p.name} pass`;
    const where = settings.obs.name || `${settings.obs.lat}, ${settings.obs.lon}`;
    const desc = `${describePass(p)} Times are Eastern. https://satpass.lukedw09.workers.dev/`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//SatPass//lukedw09//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:satpass-${p.norad}-${Math.round(p.rise.t / 1000)}@satpass.lukedw09.workers.dev`,
      'DTSTAMP:' + icsStamp(Date.now()),
      'DTSTART:' + icsStamp(start),
      'DTEND:' + icsStamp(end),
      'SUMMARY:' + icsEscape(summary),
      'LOCATION:' + icsEscape(where),
      'DESCRIPTION:' + icsEscape(desc),
      'URL:https://satpass.lukedw09.workers.dev/',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEscape(`${p.name} in ${lead} minutes`),
      `TRIGGER:-PT${lead}M`,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR'
    ];
    const body = lines.map(icsFold).join('\r\n') + '\r\n';
    const blob = new Blob([body], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pass';
    a.href = URL.createObjectURL(blob);
    a.download = `satpass-${slug}-${icsStamp(start).slice(0, 8)}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function bindAlerts() {
    const lead = $('alertLead'), iss = $('alertIss');
    if (!lead || !iss) return;
    lead.value = String(alerts.leadMin);
    iss.checked = alerts.issAll;
    refreshAlertNote();
    scheduleAll();
    lead.onchange = () => {
      const n = +lead.value;
      alerts.leadMin = [5, 10, 15].includes(n) ? n : 10;
      for (const rec of Object.values(alerts.armed)) rec.leadMin = alerts.leadMin;
      scheduleAll();
      setAlertMsg(`Reminders ring ${alerts.leadMin} minutes before the pass.`);
      renderPasses();
      schedulePushSync();
    };
    iss.onchange = async () => {
      if (iss.checked) {
        const ok = await ensurePermission();
        if (!ok) { iss.checked = false; alerts.issAll = false; saveAlerts(); return; }
        alerts.issAll = true;
        alerts.dismissed = {};
        setAlertMsg('Visible ISS passes will ring ' + alerts.leadMin + ' min before they become visible.');
      } else {
        alerts.issAll = false;
        alerts.dismissed = {};
        setAlertMsg('');
      }
      reconcileAlerts();
      renderPasses();
      schedulePushSync();
    };
    $('skyInfo').addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      e.stopPropagation();
      const p = passes.find(x => keyOf(x) === btn.dataset.key);
      if (!p) return;
      if (btn.dataset.act === 'bell') toggleAlert(p);
      else if (btn.dataset.act === 'find') openFinder(p.norad);
      else downloadIcs(p);
    });
  }

  function bannerWhen(ms) {
    const d = new Date(ms);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
    const tm = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
    return `${wd} ${tm}`;
  }

  function renderTrainBanner() {
    const el = $('trainBanner');
    if (!el) return;
    const items = [];
    const now = Date.now(), start = new Date(now - 20 * 60e3), end = new Date(now + settings.days * 86400e3);
    for (const t of trains) {
      const omm = recentByNorad.get(t.lead.norad);
      if (!omm) continue;
      let sat;
      try { sat = stampMag(C.makeSatFromOmm(omm)); } catch { continue; }
      sat.name = t.label;
      let found = [];
      try { found = C.findPasses(sat, settings.obs, start, end, { minEl: settings.minEl, sunMax: settings.sunMax }); }
      catch { continue; }
      const p = found.filter(x => x.visible && x.visible.end.t > now).sort((a, b) => a.visible.start.t - b.visible.start.t)[0];
      if (p) items.push({ t, p });
    }
    items.sort((a, b) => a.p.visible.start.t - b.p.visible.start.t);
    if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.innerHTML = items.slice(0, 3).map(({ t, p }) =>
      `<p>Starlink train visible ${bannerWhen(p.visible.start.t)}, look ${C.compass(p.visible.start.az)} <span class="sub">· ${esc(t.label)} · spread ${fmtSpread(t.spreadMin)}</span></p>`
    ).join('');
  }

  function shownPasses() {
    let list = settings.visOnly ? passes.filter(p => p.visible) : passes.slice();
    if (settings.maxMag != null && !Number.isNaN(+settings.maxMag)) {
      const lim = +settings.maxMag;
      list = list.filter(p => p.peakMag != null && Math.round(p.peakMag * 10) / 10 < lim);
    }
    if (sortMode === 'mag-asc' || sortMode === 'mag-desc') {
      const dir = sortMode === 'mag-asc' ? 1 : -1;
      list.sort((a, b) => {
        if (a.peakMag == null && b.peakMag == null) return a.rise.t - b.rise.t;
        if (a.peakMag == null) return 1;
        if (b.peakMag == null) return -1;
        return (a.peakMag - b.peakMag) * dir || a.rise.t - b.rise.t;
      });
    }
    return list;
  }

  function magCell(p) {
    if (p.peakMag == null || !Number.isFinite(p.peakMag)) return '<td class="mag">—</td>';
    const approx = satObjs.get(p.norad)?.magApprox ? 'Approximate standard magnitude for this type of Starlink' : 'Peak visual magnitude along the visible pass';
    return `<td class="mag" title="${esc(approx)}">${p.peakMag.toFixed(1)}</td>`;
  }

  function cloudCell(p) {
    if (!cloudPack) return '<td class="cloud"></td>';
    const c = C.nearestCloud(cloudPack.samples, p.max.t);
    if (!c || !c.forecast) return '<td class="cloud">no forecast</td>';
    const pct = v => v == null || Number.isNaN(v) ? '—' : `${Math.round(v)}%`;
    const tip = `Total ${Math.round(c.total)}% · low ${pct(c.low)} · mid ${pct(c.mid)} · high ${pct(c.high)}`;
    return `<td class="cloud"><span class="cicon ${c.kind}" title="${esc(tip)}">${Math.round(c.total)}%</span></td>`;
  }

  function renderPasses() {
    skyCursor = null;
    const tip = $('skyHover'); if (tip) tip.hidden = true;
    const table = $('passTable');
    table.classList.toggle('nocoloud', !cloudPack);
    const tb = table.querySelector('tbody'); tb.innerHTML = '';
    $('magSort').textContent = sortMode === 'mag-asc' ? 'Mag ▲' : sortMode === 'mag-desc' ? 'Mag ▼' : 'Mag';
    const list = shownPasses();
    const nVis = passes.filter(p => p.visible).length;
    const magNote = settings.maxMag != null && !Number.isNaN(+settings.maxMag) ? ` · brighter than ${settings.maxMag}` : '';
    $('passCount').textContent = `${list.length} shown · ${nVis} visible · next ${settings.days} days · times ${tzAbbr(new Date())}${magNote}`;
    $('tzLabel').textContent = `America/New_York (${tzAbbr(new Date())})`;
    if (!list.some(p => keyOf(p) === selKey)) { const d = list.find(p => p.visible) || list[0]; selKey = d ? keyOf(d) : null; }
    const now = Date.now();
    for (const p of list) {
      const tr = document.createElement('tr'), k = keyOf(p);
      if (k === selKey) tr.className = 'sel';
      const live = p.rise.t <= now && p.set.t >= now;
      const why = p.sunElAtMax > settings.sunMax ? 'daylight' : (!p.sunlitAtMax ? 'in shadow' : 'too low');
      const vis = p.visible ? `<span class="badge vis">★ ${T(p.visible.start.t)} – ${T(p.visible.end.t)}</span> <span class="sub">max ${deg(p.visible.max.el)} ${C.compass(p.visible.max.az)}</span>` : `<span class="badge no">— ${why}</span>`;
      tr.innerHTML = `<td>${fmtDate.format(new Date(p.rise.t))}${live ? '<span class="badge now">NOW</span>' : ''}</td>
        <td><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorOf(p.norad)};margin-right:6px"></span>${esc(p.name)}</td>
        <td>${T(p.rise.t)} <span class="sub">${C.compass(p.rise.az)}</span></td>
        <td>${T(p.max.t)} <b>${deg(p.max.el)}</b> <span class="sub">${C.compass(p.max.az)}</span></td>
        <td>${T(p.set.t)} <span class="sub">${C.compass(p.set.az)}</span></td>
        <td>${dur(p.durationSec)}</td>${magCell(p)}${cloudCell(p)}<td>${vis}</td><td class="alertcell">${alertButtons(p)}</td>`;
      wireAlertButtons(tr, p);
      tr.onclick = () => { selKey = k; liveNorad = p.norad; if ($('liveSat').querySelector(`option[value="${p.norad}"]`)) $('liveSat').value = p.norad; renderPasses(); };
      tb.appendChild(tr);
    }
    if (!list.length) tb.innerHTML = `<tr><td colspan="10" class="muted">No passes match. Try lowering the minimum elevation, adding days, relaxing the magnitude filter, or unticking “visible only”.</td></tr>`;
    drawSky();
  }

  const selected = () => passes.find(p => keyOf(p) === selKey) || null;

  // ---------- sky chart ----------
  function drawSky() {
    const cv = $('sky'), g = cv.getContext('2d'), W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 34;
    g.clearRect(0, 0, W, W);
    const P = (az, el) => { const r = R * (90 - Math.max(el, 0)) / 90, a = az * Math.PI / 180; return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    g.fillStyle = '#0d1430'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
    g.strokeStyle = '#26305a'; g.lineWidth = 1; g.fillStyle = '#5c6796'; g.font = '11px system-ui';
    for (const el of [0, 30, 60]) { g.beginPath(); g.arc(cx, cy, R * (90 - el) / 90, 0, 7); g.stroke(); if (el) g.fillText(el + '°', cx + 3, cy - R * (90 - el) / 90 + 12); }
    for (let a = 0; a < 360; a += 45) { const [x, y] = P(a, 0); g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke(); }
    g.fillStyle = '#aab4dd'; g.font = 'bold 13px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
    ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((t, i) => { const a = i * 45 * Math.PI / 180, r = R + 18; g.fillText(t, cx + r * Math.sin(a), cy - r * Math.cos(a)); });
    g.textAlign = 'left'; g.textBaseline = 'alphabetic';
    const p = selected();
    skyPts = [];
    if (!p) { $('skyTitle').textContent = 'select a pass'; $('skyInfo').innerHTML = ''; return; }
    $('skyTitle').textContent = `${p.name} · ${fmtDate.format(new Date(p.max.t))}`;
    g.lineWidth = 4; g.lineCap = 'round';
    for (let i = 1; i < p.track.length; i++) {
      const a = p.track[i - 1], b = p.track[i];
      g.strokeStyle = b.vis ? '#ffd166' : (b.lit ? '#6ea8ff' : '#4a5380');
      g.beginPath(); g.moveTo(...P(a.az, a.el)); g.lineTo(...P(b.az, b.el)); g.stroke();
    }
    for (const pt of p.track) {
      if (pt.el <= 0) continue;
      const [x, y] = P(pt.az, pt.el);
      skyPts.push({ x, y, mag: pt.mag });
    }
    const mark = (pt, shape, label) => {
      const [x, y] = P(pt.az, pt.el); g.fillStyle = '#fff'; g.strokeStyle = '#0b1020'; g.lineWidth = 2; g.beginPath();
      if (shape === 'c') g.arc(x, y, 6, 0, 7); else if (shape === 'd') { g.moveTo(x, y - 8); g.lineTo(x + 8, y); g.lineTo(x, y + 8); g.lineTo(x - 8, y); g.closePath(); } else g.rect(x - 6, y - 6, 12, 12);
      g.fill(); g.stroke();
      g.fillStyle = '#dfe6ff'; g.font = '12px system-ui'; g.fillText(label, x + 10, y - 8);
    };
    mark(p.rise, 'c', 'Rise ' + fmtHM.format(new Date(p.rise.t)));
    mark(p.set, 's', 'Set ' + fmtHM.format(new Date(p.set.t)));
    mark(p.max, 'd', `Max ${deg(p.max.el)} ` + fmtHM.format(new Date(p.max.t)));
    // live dot if pass is in progress
    const now = Date.now(), sat = satObjs.get(p.norad);
    if (sat && now >= p.rise.t && now <= p.set.t) {
      const st = C.stateNow(sat, settings.obs); if (st && st.el > 0) { const [x, y] = P(st.az, st.el); g.fillStyle = '#3ddc97'; g.beginPath(); g.arc(x, y, 7, 0, 7); g.fill(); }
    }
    if (skyCursor) {
      const label = 'mag ' + (skyCursor.mag == null || !Number.isFinite(skyCursor.mag) ? '—' : skyCursor.mag.toFixed(1));
      g.font = 'bold 13px system-ui';
      const tw = g.measureText(label).width;
      const x = Math.min(Math.max(8, skyCursor.x + 12), W - tw - 14);
      const y = Math.min(Math.max(20, skyCursor.y - 12), W - 8);
      g.fillStyle = '#10173af2'; g.strokeStyle = '#ffd166'; g.lineWidth = 1;
      g.beginPath(); g.roundRect(x - 5, y - 14, tw + 10, 20, 4); g.fill(); g.stroke();
      g.fillStyle = '#ffd166'; g.fillText(label, x, y);
    }
    const v = p.visible;
    const magTxt = p.peakMag == null ? '—' : p.peakMag.toFixed(1) + (sat && sat.magApprox ? ' approx' : '');
    const spreadNote = sat && sat.trainSpreadMin != null ? ` Train spread ${fmtSpread(sat.trainSpreadMin)} (${sat.trainCount} satellites), timed from the lead.` : '';
    $('skyInfo').innerHTML = `
      <div><b>Rise</b>${T(p.rise.t)}<br>${azTxt(p.rise.az)}</div>
      <div><b>Max</b>${T(p.max.t)}<br>${deg(p.max.el, 1)} · ${azTxt(p.max.az)}</div>
      <div><b>Set</b>${T(p.set.t)}<br>${azTxt(p.set.az)}</div>
      <div><b>Duration</b>${dur(p.durationSec)}</div>
      <div><b>Peak mag</b>${magTxt}</div>
      <div><b>Range at max</b>${Math.round(p.max.range).toLocaleString()} km</div>
      <div><b>Sun at max</b>${deg(p.sunElAtMax, 1)}</div>
      <div style="grid-column:1/-1"><b>Naked-eye visibility</b>${v ? `Visible ${T(v.start.t)} (${deg(v.start.el)} ${C.compass(v.start.az)}) → max ${deg(v.max.el)} ${C.compass(v.max.az)} → ${T(v.end.t)} (${deg(v.end.el)} ${C.compass(v.end.az)})${v.end.t < p.set.t - 20000 && !p.set.lit ? ', then fades into Earth’s shadow' : ''}${spreadNote}` : 'Not visible: ' + (p.sunElAtMax > settings.sunMax ? 'sky too bright (sun above ' + settings.sunMax + '°)' : 'satellite in Earth’s shadow or below 10°')}</div>
      <div class="remind" style="grid-column:1/-1">${alertButtons(p)}<span class="when">${alerts.leadMin} min before ${p.visible ? 'it becomes visible' : 'rise'}</span></div>`;
  }

  // ---------- live + map ----------
  // Unwrap rings that cross the antimeridian so they fill correctly; draw copies shifted by +-360 deg.
  const landRings = (window.SATPASS_LAND || []).map(r => {
    const pts = [r[0].slice()];
    for (let i = 1; i < r.length; i++) {
      let lo = r[i][0]; const prev = pts[i - 1][0];
      while (lo - prev > 180) lo -= 360; while (lo - prev < -180) lo += 360;
      pts.push([lo, r[i][1]]);
    }
    const span = pts[pts.length - 1][0] - pts[0][0];
    if (Math.abs(span) > 300) { // encircles a pole (Antarctica): close the ring along the pole
      const pole = pts[0][1] < 0 ? -90 : 90;
      pts.push([pts[pts.length - 1][0], pole], [pts[0][0], pole]);
    }
    const mn = Math.min(...pts.map(p => p[0])), mx = Math.max(...pts.map(p => p[0]));
    const offs = [0]; if (mn < -180) offs.push(360); if (mx > 180) offs.push(-360);
    return { pts, offs };
  });
  let nightCanvas = null, nightAt = 0;
  function nightLayer(W, H) {
    if (nightCanvas && Date.now() - nightAt < 60e3) return nightCanvas;
    const cw = 180, ch = 90, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d'), img = g.createImageData(cw, ch), ss = C.subSolar(new Date());
    const d2r = Math.PI / 180, sl = ss.lat * d2r, so = ss.lon * d2r;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const lat = (90 - (j + .5) * 180 / ch) * d2r, lon = (-180 + (i + .5) * 360 / cw) * d2r;
      const cosz = Math.sin(lat) * Math.sin(sl) + Math.cos(lat) * Math.cos(sl) * Math.cos(lon - so);
      const a = cosz < -0.1 ? 150 : cosz < 0.05 ? 150 * (0.05 - cosz) / 0.15 : 0, k = (j * cw + i) * 4;
      img.data[k] = 0; img.data[k + 1] = 3; img.data[k + 2] = 12; img.data[k + 3] = a;
    }
    g.putImageData(img, 0, 0); nightCanvas = c; nightAt = Date.now(); return c;
  }

  function drawMap(sat) {
    const cv = $('map'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
    const X = lon => (lon + 180) / 360 * W, Y = lat => (90 - lat) / 180 * H;
    g.fillStyle = '#0a1a3a'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1f3358'; g.strokeStyle = '#3a5487'; g.lineWidth = .8;
    for (const ring of landRings) for (const off of ring.offs) {
      g.beginPath();
      ring.pts.forEach(([lo, la], i) => i ? g.lineTo(X(lo + off), Y(la)) : g.moveTo(X(lo + off), Y(la)));
      g.closePath(); g.fill(); g.stroke();
    }
    g.strokeStyle = '#ffffff10'; g.lineWidth = 1;
    for (let lo = -150; lo < 180; lo += 30) { g.beginPath(); g.moveTo(X(lo), 0); g.lineTo(X(lo), H); g.stroke(); }
    for (let la = -60; la < 90; la += 30) { g.beginPath(); g.moveTo(0, Y(la)); g.lineTo(W, Y(la)); g.stroke(); }
    g.imageSmoothingEnabled = true; g.drawImage(nightLayer(W, H), 0, 0, W, H);
    const o = settings.obs; g.fillStyle = '#3ddc97'; g.beginPath(); g.arc(X(o.lon), Y(o.lat), 4, 0, 7); g.fill();
    if (!sat) return;
    const now = Date.now(), pts = C.groundTrack(sat, now - 45 * 60e3, now + 90 * 60e3, 30);
    const line = (arr, style, w) => { g.strokeStyle = style; g.lineWidth = w; g.beginPath(); arr.forEach((p, i) => { if (i && Math.abs(p.lon - arr[i - 1].lon) > 180) g.moveTo(X(p.lon), Y(p.lat)); else if (i) g.lineTo(X(p.lon), Y(p.lat)); else g.moveTo(X(p.lon), Y(p.lat)); }); g.stroke(); };
    line(pts.filter(p => p.t <= now), '#ffd16655', 1.5);
    line(pts.filter(p => p.t >= now), '#ffd166', 2);
    const st = C.stateNow(sat, o);
    if (st) {
      // visibility footprint (satellite above observer's horizon)
      const lam = Math.acos(6371 / (6371 + st.alt)), d2r = Math.PI / 180, la0 = st.lat * d2r, lo0 = st.lon * d2r, fp = [];
      for (let b = 0; b <= 360; b += 5) { const br = b * d2r, la = Math.asin(Math.sin(la0) * Math.cos(lam) + Math.cos(la0) * Math.sin(lam) * Math.cos(br)); const lo = lo0 + Math.atan2(Math.sin(br) * Math.sin(lam) * Math.cos(la0), Math.cos(lam) - Math.sin(la0) * Math.sin(la)); fp.push({ lat: la / d2r, lon: ((lo / d2r + 540) % 360) - 180 }); }
      line(fp, '#6ea8ff88', 1);
      g.fillStyle = st.lit ? '#ffd166' : '#8a96c2'; g.strokeStyle = '#0b1020'; g.lineWidth = 2;
      g.beginPath(); g.arc(X(st.lon), Y(st.lat), 6, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#dfe6ff'; g.font = '12px system-ui'; g.fillText(sat.name, X(st.lon) + 9, Y(st.lat) - 7);
    }
  }

  function tickLive() {
    const sat = satObjs.get(liveNorad);
    const box = $('live');
    if (!sat) { box.innerHTML = '<div style="grid-column:1/-1" class="muted">No satellite selected.</div>'; drawMap(null); return; }
    const st = C.stateNow(sat, settings.obs);
    if (!st) { box.innerHTML = '<div style="grid-column:1/-1" class="muted">Propagation failed (decayed or bad TLE).</div>'; drawMap(null); return; }
    const next = passes.find(p => p.norad === liveNorad && p.rise.t > Date.now());
    const nextTxt = next ? `${fmtDate.format(new Date(next.rise.t))} ${fmtHM.format(new Date(next.rise.t))}` : '—';
    const nv = passes.find(p => p.norad === liveNorad && p.visible && p.visible.end.t > Date.now());
    box.innerHTML = `
      <div><b>Azimuth</b>${azTxt(st.az)}</div>
      <div><b>Elevation</b><span class="${st.el > 0 ? 'up' : ''}">${deg(st.el, 1)}</span></div>
      <div><b>Range</b>${Math.round(st.range).toLocaleString()} km</div>
      <div><b>Altitude</b>${Math.round(st.alt).toLocaleString()} km</div>
      <div><b>Sub-point</b>${st.lat.toFixed(2)}°, ${st.lon.toFixed(2)}°</div>
      <div><b>Speed</b>${st.speed.toFixed(2)} km/s</div>
      <div><b>Lighting</b>${st.lit ? '☀ sunlit' : '◐ in shadow'}</div>
      <div><b>Your sun alt</b>${deg(st.sunEl, 1)}</div>
      <div style="grid-column:1/3"><b>Next rise</b>${nextTxt}</div>
      <div style="grid-column:3/5"><b>Next visible</b>${nv ? `${fmtDate.format(new Date(nv.visible.start.t))} ${fmtHM.format(new Date(nv.visible.start.t))} · ${deg(nv.visible.max.el)}` : '—'}</div>`;
    drawMap(sat);
  }

  // ---------- find it ----------
  const findDemo = /(?:^|[?&])findDemo=1(?:&|$)/.test(location.search);
  let finderNorad = null, finderTimer = 0, finderListening = false, finderOn = false, finderCam = null;
  let simOrient = null, lastReading = null, simLandscape = false, sawAbsolute = false;

  function screenAngle() {
    let angle = 0;
    try {
      if (screen.orientation && typeof screen.orientation.angle === 'number') angle = screen.orientation.angle;
      else if (typeof window.orientation === 'number') angle = window.orientation;
    } catch { /* a locked iframe */ }
    if (simLandscape) angle = 90;
    return angle;
  }

  function decimalYear(date) {
    const y = date.getUTCFullYear();
    const a = Date.UTC(y, 0, 1), b = Date.UTC(y + 1, 0, 1);
    return y + (date.getTime() - a) / (b - a);
  }
  function currentMagnitude(sat, st) {
    if (!st || st.el <= 0 || !st.lit || sat.mStd == null || !window.satellite) return null;
    const when = new Date();
    const gd = C.observerGd(settings.obs);
    const l = C.look(sat, when, gd);
    if (!l) return null;
    const rs = window.satellite.sunPos(window.satellite.jday(when)).rsun;
    const sun = { x: rs.x * 149597870.7, y: rs.y * 149597870.7, z: rs.z * 149597870.7 };
    const obs = C.observerEci(gd, l.gmst);
    const range = Math.hypot(l.eci.x - obs.x, l.eci.y - obs.y, l.eci.z - obs.z);
    return C.visualMagnitude(sat.mStd, range, C.phaseAngle(l.eci, sun, obs), l.el);
  }

  function aimFromReading(ev) {
    const look = C.phoneLook(ev.alpha || 0, ev.beta || 0, ev.gamma || 0);
    const decl = C.magneticDeclination(settings.obs.lat, settings.obs.lon, decimalYear(new Date()));
    let az = look.az, magnetic = false;
    if (typeof ev.webkitCompassHeading === 'number' && !Number.isNaN(ev.webkitCompassHeading)) {
      const base = C.trueAzimuth(ev.webkitCompassHeading, decl);
      const alphaAz = ((-(ev.alpha || 0)) % 360 + 360) % 360;
      az = (base + C.wrapSigned(look.az - alphaAz) + 360) % 360;
      magnetic = true;
    }
    const acc = ev.webkitCompassAccuracy;
    const calibrate = typeof acc === 'number' && (acc < 0 || acc > 25);
    return { az, el: look.el, magnetic, calibrate };
  }

  function paintFinder() {
    const root = $('finder');
    if (!root || root.hidden) return;
    const sat = satObjs.get(finderNorad);
    if (!sat) { $('finderCue').textContent = 'That satellite has no orbit loaded.'; return; }
    const st = C.stateNow(sat, settings.obs);
    if (!st) { $('finderCue').textContent = 'Propagation failed for this satellite.'; return; }
    $('finderName').textContent = sat.name;
    const reading = simOrient || lastReading;
    if (!reading) return;
    const aim = aimFromReading(reading);
    const off = C.pointingOffset(aim.az, aim.el, st.az, st.el);
    const screen = C.deviceToScreen(off.dAz, off.dEl, screenAngle());
    const arrow = $('finderArrow');
    const on = off.onTarget;
    if (on && !finderOn && navigator.vibrate) { try { navigator.vibrate(40); } catch { /* some browsers refuse */ } }
    finderOn = on;
    root.classList.toggle('on', on);
    const cue = on ? 'On target'
      : (st.el <= 0 && off.separation < C.ON_TARGET_DEG) ? 'Below the horizon'
      : (C.pointingCue(off.dAz, off.dEl) || 'Hold steady') + (st.el <= 0 ? ' · below the horizon' : '');
    if (on) arrow.hidden = true;
    else {
      const len = Math.min(18, 7 + off.separation * 0.28);
      const ang = Math.atan2(screen.x, screen.y) * 180 / Math.PI;
      arrow.hidden = false;
      arrow.style.transform = `rotate(${ang}deg)`;
      arrow.querySelector('i').style.height = len + 'vh';
      if (off.separation < C.ON_TARGET_DEG) arrow.hidden = true;
    }
    $('finderCue').textContent = cue;
    $('finderCal').hidden = !aim.calibrate;
    const mag = currentMagnitude(sat, st);
    const magTxt = mag == null ? '—' : mag.toFixed(1) + (sat.magApprox ? ' approx' : '');
    const next = passes.find(p => p.norad === sat.norad && p.rise.t > Date.now());
    const rise = st.el > 0 ? 'Above the horizon' : (next ? `Rises ${fmtDate.format(new Date(next.rise.t))} ${fmtHM.format(new Date(next.rise.t))} ${C.compass(next.rise.az)}` : 'No rise in this window');
    $('finderRead').innerHTML = `<div><b>Pointing</b>${Math.round(aim.az)}° ${aim.el.toFixed(0)}°</div><div><b>Satellite</b>${Math.round(st.az)}° ${st.el.toFixed(0)}°</div><div><b>Light</b>${st.el <= 0 ? 'below horizon' : (st.lit ? 'sunlit' : 'in shadow')}</div><div><b>Mag</b>${magTxt}</div><div style="grid-column:span 2"><b>Where</b>${esc(rise)}</div>`;
  }

  function onOrientation(ev) {
    if (simOrient) return;
    if (ev.absolute) sawAbsolute = true;
    if (sawAbsolute && !ev.absolute && ev.webkitCompassHeading == null) return;
    lastReading = ev;
    paintFinder();
  }

  function startFinderListen() {
    if (finderListening) return;
    finderListening = true;
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
    finderTimer = setInterval(paintFinder, 200);
  }
  function stopFinderListen() {
    finderListening = false;
    sawAbsolute = false;
    window.removeEventListener('deviceorientationabsolute', onOrientation, true);
    window.removeEventListener('deviceorientation', onOrientation, true);
    clearInterval(finderTimer);
  }

  async function openFinder(norad) {
    finderNorad = norad;
    finderOn = false;
    const root = $('finder');
    root.hidden = false;
    root.classList.remove('on');
    $('finderDemo').hidden = !findDemo;
    $('finderCal').hidden = true;
    const DOE = window.DeviceOrientationEvent;
    if (findDemo) {
      $('finderGate').hidden = true;
      const sat = satObjs.get(norad);
      const st = sat && C.stateNow(sat, settings.obs);
      const base = st || { az: 0, el: 30 };
      simOrient = { ...C.aimOrientation(base.az - 40, base.el - 15), demo: true };
      startFinderListen();
      paintFinder();
      return;
    }
    if (!DOE) {
      $('finderGate').hidden = false;
      $('finderEnable').hidden = true;
      $('finderGateMsg').textContent = 'This browser has no orientation sensors. Find it needs a phone with a compass and a tilt sensor.';
      return;
    }
    $('finderEnable').hidden = false;
    $('finderGateMsg').textContent = 'Hold the phone up and turn until the arrow sits on the crosshair. The compass is requested only after you tap Enable compass.';
    $('finderGate').hidden = typeof DOE.requestPermission !== 'function';
    if (typeof DOE.requestPermission !== 'function') {
      startFinderListen();
      setTimeout(() => {
        if ($('finder').hidden || simOrient) return;
        $('finderGate').hidden = false;
        $('finderEnable').hidden = true;
        $('finderGateMsg').textContent = 'No orientation data arrived. Find it needs a phone with a compass. Desktop browsers usually do not have one.';
      }, 2500);
    }
  }

  async function enableCompass() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') {
          $('finderGateMsg').textContent = 'Compass permission was denied. Allow motion and orientation access for this site, then try again.';
          return;
        }
      } catch {
        $('finderGateMsg').textContent = 'The compass permission request failed. Open SatPass over HTTPS and try the button again.';
        return;
      }
    }
    $('finderGate').hidden = true;
    startFinderListen();
  }

  function closeFinder() {
    $('finder').hidden = true;
    $('finder').classList.remove('on', 'cam');
    stopFinderListen();
    simOrient = null;
    if (finderCam) {
      for (const t of finderCam.getTracks()) t.stop();
      finderCam = null;
      $('finderCam').srcObject = null;
    }
  }

  async function toggleCamera() {
    const video = $('finderCam');
    if (finderCam) { closeCam(); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('finderCue').textContent = 'This browser has no camera.';
      return;
    }
    try {
      finderCam = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      video.srcObject = finderCam;
      $('finder').classList.add('cam');
      $('finderCamBtn').textContent = 'Camera off';
    } catch {
      $('finderCue').textContent = 'Camera permission was denied. The pointer still works without it.';
    }
  }
  function closeCam() {
    if (finderCam) { for (const t of finderCam.getTracks()) t.stop(); finderCam = null; }
    $('finderCam').srcObject = null;
    $('finder').classList.remove('cam');
    $('finderCamBtn').textContent = 'Camera';
  }

  function bindFinder() {
    $('findBtn').onclick = () => openFinder(liveNorad);
    $('finderClose').onclick = closeFinder;
    $('finderEnable').onclick = enableCompass;
    $('finderCamBtn').onclick = toggleCamera;
    if (!findDemo) return;
    const setAim = (dAz, dEl) => {
      const sat = satObjs.get(finderNorad);
      const st = sat && C.stateNow(sat, settings.obs);
      const base = st || { az: 0, el: 40 };
      simOrient = { ...C.aimOrientation(base.az + dAz, Math.max(-80, Math.min(85, base.el + dEl))), demo: true };
      paintFinder();
    };
    $('demoOff').onclick = () => setAim(-40, -15);
    $('demoOn').onclick = () => setAim(0, 0);
    $('demoLand').onclick = () => { simLandscape = !simLandscape; $('demoLand').textContent = simLandscape ? 'Portrait' : 'Landscape'; paintFinder(); };
    $('demoCal').onclick = () => { if (simOrient) simOrient.webkitCompassAccuracy = -1; paintFinder(); };
  }

  // ---------- controls ----------
  function bindInputs() {
    const o = settings.obs;
    $('obsName').value = o.name || ''; $('obsLat').value = o.lat; $('obsLon').value = o.lon; $('obsElev').value = o.elev;
    $('optDays').value = settings.days; $('optMinEl').value = settings.minEl; $('optSun').value = settings.sunMax; $('optVisOnly').checked = settings.visOnly;
    $('optMag').value = settings.maxMag == null ? '' : settings.maxMag;
  }
  function nyLocalToMs(iso) {
    const [d, tm] = String(iso).split('T');
    const [Y, M, D] = d.split('-').map(Number);
    const [h, m] = (tm || '00:00').split(':').map(Number);
    let utc = Date.UTC(Y, M - 1, D, h || 0, m || 0);
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    for (let i = 0; i < 2; i++) {
      const parts = Object.fromEntries(fmt.formatToParts(new Date(utc)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
      const got = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
      const want = Date.UTC(Y, M - 1, D, h || 0, m || 0);
      if (got === want) break;
      utc += want - got;
    }
    return utc;
  }
  async function loadClouds(force) {
    const lat = +settings.obs.lat, lon = +settings.obs.lon;
    const cache = load(LS_CLOUD, null);
    const same = cache && Math.abs(cache.lat - lat) < 0.01 && Math.abs(cache.lon - lon) < 0.01 && Array.isArray(cache.samples);
    if (!force && same && Date.now() - cache.fetchedMs < CLOUD_TTL) { cloudPack = cache; return; }
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high&timezone=America/New_York&forecast_days=7`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const H = j && j.hourly;
      if (!H || !Array.isArray(H.time)) throw new Error('no hourly');
      const samples = H.time.map((iso, i) => ({
        t: nyLocalToMs(iso),
        total: H.cloud_cover[i],
        low: H.cloud_cover_low[i],
        mid: H.cloud_cover_mid[i],
        high: H.cloud_cover_high[i]
      })).filter(s => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
      cloudPack = { lat, lon, fetchedMs: Date.now(), samples };
      save(LS_CLOUD, cloudPack);
    } catch {
      // A failed fetch hides the column. A cache from the last few hours is still the last good fetch.
      if (same && Date.now() - cache.fetchedMs < 3 * CLOUD_TTL) cloudPack = cache;
      else cloudPack = null;
    }
  }
  function bindSkyHover() {
    const cv = $('sky'), tip = $('skyHover');
    if (!cv || !tip) return;
    let frame = 0;
    cv.addEventListener('mousemove', e => {
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) * cv.width / rect.width;
      const y = (e.clientY - rect.top) * cv.height / rect.height;
      let best = null, bd = 20 * 20;
      for (const p of skyPts) {
        const d = (p.x - x) ** 2 + (p.y - y) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      skyCursor = best;
      const box = cv.parentElement.getBoundingClientRect();
      if (!best) tip.hidden = true;
      else {
        tip.hidden = false;
        tip.textContent = 'mag ' + (best.mag == null || !Number.isFinite(best.mag) ? '—' : best.mag.toFixed(1));
        tip.style.left = (e.clientX - box.left + 12) + 'px';
        tip.style.top = (e.clientY - box.top - 18) + 'px';
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; drawSky(); });
    });
    cv.addEventListener('mouseleave', () => { tip.hidden = true; skyCursor = null; drawSky(); });
  }
  function readObs() {
    const lat = parseFloat($('obsLat').value), lon = parseFloat($('obsLon').value), elev = parseFloat($('obsElev').value) || 0;
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { $('geoMsg').className = 'hint err'; $('geoMsg').textContent = 'Latitude must be −90…90 and longitude −180…180.'; return; }
    $('geoMsg').className = 'hint'; $('geoMsg').textContent = '';
    const moved = Math.abs(settings.obs.lat - lat) > 1e-4 || Math.abs(settings.obs.lon - lon) > 1e-4;
    settings.obs = { name: $('obsName').value, lat, lon, elev }; persist();
    if (moved) {
      loadClouds(true).then(() => renderPasses());
      noteLocationDrift();
    }
    recompute();
  }
  function readOpts() {
    settings.days = Math.min(10, Math.max(1, parseInt($('optDays').value) || 7));
    settings.minEl = Math.min(89, Math.max(0, parseFloat($('optMinEl').value) || 0));
    const s = parseFloat($('optSun').value); settings.sunMax = isNaN(s) ? -6 : Math.min(0, Math.max(-18, s));
    settings.visOnly = $('optVisOnly').checked;
    persist(); recompute();
    schedulePushSync();
  }
  function readMag() {
    const raw = $('optMag').value.trim();
    settings.maxMag = raw === '' || !Number.isFinite(parseFloat(raw)) ? null : parseFloat(raw);
    persist();
    if (passes.length || $('passTable')) renderPasses();
    schedulePushSync();
  }

  // ---------- install and closed-tab alerts ----------
  let pushSyncTimer = null;
  let pushSyncGen = 0;
  function syncedPlace(state) {
    if (!state || !Number.isFinite(+state.lat) || !Number.isFinite(+state.lon)) return null;
    return Loc.roundObs(state.lat, state.lon);
  }
  function paintAlertLocation() {
    const el = $('pushLoc');
    if (!el) return;
    const state = load(LS_PUSH, null);
    const status = Loc.alertLocationStatus({
      on: !!(state && state.on),
      synced: syncedPlace(state),
      obs: settings.obs,
      failed: !!(state && state.locError)
    });
    el.hidden = !status.text;
    el.className = status.err ? 'hint err' : 'hint';
    el.textContent = status.text;
  }
  function noteLocationDrift() {
    const state = load(LS_PUSH, null);
    const on = !!(state && state.on);
    const saved = syncedPlace(state);
    if (on && state.locError && !Loc.locationNeedsSync(true, settings.obs, saved)) {
      save(LS_PUSH, { ...state, locError: false });
    }
    paintAlertLocation();
    if (Loc.locationNeedsSync(on, settings.obs, syncedPlace(load(LS_PUSH, null)))) schedulePushSync();
  }
  function schedulePushSync() {
    const state = load(LS_PUSH, null);
    if (!state || !state.on) return;
    clearTimeout(pushSyncTimer);
    pushSyncTimer = setTimeout(() => { syncPush().catch(() => {}); }, 400);
  }
  async function pushSubscription(endpoint) {
    if (!('serviceWorker' in navigator) || !endpoint) return null;
    let reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      // register() on startup may still be activating. ready waits for that;
      // the timer keeps a missing worker from hanging the sync.
      reg = await Promise.race([
        navigator.serviceWorker.ready.catch(() => null),
        new Promise(resolve => setTimeout(() => resolve(null), 4000))
      ]);
    }
    if (!reg || !reg.pushManager) return null;
    const sub = await reg.pushManager.getSubscription();
    if (!sub || sub.endpoint !== endpoint) return null;
    return sub;
  }
  function markLocationSyncFailed() {
    const fresh = load(LS_PUSH, null);
    if (!fresh || !fresh.on) return;
    const place = Loc.roundObs(settings.obs.lat, settings.obs.lon);
    if (place && !Loc.samePlace(place, syncedPlace(fresh))) {
      save(LS_PUSH, { ...fresh, locError: true });
    }
    paintAlertLocation();
  }
  function chosenNorads() {
    const ids = new Set();
    if (alerts.issAll) ids.add(ISS_NORAD);
    for (const rec of Object.values(alerts.armed || {})) if (rec && rec.norad) ids.add(+rec.norad);
    return [...ids].slice(0, 12);
  }
  function b64ToBuf(s) {
    const pad = s + '='.repeat((4 - s.length % 4) % 4);
    const bin = atob(pad.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function pushBody(sub) {
    return {
      subscription: sub.toJSON ? sub.toJSON() : sub,
      lat: settings.obs.lat, lon: settings.obs.lon,
      norads: chosenNorads(), leadMin: alerts.leadMin,
      visOnly: settings.visOnly, minMag: settings.maxMag
    };
  }
  function paintPushButtons(on) {
    $('pushBtn').hidden = on;
    $('pushOffBtn').hidden = !on;
    $('pushTestBtn').hidden = !on;
  }
  function showPushToast(data) {
    const el = $('pushToast');
    el.hidden = false;
    el.textContent = 'Push received (local test): ' + (data.body || data.title || '');
  }
  async function syncPush() {
    const gen = ++pushSyncGen;
    const state = load(LS_PUSH, null);
    if (!state || !state.on || !state.endpoint) return;
    const norads = chosenNorads();
    if (!norads.length) {
      if (Loc.locationNeedsSync(true, settings.obs, syncedPlace(state))) markLocationSyncFailed();
      return;
    }
    try {
      const sub = await pushSubscription(state.endpoint);
      if (!sub) {
        if (Loc.locationNeedsSync(true, settings.obs, syncedPlace(state))) markLocationSyncFailed();
        return;
      }
      if (gen !== pushSyncGen) return;
      const sent = pushBody(sub);
      const res = await fetch('/api/push/update', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sent)
      });
      const data = await res.json().catch(() => ({}));
      if (gen !== pushSyncGen) return;
      const fresh = load(LS_PUSH, null);
      if (!fresh || !fresh.on) return;
      if (!res.ok) { markLocationSyncFailed(); return; }
      const place = Loc.acceptedPlace(data.lat, data.lon, sent.lat, sent.lon);
      if (!place) { markLocationSyncFailed(); return; }
      save(LS_PUSH, { ...fresh, lat: place.lat, lon: place.lon, locError: false });
      paintAlertLocation();
    } catch {
      if (gen !== pushSyncGen) return;
      markLocationSyncFailed();
    }
  }
  async function enablePush() {
    const norads = chosenNorads();
    if (!norads.length) {
      setAlertMsg('Turn on the ISS toggle, or tap a bell, so there is a satellite to watch.', true);
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setAlertMsg('This browser cannot receive closed-tab alerts. Use Add to calendar.', true);
      return;
    }
    const ok = await ensurePermission();
    if (!ok) return;
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const keyRes = await fetch('/api/push/key');
    if (!keyRes.ok) {
      setAlertMsg('Closed-tab alerts are not configured on this server yet. Use Add to calendar.', true);
      return;
    }
    const key = await keyRes.json();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBuf(key.publicKey) });
    }
    const res = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pushBody(sub))
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { setAlertMsg(body.error || 'Could not save the alert.', true); return; }
    const place = Loc.acceptedPlace(body.lat, body.lon, settings.obs.lat, settings.obs.lon);
    save(LS_PUSH, {
      on: true, endpoint: sub.endpoint, locError: false,
      lat: place ? place.lat : undefined, lon: place ? place.lon : undefined
    });
    paintPushButtons(true);
    paintAlertLocation();
    setAlertMsg('Closed-tab alerts are on. A pass notice arrives ' + alerts.leadMin + ' minutes before it starts.');
  }
  async function disablePush() {
    const state = load(LS_PUSH, null);
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const sub = reg && await reg.pushManager.getSubscription();
    const endpoint = (sub && sub.endpoint) || (state && state.endpoint);
    if (endpoint) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint })
      });
    }
    if (sub) await sub.unsubscribe();
    clearTimeout(pushSyncTimer);
    pushSyncGen++;
    save(LS_PUSH, { on: false });
    paintPushButtons(false);
    paintAlertLocation();
    setAlertMsg('Closed-tab alerts are off.');
  }
  async function sendTestPush() {
    const state = load(LS_PUSH, null);
    if (!state || !state.endpoint) { setAlertMsg('Turn on closed-tab alerts first.', true); return; }
    const res = await fetch('/api/push/test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: state.endpoint })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setAlertMsg(body.error || 'The test push did not send.', true);
  }
  function bindInstallPush() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (ios && !standalone) $('iosInstall').hidden = false;
    if (ios) $('iosPush').hidden = false;
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      $('installBtn').hidden = false;
    });
    $('installBtn').onclick = async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      $('installBtn').hidden = true;
    };
    window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });
    if (new URLSearchParams(location.search).has('installDemo')) {
      $('installBtn').hidden = false;
      $('installDemoNote').hidden = false;
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'push') showPushToast(e.data);
      });
    }
    const saved = load(LS_PUSH, null);
    paintPushButtons(!!(saved && saved.on));
    noteLocationDrift();
    $('pushBtn').onclick = () => { enablePush().catch(err => setAlertMsg(err.message || 'Could not turn alerts on.', true)); };
    $('pushOffBtn').onclick = () => { disablePush().catch(err => setAlertMsg(err.message || 'Could not turn alerts off.', true)); };
    $('pushTestBtn').onclick = () => { sendTestPush().catch(err => setAlertMsg(err.message || 'The test push did not send.', true)); };
  }

  function init() {
    bindInputs();
    bindAlerts();
    bindSkyHover();
    bindFinder();
    bindInstallPush();
    let deb, magDeb;
    ['obsLat', 'obsLon', 'obsElev', 'obsName'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(readObs, 500); }));
    ['optDays', 'optMinEl', 'optSun'].forEach(id => $(id).addEventListener('change', readOpts));
    $('optVisOnly').addEventListener('change', readOpts);
    $('optMag').addEventListener('input', () => { clearTimeout(magDeb); magDeb = setTimeout(readMag, 250); });
    $('magSort').onclick = () => { sortMode = sortMode === 'mag-asc' ? 'mag-desc' : sortMode === 'mag-desc' ? 'time' : 'mag-asc'; renderPasses(); };
    $('dateSort').onclick = () => { sortMode = 'time'; renderPasses(); };
    $('resetObsBtn').onclick = () => { settings.obs = { ...HOME }; bindInputs(); persist(); loadClouds(true).then(() => renderPasses()); recompute(); noteLocationDrift(); };
    $('geoBtn').onclick = () => {
      const m = $('geoMsg'); m.className = 'hint';
      if (!navigator.geolocation) { m.className = 'hint err'; m.textContent = 'Geolocation not available in this browser.'; return; }
      m.textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(pos => {
        const c = pos.coords;
        $('obsLat').value = c.latitude.toFixed(4); $('obsLon').value = c.longitude.toFixed(4);
        if (c.altitude != null) $('obsElev').value = Math.round(c.altitude);
        $('obsName').value = 'My location'; readObs();
        m.textContent = `Located (±${Math.round(c.accuracy)} m).`;
      }, err => { m.className = 'hint err'; m.textContent = 'Location failed: ' + err.message; }, { enableHighAccuracy: false, timeout: 15000 });
    };
    $('addForm').onsubmit = e => { e.preventDefault(); addSat($('addInput').value); };
    $('refreshBtn').onclick = async () => { await loadData(true); renderSatList(); recompute(); };
    $('liveSat').onchange = e => { liveNorad = +e.target.value; tickLive(); };

    loadClouds(false).then(() => { if (passes.length) renderPasses(); });
    loadData(false).then(() => {
      renderSatList(); computeNow(); tickLive();
      setInterval(tickLive, 1000);
      setInterval(() => { renderStatus(); drawSky(); }, 30e3);
      setInterval(async () => { if (Date.now() - (dataMeta?.fetchedMs || 0) > AUTO_REFRESH_MS) { await loadData(false); renderSatList(); } computeNow(); }, 10 * 60e3);
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
