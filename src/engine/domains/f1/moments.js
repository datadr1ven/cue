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
  resolveFinishOrder,
  isPositionMapSane,
} from "./snapshot.js";

/** Min gap between session-best alerts (event time). */
const SESSION_BEST_COOLDOWN_MS = 45_000;
/** Same driver must beat their previous best by at least this much to re-alert. */
const SESSION_BEST_MIN_IMPROVE_SEC = 0.05;
/** Race/sprint: top-5 board if quiet this long (event time). */
export const ORDER_PULSE_MS = 12 * 60 * 1000;

/**
 * Big swing: sparse "that was a disaster / rocket" only.
 * OpenF1 position ticks thrash at lights-out and under SC/VSC pits — a raw
 * |Δ|≥3 on every message is noise (Aus GP: 30+ fake swings in ~30s).
 */
export const BIG_SWING_PLACES = 5;
/** First this long after race start: only huge drops (anti-stall / pile-up). */
export const BIG_SWING_OPENING_MS = 90_000;
export const BIG_SWING_OPENING_DROP = 8;
/** Skip expected board jumps right after that car's own pit. */
export const BIG_SWING_PIT_IGNORE_MS = 45_000;
/** One swing alert per driver this often (event time). */
export const BIG_SWING_COOLDOWN_MS = 90_000;

const ORDER_NOISE_TYPES = new Set([
  "order.leader_change",
  "order.big_swing",
  "order.snapshot",
  "strategy.pit",
  "flag.vsc",
  "flag.safety_car",
  "flag.red",
  "session.started",
  "session.chequered",
  "session.finished",
]);

/** Moments that make a following radio more interesting */
const RADIO_INTEREST_TYPES = new Set([
  "order.leader_change",
  "strategy.pit",
  "flag.vsc",
  "flag.safety_car",
  "flag.red",
]);

/** Hard cap radios per session (or per Q segment). */
export const RADIO_MAX_PER_SESSION = 5;
/** Min gap between any two radio alerts (event time). */
export const RADIO_GLOBAL_GAP_MS = 8 * 60 * 1000;
/** Prefer radios within this long after a key moment. */
export const RADIO_INTEREST_MS = 4 * 60 * 1000;
/** If still zero radios after this long, allow one ambient top-3 clip. */
export const RADIO_AMBIENT_AFTER_MS = 18 * 60 * 1000;

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

  if (event.type === "f1.team_radio") {
    moments.push(...fromRadio(next, p, t));
  }

  // Deferred race finish (after chequered + lap completions)
  if (next._raceFinishEmit) {
    const e = next._raceFinishEmit;
    moments.push(
      buildRaceFinishMomentFromResolved(
        next,
        e.eventT || t,
        e.msg || "",
        e.type || "session.chequered",
        e.severity ?? 9,
        e.resolved,
      ),
    );
  }

  // Race/sprint heartbeat when the order has been quiet under green
  moments.push(...maybeOrderPulse(next, event));

  return moments;
}

/**
 * Apply silence / pulse timestamps after moments are chosen (pipeline calls this).
 * @param {object} state
 * @param {import('../../types.js').IngestEvent} event
 * @param {import('../../types.js').Moment[]} moments
 */
export function applyOrderHeartbeatBookkeeping(state, event, moments) {
  let next = state;
  const t = event?.t || state.lastEventT;
  let noise = false;
  let pulsed = false;
  let radioInterest = false;
  let radioEmitted = false;
  for (const m of moments) {
    if (ORDER_NOISE_TYPES.has(m.type)) noise = true;
    if (m.type === "order.snapshot") pulsed = true;
    if (RADIO_INTEREST_TYPES.has(m.type)) radioInterest = true;
    if (m.type === "radio.clip") radioEmitted = true;
  }
  if (noise || pulsed) {
    next = {
      ...next,
      lastOrderNoiseT: t || next.lastOrderNoiseT,
    };
  }
  if (pulsed) {
    next = {
      ...next,
      lastOrderPulseT: t || next.lastOrderPulseT,
      lastOrderNoiseT: t || next.lastOrderNoiseT,
    };
  }
  for (const m of moments) {
    if (m.type === "order.big_swing" && m.data?.driver != null) {
      next = {
        ...next,
        lastBigSwingByDriver: {
          ...(next.lastBigSwingByDriver || {}),
          [m.data.driver]: t || next.lastBigSwingByDriver?.[m.data.driver],
        },
      };
    }
  }
  if (radioInterest) {
    next = {
      ...next,
      lastRadioInterestT: t || next.lastRadioInterestT,
    };
  }
  if (radioEmitted) {
    next = {
      ...next,
      radioEmitCount: (next.radioEmitCount || 0) + 1,
      lastRadioEmitT: t || next.lastRadioEmitT,
    };
  }
  return next;
}

