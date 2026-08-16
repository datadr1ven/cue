/**
 * Pure-ish reduce: IngestEvent → next state.
 */

import { ROSTER_2026 } from "./roster.js";
import { meetingMeta, parseLivetimingPath } from "./meeting-meta.js";

/**
 * @typedef {'unknown'|'practice'|'qualifying'|'sprint_qualifying'|'sprint'|'race'} SessionKind
 *
 * practice          — FP1/2/3: start / end / red only
 * qualifying        — Q1–Q3
 * sprint_qualifying — SQ1–SQ3 / shootout (same shape as quali)
 * sprint            — sprint race (race-style moments)
 * race              — grand prix
 */

/** Canonical kinds accepted by ENGINE_SESSION_KIND / config */
export const SESSION_KINDS = [
  "practice",
  "qualifying",
  "sprint_qualifying",
  "sprint",
  "race",
];

/**
 * Normalize aliases → canonical kind, or null.
 * @param {string|null|undefined} raw
 * @returns {SessionKind|null}
 */
export function normalizeSessionKind(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const u = String(raw).trim().toLowerCase().replace(/-/g, "_");
  if (SESSION_KINDS.includes(u)) return /** @type {SessionKind} */ (u);
  if (["fp", "fp1", "fp2", "fp3", "practice1", "practice2", "practice3"].includes(u))
    return "practice";
  if (["quali", "q", "q1", "q2", "q3"].includes(u)) return "qualifying";
  if (
    ["sprint_quali", "sprint_qualifying", "shootout", "sq", "sq1", "sq2", "sq3"].includes(
      u,
    )
  ) {
    return "sprint_qualifying";
  }
  if (u === "sprint_race") return "sprint";
  if (u === "gp" || u === "grand_prix") return "race";
  return null;
}

