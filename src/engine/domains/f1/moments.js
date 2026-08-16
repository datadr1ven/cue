/**
 * Detect moments from (prevState, nextState, event).
 * Race: high-signal order / pits / flags.
 * Qualifying: segment flow, session-best, cuts, pole — not position thrash.
 */

import { driverLabel } from "./roster.js";
import {
  isQualifyingMode,
  isRaceStyleMode,
  isPracticeMode,
  isKnockoutMode,
  knockoutSegmentLabel,
  orderedField,
  sessionContext,
  phaseLabel,
  buildPracticeRecap,
  buildPitMoment,
} from "./snapshot.js";

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

  // Practice: no order / pits / radio noise
  if (event.type === "f1.position" && isRaceStyleMode(next) && !isPracticeMode(next)) {
    moments.push(...fromPosition(prev, next, p, t));
  }

  // Pits are deferred in reduce (pendingPits) until stint compound arrives
  if (event.type === "f1.pit" && allowPitMoments(next)) {
    // no immediate moment — see pendingPits + flushExpiredPits / _pitCombined
  }

  // Combined pit + new compound (usual path, often within ~0.2–5s)
  if (
    event.type === "f1.stints" &&
    allowPitMoments(next) &&
    next._pitCombined
  ) {
    const c = next._pitCombined;
    moments.push(
      buildPitMoment(
        {
          ...c,
          driver: c.driver,
        },
        { compoundOn: c.compoundOn, state: next },
      ),
    );
  }

  if (event.type === "f1.team_radio" && !isPracticeMode(next)) {
    moments.push(...fromRadio(next, p, t));
  }

  return moments;
}

function fromRaceControl(prev, next, p, t) {
  const msg = String(p.message || "");
  const up = msg.toUpperCase();
  const flag = String(p.flag || "").toUpperCase();
  const out = [];
  const knockout = isKnockoutMode(next) || isKnockoutMode(prev) || isQualifyingMode(next);

  if (up.includes("SESSION STARTED")) {
    if (knockout || next.segment >= 2) {
      const seg = next.segment || 1;
      const label = segmentLabel(seg, next.sessionKind);
      out.push({
        id: `quali-seg-start-${seg}-${t}`,
        type: "quali.segment_start",
        severity: 7,
        t,
        data: {
          segment: seg,
          label,
          message: msg,
          ...contextFields(next, label),
        },
      });
    } else {
      // Practice / race / sprint / unknown — single session banner
      const label = phaseLabel(next);
      out.push({
        id: `session-started-${t}`,
        type: "session.started",
        severity: isPracticeMode(next) ? 6 : 7,
        t,
        data: {
          message: msg,
          label,
          practice: isPracticeMode(next),
          ...contextFields(next, label),
        },
      });
    }
  }

  // Delayed knockout cut: previous chequered + new segment starting
  if (
    up.includes("SESSION STARTED") &&
    prev.awaitingNextSegment &&
    prev.orderAtChequered?.length &&
    (prev.chequeredCount || 0) >= 1 &&
    (isKnockoutMode(prev) || isKnockoutMode(next) || isQualifyingMode(next))
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

    if (isPracticeMode(next)) {
      // Ultra-low volume: end recap (fastest · compounds · pit tourist)
      const best = next.sessionBest;
      const recap = buildPracticeRecap(next);
      const mostStopsNames = recap.mostStopsDrivers.map((num) =>
        driverLabel(next, num),
      );
      out.push({
        id: `practice-end-${t}`,
        type: "session.chequered",
        severity: 6,
        t,
        data: {
          message: msg,
          practice: true,
          label: phaseLabel(next) || "Practice",
          sessionBestName:
            best?.driver != null ? driverLabel(next, best.driver) : null,
          sessionBestTime:
            best?.timeSec != null ? formatLapTime(best.timeSec) : null,
          compounds: recap.compounds,
          mostStopsCount: recap.mostStopsCount,
          mostStopsNames,
          ...contextFields(next, phaseLabel(next) || "Practice"),
        },
      });
    } else if (
      isKnockoutMode(next) ||
      seg >= 2 ||
      (kind === "unknown" && isShortSegment(next))
    ) {
      const label = segmentLabel(seg, kind);
      if (seg >= 3) {
        out.push(...buildPoleMoment(next, order, t));
      } else if (seg <= 2 && !next.awaitingNextSegment) {
        out.push(...buildCutMoment(next, order, seg, t));
      } else if (seg <= 2) {
        out.push({
          id: `quali-chequered-${seg}-${t}`,
          type: "quali.chequered",
          severity: 7,
          t,
          data: {
            segment: seg,
            label,
            top5: enrichOrder(next, order.slice(0, 5)),
            ...contextFields(next, label),
          },
        });
      }
    } else {
      // Race / sprint finish
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
          label: phaseLabel(next),
          ...contextFields(next, phaseLabel(next)),
        },
      });
    }
  }

  if (up.includes("SESSION FINISHED") && !up.includes("CHEQUERED")) {
    // Knockout: cut/pole cover the story. Practice: chequered path preferred.
    if (
      !isQualifyingMode(next) &&
      !isKnockoutMode(next) &&
      !isPracticeMode(next)
    ) {
      out.push({
        id: `session-finished-${t}`,
        type: "session.finished",
        severity: 7,
        t,
        data: {
          message: msg,
          top5: topN(next, 5),
          ...contextFields(next, phaseLabel(next)),
        },
      });
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
  // Knockout formats only — not practice / race / sprint race
  if (!isKnockoutMode(next) && !isQualifyingMode(next)) return [];
  if (isPracticeMode(next)) return [];

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

  const stint = next.stints[best.driver];
  const compound =
    stint?.compound && stint.compound !== "UNKNOWN" ? stint.compound : null;
  const label = segmentLabel(next.segment || 1, next.sessionKind);
  const afterChequered = Boolean(next.chequered || next.awaitingNextSegment);

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
        label,
        compound,
        afterChequered,
        ...contextFields(next, label),
      },
    },
  ];
}

