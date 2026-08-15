/**
 * Detect moments from (prevState, nextState, event).
 * Race: high-signal order / pits / flags.
 * Qualifying: segment flow, session-best, cuts, pole — not position thrash.
 */

import { driverLabel } from "./roster.js";
import { isQualifyingMode, isRaceStyleMode, orderedField } from "./snapshot.js";

const SESSION_BEST_COOLDOWN_MS = 20_000;

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

  if (event.type === "f1.laps") {
    moments.push(...fromLap(prev, next, p, t));
  }

  if (event.type === "f1.position" && isRaceStyleMode(next)) {
    moments.push(...fromPosition(prev, next, p, t));
  }

  if (event.type === "f1.pit" && allowPitMoments(next)) {
    moments.push(...fromPit(prev, next, p, t));
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
  const quali = isQualifyingMode(next) || isQualifyingMode(prev);

  if (up.includes("SESSION STARTED")) {
    if (quali || next.segment >= 2 || next.sessionKind === "qualifying") {
      const seg = next.segment || 1;
      out.push({
        id: `quali-seg-start-${seg}-${t}`,
        type: "quali.segment_start",
        severity: 7,
        t,
        data: {
          segment: seg,
          label: segmentLabel(seg),
          message: msg,
        },
      });
    } else {
      out.push({
        id: `session-started-${t}`,
        type: "session.started",
        severity: 7,
        t,
        data: { message: msg },
      });
    }
  }

  // Delayed Q-cut: previous chequered + new segment starting
  if (
    up.includes("SESSION STARTED") &&
    prev.awaitingNextSegment &&
    prev.orderAtChequered?.length &&
    (prev.chequeredCount || 0) >= 1
  ) {
    const ended = prev.endedSegment || prev.segment || 1;
    if (ended <= 2) {
      out.push(...buildCutMoment(next, prev.orderAtChequered, ended, t));
    }
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
    const seg = next.endedSegment || next.segment || 1;
    const order = next.orderAtChequered || orderedField(next, 30);
    const kind = next.sessionKind;

    if (kind === "qualifying" || seg >= 2 || (kind === "unknown" && isShortSegment(next))) {
      if (seg >= 3) {
        out.push(...buildPoleMoment(next, order, t));
      } else if (seg <= 2 && !next.awaitingNextSegment) {
        // no next segment expected — emit cut immediately (rare)
        out.push(...buildCutMoment(next, order, seg, t));
      } else if (seg <= 2) {
        // cut usually emitted on next SESSION STARTED; soft chequered note
        out.push({
          id: `quali-chequered-${seg}-${t}`,
          type: "quali.chequered",
          severity: 7,
          t,
          data: {
            segment: seg,
            label: segmentLabel(seg),
            top5: enrichOrder(next, order.slice(0, 5)),
          },
        });
      }
    } else {
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
  }

  if (up.includes("SESSION FINISHED") && !up.includes("CHEQUERED")) {
    // Quali: cut/pole cover the story; skip noisy finished lines
    if (!isQualifyingMode(next) && next.sessionKind !== "qualifying") {
      out.push({
        id: `session-finished-${t}`,
        type: "session.finished",
        severity: 7,
        t,
        data: { message: msg, top5: topN(next, 5) },
      });
    }
  }

  // Final Q segment with no following SESSION STARTED: emit cut/pole on finished
  if (
    (up.includes("SESSION FINISHED") || flag.includes("CHEQUERED") || up.includes("CHEQUERED FLAG")) &&
    (next.sessionKind === "qualifying" || (next.segment || 0) >= 2)
  ) {
    // Pole if Q3 just ended (chequered path handles seg>=3)
    // Q1/Q2 cut without a following segment: if finished and awaiting and no more data later — handled by chequered soft + optional finished cut
    if (
      up.includes("SESSION FINISHED") &&
      next.awaitingNextSegment &&
      (next.endedSegment || 0) <= 2 &&
      next.orderAtChequered?.length
    ) {
      // Don't double with delayed cut on next start; only if this looks like last segment of file
      // Skip here — delayed cut on next start is primary. For Q3-less weekend edge, ignore.
    }
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
      entities:
        p.driver_number != null ? [p.driver_number] : extractCarNumbers(msg),
      data: { message: msg },
    });
  } else if (/UNDER INVESTIGATION|WILL BE INVESTIGATED/.test(up)) {
    out.push({
      id: `invest-${t}-${msg.slice(0, 40)}`,
      type: "stewards.investigation",
      severity: 7,
      t,
      entities:
        p.driver_number != null ? [p.driver_number] : extractCarNumbers(msg),
      data: { message: msg },
    });
  }

  return out;
}

