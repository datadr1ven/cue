/**
 * Pure-ish reduce: IngestEvent → next state.
 */

import { ROSTER_2026 } from "./roster.js";

/** @typedef {'unknown'|'race'|'qualifying'} SessionKind */

export function createF1State() {
  return {
    sessionKey: null,
    meetingKey: null,
    sessionActive: false,
    trackStatus: null, // green | yellow | red | vsc | safety_car | chequered
    /** @type {SessionKind} */
    sessionKind: "unknown",
    /** Forced kind from pipeline config / env (race|qualifying) */
    sessionKindForced: null,
    /** 0 = not started; 1=Q1/race; 2=Q2; 3=Q3 */
    segment: 0,
    segmentStartT: null,
    /** @type {Record<number, object>} */
    drivers: {},
    /** driver_number → position */
    position: {},
    /** driver_number → last stint info */
    stints: {},
    /** driver_number → last pit */
    lastPit: {},
    leader: null,
    weather: null,
    lastEventT: null,
    chequered: false,
    chequeredCount: 0,
    /** Order frozen at last chequered (for delayed Q cut) */
    orderAtChequered: null,
    /** Chequered waiting for next SESSION STARTED (multi-segment quali) */
    awaitingNextSegment: false,
    /** Segment index that just ended (for cut emission) */
    endedSegment: null,
    /** Best complete flying lap this session */
    sessionBest: null, // { driver, timeSec, t, lap }
    lastSessionBestAlertT: null,
    completeLapCount: 0,
    sessionName: null,
    sessionType: null,
  };
}

/**
 * @param {Record<number|string, number>} position
 * @returns {number|null}
 */
export function computeLeader(position) {
  for (const [num, pos] of Object.entries(position || {})) {
    if (Number(pos) === 1) return Number(num);
  }
  return null;
}

/**
 * Ordered classification from position map.
 * @param {object} state
 * @param {number} [n]
 */
export function orderedField(state, n = 30) {
  return Object.entries(state.position || {})
    .map(([num, pos]) => ({
      driver: Number(num),
      pos: Number(pos),
    }))
    .filter((r) => Number.isFinite(r.pos))
    .sort((a, b) => a.pos - b.pos)
    .slice(0, n);
}

/**
 * @param {object} state
 * @param {import('../../types.js').IngestEvent} event
 * @param {{ sessionKind?: string|null }} [opts]
 */
export function reduceF1(state, event, opts = {}) {
  const next = {
    ...state,
    drivers: { ...state.drivers },
    position: { ...state.position },
    stints: { ...state.stints },
    lastPit: { ...state.lastPit },
    sessionBest: state.sessionBest ? { ...state.sessionBest } : null,
  };

  if (opts.sessionKind && !next.sessionKindForced) {
    const forced = String(opts.sessionKind).toLowerCase();
    if (forced === "race" || forced === "qualifying") {
      next.sessionKindForced = forced;
      next.sessionKind = forced;
    }
  }
  if (next.sessionKindForced) {
    next.sessionKind = next.sessionKindForced;
  }

  const p = event.payload || {};
  if (p.session_key != null) next.sessionKey = p.session_key;
  if (p.meeting_key != null) next.meetingKey = p.meeting_key;
  if (event.t != null) next.lastEventT = event.t;

  // Session change → reset dynamic maps (keep drivers if same meeting)
  if (
    p.session_key != null &&
    state.sessionKey != null &&
    p.session_key !== state.sessionKey
  ) {
    next.position = {};
    next.stints = {};
    next.lastPit = {};
    next.leader = null;
    next.trackStatus = null;
    next.sessionActive = false;
    next.chequered = false;
    next.chequeredCount = 0;
    next.segment = 0;
    next.segmentStartT = null;
    next.orderAtChequered = null;
    next.awaitingNextSegment = false;
    next.endedSegment = null;
    next.sessionBest = null;
    next.lastSessionBestAlertT = null;
    next.completeLapCount = 0;
    next.sessionName = null;
    next.sessionType = null;
    if (!next.sessionKindForced) next.sessionKind = "unknown";
  }

  switch (event.type) {
    case "f1.sessions": {
      applySessionsMeta(next, p);
      break;
    }
    case "f1.drivers": {
      const num = p.driver_number;
      if (num == null) break;
      // Ignore null-name shells (aus-qual); keep prior / fallback
      if (!p.broadcast_name && !p.full_name && !p.name_acronym) break;
      next.drivers[num] = {
        driver_number: num,
        broadcast_name: p.broadcast_name,
        full_name: p.full_name,
        name_acronym: p.name_acronym,
        team_name: p.team_name,
        team_colour: p.team_colour,
      };
      break;
    }
    case "f1.position": {
      const num = p.driver_number;
      const pos = p.position;
      if (num == null || pos == null) break;
      next.position[num] = Number(pos);
      next.leader = computeLeader(next.position);
      break;
    }
    case "f1.pit": {
      const num = p.driver_number;
      if (num == null) break;
      next.lastPit[num] = {
        lap_number: p.lap_number,
        stop_duration: p.stop_duration,
        lane_duration: p.lane_duration ?? p.pit_duration,
        t: event.t,
      };
      break;
    }
    case "f1.stints": {
      const num = p.driver_number;
      if (num == null || !p.compound || p.compound === "UNKNOWN") break;
      const prev = state.stints[num];
      next.stints[num] = {
        compound: p.compound,
        tyre_age_at_start: p.tyre_age_at_start,
        lap_start: p.lap_start,
        _changed:
          !prev ||
          prev.compound !== p.compound ||
          prev.lap_start !== p.lap_start,
      };
      break;
    }
    case "f1.laps": {
      applyLap(next, p, event.t);
      break;
    }
    case "f1.race_control": {
      applyRaceControl(next, p, event.t);
      break;
    }
    case "f1.weather": {
      next.weather = {
        air_temperature: p.air_temperature,
        track_temperature: p.track_temperature,
        rainfall: p.rainfall,
      };
      break;
    }
    default:
      break;
  }

  ensureFallbackDrivers(next);
  return next;
}

