/**
 * Minimal F1 livetiming SignalR Core capture → NDJSON.
 *
 * Parallel to OpenF1 MQTT — does NOT feed Cue. Raw hub messages only, so we
 * can compare upstream vs OpenF1 middle-layer on race day.
 *
 * Auth (optional but increasingly required for full streams):
 *   F1_TOKEN / F1_SUBSCRIPTION_TOKEN — F1TV subscription JWT
 * Without a token we still connect (no_auth); some topics may be empty.
 *
 * Based on FastF1's livetiming client (signalrcore + AWSALBCORS negotiate).
 */

import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import * as signalR from "@microsoft/signalr";
import { logError, logInfo, logWarn } from "./log.js";

const NEGOTIATE_URL =
  "https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1";
/** Use https — @microsoft/signalr negotiates and upgrades to wss itself. */
const HUB_URL = "https://livetiming.formula1.com/signalrcore";

/** Lean set — enough to compare RC / order / weather without CarData floods. */
export const DEFAULT_TOPICS = [
  "Heartbeat",
  "DriverList",
  "RaceControlMessages",
  "SessionInfo",
  "SessionStatus",
  "SessionData",
  "TrackStatus",
  "WeatherData",
  "TimingData",
  "TimingAppData",
  "TimingStats",
  "TopThree",
  "LapCount",
  "TeamRadio",
];

/** Extra volume — only with --telemetry / SIGNALR_TELEMETRY=1 */
export const TELEMETRY_TOPICS = ["Position.z", "CarData.z"];

/**
 * @param {object} opts
 * @param {string} opts.outPath
 * @param {string[]} [opts.topics]
 * @param {boolean} [opts.telemetry]
 * @param {string|null} [opts.token]
 * @param {number} [opts.heartbeatMs]
 */
export async function startSignalRCapture(opts) {
  const outPath = opts.outPath;
  const telemetry = Boolean(opts.telemetry);
  const topics = opts.topics?.length
    ? opts.topics
    : [...DEFAULT_TOPICS, ...(telemetry ? TELEMETRY_TOPICS : [])];
  const token =
    opts.token ||
    process.env.F1_TOKEN ||
    process.env.F1_SUBSCRIPTION_TOKEN ||
    null;
  const heartbeatMs = opts.heartbeatMs ?? 5 * 60 * 1000;

  await mkdir(dirname(outPath), { recursive: true });
  const out = createWriteStream(outPath, { flags: "a" });

  let lines = 0;
  let lastTopic = null;
  let stopping = false;

  const cookieHeader = await negotiateCookieHeader();
  logInfo(
    `SignalR ALB cookie=${cookieHeader ? "yes" : "no"} · auth=${token ? "token" : "none"} · topics=${topics.length}`,
  );

  const headers = {};
  if (cookieHeader) headers.Cookie = cookieHeader;

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL, {
      accessTokenFactory: token ? async () => token : undefined,
      headers,
    })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  connection.on("feed", (...args) => {
    // FastF1 sees either a list [topic, jsonPayload, timestamp] batches
    // or completion-style maps. Normalize to one NDJSON line per topic hit.
    writeFeed(args);
  });

  connection.onreconnecting((err) => {
    logWarn("SignalR reconnecting…", err?.message || "");
  });
  connection.onreconnected(() => {
    logInfo("SignalR reconnected — re-subscribing");
    return subscribe();
  });
  connection.onclose((err) => {
    if (!stopping) {
      logWarn("SignalR closed", err?.message || "");
    }
  });

  function writeLine(obj) {
    out.write(`${JSON.stringify(obj)}\n`);
    lines += 1;
    lastTopic = obj.topic || lastTopic;
  }

  function writeFeed(args) {
    const receivedAt = new Date().toISOString();
    // Typical live message: one array of [topic, payloadJson, time] triples
    // or a flat [topic, payload, time]
    const batch = flattenFeedArgs(args);
    for (const item of batch) {
      writeLine({
        source: "f1-signalr",
        receivedAt,
        topic: item.topic,
        payload: item.payload,
        hubTime: item.hubTime ?? null,
      });
    }
  }

  async function subscribe() {
    // Invoke Subscribe; F1 also returns a snapshot via completion → on("feed")
    // or as invoke result depending on hub version.
    try {
      const result = await connection.invoke("Subscribe", topics);
      if (result && typeof result === "object") {
        const receivedAt = new Date().toISOString();
        for (const [topic, raw] of Object.entries(result)) {
          let payload = raw;
          if (typeof raw === "string") {
            try {
              payload = JSON.parse(raw);
            } catch {
              /* keep string */
            }
          }
          writeLine({
            source: "f1-signalr",
            receivedAt,
            topic,
            payload,
            snapshot: true,
          });
        }
        logInfo(`SignalR subscribe snapshot · keys=${Object.keys(result).length}`);
      } else {
        logInfo("SignalR subscribed (no snapshot payload)");
      }
    } catch (err) {
      logError("SignalR Subscribe failed:", err.message || err);
      throw err;
    }
  }

  await connection.start();
  logInfo(`SignalR connected → ${outPath}`);
  await subscribe();

  const hb = setInterval(() => {
    logInfo(
      `💓 signalr capture · lines=${lines} · last=${lastTopic || "—"} · state=${connection.state}`,
    );
  }, heartbeatMs);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(hb);
    logInfo(`SignalR capture stopping · lines=${lines}`);
    try {
      await connection.stop();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => out.end(resolve));
  };

  process.once("SIGINT", () => {
    shutdown().then(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().then(() => process.exit(0));
  });

  // Stay alive until signal
  await new Promise(() => {});
}

