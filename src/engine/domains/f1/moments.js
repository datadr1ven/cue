/**
 * Detect moments from (prevState, nextState, event).
 * High-signal only — soft-launch subset.
 */

import { driverLabel } from "./roster.js";

/**
 * @param {object} prev
 * @param {object} next
 * @param {import('../../types.js').IngestEvent} event
 * @returns {import('../../types.js').Moment[]}
 */
export function detectF1Moments(prev, next, event) {
  const moments = [];
  const t = event.t;
  const p = event.payload || {};

  if (event.type === "f1.race_control") {
    moments.push(...fromRaceControl(prev, next, p, t));
  }

  if (event.type === "f1.position") {
    moments.push(...fromPosition(prev, next, p, t));
  }

  if (event.type === "f1.pit") {
    moments.push(...fromPit(prev, next, p, t));
  }

  if (event.type === "f1.stints") {
    const num = p.driver_number;
    const st = next.stints[num];
    if (st?._changed && p.compound && p.compound !== "UNKNOWN") {
      // Only emit compound change if we also have a recent pit context — else low value
      // Skip standalone stint spam; pit handler covers most strategy
    }
  }

  if (event.type === "f1.team_radio") {
    moments.push(...fromRadio(next, p, t));
  }

  return moments;
}

function fromRaceControl(prev, next, p, t) {
  const msg = String(p.message || "");
  const up = msg.toUpperCase();
  const flag = String(p.flag || "").toUpperCase();
  const out = [];

  if (up.includes("SESSION STARTED")) {
    out.push({
      id: `session-started-${t}`,
      type: "session.started",
      severity: 7,
      t,
      data: { message: msg },
    });
  }

  if (up.includes("VSC DEPLOYED")) {
    out.push({
      id: `vsc-deployed-${t}`,
      type: "flag.vsc",
      severity: 9,
      t,
      data: {
        message: msg,
        leader: next.leader,
        leaderName: next.leader != null ? driverLabel(next, next.leader) : null,
        top3: topN(next, 3),
      },
    });
  }

  if (
    (up.includes("SAFETY CAR DEPLOYED") ||
      (p.category === "SafetyCar" && up.includes("DEPLOYED"))) &&
    !up.includes("VSC")
  ) {
    out.push({
      id: `sc-deployed-${t}`,
      type: "flag.safety_car",
      severity: 9,
      t,
      data: {
        message: msg,
        leader: next.leader,
        leaderName: next.leader != null ? driverLabel(next, next.leader) : null,
        top3: topN(next, 3),
      },
    });
  }

  if (flag.includes("CHEQUERED") || up.includes("CHEQUERED FLAG")) {
    out.push({
      id: `chequered-${t}`,
      type: "session.chequered",
      severity: 9,
      t,
      data: {
        message: msg,
        top5: topN(next, 5),
        leader: next.leader,
        leaderName: next.leader != null ? driverLabel(next, next.leader) : null,
      },
    });
  }

  if (up.includes("SESSION FINISHED") && !up.includes("CHEQUERED")) {
    out.push({
      id: `session-finished-${t}`,
      type: "session.finished",
      severity: 7,
      t,
      data: { message: msg, top5: topN(next, 5) },
    });
  }

  // Don't treat CHEQUERED as red (string contains "RED")
  if (
    (flag === "RED" || /\bRED FLAG\b/.test(up)) &&
    !up.includes("CHEQUERED")
  ) {
    out.push({
      id: `red-${t}`,
      type: "flag.red",
      severity: 9,
      t,
      data: { message: msg },
    });
  }

  // Penalties / investigations (high signal keywords)
  if (
    /TIME PENALTY|STOP-AND-GO|STOP AND GO|DRIVE THROUGH|GRID DROP|DROP OF \d+/.test(
      up,
    )
  ) {
    out.push({
      id: `penalty-${t}-${msg.slice(0, 40)}`,
      type: "penalty.time",
      severity: 8,
      t,
      entities: p.driver_number != null ? [p.driver_number] : extractCarNumbers(msg),
      data: { message: msg },
    });
  } else if (/UNDER INVESTIGATION|WILL BE INVESTIGATED/.test(up)) {
    out.push({
      id: `invest-${t}-${msg.slice(0, 40)}`,
      type: "stewards.investigation",
      severity: 7,
      t,
      entities: p.driver_number != null ? [p.driver_number] : extractCarNumbers(msg),
      data: { message: msg },
    });
  }

  // Avoid yellow-sector spam — not emitted

  return out;
}

