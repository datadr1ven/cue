/**
 * Operator actions for Starship HITL.
 * Keys: single char for CLI; id used for Telegram callbacks.
 */

/** @typedef {{ id: string, key: string, label: string, phase: string, severity: number, scriptTPlusSec?: number|null, group: string }} StarshipAction */

/** @type {StarshipAction[]} */
export const STARSHIP_ACTIONS = [
  // Pre-flight / clock
  { id: "hold", key: "h", label: "Hold / scrub", phase: "hold", severity: 8, scriptTPlusSec: null, group: "window" },
  { id: "go", key: "g", label: "Go for launch", phase: "terminal", severity: 7, scriptTPlusSec: null, group: "window" },
  { id: "liftoff", key: "0", label: "Liftoff (T+0)", phase: "ascent", severity: 9, scriptTPlusSec: 0, group: "ascent" },

  // Ascent (nominal T+ from SpaceX Flight 13 script — approximate)
  { id: "max_q", key: "1", label: "Max Q", phase: "ascent", severity: 6, scriptTPlusSec: 58, group: "ascent" },
  { id: "meco", key: "2", label: "Super Heavy MECO", phase: "ascent", severity: 7, scriptTPlusSec: 138, group: "ascent" },
  { id: "hot_stage", key: "3", label: "Hot-staging / sep", phase: "ascent", severity: 9, scriptTPlusSec: 141, group: "ascent" },

  // Booster
  { id: "boostback_start", key: "4", label: "Boostback burn start", phase: "booster", severity: 7, scriptTPlusSec: 145, group: "booster" },
  { id: "boostback_end", key: "5", label: "Boostback end", phase: "booster", severity: 6, scriptTPlusSec: 183, group: "booster" },
  { id: "landing_burn_booster", key: "6", label: "Booster landing burn", phase: "booster", severity: 8, scriptTPlusSec: 387, group: "booster" },
  { id: "booster_splash", key: "7", label: "Booster splashdown / impact", phase: "booster", severity: 8, scriptTPlusSec: 413, group: "booster" },
  { id: "booster_catch", key: "c", label: "Booster catch (tower)", phase: "booster", severity: 9, scriptTPlusSec: null, group: "booster" },

  // Ship
  { id: "seco", key: "8", label: "Ship SECO", phase: "ship", severity: 7, scriptTPlusSec: 485, group: "ship" },
  { id: "deploy_start", key: "d", label: "Payload deploy start", phase: "ship", severity: 8, scriptTPlusSec: 1000, group: "ship" },
  { id: "deploy_done", key: "D", label: "Payload deploy complete", phase: "ship", severity: 7, scriptTPlusSec: 1659, group: "ship" },
  { id: "relight", key: "r", label: "In-space Raptor relight", phase: "ship", severity: 8, scriptTPlusSec: 2338, group: "ship" },
  { id: "entry", key: "e", label: "Ship entry interface", phase: "entry", severity: 8, scriptTPlusSec: 2850, group: "entry" },
  { id: "landing_burn_ship", key: "9", label: "Ship landing burn", phase: "entry", severity: 8, scriptTPlusSec: 3901, group: "entry" },
  { id: "ship_splash", key: "s", label: "Ship soft splashdown", phase: "entry", severity: 9, scriptTPlusSec: 3921, group: "entry" },

  // Outcomes / anomalies
  { id: "los", key: "l", label: "Loss of signal / telemetry", phase: "anomaly", severity: 8, scriptTPlusSec: null, group: "anomaly" },
  { id: "anomaly", key: "x", label: "Anomaly / RUD", phase: "anomaly", severity: 9, scriptTPlusSec: null, group: "anomaly" },
  { id: "success", key: "w", label: "Mission success (ops call)", phase: "complete", severity: 9, scriptTPlusSec: null, group: "anomaly" },
];

export function actionByKey(key) {
  return STARSHIP_ACTIONS.find((a) => a.key === key) || null;
}

export function actionById(id) {
  return STARSHIP_ACTIONS.find((a) => a.id === id) || null;
}

export function formatHelp() {
  const lines = ["Starship ops keys:", ""];
  let group = "";
  for (const a of STARSHIP_ACTIONS) {
    if (a.group !== group) {
      group = a.group;
      lines.push(`  [${group}]`);
    }
    const t =
      a.scriptTPlusSec == null
        ? "       "
        : `T+${formatTPlus(a.scriptTPlusSec)}`;
    lines.push(`  ${a.key}  ${t}  ${a.label}`);
  }
  lines.push("");
  lines.push("  ?  help   q  quit   t  show T+   p  show phase");
  return lines.join("\n");
}

export function formatTPlus(sec) {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}