/**
 * OPTIONS on negotiate → AWSALB + AWSALBCORS cookies (F1 ALB sticky).
 * @returns {Promise<string|null>} Cookie header value
 */
async function negotiateCookieHeader() {
  try {
    const res = await fetch(NEGOTIATE_URL, { method: "OPTIONS" });
    const setCookie = res.headers.getSetCookie?.() || [];
    const parts = [];
    for (const name of ["AWSALB", "AWSALBCORS"]) {
      const line = setCookie.find((c) => c.startsWith(`${name}=`));
      const m = line && String(line).match(new RegExp(`${name}=([^;]+)`));
      if (m) parts.push(`${name}=${m[1]}`);
    }
    return parts.length ? parts.join("; ") : null;
  } catch (err) {
    logWarn("SignalR negotiate cookie failed:", err.message || err);
    return null;
  }
}

/**
 * @param {unknown[]} args
 * @returns {{ topic: string, payload: unknown, hubTime?: string }[]}
 */
function flattenFeedArgs(args) {
  const out = [];
  if (!args?.length) return out;

  // invoke completion sometimes passes a single object map
  if (args.length === 1 && args[0] && !Array.isArray(args[0]) && typeof args[0] === "object") {
    for (const [topic, raw] of Object.entries(args[0])) {
      out.push({ topic, payload: tryParse(raw) });
    }
    return out;
  }

  const first = args[0];
  // [ [topic, json, t], ... ]
  if (Array.isArray(first) && first.length && Array.isArray(first[0])) {
    for (const row of first) {
      pushTriple(out, row);
    }
    return out;
  }
  // [topic, json, t]
  if (Array.isArray(first) && typeof first[0] === "string") {
    pushTriple(out, first);
    return out;
  }
  // feed(topic, payload, time) as separate args
  if (typeof args[0] === "string") {
    pushTriple(out, args);
    return out;
  }

  // fallback: dump raw
  out.push({ topic: "unknown", payload: args.length === 1 ? args[0] : args });
  return out;
}

function pushTriple(out, row) {
  if (!Array.isArray(row) || row.length < 2) return;
  const topic = String(row[0]);
  const payload = tryParse(row[1]);
  const hubTime = row[2] != null ? String(row[2]) : undefined;
  out.push({ topic, payload, hubTime });
}

function tryParse(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
