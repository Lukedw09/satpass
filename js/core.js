/* SatPass core: TLE parsing, look angles, sun/shadow, pass search.
   Plain script; needs globalThis.satellite (vendor/satellite.min.js). Exposes globalThis.SatCore. */
(function (root) {
  'use strict';
  const S = root.satellite;
  const DEG = 180 / Math.PI, RAD = Math.PI / 180;
  const AU_KM = 149597870.7;
  const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

  function parseTLE(text) {
    const lines = String(text).split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('1 ') && lines[i + 1] && lines[i + 1].startsWith('2 ')) {
        const prev = lines[i - 1];
        const name = prev && !prev.startsWith('1 ') && !prev.startsWith('2 ') ? prev.replace(/^0 /, '').trim() : 'NORAD ' + l.slice(2, 7).trim();
        out.push({ name, l1: l, l2: lines[i + 1], norad: parseInt(l.slice(2, 7), 10) });
        i++;
      }
    }
    return out;
  }

  function makeSat(rec) {
    const satrec = S.twoline2satrec(rec.l1, rec.l2);
    if (satrec.error) throw new Error('Bad TLE for ' + rec.name + ' (error ' + satrec.error + ')');
    // epoch from jdsatepoch
    const epochMs = ((satrec.jdsatepoch + (satrec.jdsatepochF || 0)) - 2440587.5) * 86400000;
    const periodMin = (2 * Math.PI) / satrec.no; // satrec.no is rad/min
    return { name: rec.name, norad: rec.norad, l1: rec.l1, l2: rec.l2, satrec, epoch: new Date(epochMs), periodMin };
  }

  function observerGd(obs) {
    return { latitude: obs.lat * RAD, longitude: obs.lon * RAD, height: (obs.elev || 0) / 1000 };
  }

  function compass(azDeg) { return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16]; }

  /** Satellite state at date for observer; null if propagation fails. */
  function look(sat, date, gd) {
    const pv = S.propagate(sat.satrec, date);
    if (!pv || !pv.position || typeof pv.position === 'boolean' || isNaN(pv.position.x)) return null;
    const gmst = S.gstime(date);
    const ecf = S.eciToEcf(pv.position, gmst);
    const la = S.ecfToLookAngles(gd, ecf);
    return { az: la.azimuth * DEG, el: la.elevation * DEG, range: la.rangeSat, eci: pv.position, vel: pv.velocity, gmst };
  }

  function sunEci(date) {
    const r = S.sunPos(S.jday(date)).rsun;
    return { x: r.x * AU_KM, y: r.y * AU_KM, z: r.z * AU_KM, au: r };
  }

  function sunElevation(date, gd) {
    const s = sunEci(date);
    const ecf = S.eciToEcf(s, S.gstime(date));
    return S.ecfToLookAngles(gd, ecf).elevation * DEG;
  }

  /** true when the satellite is in sunlight (less than half the solar disc hidden by Earth). */
  function isSunlit(eci, date) {
    return S.shadowFraction(sunEci(date).au, eci) < 0.5;
  }

  function subPoint(eci, gmst) {
    const g = S.eciToGeodetic(eci, gmst);
    return { lat: g.latitude * DEG, lon: ((g.longitude * DEG + 540) % 360) - 180, alt: g.height };
  }

  function elAt(sat, t, gd) { const l = look(sat, new Date(t), gd); return l ? l.el : -90; }

  function bisectCrossing(sat, gd, tLo, tHi, rising) {
    // find time where el crosses 0 between tLo and tHi (ms), to 0.5 s
    for (let k = 0; k < 40 && tHi - tLo > 500; k++) {
      const m = (tLo + tHi) / 2, up = elAt(sat, m, gd) > 0;
      if (up === rising) tHi = m; else tLo = m;
    }
    return (tLo + tHi) / 2;
  }

  function goldenMax(sat, gd, a, b) {
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a), fc = elAt(sat, c, gd), fd = elAt(sat, d, gd);
    while (b - a > 500) {
      if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = elAt(sat, c, gd); }
      else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = elAt(sat, d, gd); }
    }
    return (a + b) / 2;
  }

  /**
   * Find passes between start and end (Date). opts: {minEl=10, stepSec=30, sunMax=-6, visMinEl=10}
   * Rise/set are at the 0 deg horizon; minEl filters on max elevation.
   */
  function findPasses(sat, obs, start, end, opts = {}) {
    const minEl = opts.minEl ?? 10, step = (opts.stepSec ?? 30) * 1000;
    const sunMax = opts.sunMax ?? -6, visMinEl = opts.visMinEl ?? 10;
    const gd = observerGd(obs);
    const t0 = start.getTime(), t1 = end.getTime();
    const passes = [];
    let prevT = t0, prevEl = elAt(sat, t0, gd), riseT = prevEl > 0 ? t0 : null, inProgress = prevEl > 0;
    let bestT = t0, bestEl = prevEl;
    for (let t = t0 + step; t <= t1 + step; t += step) {
      const tt = Math.min(t, t1);
      const el = elAt(sat, tt, gd);
      if (prevEl <= 0 && el > 0) { riseT = bisectCrossing(sat, gd, prevT, tt, true); inProgress = false; bestEl = el; bestT = tt; }
      if (riseT !== null && el > bestEl) { bestEl = el; bestT = tt; }
      const ended = prevEl > 0 && el <= 0;
      if (riseT !== null && (ended || (tt >= t1 && el > 0))) {
        const setT = ended ? bisectCrossing(sat, gd, prevT, tt, false) : t1;
        if (setT - riseT > 6 * 3600e3) { riseT = null; break; } // geostationary-ish, not a pass
        const maxT = goldenMax(sat, gd, Math.max(riseT, bestT - step), Math.min(setT, bestT + step));
        const p = buildPass(sat, gd, riseT, maxT, setT, { sunMax, visMinEl });
        p.inProgress = inProgress; p.truncated = !ended;
        if (p.max.el >= minEl) passes.push(p);
        riseT = null; inProgress = false; bestEl = -90;
      }
      prevT = tt; prevEl = el;
      if (tt >= t1) break;
    }
    return passes;
  }

  function pointAt(sat, gd, t, sunMax, visMinEl) {
    const d = new Date(t), l = look(sat, d, gd);
    if (!l) return null;
    const lit = isSunlit(l.eci, d), sunEl = sunElevation(d, gd);
    return { t, az: l.az, el: l.el, range: l.range, lit, sunEl, vis: lit && sunEl < sunMax && l.el >= visMinEl };
  }

  function buildPass(sat, gd, riseT, maxT, setT, { sunMax, visMinEl }) {
    const track = [];
    const n = Math.max(20, Math.ceil((setT - riseT) / 10000));
    for (let i = 0; i <= n; i++) {
      const p = pointAt(sat, gd, riseT + (setT - riseT) * i / n, sunMax, visMinEl);
      if (p) track.push(p);
    }
    const rise = pointAt(sat, gd, riseT, sunMax, visMinEl), max = pointAt(sat, gd, maxT, sunMax, visMinEl), set = pointAt(sat, gd, setT, sunMax, visMinEl);
    const visPts = track.filter(p => p.vis);
    let visible = null;
    if (visPts.length) {
      // refine visible-window edges to ~1 s by bisection on the visibility test
      const refine = (a, b) => { // a: not visible, b: visible -> boundary point (visible side)
        let lo = a.t, hi = b.t, best = b;
        while (hi - lo > 1000) { const m = (lo + hi) / 2, q = pointAt(sat, gd, m, sunMax, visMinEl); if (q && q.vis) { hi = m; best = q; } else lo = m; }
        return best;
      };
      const i0 = track.indexOf(visPts[0]), i1 = track.indexOf(visPts[visPts.length - 1]);
      if (i0 > 0) visPts[0] = refine(track[i0 - 1], track[i0]);
      if (i1 < track.length - 1) visPts[visPts.length - 1] = refine(track[i1 + 1], track[i1]);
      const vmax = visPts.reduce((a, b) => (b.el > a.el ? b : a));
      // if the true culmination lies inside the visible window, use it
      const peak = (max.vis || (maxT >= visPts[0].t && maxT <= visPts[visPts.length - 1].t)) ? max : vmax;
      visible = { start: visPts[0], max: peak, end: visPts[visPts.length - 1] };
    }
    return {
      norad: sat.norad, name: sat.name, rise, max, set,
      durationSec: (setT - riseT) / 1000, track, visible,
      sunElAtMax: max.sunEl, sunlitAtMax: max.lit
    };
  }

  /** Full current state for the live panel. */
  function stateNow(sat, obs, date = new Date()) {
    const gd = observerGd(obs), l = look(sat, date, gd);
    if (!l) return null;
    const sp = subPoint(l.eci, l.gmst);
    const v = l.vel, speed = Math.hypot(v.x, v.y, v.z);
    return { az: l.az, el: l.el, range: l.range, lat: sp.lat, lon: sp.lon, alt: sp.alt, speed,
      lit: isSunlit(l.eci, date), sunEl: sunElevation(date, gd) };
  }

  function groundTrack(sat, fromMs, toMs, stepSec = 30) {
    const pts = [];
    for (let t = fromMs; t <= toMs; t += stepSec * 1000) {
      const d = new Date(t), pv = S.propagate(sat.satrec, d);
      if (!pv || !pv.position || typeof pv.position === 'boolean') continue;
      pts.push({ t, ...subPoint(pv.position, S.gstime(d)) });
    }
    return pts;
  }

  /** Subsolar point (lat/lon deg) for drawing the day/night terminator. */
  function subSolar(date) {
    const s = sunEci(date), gmst = S.gstime(date);
    const r = Math.hypot(s.x, s.y, s.z);
    const lat = Math.asin(s.z / r) * DEG;
    let lon = (Math.atan2(s.y, s.x) - gmst) * DEG;
    lon = ((lon + 540) % 360) - 180;
    return { lat, lon };
  }

  root.SatCore = { parseTLE, makeSat, findPasses, stateNow, groundTrack, subSolar, compass, sunElevation, observerGd, look };
})(typeof window !== 'undefined' ? window : globalThis);
