/**
 * Pure mission helpers (no filesystem — safe for Workers).
 */

/**
 * Map actionId → nominal tPlusSec from mission script.
 * @param {object} doc
 */
export function scriptTPlusMap(doc) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of doc?.script || []) {
    if (row.actionId != null && row.tPlusSec != null) {
      map.set(row.actionId, Number(row.tPlusSec));
    }
  }
  return map;
}

/**
 * @param {string|null|undefined} iso
 * @param {number} [nowMs]
 */
export function formatEta(iso, nowMs = Date.now()) {
  if (!iso) {
    return {
      ok: false,
      text: "No launch time set for this mission (launchApproxUtc).",
    };
  }
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return { ok: false, text: `Invalid launchApproxUtc: ${iso}` };
  }
  const deltaMs = target - nowMs;
  const abs = Math.abs(deltaMs);
  const sec = Math.floor(abs / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  const span = parts.join(" ");
  if (deltaMs > 0) {
    return {
      ok: true,
      text: `T−${span} until NET ${iso} (approx)`,
      deltaMs,
      past: false,
    };
  }
  return {
    ok: true,
    text: `NET ${iso} was ~${span} ago (update launchApproxUtc if slipped)`,
    deltaMs,
    past: true,
  };
}
