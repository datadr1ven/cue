/**
 * OpenF1 MQTT topics Cue cares about (live worker + capture).
 */

/** Lean set consumed by the F1 pipeline / worker. */
export const MQTT_TOPICS = [
  "v1/drivers",
  "v1/position",
  "v1/pit",
  "v1/stints",
  "v1/race_control",
  "v1/weather",
  "v1/team_radio",
  "v1/session_result",
  "v1/starting_grid",
  "v1/sessions",
  "v1/meetings",
  "v1/laps",
];

/** Extra topics for NDJSON gold (not all reduced live). */
export const CAPTURE_EXTRA_TOPICS = [
  "v1/championship_drivers",
  "v1/championship_teams",
  "v1/overtakes",
];

export function captureTopics() {
  return [...new Set([...MQTT_TOPICS, ...CAPTURE_EXTRA_TOPICS])];
}
