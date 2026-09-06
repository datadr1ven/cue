/**
 * First-draft F1 SignalR capture → Cue IngestEvent (OpenF1-shaped payloads).
 *
 * Goal: offline replay of livetiming NDJSON through the existing F1 domain
 * without OpenF1. Not yet a live worker — state merge for TimingData deltas
 * is intentionally minimal.
 *
 * Capture line shape (from capture-signalr.js):
 *   { source, receivedAt, topic, payload, snapshot?, hubTime? }
 */

/**
 * @typedef {{
 *   positions: Map<number, number>,
 *   inPit: Map<number, boolean>,
 *   compounds: Map<number, string>,
 * }} SignalRMergeState
 */

/** @returns {SignalRMergeState} */
export function createSignalRMergeState() {
  return {
    positions: new Map(),
    inPit: new Map(),
    compounds: new Map(),
  };
}

/**
 * Expand one SignalR capture line into zero or more Cue ingest events.
 * @param {object} line
 * @param {SignalRMergeState} [merge]
 * @returns {import('../types.js').IngestEvent[]}
 */
export function expandSignalRLine(line, merge = createSignalRMergeState()) {
  if (!line || typeof line !== "object") return [];
  const topic = line.topic;
  const payload = line.payload;
  const t =
    line.hubTime ||
    line.receivedAt ||
    (payload && typeof payload === "object" && payload.Utc) ||
    null;
  const base = { source: "f1-signalr", topic, t };

  switch (topic) {
    case "RaceControlMessages":
      return expandRaceControl(payload, base, line.snapshot);
    case "WeatherData":
      return expandWeather(payload, base);
    case "SessionStatus":
      return expandSessionStatus(payload, base);
    case "TrackStatus":
      return expandTrackStatus(payload, base);
    case "TimingData":
      return expandTimingData(payload, base, merge);
    case "TimingAppData":
      return expandTimingAppData(payload, base, merge);
    case "TeamRadio":
      return expandTeamRadio(payload, base);
    default:
      return [];
  }
}

function expandRaceControl(payload, base, isSnapshot) {
  if (!payload || typeof payload !== "object") return [];
  // Snapshots dump the whole weekend history — skip for live-shaped replay
  // (caller can pass keepSnapshots if needed later).
  if (isSnapshot) return [];

  const raw = payload.Messages ?? payload.messages ?? payload;
  /** @type {object[]} */
  let items = [];
  if (Array.isArray(raw)) items = raw.filter((x) => x && typeof x === "object");
  else if (raw && typeof raw === "object") {
    const vals = Object.values(raw);
    if (vals.length && vals.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      items = /** @type {object[]} */ (vals);
    } else if (raw.Message || raw.Flag || raw.Category) {
      items = [raw];
    }
  }

  return items.map((m) => {
    const category = m.Category || m.category || null;
    const flag = m.Flag || m.flag || null;
    const message = m.Message || m.message || "";
    const mode = m.Mode || m.mode || null;
    // Map SafetyCar + Mode=VSC into OpenF1-ish message text Cue already parses
    let msg = String(message);
    if (category === "SafetyCar" && !msg) {
      msg = mode === "VSC" || mode === "Virtual Safety Car"
        ? "VSC DEPLOYED"
        : "SAFETY CAR DEPLOYED";
    }
    return {
      type: "f1.race_control",
      t: m.Utc || m.utc || base.t,
      source: base.source,
      topic: base.topic,
      payload: {
        date: m.Utc || m.utc || base.t,
        category,
        flag,
        message: msg,
        scope: m.Scope || m.scope || null,
        sector: m.Sector ?? m.sector ?? null,
        lap_number: m.Lap ?? m.lap ?? null,
        driver_number: parseRacingNumber(m.RacingNumber),
        // Preserve mode for future detectors
        _signalrMode: mode,
      },
    };
  });
}

function expandWeather(payload, base) {
  if (!payload || typeof payload !== "object") return [];
  if (payload._kf && Object.keys(payload).length <= 2) return [];
  return [
    {
      type: "f1.weather",
      t: base.t,
      source: base.source,
      topic: base.topic,
      payload: {
        date: base.t,
        air_temperature: numOrNull(payload.AirTemp),
        track_temperature: numOrNull(payload.TrackTemp),
        humidity: numOrNull(payload.Humidity),
        pressure: numOrNull(payload.Pressure),
        rainfall: payload.Rainfall === true || payload.Rainfall === "true" || Number(payload.Rainfall) > 0 ? 1 : 0,
        wind_direction: numOrNull(payload.WindDirection),
        wind_speed: numOrNull(payload.WindSpeed),
      },
    },
  ];
}

function expandSessionStatus(payload, base) {
  if (!payload || typeof payload !== "object") return [];
  const status = payload.Status || payload.Started || null;
  if (!status) return [];
  const up = String(status).toUpperCase();
  let message = `SESSION ${up}`;
  if (up === "STARTED") message = "SESSION STARTED";
  if (up === "FINISHED" || up === "FINALISED" || up === "FINALIZED") {
    message = "SESSION FINISHED";
  }
  if (up.includes("ABORT")) message = "SESSION ABORTED";
  return [
    {
      type: "f1.race_control",
      t: base.t,
      source: base.source,
      topic: base.topic,
      payload: {
        date: base.t,
        category: "SessionStatus",
        flag: null,
        message,
      },
    },
  ];
}

