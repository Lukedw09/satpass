/* Rounded observer place for closed-tab alerts.
   Plain script. Exposes globalThis.SatPassLocation.
   Rounding matches worker/alerts.js validateSubscription: 0.01° (~1 km). */
(function (root) {
  'use strict';

  function coordOrNull(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** Same expression the Worker uses. In-range check happens before this. */
  function roundCoord(n) {
    const x = coordOrNull(n);
    if (x == null) return null;
    return Math.round(x * 100) / 100;
  }

  function roundObs(lat, lon) {
    const la = coordOrNull(lat), lo = coordOrNull(lon);
    if (la == null || lo == null) return null;
    if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
    return { lat: Math.round(la * 100) / 100, lon: Math.round(lo * 100) / 100 };
  }

  function samePlace(a, b) {
    return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
  }

  /**
   * Push is on and the rounded place is not the one the server last accepted.
   * A missing record counts as drifted so the next open sends the current place.
   */
  function locationNeedsSync(pushOn, obs, synced) {
    if (!pushOn) return false;
    const here = roundObs(obs && obs.lat, obs && obs.lon);
    if (!here) return false;
    const saved = synced ? roundObs(synced.lat, synced.lon) : null;
    if (!saved) return true;
    return !samePlace(here, saved);
  }

  /** Prefer the coordinates the server says it stored. Otherwise round what we sent. */
  function acceptedPlace(responseLat, responseLon, sentLat, sentLon) {
    const fromServer = roundObs(responseLat, responseLon);
    if (fromServer) return fromServer;
    return roundObs(sentLat, sentLon);
  }

  function formatPlace(place) {
    return place.lat.toFixed(2) + '°, ' + place.lon.toFixed(2) + '°';
  }

  /**
   * Status line for the alerts card. `synced` is the last place the server accepted.
   * A failed sync keeps that place and says so. Push off yields an empty line.
   */
  function alertLocationStatus(state) {
    if (!state || !state.on) return { text: '', err: false };
    const here = roundObs(state.obs && state.obs.lat, state.obs && state.obs.lon);
    const saved = state.synced ? roundObs(state.synced.lat, state.synced.lon) : null;
    const drifted = !!(saved && here && !samePlace(here, saved));
    if (state.failed && (drifted || (here && !saved))) {
      if (saved) return { text: 'Closed-tab alerts are still using ' + formatPlace(saved) + '.', err: true };
      return { text: 'Closed-tab alerts are still using the previous location.', err: true };
    }
    if (saved) return { text: 'Closed-tab alerts use ' + formatPlace(saved) + '.', err: false };
    return { text: '', err: false };
  }

  root.SatPassLocation = {
    roundCoord, roundObs, samePlace, locationNeedsSync, acceptedPlace, formatPlace, alertLocationStatus
  };
})(typeof window !== 'undefined' ? window : globalThis);
