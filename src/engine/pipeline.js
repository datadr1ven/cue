/**
 * Core pipeline: ingest event → reduce state → detect moments → gate → render.
 */

import { loadConfig } from "./config.js";
import { createGate } from "./gate.js";
import { createF1Domain } from "./domains/f1/index.js";
import { createStarshipDomain } from "./domains/starship/index.js";

/**
 * @param {string} name
 * @param {import('./types.js').EngineConfig} config
 */
function loadDomain(name, config) {
  if (name === "f1") return createF1Domain(config);
  if (name === "starship") return createStarshipDomain();
  throw new Error(
    `Unknown domain "${name}". Registered: f1, starship.`,
  );
}

/**
 * @param {Partial<import('./types.js').EngineConfig>} [configOverrides]
 */
export function createPipeline(configOverrides = {}) {
  const config = loadConfig(configOverrides);
  const domain = loadDomain(config.domain, config);
  const gate = createGate(config);
  let state = domain.createState();

  /**
   * Process one normalized ingest event.
   * @param {import('./types.js').IngestEvent} event
   * @param {object|null} [prefs]
   * @returns {{ state: object, moments: import('./types.js').Moment[], alerts: import('./types.js').Alert[] }}
   */
  function push(event, prefs = null) {
    if (!event || !event.type) {
      return { state, moments: [], alerts: [] };
    }

    const prev = state;
    const next = domain.reduce(prev, event);
    state = next;

    const rawMoments = domain.detectMoments(prev, next, event) || [];
    const moments = gate.filter(rawMoments, config.usePrefs ? prefs : null);

    // F1 race/sprint order heartbeat timestamps
    if (
      config.domain === "f1" &&
      typeof domain.applyOrderHeartbeatBookkeeping === "function"
    ) {
      state = domain.applyOrderHeartbeatBookkeeping(state, event, moments);
    }

    /** @type {import('./types.js').Alert[]} */
    const alerts = [];
    for (const moment of moments) {
      let text = domain.renderMoment(moment, state);
      let renderSource = "template";

      if (config.useLlm) {
        // Future: text = await llmPolish(text, moment, next)
        // keep template on failure
      }

      if (text && String(text).trim()) {
        alerts.push({
          moment,
          text: String(text).trim(),
          renderSource,
        });
      }
    }

    return { state, moments, alerts };
  }

  function getState() {
    return state;
  }

  /** Replace domain state (e.g. hydrate from KV). */
  function replaceState(next) {
    state = next;
  }

  function reset() {
    state = domain.createState();
  }

  /**
   * Emit deferred F1 pit alerts whose tyre compound never arrived (timeout).
   * No-op for domains without flushPending.
   * @param {number} [nowMs]
   */
  function flushPending(nowMs = Date.now()) {
    if (typeof domain.flushPending !== "function") {
      return { state, moments: [], alerts: [] };
    }
    const { state: next, moments: rawMoments } = domain.flushPending(
      state,
      nowMs,
    );
    state = next;
    const moments = gate.filter(rawMoments, null);
    /** @type {import('./types.js').Alert[]} */
    const alerts = [];
    for (const moment of moments) {
      const text = domain.renderMoment(moment, state);
      if (text && String(text).trim()) {
        alerts.push({
          moment,
          text: String(text).trim(),
          renderSource: "template",
        });
      }
    }
    return { state, moments, alerts };
  }

  return {
    config,
    push,
    getState,
    replaceState,
    reset,
    flushPending,
    domainName: config.domain,
  };
}