function maybeOrderPulse(state, event) {
  if (!isRaceStyleMode(state)) return [];
  if (isPracticeMode(state) || isKnockoutMode(state) || isQualifyingMode(state)) {
    return [];
  }
  if (state.chequered || !state.sessionActive) return [];
  const status = state.trackStatus;
  if (status && status !== "green" && status !== "yellow") return [];
  // yellow OK for soft pulse? Suppress yellow too for safety — only full green
  if (status === "yellow") return [];

  const t = event.t || state.lastEventT;
  const tMs = toMs(t);
  if (tMs == null) return [];

  const silenceFrom =
    state.lastOrderNoiseT || state.segmentStartT || state.lastEventT;
  const silenceFromMs = toMs(silenceFrom);
  if (silenceFromMs == null) return [];
  const quietMs = tMs - silenceFromMs;
  if (quietMs < ORDER_PULSE_MS) return [];
  // Multi-hour leap usually means wall-clock mixed into event time (MQTT replay
  // of dateless topics), not a genuinely quiet race — refuse the pulse.
  if (quietMs > 6 * 60 * 60 * 1000) return [];

  const lastPulseMs = toMs(state.lastOrderPulseT);
  if (lastPulseMs != null && tMs - lastPulseMs < ORDER_PULSE_MS) return [];

  const top5 = topN(state, 5);
  if (top5.length < 3) return [];
  // Partial boards right after lights-out (P2… without P1, duplicate slots)
  // must not pulse — wait until the map is coherent.
  if (!isPositionMapSane(state)) return [];

  // Prefer a real feed clock for the moment stamp (not wall-clock fallback).
  const stamp = state.lastEventT || t;

  return [
    {
      id: `order-snapshot-${stamp}`,
      type: "order.snapshot",
      severity: 6,
      t: stamp,
      data: {
        top5,
        approx: true,
        label: phaseLabel(state) || "Race",
        ...contextFields(state, phaseLabel(state)),
      },
    },
  ];
}

