/**
 * Operator action catalog for launch HITL (Starship, Falcon 9, Starlink, …).
 *
 * Catalog = fireable vocabulary (id, key, severity, default label).
 * Mission scripts choose which milestones appear on /ops and override labels + T+.
 *
 * Keys: single char for CLI; id used for Telegram callbacks.
 */

/** @typedef {{ id: string, key: string, label: string, phase: string, severity: number, scriptTPlusSec?: number|null, group: string }} LaunchAction */

/**
 * Full action dictionary. Prefer mission script labels/T+ at fire time.
 * Default scriptTPlusSec values are legacy hints only (often Flight-13-ish).
 *
 * @type {LaunchAction[]}
 */
export const LAUNCH_ACTIONS = [
  // Pre-flight / clock
  { id: "hold", key: "h", label: "Hold / scrub", phase: "hold", severity: 8, scriptTPlusSec: null, group: "window" },
  { id: "go", key: "g", label: "Go for launch", phase: "terminal", severity: 7, scriptTPlusSec: null, group: "window" },
  { id: "liftoff", key: "0", label: "Liftoff (T+0)", phase: "ascent", severity: 9, scriptTPlusSec: 0, group: "ascent" },

  // Ascent
  { id: "max_q", key: "1", label: "Max Q", phase: "ascent", severity: 6, scriptTPlusSec: null, group: "ascent" },
  { id: "meco", key: "2", label: "MECO", phase: "ascent", severity: 7, scriptTPlusSec: null, group: "ascent" },
  { id: "hot_stage", key: "3", label: "Hot-staging / sep", phase: "ascent", severity: 9, scriptTPlusSec: null, group: "ascent" },
  { id: "stage_sep", key: "S", label: "Stage separation", phase: "ascent", severity: 8, scriptTPlusSec: null, group: "ascent" },
  { id: "ses1", key: "j", label: "SES-1 (2nd stage start)", phase: "ascent", severity: 7, scriptTPlusSec: null, group: "ascent" },
  { id: "fairing", key: "f", label: "Fairing separation", phase: "ascent", severity: 6, scriptTPlusSec: null, group: "ascent" },

  // Booster / first stage
  { id: "boostback_start", key: "4", label: "Boostback burn start", phase: "booster", severity: 7, scriptTPlusSec: null, group: "booster" },
  { id: "boostback_end", key: "5", label: "Boostback end", phase: "booster", severity: 6, scriptTPlusSec: null, group: "booster" },
  { id: "entry_burn", key: "b", label: "1st stage entry burn start", phase: "booster", severity: 7, scriptTPlusSec: null, group: "booster" },
  { id: "entry_burn_end", key: "B", label: "1st stage entry burn end", phase: "booster", severity: 6, scriptTPlusSec: null, group: "booster" },
  { id: "landing_burn_booster", key: "6", label: "Booster / 1st stage landing burn", phase: "booster", severity: 8, scriptTPlusSec: null, group: "booster" },
  { id: "booster_landing", key: "L", label: "1st stage landing (ASDS / LZ)", phase: "booster", severity: 9, scriptTPlusSec: null, group: "booster" },
  { id: "booster_splash", key: "7", label: "Booster splashdown / impact", phase: "booster", severity: 8, scriptTPlusSec: null, group: "booster" },
  { id: "booster_catch", key: "c", label: "Booster catch (tower)", phase: "booster", severity: 9, scriptTPlusSec: null, group: "booster" },

  // Upper stage / ship / payload
  { id: "seco", key: "8", label: "SECO / SECO-1", phase: "ship", severity: 7, scriptTPlusSec: null, group: "upper" },
  { id: "ses2", key: "J", label: "SES-2 (2nd stage restart)", phase: "ship", severity: 7, scriptTPlusSec: null, group: "upper" },
  { id: "seco2", key: "u", label: "SECO-2", phase: "ship", severity: 6, scriptTPlusSec: null, group: "upper" },
  { id: "deploy_start", key: "d", label: "Payload deploy start", phase: "ship", severity: 8, scriptTPlusSec: null, group: "upper" },
  { id: "deploy_done", key: "D", label: "Payload deploy complete", phase: "ship", severity: 7, scriptTPlusSec: null, group: "upper" },
  { id: "relight", key: "r", label: "In-space engine relight", phase: "ship", severity: 8, scriptTPlusSec: null, group: "upper" },
  { id: "entry", key: "e", label: "Entry interface", phase: "entry", severity: 8, scriptTPlusSec: null, group: "entry" },
  { id: "landing_burn_ship", key: "9", label: "Ship landing burn", phase: "entry", severity: 8, scriptTPlusSec: null, group: "entry" },
  { id: "ship_splash", key: "s", label: "Ship soft splashdown", phase: "entry", severity: 9, scriptTPlusSec: null, group: "entry" },

  // Outcomes / anomalies
  { id: "los", key: "l", label: "Loss of signal / telemetry", phase: "anomaly", severity: 8, scriptTPlusSec: null, group: "anomaly" },
  { id: "anomaly", key: "x", label: "Anomaly / RUD", phase: "anomaly", severity: 9, scriptTPlusSec: null, group: "anomaly" },
  { id: "success", key: "w", label: "Mission success (ops call)", phase: "complete", severity: 9, scriptTPlusSec: null, group: "anomaly" },
];