/** Pits: GP/sprint race only — never practice or knockout quali. */
function allowPitMoments(state) {
  if (isPracticeMode(state) || isKnockoutMode(state) || isQualifyingMode(state)) {
    return false;
  }
  if (state.sessionKind === "race" || state.sessionKind === "sprint") return true;
  // unknown: allow once green has run long (GP) — not early Q1
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

function fromRadio(state, p, t) {
  const num = Number(p.driver_number);
  const pos = state.position[num];
  const stint = state.stints[num];
  const compound =
    stint?.compound && stint.compound !== "UNKNOWN" ? stint.compound : null;
  // Default floor is 6 — was 5 so radios never fired
  const severity = isQualifyingMode(state) || state.sessionKind === "qualifying"
    ? 6
    : 6;
  return [
    {
      id: `radio-${num}-${p.recording_url || t}`,
      type: "radio.clip",
      severity,
      t,
      entities: [num],
      data: {
        driver: num,
        driverName: driverLabel(state, num),
        url: p.recording_url,
        position: pos != null ? Number(pos) : null,
        trackStatus: state.trackStatus,
        leaderName:
          state.leader != null ? driverLabel(state, state.leader) : null,
        compound,
        label: segmentLabel(state.segment || 1),
        ...contextFields(state),
      },
    },
  ];
}

/**
 * How many advance from a knockout segment.
 * 20-car grid: Q1→15, Q2→10.  22-car (2026): Q1→16, Q2→10.
 * Rule of thumb: Q3 always 10; Q1/Q2 split the rest of the eliminations.
 */
export function knockoutAdvanceCount(endedSegment, fieldSize) {
  const n = Number(fieldSize) || 0;
  if (n <= 0) return 0;
  if (endedSegment >= 2) return Math.min(10, n);
  const mustDropBeforeQ3 = Math.max(0, n - 10);
  const dropThisSegment = Math.ceil(mustDropBeforeQ3 / 2);
  return Math.max(0, n - dropThisSegment);
}

function buildCutMoment(state, order, endedSegment, t) {
  // Prefer live freeze (includes post-chequered improvements) over stale snapshot
  const field =
    (state.orderAtChequered && state.orderAtChequered.length
      ? state.orderAtChequered
      : order) || [];
  const advanceN = knockoutAdvanceCount(endedSegment, field.length);
  const through = enrichOrder(state, field.slice(0, advanceN));
  const outList = enrichOrder(state, field.slice(advanceN));
  const label = segmentLabel(endedSegment, state.sessionKind);
  const nextLabel = segmentLabel(endedSegment + 1, state.sessionKind);

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
        throughCount: through.length,
        outCount: outList.length,
        ...contextFields(state, label),
      },
    },
  ];
}

function buildPoleMoment(state, order, t) {
  const top = enrichOrder(state, (order || []).slice(0, 10));
  const pole = top[0] || null;
  const finalLabel = segmentLabel(3, state.sessionKind);
  const isSprintShootout = state.sessionKind === "sprint_qualifying";
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
        sprintShootout: isSprintShootout,
        ...contextFields(state, finalLabel),
      },
    },
  ];
}

function contextFields(state, label = null) {
  const ctx = sessionContext(state, label ? { label } : {});
  return {
    context: ctx || null,
    meetingName: state.meetingName || null,
    circuitShortName: state.circuitShortName || null,
  };
}

function enrichOrder(state, rows) {
  return (rows || []).map((r) => ({
    driver: r.driver,
    pos: r.pos,
    name: driverLabel(state, r.driver),
  }));
}

function segmentLabel(seg, kind = "qualifying") {
  return knockoutSegmentLabel(seg, kind);
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
