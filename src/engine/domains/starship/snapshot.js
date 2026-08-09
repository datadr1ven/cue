/**
 * Starship session snapshot.
 */

export function createStarshipState() {
  return {
    missionId: null,
    missionName: null,
    phase: "prelaunch",
    /** wall-clock ms when liftoff was marked */
    liftoffWallMs: null,
    /** last operator action id */
    lastActionId: null,
    lastActionT: null,
    /** script reference (optional) */
    script: null,
    history: [],
  };
}

/**
 * @param {object} state
 * @param {import('../../../types.js').IngestEvent} event
 */
export function reduceStarship(state, event) {
  const next = {
    ...state,
    history: state.history.slice(-50),
  };
  const p = event.payload || {};

  if (event.type === "starship.mission") {
    next.missionId = p.missionId || next.missionId;
    next.missionName = p.missionName || next.missionName;
    next.script = p.script || next.script;
    return next;
  }

  if (event.type === "starship.action") {
    const id = p.actionId;
    next.lastActionId = id;
    next.lastEventT = event.t;
    next.lastActionT = event.t;
    if (p.phase) next.phase = p.phase;

    if (id === "liftoff" && next.liftoffWallMs == null) {
      next.liftoffWallMs = p.wallMs || Date.now();
    }
    if (id === "hold") {
      next.phase = "hold";
    }
    if (id === "success" || id === "anomaly") {
      next.phase = id === "success" ? "complete" : "anomaly";
    }

    next.history.push({
      id,
      t: event.t,
      label: p.label,
      tPlusSec: p.tPlusSec,
    });
  }

  return next;
}

/**
 * Seconds since liftoff mark, or null.
 * @param {object} state
 * @param {number} [nowMs]
 */
export function tPlusSec(state, nowMs = Date.now()) {
  if (state.liftoffWallMs == null) return null;
  return (nowMs - state.liftoffWallMs) / 1000;
}
