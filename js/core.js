/* SatPass core: TLE parsing, look angles, sun/shadow, pass search, visual magnitude, trains.
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
    const obs = observerEci(gd, l.gmst);
    const sun = sunEci(d);
    const range = Math.hypot(l.eci.x - obs.x, l.eci.y - obs.y, l.eci.z - obs.z);
    const phase = phaseAngle(l.eci, sun, obs);
    const mag = (lit && l.el > 0 && sat.mStd != null) ? visualMagnitude(sat.mStd, range, phase, l.el) : null;
    return { t, az: l.az, el: l.el, range, lit, sunEl, mag, phase, vis: lit && sunEl < sunMax && l.el >= visMinEl };
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
    const magPts = track.filter(p => p.vis && p.mag != null);
    if (visible) for (const p of [visible.start, visible.max, visible.end]) if (p && p.mag != null) magPts.push(p);
    const peakMag = magPts.length ? magPts.reduce((a, p) => Math.min(a, p.mag), Infinity) : null;
    return {
      norad: sat.norad, name: sat.name, rise, max, set,
      durationSec: (setT - riseT) / 1000, track, visible, peakMag,
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

  function makeSatFromOmm(omm) {
    const satrec = S.json2satrec(omm);
    if (!satrec || satrec.error) throw new Error('Bad elements for ' + (omm.OBJECT_NAME || omm.NORAD_CAT_ID));
    const epochMs = ((satrec.jdsatepoch + (satrec.jdsatepochF || 0)) - 2440587.5) * 86400000;
    const periodMin = (2 * Math.PI) / satrec.no;
    const norad = +omm.NORAD_CAT_ID;
    const name = String(omm.OBJECT_NAME || ('NORAD ' + norad)).trim();
    return {
      name, norad, omm, satrec, epoch: new Date(epochMs), periodMin,
      objectId: omm.OBJECT_ID, meanMotion: omm.MEAN_MOTION, meanAnomaly: omm.MEAN_ANOMALY
    };
  }

  // WGS-84, same ellipsoid satellite.js uses in geodeticToEcf (not exported by the vendored build).
  function observerEcf(gd) {
    const a = 6378.137, f = 1 / 298.257223563, e2 = 2 * f - f * f;
    const lat = gd.latitude, lon = gd.longitude, h = gd.height || 0;
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const n = a / Math.sqrt(1 - e2 * sl * sl);
    return {
      x: (n + h) * cl * Math.cos(lon),
      y: (n + h) * cl * Math.sin(lon),
      z: (n * (1 - e2) + h) * sl
    };
  }

  // Inverse of satellite.js eciToEcf (x' = c x + s y, y' = -s x + c y).
  function ecfToEci(ecf, gmst) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    return { x: c * ecf.x - s * ecf.y, y: s * ecf.x + c * ecf.y, z: ecf.z };
  }

  function observerEci(gd, gmst) { return ecfToEci(observerEcf(gd), gmst); }

  /**
   * Phase angle at the satellite, radians.
   * phi = 0 is full phase (the Sun is behind the observer: sat→Sun and sat→observer are parallel).
   * phi = pi is new phase (the satellite is between the Sun and the observer).
   */
  function phaseAngle(satEci, sunVec, obsEci) {
    const sx = sunVec.x - satEci.x, sy = sunVec.y - satEci.y, sz = sunVec.z - satEci.z;
    const ox = obsEci.x - satEci.x, oy = obsEci.y - satEci.y, oz = obsEci.z - satEci.z;
    const sd = Math.hypot(sx, sy, sz), od = Math.hypot(ox, oy, oz);
    if (!(sd > 0) || !(od > 0)) return null;
    const cos = Math.min(1, Math.max(-1, (sx * ox + sy * oy + sz * oz) / (sd * od)));
    return Math.acos(cos);
  }

  // Plane-parallel airmass. Below ~5° the secant formula runs away, so the elevation is floored.
  const EXTINCTION_PER_AIRMASS = 0.2;
  const AIRMASS_EL_FLOOR_DEG = 5;

  function airmass(elDeg) {
    const el = Math.max(elDeg, AIRMASS_EL_FLOOR_DEG);
    return 1 / Math.sin(el * RAD);
  }

  /**
   * Apparent visual magnitude.
   * m = m_std + 5 log10(r/1000) - 2.5 log10(sin phi + (pi - phi) cos phi) + k X
   * m_std is the magnitude at 1000 km and 90° phase (the phase term is 0 there).
   * phi is radians, r is kilometres, X is airmass, k is 0.2 mag/airmass.
   * Returns null when the phase function is not positive (dark face) or the object is not above the horizon.
   */
  function visualMagnitude(mStd, rangeKm, phaseRad, elDeg) {
    if (mStd == null || !(rangeKm > 0) || phaseRad == null || !(elDeg > 0)) return null;
    const phi = Math.min(Math.PI, Math.max(0, phaseRad));
    const phase = Math.sin(phi) + (Math.PI - phi) * Math.cos(phi);
    // At new phase the function is 0 (and a hair above 0 in floating point). That face is dark.
    if (!(phase > 1e-6)) return null;
    return mStd + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(phase) + EXTINCTION_PER_AIRMASS * airmass(elDeg);
  }

  /*
   * Standard magnitudes: apparent V at 1000 km and 90° phase (50% illuminated for a sphere).
   * That is the m_std of the formula above. Heavens-Above publishes this as
   * "Intrinsic brightness (Magnitude) at 1000km distance, 50% illuminated".
   * McCants qs.mag uses a different scale (1000 km, full phase, brightest orientation),
   * about 0.7–1.5 mag brighter; those numbers are cited only as a cross-check and are not m_std.
   * qs.mag copy: https://github.com/barolfe/satellite-tracker/blob/master/qs.mag
   * Definition note: https://mmccants.org/tles/intrmagdef.html
   * Anything missing from this table returns null. The UI shows an em dash, never a guess.
   */
  const STD_MAG = {
    // ISS (ZARYA), NORAD 25544. Heavens-Above intrinsic −1.8 (fetched 2026-11-15):
    // https://www.heavens-above.com/satinfo.aspx?satid=25544
    // Ted Molczan's 2005 reduction was −1.3 for the smaller 2002–2005 station
    // (https://www.satobs.org/seesat/Aug-2005/0114.html). qs.mag lists −2.0 on the other scale.
    25544: -1.8,
    // CSS (TIANHE), the Tiangong core SatPass tracks as 48274. Heavens-Above intrinsic 0.0:
    // https://www.heavens-above.com/satinfo.aspx?satid=48274
    // Wentian (53239) and Mengtian (54216) have no intrinsic magnitude on Heavens-Above, so they stay blank.
    48274: 0.0,
    // HST, NORAD 20580. Heavens-Above intrinsic 2.2:
    // https://www.heavens-above.com/satinfo.aspx?satid=20580
    // qs.mag lists 1.5 on the full-phase scale.
    20580: 2.2,
    // ENVISAT, NORAD 27386. Heavens-Above intrinsic 3.7:
    // https://www.heavens-above.com/satinfo.aspx?satid=27386
    // qs.mag lists 3.0 on the full-phase scale.
    27386: 3.7,
    // SL-16 (Zenit-2) rocket bodies, each value read from that object's Heavens-Above satinfo page.
    // They are not all the same, so other SL-16 catalog numbers are left unknown.
    // qs.mag lists 2.0 for 22566 (Cosmos 2237 Rk) and 25407 (Cosmos 2360 Rk) on the other scale.
    22566: 2.7, // https://www.heavens-above.com/satinfo.aspx?satid=22566
    25407: 2.7, // https://www.heavens-above.com/satinfo.aspx?satid=25407
    20625: 2.7, // https://www.heavens-above.com/satinfo.aspx?satid=20625
    28353: 2.7, // https://www.heavens-above.com/satinfo.aspx?satid=28353
    31793: 2.7, // https://www.heavens-above.com/satinfo.aspx?satid=31793
    16182: 3.2  // https://www.heavens-above.com/satinfo.aspx?satid=16182
  };

  // New Starlinks have no per-object m_std. Heavens-Above lists intrinsic magnitude 5.0
  // (1000 km, 50% illuminated) for STARLINK-11300, NORAD 61243:
  // https://www.heavens-above.com/satinfo.aspx?satid=61243
  // That is an approximation for the type, not a measurement of each new vehicle.
  // Mallama's phase-uncorrected 1000 km means are fainter (VisorSat ~7.2; arXiv:2101.00374).
  const STARLINK_MSTD = 5.0;

  function standardMagnitude(norad, name) {
    if (Object.prototype.hasOwnProperty.call(STD_MAG, norad)) return { m: STD_MAG[norad], approx: false };
    if (name && /^STARLINK-\d/i.test(String(name))) return { m: STARLINK_MSTD, approx: true };
    return null;
  }

  function launchPrefix(objectId) {
    const m = String(objectId || '').match(/^(\d{4}-\d+)/);
    return m ? m[1] : null;
  }

  function isStarlinkName(name, norad, starlinkIds) {
    if (starlinkIds && starlinkIds.has(norad)) return true;
    return /^STARLINK-\d/i.test(String(name || ''));
  }

  function formatLaunchDay(iso) {
    const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return String(iso);
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  }

  // Along-track length of a cluster. Lead is the object at the forward end (highest mean anomaly).
  function trainGeometry(members) {
    const order = members.map(m => ({ m, ma: ((m.meanAnomaly % 360) + 360) % 360 })).sort((a, b) => a.ma - b.ma);
    const forward = (from, to) => { let g = to - from; if (g <= 0) g += 360; return g; };
    let biggest = 0, at = 0;
    for (let i = 0; i < order.length; i++) {
      const g = forward(order[i].ma, order[(i + 1) % order.length].ma);
      if (g >= biggest) { biggest = g; at = i; }
    }
    const arc = [];
    for (let k = 1; k <= order.length; k++) arc.push(order[(at + k) % order.length]);
    const arcDeg = 360 - biggest;
    const n = members.reduce((s, m) => s + m.meanMotion, 0) / members.length;
    const spreadMin = n > 0 ? (arcDeg / 360) * (1440 / n) : 0;
    return { lead: arc[arc.length - 1].m, spreadMin, arcDeg };
  }

  function clusterByMeanMotion(list, span) {
    const sorted = list.slice().sort((a, b) => a.meanMotion - b.meanMotion);
    const clusters = [];
    for (const o of sorted) {
      const c = clusters[clusters.length - 1];
      if (!c) { clusters.push([o]); continue; }
      const vals = c.map(x => x.meanMotion);
      const lo = Math.min(o.meanMotion, ...vals), hi = Math.max(o.meanMotion, ...vals);
      if (hi - lo <= span + 1e-9) c.push(o);
      else clusters.push([o]);
    }
    return clusters;
  }

  /**
   * Starlink trains: same international-designator launch (YYYY-NNN), launched within ~10 days,
   * still within meanMotionSpan rev/day of each other, and at least minCount objects.
   * Prediction uses the lead object. spreadMin is the along-track length in minutes.
   * objects: {name, norad, objectId, meanMotion, meanAnomaly, launchDate}
   */
  function detectTrains(objects, now, opts = {}) {
    const maxAge = opts.maxAgeDays ?? 10;
    const nnSpan = opts.meanMotionSpan ?? 0.05;
    const minCount = opts.minCount ?? 3;
    const ids = opts.starlinkIds || null;
    const byLaunch = new Map();
    for (const o of objects || []) {
      const prefix = launchPrefix(o.objectId);
      if (!prefix || !isStarlinkName(o.name, o.norad, ids)) continue;
      if (!o.launchDate || !(o.meanMotion > 0)) continue;
      const launched = Date.parse(String(o.launchDate).slice(0, 10) + 'T00:00:00Z');
      if (Number.isNaN(launched)) continue;
      const ageDays = (now.getTime() - launched) / 86400000;
      if (ageDays < 0 || ageDays > maxAge) continue;
      if (!byLaunch.has(prefix)) byLaunch.set(prefix, { launchDate: String(o.launchDate).slice(0, 10), members: [] });
      byLaunch.get(prefix).members.push(o);
    }
    const trains = [];
    for (const [prefix, group] of byLaunch) {
      const clusters = clusterByMeanMotion(group.members, nnSpan);
      clusters.forEach((members, i) => {
        if (members.length < minCount) return;
        const geo = trainGeometry(members);
        const day = formatLaunchDay(group.launchDate);
        trains.push({
          key: prefix + '#' + i,
          prefix,
          launchDate: group.launchDate,
          label: `Starlink train (Group ${prefix}, launched ${day})`,
          lead: geo.lead,
          members,
          count: members.length,
          spreadMin: geo.spreadMin
        });
      });
    }
    trains.sort((a, b) => a.launchDate < b.launchDate ? 1 : a.launchDate > b.launchDate ? -1 : a.key.localeCompare(b.key));
    return trains;
  }

  /** Hourly cloud samples: {t, total, low, mid, high}. Outside the first/last hour is no forecast. */
  function cloudKind(pct) {
    if (pct < 25) return 'clear';
    if (pct <= 70) return 'partly';
    return 'cloudy';
  }

  function nearestCloud(samples, timeMs) {
    if (!samples || !samples.length) return null;
    const first = samples[0].t, last = samples[samples.length - 1].t;
    if (!(timeMs >= first && timeMs <= last)) return { forecast: false };
    let best = null, bestD = Infinity;
    for (const s of samples) {
      if (s.total == null || Number.isNaN(+s.total)) continue;
      const d = Math.abs(s.t - timeMs);
      if (d < bestD) { best = s; bestD = d; }
    }
    if (!best) return { forecast: false };
    return {
      forecast: true, total: +best.total,
      low: best.low == null ? null : +best.low,
      mid: best.mid == null ? null : +best.mid,
      high: best.high == null ? null : +best.high,
      kind: cloudKind(+best.total)
    };
  }

  root.SatCore = {
    parseTLE, makeSat, makeSatFromOmm, findPasses, stateNow, groundTrack, subSolar, compass, sunElevation, observerGd, look,
    observerEci, phaseAngle, airmass, visualMagnitude, standardMagnitude, launchPrefix, detectTrains, nearestCloud, cloudKind,
    EXTINCTION_PER_AIRMASS, AIRMASS_EL_FLOOR_DEG, STARLINK_MSTD
  };
})(typeof window !== 'undefined' ? window : globalThis);