function expandTrackStatus(payload, base) {
  if (!payload || typeof payload !== "object") return [];
  const msg = payload.Message || null;
  const status = payload.Status;
  // Status codes: 1 AllClear, 2 Yellow, 4 SC, 5 Red, 6 VSC, 7 VSCEnding…
  let message = msg ? String(msg) : null;
  let flag = null;
  let category = "Flag";
  if (!message && status != null) {
    const s = String(status);
    if (s === "2") {
      message = "YELLOW";
      flag = "YELLOW";
    } else if (s === "4") {
      message = "SAFETY CAR DEPLOYED";
      category = "SafetyCar";
    } else if (s === "5") {
      message = "RED FLAG";
      flag = "RED";
    } else if (s === "6") {
      message = "VSC DEPLOYED";
      category = "SafetyCar";
    } else if (s === "1") {
      message = "TRACK CLEAR";
      flag = "CLEAR";
    }
  }
  if (!message) return [];
  return [
    {
      type: "f1.race_control",
      t: base.t,
      source: base.source,
      topic: base.topic,
      payload: {
        date: base.t,
        category,
        flag: flag || (String(message).includes("YELLOW") ? "YELLOW" : null),
        message,
      },
    },
  ];
}

function expandTimingData(payload, base, merge) {
  if (!payload || typeof payload !== "object") return [];
  const lines = payload.Lines || {};
  /** @type {import('../types.js').IngestEvent[]} */
  const out = [];
  for (const [key, rec] of Object.entries(lines)) {
    if (!rec || typeof rec !== "object") continue;
    const num = parseRacingNumber(rec.RacingNumber ?? key);
    if (!Number.isFinite(num)) continue;

    if (rec.Position != null && String(rec.Position).trim() !== "") {
      const pos = Number(rec.Position);
      if (Number.isFinite(pos)) {
        const prev = merge.positions.get(num);
        merge.positions.set(num, pos);
        if (prev !== pos) {
          out.push({
            type: "f1.position",
            t: base.t,
            source: base.source,
            topic: base.topic,
            payload: {
              date: base.t,
              driver_number: num,
              position: pos,
            },
          });
        }
      }
    }

    if (typeof rec.InPit === "boolean") {
      const was = merge.inPit.get(num);
      merge.inPit.set(num, rec.InPit);
      // Rising edge → synthetic pit stop (no duration from SignalR alone)
      if (was === false && rec.InPit === true) {
        out.push({
          type: "f1.pit",
          t: base.t,
          source: base.source,
          topic: base.topic,
          payload: {
            date: base.t,
            driver_number: num,
            lap_number: numOrNull(rec.NumberOfLaps),
            pit_duration: null,
            stop_duration: null,
            _signalr: true,
          },
        });
      }
    }
  }
  return out;
}

function expandTimingAppData(payload, base, merge) {
  if (!payload || typeof payload !== "object") return [];
  const lines = payload.Lines || {};
  /** @type {import('../types.js').IngestEvent[]} */
  const out = [];
  for (const [key, rec] of Object.entries(lines)) {
    if (!rec || typeof rec !== "object") continue;
    const num = parseRacingNumber(rec.RacingNumber ?? key);
    if (!Number.isFinite(num)) continue;
    const stints = rec.Stints;
    if (!stints) continue;
    // Stints may be array or { "0": {...}, "1": {...} }
    const list = Array.isArray(stints)
      ? stints
      : Object.keys(stints)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => stints[k]);
    const last = list.filter(Boolean).at(-1);
    if (!last || typeof last !== "object") continue;
    const compound = last.Compound || last.compound || null;
    if (!compound) continue;
    const prev = merge.compounds.get(num);
    merge.compounds.set(num, compound);
    if (prev === compound) continue;
    out.push({
      type: "f1.stints",
      t: base.t,
      source: base.source,
      topic: base.topic,
      payload: {
        driver_number: num,
        compound: String(compound).toUpperCase(),
        stint_number: list.length,
        tyre_age_at_start: numOrNull(last.StartLaps),
        lap_start: null,
        lap_end: numOrNull(last.TotalLaps),
        _signalrNew: last.New === true || last.New === "true",
      },
    });
  }
  return out;
}

function expandTeamRadio(payload, base) {
  if (!payload || typeof payload !== "object") return [];
  const captures = payload.Captures || payload.captures;
  if (!Array.isArray(captures)) return [];
  return captures
    .map((c) => {
      const num = parseRacingNumber(c.RacingNumber);
      if (!Number.isFinite(num)) return null;
      const path = c.Path || c.path;
      return {
        type: "f1.team_radio",
        t: c.Utc || base.t,
        source: base.source,
        topic: base.topic,
        payload: {
          date: c.Utc || base.t,
          driver_number: num,
          recording_url: path
            ? `https://livetiming.formula1.com/static/${path}`
            : null,
        },
      };
    })
    .filter(Boolean);
}

function parseRacingNumber(v) {
  if (v == null) return NaN;
  const n = Number(String(v).replace(/\D/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
