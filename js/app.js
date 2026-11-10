/* SatPass UI. Depends on SatCore (js/core.js), SATPASS_FALLBACK, SATPASS_LAND. */
(function () {
  'use strict';
  const C = window.SatCore;
  const TZ = 'America/New_York';
  const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
  const GROUPS = ['stations', 'visual'];
  const AUTO_REFRESH_MS = 2 * 3600e3;      // CelesTrak updates GP data ~every 2 h; don't poll faster
  const MANUAL_COOLDOWN_MS = 10 * 60e3;
  const LS_TLE = 'satpass.tle.v1', LS_SET = 'satpass.settings.v1', LS_CUSTOM = 'satpass.custom.v1';
  const HOME = { name: 'Killearn Lakes, Tallahassee FL', lat: 30.588, lon: -84.243, elev: 60 };
  const DEFAULT_SATS = [25544, 48274, 20580, 27386, 25407, 22566];
  const PALETTE = ['#ffd166', '#ff7b7b', '#6ea8ff', '#3ddc97', '#c792ea', '#ff9f43', '#4dd0e1', '#f78fb3', '#a3e635', '#e2e8f0'];

  const $ = id => document.getElementById(id);
  const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota / private mode */ } };

  const settings = Object.assign({ obs: { ...HOME }, days: 7, minEl: 10, sunMax: -6, visOnly: true,
    sats: DEFAULT_SATS.map(n => ({ norad: n, on: true })) }, load(LS_SET, {}));
  let custom = load(LS_CUSTOM, {});        // norad -> {name,l1,l2,norad} for objects added by search
  let catalog = new Map();                  // norad -> rec from group downloads
  let satObjs = new Map();                  // norad -> SatCore sat
  let dataMeta = null;
  let passes = [], selKey = null, liveNorad = null, lastFetchMs = 0;

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

  function ingest(text) {
    catalog = new Map();
    for (const r of C.parseTLE(text)) if (!catalog.has(r.norad)) catalog.set(r.norad, r);
  }

  async function loadData(force) {
    const cache = load(LS_TLE, null);
    const fresh = cache && Date.now() - cache.fetchedMs < AUTO_REFRESH_MS;
    if (cache) lastFetchMs = Math.max(lastFetchMs, cache.fetchedMs);
    if (!force && fresh) { ingest(cache.text); dataMeta = { kind: 'cache', fetchedMs: cache.fetchedMs }; }
    else {
      setStatus('Downloading TLEs from CelesTrak…');
      try {
        const texts = await Promise.all(GROUPS.map(g => fetchText(`${CELESTRAK}?GROUP=${g}&FORMAT=tle`)));
        const text = texts.join('\n');
        if (C.parseTLE(text).length < 5) throw new Error('unexpected response');
        ingest(text); lastFetchMs = Date.now();
        save(LS_TLE, { fetchedMs: lastFetchMs, text });
        dataMeta = { kind: 'live', fetchedMs: lastFetchMs };
        await refreshCustom();
      } catch (e) {
        if (cache) { ingest(cache.text); dataMeta = { kind: 'cache', fetchedMs: cache.fetchedMs, err: e.message }; }
        else {
          const fb = window.SATPASS_FALLBACK;
          ingest(fb.tle); dataMeta = { kind: 'fallback', fetchedMs: Date.parse(fb.fetchedUtc), err: e.message };
        }
      }
    }
    buildSats(); renderStatus(); renderCatalog();
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
      const r = recOf(s.norad); if (!r) continue;
      try { satObjs.set(s.norad, C.makeSat(r)); } catch (e) { console.warn(e); }
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
    for (const s of settings.sats) { const sat = satObjs.get(s.norad); if (!sat) continue; const o = document.createElement('option'); o.value = s.norad; o.textContent = sat.name; sel.appendChild(o); }
    if (cur && satObjs.has(cur)) sel.value = cur; else if (sel.options.length) { liveNorad = +sel.options[0].value; sel.value = liveNorad; }
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
    renderPasses();
  }
  const keyOf = p => `${p.norad}:${Math.round(p.rise.t / 60000)}`;

  function renderPasses() {
    const tb = $('passTable').querySelector('tbody'); tb.innerHTML = '';
    const list = settings.visOnly ? passes.filter(p => p.visible) : passes;
    const nVis = passes.filter(p => p.visible).length;
    $('passCount').textContent = `${list.length} shown · ${nVis} visible · next ${settings.days} days · times ${tzAbbr(new Date())}`;
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
        <td>${dur(p.durationSec)}</td><td>${vis}</td>`;
      tr.onclick = () => { selKey = k; liveNorad = p.norad; $('liveSat').value = p.norad; renderPasses(); };
      tb.appendChild(tr);
    }
    if (!list.length) tb.innerHTML = `<tr><td colspan="7" class="muted">No passes match. Try lowering the minimum elevation, adding days, or unticking “visible only”.</td></tr>`;
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
    if (!p) { $('skyTitle').textContent = 'select a pass'; $('skyInfo').innerHTML = ''; return; }
    $('skyTitle').textContent = `${p.name} · ${fmtDate.format(new Date(p.max.t))}`;
    g.lineWidth = 4; g.lineCap = 'round';
    for (let i = 1; i < p.track.length; i++) {
      const a = p.track[i - 1], b = p.track[i];
      g.strokeStyle = b.vis ? '#ffd166' : (b.lit ? '#6ea8ff' : '#4a5380');
      g.beginPath(); g.moveTo(...P(a.az, a.el)); g.lineTo(...P(b.az, b.el)); g.stroke();
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
    const v = p.visible;
    $('skyInfo').innerHTML = `
      <div><b>Rise</b>${T(p.rise.t)}<br>${azTxt(p.rise.az)}</div>
      <div><b>Max</b>${T(p.max.t)}<br>${deg(p.max.el, 1)} · ${azTxt(p.max.az)}</div>
      <div><b>Set</b>${T(p.set.t)}<br>${azTxt(p.set.az)}</div>
      <div><b>Duration</b>${dur(p.durationSec)}</div>
      <div><b>Range at max</b>${Math.round(p.max.range).toLocaleString()} km</div>
      <div><b>Sun at max</b>${deg(p.sunElAtMax, 1)}</div>
      <div style="grid-column:1/-1"><b>Naked-eye visibility</b>${v ? `Visible ${T(v.start.t)} (${deg(v.start.el)} ${C.compass(v.start.az)}) → max ${deg(v.max.el)} ${C.compass(v.max.az)} → ${T(v.end.t)} (${deg(v.end.el)} ${C.compass(v.end.az)})${v.end.t < p.set.t - 20000 && !p.set.lit ? ', then fades into Earth’s shadow' : ''}` : 'Not visible: ' + (p.sunElAtMax > settings.sunMax ? 'sky too bright (sun above ' + settings.sunMax + '°)' : 'satellite in Earth’s shadow or below 10°')}</div>`;
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

  // ---------- controls ----------
  function bindInputs() {
    const o = settings.obs;
    $('obsName').value = o.name || ''; $('obsLat').value = o.lat; $('obsLon').value = o.lon; $('obsElev').value = o.elev;
    $('optDays').value = settings.days; $('optMinEl').value = settings.minEl; $('optSun').value = settings.sunMax; $('optVisOnly').checked = settings.visOnly;
  }
  function readObs() {
    const lat = parseFloat($('obsLat').value), lon = parseFloat($('obsLon').value), elev = parseFloat($('obsElev').value) || 0;
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) { $('geoMsg').className = 'hint err'; $('geoMsg').textContent = 'Latitude must be −90…90 and longitude −180…180.'; return; }
    $('geoMsg').className = 'hint'; $('geoMsg').textContent = '';
    settings.obs = { name: $('obsName').value, lat, lon, elev }; persist(); recompute();
  }
  function readOpts() {
    settings.days = Math.min(10, Math.max(1, parseInt($('optDays').value) || 7));
    settings.minEl = Math.min(89, Math.max(0, parseFloat($('optMinEl').value) || 0));
    const s = parseFloat($('optSun').value); settings.sunMax = isNaN(s) ? -6 : Math.min(0, Math.max(-18, s));
    settings.visOnly = $('optVisOnly').checked; persist(); recompute();
  }

  function init() {
    bindInputs();
    let deb; ['obsLat', 'obsLon', 'obsElev', 'obsName'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(readObs, 500); }));
    ['optDays', 'optMinEl', 'optSun'].forEach(id => $(id).addEventListener('change', readOpts));
    $('optVisOnly').addEventListener('change', readOpts);
    $('resetObsBtn').onclick = () => { settings.obs = { ...HOME }; bindInputs(); persist(); recompute(); };
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

    loadData(false).then(() => {
      renderSatList(); computeNow(); tickLive();
      setInterval(tickLive, 1000);
      setInterval(() => { renderStatus(); drawSky(); }, 30e3);
      setInterval(async () => { if (Date.now() - (dataMeta?.fetchedMs || 0) > AUTO_REFRESH_MS) { await loadData(false); renderSatList(); } computeNow(); }, 10 * 60e3);
    });
  }
  document.addEventListener('DOMContentLoaded', init);
})();