export function createF1State() {
  return {
    sessionKey: null,
    meetingKey: null,
    /** Human label e.g. "Chinese GP" */
    meetingName: null,
    circuitShortName: null,
    sessionActive: false,
    trackStatus: null, // green | yellow | red | vsc | safety_car | chequered
    /** @type {SessionKind} */
    sessionKind: "unknown",
    /** Forced kind from pipeline config / env */
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
    const forced = normalizeSessionKind(opts.sessionKind);
    if (forced) {
      next.sessionKindForced = forced;
      next.sessionKind = forced;
    }
  }
  if (next.sessionKindForced) {
    next.sessionKind = next.sessionKindForced;
  }

  const p = event.payload || {};
  if (p.session_key != null) next.sessionKey = p.session_key;
  if (p.meeting_key != null) {
    next.meetingKey = p.meeting_key;
    applyMeetingKeyFallback(next);
  }
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
    next.meetingName = null;
    next.circuitShortName = null;
    if (!next.sessionKindForced) next.sessionKind = "unknown";
  }

  switch (event.type) {
    case "f1.meetings": {
      applyMeetingPayload(next, p);
      break;
    }
    case "f1.sessions": {
      applySessionsMeta(next, p);
      break;
    }
    case "f1.team_radio": {
      // Livetiming URLs often encode meeting + session when MQTT omits v1/meetings
      const parsed = parseLivetimingPath(p.recording_url);
      if (parsed?.meetingName && !next.meetingName) {
        next.meetingName = parsed.meetingName;
      }
      if (parsed?.sessionName && !next.sessionName) {
        next.sessionName = parsed.sessionName;
      }
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

function applyMeetingPayload(state, p) {
  const name =
    p.meeting_name ||
    p.meeting_official_name ||
    p.meeting_code ||
    null;
  if (name) state.meetingName = String(name).replace(/_/g, " ");
  if (p.circuit_short_name) {
    state.circuitShortName = String(p.circuit_short_name);
  }
  if (p.location && !state.circuitShortName) {
    state.circuitShortName = String(p.location);
  }
  applyMeetingKeyFallback(state);
}

function applyMeetingKeyFallback(state) {
  if (state.meetingName) return;
  const meta = meetingMeta(state.meetingKey);
  if (meta) {
    state.meetingName = meta.name;
    if (!state.circuitShortName && meta.circuit) {
      state.circuitShortName = meta.circuit;
    }
  }
}

function applySessionsMeta(state, p) {
  const name = p.session_name || p.session_type || p.name || null;
  if (name) {
    state.sessionName = String(name);
    state.sessionType = String(p.session_type || name);
  }
  if (state.sessionKindForced) return;
  const classified = classifySessionName(name);
  if (classified) state.sessionKind = classified;
}

/**
 * @param {string|null|undefined} name
 * @returns {SessionKind|null}
 */
export function classifySessionName(name) {
  if (!name) return null;
  const u = String(name).toUpperCase();
  // Order matters: sprint shootout before plain sprint; practice before race
  if (/PRACTICE|\bFP[123]\b/.test(u)) return "practice";
  if (/SPRINT\s*SHOOTOUT|SPRINT\s*QUAL|SHOOTOUT|\bSQ[123]\b/.test(u)) {
    return "sprint_qualifying";
  }
  if (/\bSPRINT\b/.test(u) && !/QUAL|SHOOTOUT/.test(u)) return "sprint";
  if (/QUAL|\bQ[123]\b/.test(u)) return "qualifying";
  if (/\bRACE\b/.test(u)) return "race";
  return null;
}

/**
 * Short context for alerts: "Chinese GP · Q1"
 * @param {object} state
 * @param {{ label?: string|null }} [extra]
 */
export function sessionContext(state, extra = {}) {
  const bits = [];
  if (state?.meetingName) bits.push(state.meetingName);
  else if (state?.circuitShortName) bits.push(state.circuitShortName);
  const phase = extra.label || phaseLabel(state);
  if (phase) bits.push(phase);
  return bits.join(" · ");
}

/** Human phase label for banners */
export function phaseLabel(state) {
  if (!state) return null;
  if (isKnockoutMode(state)) {
    return knockoutSegmentLabel(state.segment || 1, state.sessionKind);
  }
  if (state.sessionKind === "practice") {
    return prettyPracticeName(state.sessionName) || "Practice";
  }
  if (state.sessionKind === "sprint") return "Sprint";
  if (state.sessionKind === "race") return "Race";
  if (state.sessionName) return state.sessionName;
  return null;
}

function prettyPracticeName(name) {
  if (!name) return null;
  const u = String(name).toUpperCase();
  if (/\bFP1\b|PRACTICE\s*1/.test(u)) return "FP1";
  if (/\bFP2\b|PRACTICE\s*2/.test(u)) return "FP2";
  if (/\bFP3\b|PRACTICE\s*3/.test(u)) return "FP3";
  if (/PRACTICE/.test(u)) return "Practice";
  return null;
}

/** Q1–Q3 or SQ1–SQ3 */
export function knockoutSegmentLabel(seg, kind = "qualifying") {
  const n = seg || 1;
  const prefix = kind === "sprint_qualifying" ? "SQ" : "Q";
  if (n >= 1 && n <= 3) return `${prefix}${n}`;
  return `${prefix}${n}`;
}

/** Full / sprint quali knockout formats */
export function isKnockoutMode(state) {
  return (
    state?.sessionKind === "qualifying" ||
    state?.sessionKind === "sprint_qualifying"
  );
}

export function isPracticeMode(state) {
  return state?.sessionKind === "practice";
}

/**
 * Sparse knockout detectors (not race order/pits).
 * Unknown multi-segment (≥2) treated as knockout until proven otherwise.
 */
export function isQualifyingMode(state) {
  if (isKnockoutMode(state)) return true;
  if (
    state?.sessionKind === "race" ||
    state?.sessionKind === "sprint" ||
    state?.sessionKind === "practice"
  ) {
    return false;
  }
  if ((state?.segment || 0) >= 2) return true;
  return false;
}

/**
 * GP / sprint race order & pits.
 * Unknown single-segment stays race-style (soft-launch for live GPs).
 */
export function isRaceStyleMode(state) {
  if (isPracticeMode(state) || isKnockoutMode(state)) return false;
  if (state?.sessionKind === "race" || state?.sessionKind === "sprint") {
    return true;
  }
  return !isQualifyingMode(state);
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

/**
 * Long green running without multi-segment.
 * Do NOT use ~40m (that mis-tags FP as race). Full GPs are 90m+; promote late
 * or rely on SC / sessions feed / ENGINE_SESSION_KIND.
 */
function maybePromoteRaceByDuration(state, t) {
  if (state.sessionKindForced) return;
  if (state.sessionKind !== "unknown") return;
  if ((state.segment || 0) > 1) return;
  if (state.chequered || (state.chequeredCount || 0) > 0) return;
  const startMs = toMs(state.segmentStartT);
  const nowMs = toMs(t || state.lastEventT);
  if (startMs == null || nowMs == null) return;
  const mins = (nowMs - startMs) / 60000;
  if (mins > 100) state.sessionKind = "race";
}

function applyRaceControl(state, p, t) {
  const msg = String(p.message || "").toUpperCase();
  const flag = String(p.flag || "").toUpperCase();
  const cat = String(p.category || "");

  // Stewards text can name the format before v1/sessions arrives
  if (!state.sessionKindForced) {
    if (/\bSQ[123]\b/.test(msg) || /SPRINT\s*SHOOTOUT|SPRINT\s*QUAL/.test(msg)) {
      state.sessionKind = "sprint_qualifying";
    } else if (/\bQ[123]\b/.test(msg) && !/\bSQ/.test(msg)) {
      state.sessionKind = "qualifying";
    } else if (/\bPRACTICE\b|\bFP[123]\b/.test(msg)) {
      state.sessionKind = "practice";
    }
  }

  if (msg.includes("SESSION STARTED")) {
    const afterChequered =
      state.chequered ||
      state.awaitingNextSegment ||
      (state.chequeredCount || 0) > 0;
    if (afterChequered && isKnockoutMode(state)) {
      // Multi-segment knockout (Q2/Q3 or SQ2/SQ3)
      if (state.segment < 1) state.segment = 1;
      state.segment = Math.min(3, state.segment + 1);
    } else if (afterChequered && state.sessionKind === "unknown") {
      // Heuristic: multi-chequered session → full quali unless stewards said SQ
      state.sessionKind = "qualifying";
      if (state.segment < 1) state.segment = 1;
      state.segment = Math.min(3, state.segment + 1);
    } else if (afterChequered && state.sessionKind === "practice") {
      // Practice red-flag restart after a rare early chequered — don't treat as Q2
      state.segment = Math.max(1, state.segment || 1);
    } else if (state.segment === 0) {
      state.segment = 1;
    }
    state.sessionActive = true;
    state.chequered = false;
    state.awaitingNextSegment = false;
    state.segmentStartT = t || state.lastEventT;
    state.trackStatus = "green";
    // Fresh knockout segment: reset session-best
    if (isKnockoutMode(state) && state.segment > 1) {
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

    // Classify unknown sessions at first chequered
    if (!state.sessionKindForced && state.sessionKind === "unknown") {
      const startMs = toMs(state.segmentStartT);
      const endMs = toMs(t);
      const laps = state.completeLapCount || 0;
      if (startMs != null && endMs != null) {
        const mins = (endMs - startMs) / 60000;
        // Short pure green + few flying laps → Q segment
        // Short green after lots of laps (red-flagged FP) → practice
        // ~1h single block → practice; much longer → race
        if (mins > 0 && mins <= 35 && laps < 50) {
          state.sessionKind = "qualifying";
        } else if (mins > 0 && mins <= 100) {
          state.sessionKind = "practice";
        } else if (mins > 100) {
          state.sessionKind = "race";
        }
      } else if (laps >= 50) {
        state.sessionKind = "practice";
      } else if ((state.orderAtChequered || []).length >= 16) {
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
      // Full SC is rare in practice; usually race or sprint
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

/**
 * Parse OpenF1 / capture timestamps as UTC when timezone is omitted
 * (otherwise Node treats "2026-03-07T01:51:50.638000" as *local* and
 * duration heuristics mis-fire).
 */
function toMs(t) {
  if (t == null) return null;
  let s = String(t).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s + "Z";
  }
  const n = new Date(s).getTime();
  return Number.isFinite(n) ? n : null;
}