function applySessionsMeta(state, p) {
  const name = p.session_name || p.session_type || p.name || null;
  if (name) {
    state.sessionName = String(name);
    state.sessionType = String(p.session_type || name);
  }
  if (state.sessionKindForced) return;
  const u = String(name || "").toUpperCase();
  if (/QUAL/i.test(u) || /\bQ[123]\b/.test(u) || /SHOOTOUT/.test(u)) {
    state.sessionKind = "qualifying";
  } else if (/\bRACE\b/.test(u) && !/QUAL/.test(u)) {
    state.sessionKind = "race";
  } else if (/SPRINT/i.test(u) && !/QUAL|SHOOTOUT/.test(u)) {
    state.sessionKind = "race";
  }
}

function applyLap(state, p, t) {
  const dur = p.lap_duration;
  if (dur == null || !Number.isFinite(Number(dur))) return;
  if (p.is_pit_out_lap) return;
  const timeSec = Number(dur);
  // Real F1 flying laps are ~60–110s; reject in-laps / red-flag weirdness
  if (timeSec < 45 || timeSec > 150) return;

  state.completeLapCount = (state.completeLapCount || 0) + 1;
  maybePromoteRaceByDuration(state, t);

  const driver = Number(p.driver_number);
  const prev = state.sessionBest;
  if (!prev || timeSec < prev.timeSec - 1e-9) {
    state.sessionBest = {
      driver,
      timeSec,
      t: t || p.date_start || null,
      improvedAt: t || p.date_start || null,
      lap: p.lap_number ?? null,
      prevDriver: prev?.driver ?? null,
      prevTimeSec: prev?.timeSec ?? null,
      _improved: true,
    };
  } else if (state.sessionBest) {
    state.sessionBest = { ...state.sessionBest, _improved: false };
  }
}

/** Long green running without multi-segment → race (not Q1). */
function maybePromoteRaceByDuration(state, t) {
  if (state.sessionKindForced) return;
  if (state.sessionKind !== "unknown") return;
  if ((state.segment || 0) > 1) return;
  if (state.chequered || (state.chequeredCount || 0) > 0) return;
  const startMs = toMs(state.segmentStartT);
  const nowMs = toMs(t || state.lastEventT);
  if (startMs == null || nowMs == null) return;
  const mins = (nowMs - startMs) / 60000;
  // Q1 is ~18m, Q2 ~15m, Q3 ~12m; races run far longer before chequered
  if (mins > 40) state.sessionKind = "race";
}

