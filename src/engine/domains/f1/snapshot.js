/**
 * Pure-ish reduce: IngestEvent → next state.
 */

import { ROSTER_2026 } from "./roster.js";

export function createF1State() {
  return {
    sessionKey: null,
    meetingKey: null,
    sessionActive: false,
    trackStatus: null, // green | yellow | red | vsc | safety_car | chequered
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
 * @param {object} state
 * @param {import('../../types.js').IngestEvent} event
 */
export function reduceF1(state, event) {
  const next = {
    ...state,
    drivers: { ...state.drivers },
    position: { ...state.position },
    stints: { ...state.stints },
    lastPit: { ...state.lastPit },
  };

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
  }

  switch (event.type) {
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
    case "f1.race_control": {
      applyRaceControl(next, p);
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

function applyRaceControl(state, p) {
  const msg = String(p.message || "").toUpperCase();
  const flag = String(p.flag || "").toUpperCase();
  const cat = String(p.category || "");

  if (msg.includes("SESSION STARTED")) state.sessionActive = true;
  if (msg.includes("SESSION FINISHED") || msg.includes("SESSION ABORTED")) {
    state.sessionActive = false;
  }

  if (flag.includes("CHEQUERED") || msg.includes("CHEQUERED")) {
    state.trackStatus = "chequered";
    state.chequered = true;
    state.sessionActive = false;
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
