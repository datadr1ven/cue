/**
 * Normalize OpenF1 MQTT/HTTP-shaped records into IngestEvent.
 *
 * Accepts capture lines:
 *   { topic, payload, receivedAt }
 * or bare payloads with a topic argument.
 */

const TOPIC_MAP = {
  "v1/drivers": "f1.drivers",
  "v1/position": "f1.position",
  "v1/pit": "f1.pit",
  "v1/stints": "f1.stints",
  "v1/race_control": "f1.race_control",
  "v1/weather": "f1.weather",
  "v1/team_radio": "f1.team_radio",
  "v1/session_result": "f1.session_result",
  "v1/starting_grid": "f1.starting_grid",
  "v1/sessions": "f1.sessions",
  "v1/meetings": "f1.meetings",
  "v1/overtakes": "f1.overtakes",
  "v1/championship_drivers": "f1.championship_drivers",
  "v1/championship_teams": "f1.championship_teams",
  "v1/laps": "f1.laps", // usually ignored by detectors
};

/**
 * Topics the F1 domain actually reduces / detects on.
 * Others normalize to f1.other or are skipped.
 */
const ACTIVE = new Set([
  "f1.drivers",
  "f1.position",
  "f1.pit",
  "f1.stints",
  "f1.race_control",
  "f1.weather",
  "f1.team_radio",
  "f1.session_result",
  "f1.sessions",
  "f1.laps", // session-best in qualifying
]);

/**
 * @param {object} line - capture object or {topic, payload}
 * @param {object} [opts]
 * @param {boolean} [opts.keepAll=false] - if false, skip inactive topics
 * @returns {import('../types.js').IngestEvent|null}
 */
export function normalizeOpenF1(line, opts = {}) {
  if (!line || typeof line !== "object") return null;

  const topic = line.topic || opts.topic;
  if (!topic) return null;

  let payload = line.payload !== undefined ? line.payload : line;
  // Some feeds wrap arrays — take first for driver batch? drivers are one-per-message in captures
  if (Array.isArray(payload)) {
    // expand handled by caller; single-event normalize expects object
    if (payload.length === 1) payload = payload[0];
    else return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const type = TOPIC_MAP[topic] || `f1.unknown:${topic}`;
  if (!opts.keepAll && !ACTIVE.has(type)) {
    // mapped but inactive (championship, overtakes feed, …)
    return null;
  }

  const t =
    payload.date ||
    payload.date_start ||
    line.receivedAt ||
    null;

  return {
    type,
    t,
    source: line.source || "openf1",
    topic,
    payload,
    raw: opts.includeRaw ? line : undefined,
  };
}

/**
 * Expand a capture line into zero or more events (payload arrays).
 * @param {object} line
 * @returns {import('../types.js').IngestEvent[]}
 */
export function expandOpenF1Line(line) {
  if (!line) return [];
  const topic = line.topic;
  const payload = line.payload;

  if (Array.isArray(payload)) {
    return payload
      .map((p) =>
        normalizeOpenF1({
          topic,
          payload: p,
          receivedAt: line.receivedAt,
          source: line.source,
        }),
      )
      .filter(Boolean);
  }

  const one = normalizeOpenF1(line);
  return one ? [one] : [];
}
