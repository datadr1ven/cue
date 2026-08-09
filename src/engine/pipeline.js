/**
 * Core pipeline: ingest event → reduce state → detect moments → gate → render.
 */

import { loadConfig } from "./config.js";
import { createGate } from "./gate.js";
import { createF1Domain } from "./domains/f1/index.js";
import { createStarshipDomain } from "./domains/starship/index.js";

/**
 * @param {string} name
 */
function loadDomain(name) {
  if (name === "f1") return createF1Domain();
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
  const domain = loadDomain(config.domain);
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

    /** @type {import('./types.js').Alert[]} */
    const alerts = [];
    for (const moment of moments) {
      let text = domain.renderMoment(moment, next);
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

  function reset() {
    state = domain.createState();
  }

  return {
    config,
    push,
    getState,
    reset,
    domainName: config.domain,
  };
}
