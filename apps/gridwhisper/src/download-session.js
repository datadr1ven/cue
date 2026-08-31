/**
 * Download an OpenF1 session via REST → NDJSON shaped like MQTT capture.
 *
 *   GET https://api.openf1.org/v1/{endpoint}?session_key=…
 *   topic = v1/{endpoint}, interleaved by payload date / date_start
 */

import axios from "axios";
import fs from "fs";
import path from "path";
import { captureTopics } from "./mqtt-topics.js";
import { logInfo, logWarn, logError } from "cue/log.js";

const API_BASE = "https://api.openf1.org/v1";
/** Be polite to the free historical API */
const RATE_LIMIT_MS = 400;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** v1/laps → laps */
export function topicToEndpoint(topic) {
  return String(topic || "").replace(/^v1\//, "");
}

/**
 * Best event-time for sorting into a capture-like stream.
 * @param {string} endpoint
 * @param {object} row
 * @param {{ sessionStart?: string|null, sessionEnd?: string|null, lapStartByDriverLap?: Map<string,string> }} ctx
 */
export function eventTimestamp(endpoint, row, ctx = {}) {
  if (!row || typeof row !== "object") return null;
  if (endpoint === "laps") {
    return row.date_start || row.date || null;
  }
  if (row.date) return row.date;
  if (row.date_start) return row.date_start;

  // Stints usually lack date — pin to lap_start of that driver if we have it
  if (endpoint === "stints" && row.driver_number != null && row.lap_start != null) {
    const key = `${row.driver_number}:${row.lap_start}`;
    const pinned = ctx.lapStartByDriverLap?.get(key);
    if (pinned) return pinned;
  }

  // Meta / roster: place before session activity
  if (
    endpoint === "drivers" ||
    endpoint === "sessions" ||
    endpoint === "meetings" ||
    endpoint === "starting_grid" ||
    endpoint === "championship_drivers" ||
    endpoint === "championship_teams"
  ) {
    return ctx.sessionStart || null;
  }

  if (endpoint === "session_result") {
    return ctx.sessionEnd || ctx.sessionStart || null;
  }

  return null;
}

function toSortMs(iso) {
  if (iso == null) return Number.POSITIVE_INFINITY;
  let s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    s = s + "Z";
  }
  const n = new Date(s).getTime();
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

async function fetchJson(url) {
  const res = await axios.get(url, {
    headers: { accept: "application/json" },
    validateStatus: () => true,
  });
  if (res.status === 404) return [];
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const data = res.data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") return [data];
  return [];
}

/**
 * @param {string|number} sessionKey
 * @param {{ outPath?: string, topics?: string[], rateLimitMs?: number }} [opts]
 */
export async function downloadSession(sessionKey, opts = {}) {
  const key = String(sessionKey).trim();
  if (!key) throw new Error("session_key required");

  const topics = opts.topics || captureTopics();
  const rateLimitMs = opts.rateLimitMs ?? RATE_LIMIT_MS;
  const outPath = path.resolve(
    opts.outPath || `${key}-downloaded.ndjson`,
  );

  // Session meta (start/end + meeting_key)
  logInfo(`Fetching session meta session_key=${key}`);
  const sessions = await fetchJson(
    `${API_BASE}/sessions?session_key=${encodeURIComponent(key)}`,
  );
  await sleep(rateLimitMs);
  const sessionMeta = sessions[0] || null;
  const sessionStart = sessionMeta?.date_start || null;
  const sessionEnd = sessionMeta?.date_end || null;
  const meetingKey = sessionMeta?.meeting_key ?? null;
  if (sessionMeta) {
    logInfo(
      `Session: ${sessionMeta.session_name || sessionMeta.session_type || "?"} · ${sessionStart || "?"} → ${sessionEnd || "?"}`,
    );
  } else {
    logWarn("No sessions row for this key — continuing with endpoints only");
  }

  /** @type {Map<string, string>} */
  const lapStartByDriverLap = new Map();

  /** @type {{ topic: string, payload: object, receivedAt: string, source: string }[]} */
  const events = [];

  // Always include session row(s) if present
  for (const row of sessions) {
    const ts = eventTimestamp("sessions", row, { sessionStart, sessionEnd });
    events.push({
      topic: "v1/sessions",
      payload: row,
      receivedAt: ts || sessionStart || new Date().toISOString(),
      source: "openf1-rest",
    });
  }

  // Meeting meta (REST usually wants meeting_key, not session_key)
  if (meetingKey != null) {
    try {
      const meetings = await fetchJson(
        `${API_BASE}/meetings?meeting_key=${encodeURIComponent(meetingKey)}`,
      );
      await sleep(rateLimitMs);
      for (const row of meetings) {
        const ts = eventTimestamp("meetings", row, { sessionStart, sessionEnd });
        events.push({
          topic: "v1/meetings",
          payload: row,
          receivedAt: ts || sessionStart || new Date().toISOString(),
          source: "openf1-rest",
        });
      }
      logInfo(`meetings: ${meetings.length}`);
    } catch (e) {
      logWarn(`meetings failed: ${e.message || e}`);
    }
  }

  // Laps first — builds stint pin map
  const endpoints = topics
    .map(topicToEndpoint)
    .filter((e) => e && e !== "sessions" && e !== "meetings");

  // Ensure laps before stints in fetch order
  endpoints.sort((a, b) => {
    if (a === "laps") return -1;
    if (b === "laps") return 1;
    return a.localeCompare(b);
  });

  for (const endpoint of endpoints) {
    const url = `${API_BASE}/${endpoint}?session_key=${encodeURIComponent(key)}`;
    try {
      const rows = await fetchJson(url);
      logInfo(`${endpoint}: ${rows.length}`);

      if (endpoint === "laps") {
        for (const row of rows) {
          if (
            row.driver_number != null &&
            row.lap_number != null &&
            row.date_start
          ) {
            lapStartByDriverLap.set(
              `${row.driver_number}:${row.lap_number}`,
              row.date_start,
            );
          }
        }
      }

      const ctx = { sessionStart, sessionEnd, lapStartByDriverLap };
      for (const row of rows) {
        const ts = eventTimestamp(endpoint, row, ctx);
        events.push({
          topic: `v1/${endpoint}`,
          payload: row,
          receivedAt: ts || sessionStart || new Date().toISOString(),
          source: "openf1-rest",
        });
      }
    } catch (e) {
      logWarn(`${endpoint} failed: ${e.message || e}`);
    }
    await sleep(rateLimitMs);
  }

  events.sort((a, b) => {
    const d = toSortMs(a.receivedAt) - toSortMs(b.receivedAt);
    if (d !== 0) return d;
    return String(a.topic).localeCompare(String(b.topic));
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = fs.createWriteStream(outPath, { flags: "w" });
  for (const ev of events) {
    stream.write(`${JSON.stringify(ev)}\n`);
  }
  await new Promise((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  logInfo(`Wrote ${events.length} events → ${outPath}`);
  return { outPath, count: events.length, sessionKey: key, sessionMeta };
}