function toMs(t) {
  if (t == null) return null;
  let s = String(t).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s + "Z";
  }
  const n = new Date(s).getTime();
  return Number.isFinite(n) ? n : null;
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
    } else if (
      // Race/sprint: deferred via pendingRaceFinish (wait for lap times)
      next.pendingRaceFinish ||
      next.raceFinishEmitted ||
      next._raceFinishEmit
    ) {
      // no immediate board — see maybeReadyRaceFinish / _raceFinishEmit
    } else {
      // Fallback if deferral didn't arm (shouldn't happen often)
      out.push(buildRaceFinishMoment(next, t, msg, "session.chequered", 9));
    }
  }

  if (up.includes("SESSION FINISHED") && !up.includes("CHEQUERED")) {
    // Knockout: cut/pole cover the story. Practice: chequered path preferred.
    // Race: skip if chequered already armed/emitted a finish board
    if (
      !isQualifyingMode(next) &&
      !isKnockoutMode(next) &&
      !isPracticeMode(next) &&
      !next.pendingRaceFinish &&
      !next.raceFinishEmitted &&
      !next._raceFinishEmit
    ) {
      out.push(buildRaceFinishMoment(next, t, msg, "session.finished", 7));
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

  // Same driver shaving hundredths (common in Q/SQ) — not worth a Telegram ping
  if (
    prev.sessionBest &&
    best.prevDriver != null &&
    Number(best.driver) === Number(best.prevDriver) &&
    best.prevTimeSec != null &&
    Number.isFinite(Number(best.timeSec)) &&
    Number.isFinite(Number(best.prevTimeSec))
  ) {
    const gain = Number(best.prevTimeSec) - Number(best.timeSec);
    if (gain < SESSION_BEST_MIN_IMPROVE_SEC) return [];
  }

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

  // Big swing — race/sprint only; heavy filters (see BIG_SWING_* constants)
  if (
    (next.sessionKind === "race" || next.sessionKind === "sprint") &&
    shouldEmitBigSwing(prev, next, num, Number(oldPos), newPos, t)
  ) {
    const delta = Number(oldPos) - newPos; // positive = gained places
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

/**
 * @param {object} prev
 * @param {object} next
 * @param {number} num
 * @param {number} oldPos
 * @param {number} newPos
 * @param {string|null} t
 */
function shouldEmitBigSwing(prev, next, num, oldPos, newPos, t) {
  const places = Math.abs(oldPos - newPos);
  if (places < BIG_SWING_PLACES) return false;

  // Pit / neutralisation cascades rewrite the board in seconds — not "swings".
  const status = next.trackStatus || prev.trackStatus;
  if (status && status !== "green" && status !== "yellow") return false;

  const tMs = toMs(t);
  if (tMs == null) return false;

  // Own pit → big position jump is expected (and already a strategy.pit alert).
  const pitT = next.lastPit?.[num]?.t || prev.lastPit?.[num]?.t;
  const pitMs = toMs(pitT);
  if (pitMs != null && tMs - pitMs >= 0 && tMs - pitMs < BIG_SWING_PIT_IGNORE_MS) {
    return false;
  }

  // Lights-out thrash: many cars "gain" 5–10 places as the feed settles.
  // Keep only disaster-scale drops (Russell anti-stall, pile-up).
  const startMs = toMs(next.segmentStartT || prev.segmentStartT);
  if (startMs != null && tMs - startMs >= 0 && tMs - startMs < BIG_SWING_OPENING_MS) {
    const dropped = newPos - oldPos; // positive = lost places
    if (dropped < BIG_SWING_OPENING_DROP) return false;
  }

  const lastMs = toMs(next.lastBigSwingByDriver?.[num] || prev.lastBigSwingByDriver?.[num]);
  if (lastMs != null && tMs - lastMs >= 0 && tMs - lastMs < BIG_SWING_COOLDOWN_MS) {
    return false;
  }

  return true;
}

/**
 * Sparse radios (1–5/session): top-3 only, global gap, prefer near key moments.
 * No env opt-in — always eligible at severity 6 when rules pass.
 */
function fromRadio(state, p, t) {
  const count = state.radioEmitCount || 0;
  if (count >= RADIO_MAX_PER_SESSION) return [];

  const num = Number(p.driver_number);
  if (!Number.isFinite(num)) return [];
  const pos = state.position[num] != null ? Number(state.position[num]) : null;
  const isLeader = state.leader != null && Number(state.leader) === num;
  // Front of the field only (more often interesting)
  if (!isLeader && (pos == null || pos > 3)) return [];

  const tMs = toMs(t);
  if (tMs == null) return [];

  const lastEmitMs = toMs(state.lastRadioEmitT);
  if (lastEmitMs != null && tMs - lastEmitMs < RADIO_GLOBAL_GAP_MS) return [];

  const interestMs = toMs(state.lastRadioInterestT);
  const inInterestWindow =
    interestMs != null &&
    tMs - interestMs >= 0 &&
    tMs - interestMs <= RADIO_INTEREST_MS;
  const underNeutral = ["vsc", "safety_car", "red"].includes(
    state.trackStatus || "",
  );

  const startMs = toMs(state.segmentStartT);
  const ambientOk =
    count === 0 &&
    startMs != null &&
    tMs - startMs >= RADIO_AMBIENT_AFTER_MS &&
    (isLeader || (pos != null && pos <= 3));

  // Practice: only around red/VSC (no ambient chat)
  if (isPracticeMode(state) && !underNeutral && !inInterestWindow) {
    return [];
  }

  if (!inInterestWindow && !underNeutral && !ambientOk) return [];

  const stint = state.stints[num];
  const compound =
    stint?.compound && stint.compound !== "UNKNOWN" ? stint.compound : null;

  return [
    {
      id: `radio-${num}-${p.recording_url || t}`,
      type: "radio.clip",
      severity: 6,
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
        compound,
        label: segmentLabel(state.segment || 1, state.sessionKind),
        interest: inInterestWindow || underNeutral,
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
  let field =
    (state.orderAtChequered && state.orderAtChequered.length
      ? state.orderAtChequered
      : order) || [];
  // Q2/SQ2+: position map still lists cars already out — restrict to who
  // advanced into this segment (Dutch SQ gold: otherwise "out (12)" not 6).
  if (endedSegment >= 2 && field.length > 10) {
    const entered = knockoutAdvanceCount(endedSegment - 1, field.length);
    if (entered > 0 && entered < field.length) {
      field = field.slice(0, entered);
    }
  }
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

/**
 * Race/sprint chequered or finished with best-available order.
 * @param {object} state
 * @param {string} t
 * @param {string} msg
 * @param {'session.chequered'|'session.finished'} type
 * @param {number} severity
 */
function buildRaceFinishMoment(state, t, msg, type, severity) {
  return buildRaceFinishMomentFromResolved(
    state,
    t,
    msg,
    type,
    severity,
    resolveFinishOrder(state, 5),
  );
}

function buildRaceFinishMomentFromResolved(
  state,
  t,
  msg,
  type,
  severity,
  resolved,
) {
  const top5 = enrichOrder(state, resolved.rows);
  const winner = top5[0] || null;
  return {
    id: `${type}-${t}`,
    type,
    severity,
    t,
    data: {
      message: msg,
      top5,
      provisional: resolved.provisional,
      orderSource: resolved.source,
      winnerName: winner?.name || null,
      leader: winner?.driver ?? state.leader,
      leaderName: winner?.name || null,
      label: phaseLabel(state),
      ...contextFields(state, phaseLabel(state)),
    },
  };
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