/** @deprecated use LAUNCH_ACTIONS — same reference */
export const STARSHIP_ACTIONS = LAUNCH_ACTIONS;

export function actionByKey(key) {
  return LAUNCH_ACTIONS.find((a) => a.key === key) || null;
}

export function actionById(id) {
  return LAUNCH_ACTIONS.find((a) => a.id === id) || null;
}

/**
 * Always available on /ops regardless of mission script.
 * (window control + anomaly outcomes)
 */
export const OPS_ALWAYS_ON_IDS = [
  "hold",
  "go",
  "los",
  "anomaly",
  "success",
];

/**
 * Build the /ops (and CLI) action list for a mission: always-on set, then
 * script milestones in script order (deduped). Labels prefer script wording.
 *
 * @param {Array<{ actionId?: string, label?: string, tPlusSec?: number }>|null|undefined} script
 * @param {{ alwaysOn?: string[] }} [opts]
 * @returns {{ id: string, key: string, label: string, scriptTPlusSec?: number|null }[]}
 */
export function opsActionsForScript(script, opts = {}) {
  const alwaysOn = opts.alwaysOn || OPS_ALWAYS_ON_IDS;
  const seen = new Set();
  /** @type {{ id: string, key: string, label: string, scriptTPlusSec?: number|null }[]} */
  const out = [];

  const skip = new Set(["note", "broadcast", "hype"]);

  function push(id, labelOverride, tPlusOverride) {
    if (!id || seen.has(id) || skip.has(id)) return;
    const action = actionById(id);
    if (!action) return; // fire() only knows catalog ids
    seen.add(id);
    const tFromScript =
      tPlusOverride != null && Number.isFinite(Number(tPlusOverride))
        ? Number(tPlusOverride)
        : null;
    out.push({
      id: action.id,
      key: action.key,
      label: (labelOverride && String(labelOverride).trim()) || action.label,
      scriptTPlusSec:
        tFromScript != null ? tFromScript : action.scriptTPlusSec ?? null,
    });
  }

  for (const id of alwaysOn) push(id);

  for (const row of script || []) {
    if (row?.actionId) push(row.actionId, row.label, row.tPlusSec);
  }

  return out;
}

/**
 * CLI help for ops keys.
 * @param {Array<{ actionId?: string, label?: string, tPlusSec?: number }>|null|undefined} [script]
 *        When set, only mission-scoped keys (same as /ops). When omitted, full catalog.
 */
export function formatHelp(script) {
  const scoped = script != null;
  const actions = scoped
    ? opsActionsForScript(script)
    : LAUNCH_ACTIONS.map((a) => ({
        id: a.id,
        key: a.key,
        label: a.label,
        scriptTPlusSec: a.scriptTPlusSec ?? null,
      }));

  const lines = [
    scoped
      ? "Ops keys (this mission + hold/go/anomaly):"
      : "Ops keys (full catalog — pass mission script for scoped help):",
    "",
  ];

  if (scoped) {
    for (const a of actions) {
      const t =
        a.scriptTPlusSec == null
          ? "       "
          : `T+${formatTPlus(a.scriptTPlusSec)}`;
      lines.push(`  ${a.key}  ${t}  ${a.label}`);
    }
  } else {
    let group = "";
    for (const a of LAUNCH_ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        lines.push(`  [${group}]`);
      }
      lines.push(`  ${a.key}         ${a.label}`);
    }
  }

  lines.push("");
  lines.push("  ?  help   q  quit   t  show T+   p  show phase");
  lines.push("  n  freeform note   m  list missions");
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
