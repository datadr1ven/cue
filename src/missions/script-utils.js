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
 * User-facing launch countdown / NET status.
 * Never surfaces internal field names or "todo" language.
 *
 * @param {string|null|undefined} iso - launchApproxUtc
 * @param {number} [nowMs]
 * @param {{ missionName?: string|null }} [opts]
 * @returns {{ ok: boolean, kind: 'upcoming'|'recent'|'past'|'unknown'|'invalid', text: string, deltaMs?: number, past?: boolean }}
 */
export function formatEta(iso, nowMs = Date.now(), opts = {}) {
  const name = opts.missionName ? String(opts.missionName) : null;

  if (iso == null || String(iso).trim() === "") {
    return {
      ok: false,
      kind: "unknown",
      text: name
        ? `No launch NET published yet for ${name}.`
        : "No upcoming launch NET on file yet.",
    };
  }

  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return {
      ok: false,
      kind: "invalid",
      text: "Launch NET is unavailable for this mission.",
    };
  }

  const deltaMs = target - nowMs;
  const abs = Math.abs(deltaMs);
  const span = formatDuration(abs);

  // Upcoming
  if (deltaMs > 0) {
    const netLabel = formatNetLabel(iso);
    return {
      ok: true,
      kind: "upcoming",
      text: name
        ? `${name}: T−${span} until ${netLabel}`
        : `T−${span} until ${netLabel}`,
      deltaMs,
      past: false,
    };
  }

  // Recently past (within 12h of NET) — likely launch day / just after
  const TWELVE_H = 12 * 3600 * 1000;
  if (abs <= TWELVE_H) {
    return {
      ok: true,
      kind: "recent",
      text: name
        ? `${name}: NET window has passed (~${span} ago).`
        : `NET window has passed (~${span} ago).`,
      deltaMs,
      past: true,
    };
  }

  // Long past — inter-flight gap; no next timeline yet
  return {
    ok: true,
    kind: "past",
    text: name
      ? `No upcoming NET on file (${name} already flew).`
      : "No upcoming launch NET on file.",
    deltaMs,
    past: true,
  };
}

/**
 * Compact duration for T− / "ago" (e.g. 2d 5h 12m).
 * @param {number} ms
 */
export function formatDuration(ms) {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

/**
 * Prefer a short UTC display; full ISO if not parseable as date-only intent.
 * @param {string} iso
 */
function formatNetLabel(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  try {
    return (
      new Date(t).toISOString().replace(".000Z", "Z") + " (approx NET)"
    );
  } catch {
    return `${iso} (approx NET)`;
  }
}