function fromLap(prev, next, p, t) {
  if (!next.sessionBest?._improved) return [];
  // Only in known/inferred qualifying (not race, not unknown race distance)
  if (!isQualifyingMode(next) && next.sessionKind !== "qualifying") return [];

  const best = next.sessionBest;
  if (prev.sessionBest && prev.sessionBest.timeSec === best.timeSec) return [];

  const tMs = toMs(best.improvedAt || t) || 0;
  const prevAt = toMs(prev.sessionBest?.improvedAt);
  if (
    prev.sessionBest?._improved &&
    prevAt != null &&
    tMs - prevAt < SESSION_BEST_COOLDOWN_MS
  ) {
    return [];
  }

  return [
    {
      id: `session-best-${best.driver}-${best.timeSec}-${best.lap ?? t}`,
      type: "quali.session_best",
      severity: 7,
      t: best.t || t,
      entities: [best.driver],
      data: {
        driver: best.driver,
        driverName: driverLabel(next, best.driver),
        timeSec: best.timeSec,
        timeLabel: formatLapTime(best.timeSec),
        lap: best.lap,
        prevDriver: best.prevDriver,
        prevDriverName:
          best.prevDriver != null ? driverLabel(next, best.prevDriver) : null,
        prevTimeSec: best.prevTimeSec,
        segment: next.segment || null,
        label: segmentLabel(next.segment || 1),
      },
    },
  ];
}

/** Pits: race, or unknown after we look race-like. Never in quali. */
function allowPitMoments(state) {
  if (isQualifyingMode(state) || state.sessionKind === "qualifying") return false;
  if (state.sessionKind === "race") return true;
  // unknown: allow once green has run long (race) — not early Q1
  return (state.completeLapCount || 0) > 120;
}

function fromPosition(prev, next, p, t) {
  const num = Number(p.driver_number);
  const newPos = Number(p.position);
  const oldPos = prev.position[num];
  const out = [];

  if (oldPos == null) {
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

  // Big swing — race only (provisional quali order thrashes constantly)
  if (next.sessionKind === "race") {
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
  }

  return out;
}

function fromPit(prev, next, p, t) {
  const num = Number(p.driver_number);
  const stint = next.stints[num];
  const leader = next.leader;
  const pos = next.position[num];

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
      severity: 5,
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

function buildCutMoment(state, order, endedSegment, t) {
  const field = order || [];
  const advanceN = endedSegment <= 1 ? Math.min(15, field.length) : Math.min(10, field.length);
  const through = enrichOrder(state, field.slice(0, advanceN));
  const outList = enrichOrder(state, field.slice(advanceN));
  const label = segmentLabel(endedSegment);
  const nextLabel = endedSegment <= 1 ? "Q2" : "Q3";

  return [
    {
      id: `quali-cut-${endedSegment}-${t}`,
      type: "quali.cut",
      severity: 8,
      t,
      data: {
        segment: endedSegment,
        label,
        nextLabel,
        through,
        out: outList,
        throughNames: through.map((x) => x.name).slice(0, 15),
        outNames: outList.map((x) => x.name).slice(0, 10),
      },
    },
  ];
}

function buildPoleMoment(state, order, t) {
  const top = enrichOrder(state, (order || []).slice(0, 10));
  const pole = top[0] || null;
  return [
    {
      id: `quali-pole-${t}`,
      type: "quali.pole",
      severity: 9,
      t,
      entities: pole ? [pole.driver] : [],
      data: {
        pole,
        poleName: pole?.name || null,
        top3: top.slice(0, 3),
        top10: top,
      },
    },
  ];
}

function enrichOrder(state, rows) {
  return (rows || []).map((r) => ({
    driver: r.driver,
    pos: r.pos,
    name: driverLabel(state, r.driver),
  }));
}

function segmentLabel(seg) {
  if (seg === 1) return "Q1";
  if (seg === 2) return "Q2";
  if (seg === 3) return "Q3";
  return `Q${seg || "?"}`;
}

function isShortSegment(state) {
  const startMs = toMs(state.segmentStartT);
  const endMs = toMs(state.lastEventT);
  if (startMs == null || endMs == null) return false;
  const mins = (endMs - startMs) / 60000;
  return mins > 0 && mins <= 35;
}

function topN(state, n) {
  return orderedField(state, n).map((r) => ({
    ...r,
    name: driverLabel(state, r.driver),
  }));
}

function extractCarNumbers(msg) {
  const nums = [];
  const re = /CAR\s+(\d+)/gi;
  let m;
  while ((m = re.exec(msg))) nums.push(Number(m[1]));
  return nums;
}

function formatLapTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s)) return "?";
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  if (m <= 0) return rem.toFixed(3);
  return `${m}:${rem.toFixed(3).padStart(6, "0")}`;
}

function toMs(t) {
  if (t == null) return null;
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : null;
}
