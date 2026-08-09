/**
 * Shared Starship HITL session: mission load + action inject into Cue pipeline.
 */

import { readFileSync } from "fs";
import { createPipeline } from "./engine/pipeline.js";
import {
  actionById,
  formatTPlus,
  tPlusSec,
} from "./engine/domains/starship/index.js";

/**
 * @param {object} [opts]
 * @param {string} [opts.scriptPath]
 * @param {number} [opts.minSeverity]
 * @param {(alert: object, state: object) => void|Promise<void>} [opts.onAlert]
 */
export function createStarshipSession(opts = {}) {
  const pipeline = createPipeline({
    domain: "starship",
    source: "manual",
    useLlm: false,
    usePrefs: false,
    minSeverity: opts.minSeverity ?? 1,
    dedupeMs: 0,
  });

  let scriptDoc = null;
  if (opts.scriptPath) {
    scriptDoc = JSON.parse(readFileSync(opts.scriptPath, "utf8"));
    pipeline.push({
      type: "starship.mission",
      t: new Date().toISOString(),
      source: "script",
      payload: {
        missionId: scriptDoc.missionId,
        missionName: scriptDoc.missionName,
        script: scriptDoc.script,
      },
    });
  }

  /**
   * @param {string} actionId
   * @param {object} [extra]
   */
  async function fire(actionId, extra = {}) {
    const action = actionById(actionId);
    if (!action) {
      return { ok: false, error: `unknown action ${actionId}` };
    }

    const wallMs = Date.now();
    const stateBefore = pipeline.getState();
    let tPlus = tPlusSec(stateBefore, wallMs);
    if (actionId === "liftoff") tPlus = 0;

    const event = {
      type: "starship.action",
      t: new Date(wallMs).toISOString(),
      source: "manual",
      payload: {
        actionId: action.id,
        label: action.label,
        phase: action.phase,
        severity: action.severity,
        scriptTPlusSec: action.scriptTPlusSec,
        tPlusSec: tPlus,
        wallMs,
        ...extra,
      },
    };

    const { alerts, state } = pipeline.push(event);
    for (const alert of alerts) {
      if (opts.onAlert) await opts.onAlert(alert, state);
    }
    return { ok: true, action, alerts, state, tPlusSec: tPlus };
  }

  function status() {
    const state = pipeline.getState();
    const tp = tPlusSec(state);
    return {
      missionName: state.missionName,
      phase: state.phase,
      tPlusSec: tp,
      tPlusLabel: tp == null ? "pre-liftoff" : `T+${formatTPlus(tp)}`,
      liftoffSet: state.liftoffWallMs != null,
      lastActionId: state.lastActionId,
      history: state.history,
    };
  }

  return {
    pipeline,
    scriptDoc,
    fire,
    status,
    reset: () => pipeline.reset(),
  };
}
