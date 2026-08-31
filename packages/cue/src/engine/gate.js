/**
 * Gate: severity floor, simple dedupe, optional prefs (stub).
 * LLM is not applied here — render stage only.
 */

/**
 * @param {import('./types.js').EngineConfig} config
 */
export function createGate(config) {
  /** @type {Map<string, number>} */
  const lastEmitted = new Map();

  /**
   * @param {import('./types.js').Moment[]} moments
   * @param {object} [prefs] - unused when usePrefs=false
   * @returns {import('./types.js').Moment[]}
   */
  function filter(moments, prefs = null) {
    const out = [];
    for (const m of moments) {
      if (m.severity < config.minSeverity) continue;

      if (config.usePrefs && prefs) {
        // Future: filter by follows / interests
        // if (!matchesPrefs(m, prefs)) continue;
      }

      const tMs = toMs(m.t) || Date.now();
      const dedupeKey = `${m.type}:${m.id}`;
      const prev = lastEmitted.get(dedupeKey);
      if (prev != null && tMs - prev < config.dedupeMs) continue;

      lastEmitted.set(dedupeKey, tMs);
      out.push(m);
    }
    return out;
  }

  return { filter };
}

function toMs(t) {
  if (t == null) return null;
  let s = String(t).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s + "Z";
  }
  const n = new Date(s).getTime();
  return Number.isFinite(n) ? n : null;
}
