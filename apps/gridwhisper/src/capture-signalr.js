/**
 * F1 livetiming SignalR Core client → NDJSON and/or live onMessage callback.
 *
 * Used for:
 *   - capture:signalr (gold NDJSON twin)
 *   - ENGINE_SOURCE=signalr live worker (same hub path)
 *
 * Auth (optional): F1_TOKEN / F1_SUBSCRIPTION_TOKEN
 * No-auth twin: SIGNALR_NO_AUTH=1 (or empty F1_TOKEN=)
 *
 * Based on FastF1's livetiming client (signalrcore + AWSALBCORS negotiate).
 */

import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { dirname } from "path";
import * as signalR from "@microsoft/signalr";
import { logError, logInfo, logWarn } from "cue/log.js";

const NEGOTIATE_URL =
  "https://livetiming.formula1.com/signalrcore/negotiate?negotiateVersion=1";
/** Use https — @microsoft/signalr negotiates and upgrades to wss itself. */
const HUB_URL = "https://livetiming.formula1.com/signalrcore";

/** Lean set — RC / order / weather without CarData floods. */
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
 * @param {string} [opts.outPath]  NDJSON append path (omit for worker-only)
 * @param {(line: object) => void|Promise<void>} [opts.onMessage]
 * @param {string[]} [opts.topics]
 * @param {boolean} [opts.telemetry]
 * @param {string|null} [opts.token]
 * @param {number} [opts.heartbeatMs]
 * @param {boolean} [opts.stayAlive=true]  If false, returns { connection, stop }
 */
export async function startSignalRCapture(opts) {
  const outPath = opts.outPath || null;
  const onMessage = opts.onMessage || null;
  if (!outPath && !onMessage) {
    throw new Error("startSignalRCapture: need outPath and/or onMessage");
  }
  const telemetry = Boolean(opts.telemetry);
  const topics = opts.topics?.length
    ? opts.topics
    : [...DEFAULT_TOPICS, ...(telemetry ? TELEMETRY_TOPICS : [])];
  const rawToken =
    opts.token ??
    process.env.F1_TOKEN ??
    process.env.F1_SUBSCRIPTION_TOKEN ??
    null;
  const trimmed =
    typeof rawToken === "string" ? rawToken.trim() : rawToken;
  const token =
    process.env.SIGNALR_NO_AUTH === "1" ? null : trimmed || null;
  const heartbeatMs = opts.heartbeatMs ?? 5 * 60 * 1000;
  const stayAlive = opts.stayAlive !== false;

  let out = null;
  if (outPath) {
    await mkdir(dirname(outPath), { recursive: true });
    out = createWriteStream(outPath, { flags: "a" });
  }

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

  function emitLine(obj) {
    lines += 1;
    lastTopic = obj.topic || lastTopic;
    if (out) out.write(`${JSON.stringify(obj)}\n`);
    if (onMessage) {
      try {
        const r = onMessage(obj);
        if (r && typeof r.then === "function") {
          r.catch((e) => logError("SignalR onMessage:", e.message || e));
        }
      } catch (e) {
        logError("SignalR onMessage:", e.message || e);
      }
    }
  }

  function writeFeed(args) {
    const receivedAt = new Date().toISOString();
    const batch = flattenFeedArgs(args);
    for (const item of batch) {
      emitLine({
        source: "f1-signalr",
        receivedAt,
        topic: item.topic,
        payload: item.payload,
        hubTime: item.hubTime ?? null,
      });
    }
  }

  async function subscribe() {
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
          emitLine({
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
  logInfo(
    outPath
      ? `SignalR connected → ${outPath}`
      : "SignalR connected (live worker, no file)",
  );
  await subscribe();

  const hb = setInterval(() => {
    logInfo(
      `💓 signalr · lines=${lines} · last=${lastTopic || "—"} · state=${connection.state}`,
    );
  }, heartbeatMs);

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(hb);
    logInfo(`SignalR stopping · lines=${lines}`);
    try {
      await connection.stop();
    } catch {
      /* ignore */
    }
    if (out) await new Promise((resolve) => out.end(resolve));
  };

  if (stayAlive) {
    process.once("SIGINT", () => {
      stop().then(() => process.exit(0));
    });
    process.once("SIGTERM", () => {
      stop().then(() => process.exit(0));
    });
    await new Promise(() => {});
  }

  return { connection, stop, getLines: () => lines };
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

  if (
    args.length === 1 &&
    args[0] &&
    !Array.isArray(args[0]) &&
    typeof args[0] === "object"
  ) {
    for (const [topic, raw] of Object.entries(args[0])) {
      out.push({ topic, payload: tryParse(raw) });
    }
    return out;
  }

  const first = args[0];
  if (Array.isArray(first) && first.length && Array.isArray(first[0])) {
    for (const row of first) {
      pushTriple(out, row);
    }
    return out;
  }
  if (Array.isArray(first) && typeof first[0] === "string") {
    pushTriple(out, first);
    return out;
  }
  if (typeof args[0] === "string") {
    pushTriple(out, args);
    return out;
  }

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
