/* Load the same SatCore the page uses, on top of the satellite.js package. */
import * as satellite from 'satellite.js';

let pending;
export function loadSatCore() {
  if (!pending) {
    globalThis.satellite = satellite;
    pending = import('../js/core.js').then(() => {
      if (!globalThis.SatCore) throw new Error('SatCore did not load');
      return globalThis.SatCore;
    });
  }
  return pending;
}
