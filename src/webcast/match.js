/**
 * Phrase matching for webcast ASR transcripts → TPlus action suggestions.
 */

/**
 * @typedef {{ id: string, actionId?: string|null, severity?: number, patterns: string[], cooldownSec?: number }} PhraseDef
 * @typedef {{ id: string, cooldownSec?: number, phrases: PhraseDef[] }} PhraseBook
 */

/**
 * @param {unknown} raw
 * @returns {PhraseBook}
 */
export function normalizePhraseBook(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("phrase book must be an object");
  }
  const book = /** @type {PhraseBook} */ (raw);
  if (!Array.isArray(book.phrases) || book.phrases.length === 0) {
    throw new Error("phrase book needs phrases[]");
  }
  return {
    id: book.id || "default",
    cooldownSec: Number(book.cooldownSec) || 45,
    phrases: book.phrases.map((p) => ({
      id: p.id,
      actionId: p.actionId ?? null,
      severity: p.severity ?? 6,
      cooldownSec: p.cooldownSec,
      patterns: (p.patterns || [])
        .map((x) => String(x).toLowerCase().trim())
        .filter(Boolean),
    })),
  };
}

/**
 * @param {string} text
 * @param {PhraseBook} book
 * @param {{ lastHitById?: Record<string, number>, tSec?: number }} [state]
 * @returns {{ hits: object[], lastHitById: Record<string, number> }}
 */
export function matchPhrases(text, book, state = {}) {
  const hay = String(text || "")
    .toLowerCase()
    .replace(/[^\w\s+\-./]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tSec = state.tSec ?? 0;
  const lastHitById = { ...(state.lastHitById || {}) };
  /** @type {object[]} */
  const hits = [];
  if (!hay) return { hits, lastHitById };

  for (const phrase of book.phrases) {
    let matched = null;
    for (const pat of phrase.patterns) {
      // Word-ish boundaries — bare "seco" must not match "seconds"
      const re = new RegExp(
        `(^|[^a-z0-9])${escapeRegExp(pat)}([^a-z0-9]|$)`,
        "i",
      );
      if (re.test(hay)) {
        matched = pat;
        break;
      }
    }
    if (!matched) continue;

    const cd = phrase.cooldownSec ?? book.cooldownSec ?? 45;
    const last = lastHitById[phrase.id];
    if (last != null && tSec - last < cd) continue;

    lastHitById[phrase.id] = tSec;
    hits.push({
      phraseId: phrase.id,
      actionId: phrase.actionId,
      severity: phrase.severity,
      pattern: matched,
      raw: text,
      tSec,
    });
  }

  return { hits, lastHitById };
}

/**
 * Format seconds as T+mm:ss or absolute mm:ss from file start.
 * @param {number} tSec
 * @param {number|null} [liftoffSec] file-offset of liftoff; if set, print T+
 */
export function formatClock(tSec, liftoffSec = null) {
  if (liftoffSec != null && Number.isFinite(liftoffSec)) {
    const d = Math.round(tSec - liftoffSec);
    const sign = d < 0 ? "-" : "+";
    const a = Math.abs(d);
    const m = Math.floor(a / 60);
    const s = a % 60;
    return `T${sign}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  const a = Math.max(0, Math.round(tSec));
  const m = Math.floor(a / 60);
  const s = a % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Map mission script actionId → nominal T+ seconds.
 * @param {{ script?: { actionId?: string, tPlusSec?: number }[] }} scriptDoc
 * @returns {Map<string, number>}
 */
export function scriptTPlusByAction(scriptDoc) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of scriptDoc?.script || []) {
    if (!row?.actionId || row.tPlusSec == null) continue;
    const t = Number(row.tPlusSec);
    if (!Number.isFinite(t)) continue;
    // First wins (script is ordered; duplicates rare)
    if (!map.has(row.actionId)) map.set(row.actionId, t);
  }
  return map;
}

/** Ops / countdown calls that are valid far from script milestones. */
export const SCRIPT_GATE_ALWAYS_ALLOW = new Set([
  "hold",
  "go",
  "anomaly",
  "los",
]);

/**
 * Suppress phrase hits that are far from the mission script clock.
 * Needs webcast T+ (file time − liftoff) and a script map.
 *
 * @param {object} hit - from matchPhrases
 * @param {{
 *   tPlusSec: number,
 *   scriptTPlus: Map<string, number>,
 *   gateSec?: number,
 *   alwaysAllow?: Set<string>,
 * }} opts
 * @returns {{ ok: true, nominalTPlus: number|null, deltaSec: number|null } | { ok: false, reason: string, nominalTPlus: number|null, deltaSec: number|null }}
 */
export function gateHitAgainstScript(hit, opts) {
  const gateSec = opts.gateSec ?? 60;
  const always = opts.alwaysAllow || SCRIPT_GATE_ALWAYS_ALLOW;
  const tPlus = Number(opts.tPlusSec);
  const actionId = hit?.actionId || null;

  if (actionId && always.has(actionId)) {
    return { ok: true, nominalTPlus: null, deltaSec: null };
  }
  if (!actionId) {
    return {
      ok: false,
      reason: "no-actionId",
      nominalTPlus: null,
      deltaSec: null,
    };
  }
  if (!opts.scriptTPlus?.has(actionId)) {
    return {
      ok: false,
      reason: "not-in-script",
      nominalTPlus: null,
      deltaSec: null,
    };
  }
  if (!Number.isFinite(tPlus)) {
    return {
      ok: false,
      reason: "no-tplus",
      nominalTPlus: opts.scriptTPlus.get(actionId) ?? null,
      deltaSec: null,
    };
  }

  const nominal = opts.scriptTPlus.get(actionId);
  const delta = tPlus - nominal;
  if (Math.abs(delta) <= gateSec) {
    return { ok: true, nominalTPlus: nominal, deltaSec: delta };
  }
  return {
    ok: false,
    reason: "outside-window",
    nominalTPlus: nominal,
    deltaSec: delta,
  };
}

/** @param {string} s */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
