/**
 * Engine defaults — explicit and boring.
 * Env overrides optional for CLI experiments.
 */

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function envNum(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {Partial<import('./types.js').EngineConfig>} [overrides]
 * @returns {import('./types.js').EngineConfig}
 */
export function loadConfig(overrides = {}) {
  return {
    domain: process.env.ENGINE_DOMAIN || "f1",
    source: process.env.ENGINE_SOURCE || "ndjson",
    /** LLM top-dressing — off until we want it */
    useLlm: envBool("ENGINE_USE_LLM", false),
    /** User follows / verbosity — off until we wire prefs */
    usePrefs: envBool("ENGINE_USE_PREFS", false),
    /** Drop moments below this severity (1–9) */
    minSeverity: envNum("ENGINE_MIN_SEVERITY", 6),
    /** Wall-clock ms between identical moment types (dedupe) */
    dedupeMs: envNum("ENGINE_DEDUPE_MS", 30_000),
    /** Max radios per driver per session window */
    radioCooldownMs: envNum("ENGINE_RADIO_COOLDOWN_MS", 120_000),
    /**
     * Force session kind for F1:
     *   practice | qualifying | sprint_qualifying | sprint | race
     * Aliases: fp, quali, shootout, sq, …
     * Empty = auto (name / multi-segment / duration heuristics).
     */
    sessionKind:
      process.env.ENGINE_SESSION_KIND ||
      process.env.ENGINE_SESSION_MODE ||
      null,
    ...overrides,
  };
}