function fromPosition(prev, next, p, t) {
  const num = Number(p.driver_number);
  const newPos = Number(p.position);
  const oldPos = prev.position[num];
  const out = [];

  if (oldPos == null) {
    // First time we see this driver — only care if P1 settles after some data
    return out;
  }

  if (Number(oldPos) === newPos) return out;

  // Leader change: someone moves into P1
  if (newPos === 1 && Number(oldPos) !== 1) {
    const prevLeader = prev.leader;
    out.push({
      id: `leader-${num}-${t}`,
      type: "order.leader_change",
      severity: 9,
      t,
      entities: [num],
      data: {
        driver: num,
        driverName: driverLabel(next, num),
        fromPos: oldPos,
        prevLeader,
        prevLeaderName:
          prevLeader != null ? driverLabel(next, prevLeader) : null,
        top3: topN(next, 3),
      },
    });
  }

  // Big swing (≥3 places) — medium
  const delta = Number(oldPos) - newPos; // positive = gained places
  if (Math.abs(Number(oldPos) - newPos) >= 3) {
    out.push({
      id: `swing-${num}-${oldPos}-${newPos}-${t}`,
      type: "order.big_swing",
      severity: 6,
      t,
      entities: [num],
      data: {
        driver: num,
        driverName: driverLabel(next, num),
        fromPos: oldPos,
        toPos: newPos,
        gained: delta,
      },
    });
  }

  return out;
}

function fromPit(prev, next, p, t) {
  const num = Number(p.driver_number);
  const stint = next.stints[num];
  const leader = next.leader;
  const pos = next.position[num];

  // Front-runners + anyone in top 10 get higher severity
  let severity = 5;
  if (pos != null && pos <= 3) severity = 7;
  else if (pos != null && pos <= 10) severity = 6;
  if (num === leader) severity = 7;

  return [
    {
      id: `pit-${num}-${p.lap_number ?? t}`,
      type: "strategy.pit",
      severity,
      t,
      entities: [num],
      data: {
        driver: num,
        driverName: driverLabel(next, num),
        lap: p.lap_number,
        stop: p.stop_duration,
        lane: p.lane_duration ?? p.pit_duration,
        compound: stint?.compound,
        position: pos,
        trackStatus: next.trackStatus,
      },
    },
  ];
}

function fromRadio(state, p, t) {
  const num = Number(p.driver_number);
  const pos = state.position[num];
  return [
    {
      id: `radio-${num}-${p.recording_url || t}`,
      type: "radio.clip",
      severity: 5, // below default minSeverity 6 — enable with --min-severity 5
      t,
      entities: [num],
      data: {
        driver: num,
        driverName: driverLabel(state, num),
        url: p.recording_url,
        position: pos,
        trackStatus: state.trackStatus,
        leaderName:
          state.leader != null ? driverLabel(state, state.leader) : null,
      },
    },
  ];
}

function topN(state, n) {
  return Object.entries(state.position || {})
    .map(([num, pos]) => ({
      driver: Number(num),
      pos: Number(pos),
      name: driverLabel(state, num),
    }))
    .filter((r) => Number.isFinite(r.pos))
    .sort((a, b) => a.pos - b.pos)
    .slice(0, n);
}

function extractCarNumbers(msg) {
  const nums = [];
  const re = /CAR\s+(\d+)/gi;
  let m;
  while ((m = re.exec(msg))) nums.push(Number(m[1]));
  return nums;
}