function applyRaceControl(state, p, t) {
  const msg = String(p.message || "").toUpperCase();
  const flag = String(p.flag || "").toUpperCase();
  const cat = String(p.category || "");

  // Stewards sometimes name Q1/Q2/Q3 before we multi-segment-detect
  if (!state.sessionKindForced && /\bQ[123]\b/.test(msg)) {
    state.sessionKind = "qualifying";
  }

  if (msg.includes("SESSION STARTED")) {
    const afterChequered =
      state.chequered ||
      state.awaitingNextSegment ||
      (state.chequeredCount || 0) > 0;
    if (afterChequered) {
      // Multi-segment → qualifying (Q2/Q3 after a prior chequered)
      if (!state.sessionKindForced) state.sessionKind = "qualifying";
      if (state.segment < 1) state.segment = 1; // capture started mid-Q1
      state.segment = Math.min(3, state.segment + 1);
    } else if (state.segment === 0) {
      state.segment = 1;
    }
    state.sessionActive = true;
    state.chequered = false;
    state.awaitingNextSegment = false;
    state.segmentStartT = t || state.lastEventT;
    state.trackStatus = "green";
    // Fresh Q segment: reset session-best so each Qx has its own pole fight
    if (state.sessionKind === "qualifying" && state.segment > 1) {
      state.sessionBest = null;
      state.lastSessionBestAlertT = null;
    }
    return;
  }

  if (msg.includes("SESSION FINISHED") || msg.includes("SESSION ABORTED")) {
    state.sessionActive = false;
  }

  if (flag.includes("CHEQUERED") || msg.includes("CHEQUERED")) {
    state.trackStatus = "chequered";
    state.chequered = true;
    state.sessionActive = false;
    state.chequeredCount = (state.chequeredCount || 0) + 1;
    state.endedSegment = state.segment || 1;
    state.orderAtChequered = orderedField(state, 30);
    state.awaitingNextSegment = true;

    // Short segment → qualifying (Q1 ~18m, Q2 ~15m, Q3 ~12m)
    if (!state.sessionKindForced && state.sessionKind === "unknown") {
      const startMs = toMs(state.segmentStartT);
      const endMs = toMs(t);
      if (startMs != null && endMs != null) {
        const mins = (endMs - startMs) / 60000;
        if (mins > 0 && mins <= 35) state.sessionKind = "qualifying";
        else if (mins > 45) state.sessionKind = "race";
      } else if ((state.orderAtChequered || []).length >= 16) {
        // Capture started mid-segment (no segmentStartT): full field chequered
        // is almost always a Q cut, not a race finish without prior race signals.
        state.sessionKind = "qualifying";
      }
    }
    return;
  }

  if (msg.includes("VSC DEPLOYED")) {
    state.trackStatus = "vsc";
    return;
  }
  if (msg.includes("VSC ENDING") || msg.includes("VSC IN THIS LAP")) {
    state.trackStatus = "green";
    return;
  }

  if (
    (cat === "SafetyCar" || msg.includes("SAFETY CAR")) &&
    msg.includes("DEPLOYED") &&
    !msg.includes("VSC")
  ) {
    state.trackStatus = "safety_car";
    if (!state.sessionKindForced && state.sessionKind === "unknown") {
      state.sessionKind = "race";
    }
    return;
  }
  if (msg.includes("SAFETY CAR IN") || msg.includes("SAFETY CAR ENDING")) {
    state.trackStatus = "green";
    return;
  }

  if (
    (flag === "RED" || /\bRED FLAG\b/.test(msg)) &&
    !msg.includes("CHEQUERED")
  ) {
    state.trackStatus = "red";
    return;
  }
  if (flag === "GREEN" || msg === "TRACK CLEAR") {
    if (state.trackStatus !== "chequered") state.trackStatus = "green";
    return;
  }
  if (flag === "YELLOW" || msg.includes("YELLOW IN TRACK")) {
    if (!["vsc", "safety_car", "red", "chequered"].includes(state.trackStatus)) {
      state.trackStatus = "yellow";
    }
  }
}

function ensureFallbackDrivers(state) {
  for (const [num, info] of Object.entries(ROSTER_2026)) {
    const n = Number(num);
    if (!state.drivers[n]) {
      state.drivers[n] = {
        driver_number: n,
        broadcast_name: info.broadcast,
        full_name: info.full,
        name_acronym: info.acro,
        team_name: info.team,
        _fallback: true,
      };
    }
  }
}

function toMs(t) {
  if (t == null) return null;
  const n = new Date(t).getTime();
  return Number.isFinite(n) ? n : null;
}

/** True when we should use sparse quali detectors (not race order/pits). */
export function isQualifyingMode(state) {
  if (state.sessionKind === "qualifying") return true;
  if (state.sessionKind === "race") return false;
  // Multi-segment already underway
  if ((state.segment || 0) >= 2) return true;
  return false;
}

/** Race-style order / pit moments. */
export function isRaceStyleMode(state) {
  return !isQualifyingMode(state);
}
