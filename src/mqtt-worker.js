/**
 * MQTT → Cue engine → deliver()
 */

import mqtt from "mqtt";
import axios from "axios";
import { Telegraf } from "telegraf";
import { config, requireTelegramToken } from "./config.js";
import { getRuntime, getMqttOptions, logRuntimeBanner } from "./runtime.js";
import { deliver, deliverHttp, applyAlertTag } from "./delivery.js";
import { loadSubscribers } from "./users.js";
import { createPipeline } from "./engine/pipeline.js";
import { expandOpenF1Line } from "./engine/ingest/openf1.js";
import { logInfo, logWarn, logError } from "./log.js";
import { MQTT_TOPICS } from "./mqtt-topics.js";

export { MQTT_TOPICS };

let client = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalDisconnect = false;
let globalToken = null;
let runtime = null;
let bot = null;
let usersCache = new Map();
let pipeline = null;
let messageQueue = Promise.resolve();
/** Process-level online/offline banners (not on every MQTT reconnect) */
let startupBannerSent = false;
let shuttingDown = false;
let signalsHooked = false;
/** Flush deferred pit→tyre combines */
let pitFlushTimer = null;
/** One-time worker init (pipeline / bot / signals) — preserved across MQTT reconnects */
let workerInitialized = false;

const maxReconnectAttemptsBeforeSlow = 10;
const baseReconnectDelay = 1000;
const maxReconnectDelay = 5 * 60 * 1000;

async function fetchToken() {
  const username = config.openf1Username || process.env.OPENF1_USERNAME;
  const password = config.openf1Password || process.env.OPENF1_PASSWORD;
  if (!username || !password) {
    throw new Error("OPENF1_USERNAME / OPENF1_PASSWORD required for MQTT_SOURCE=live");
  }
  const res = await axios.post(
    "https://api.openf1.org/token",
    new URLSearchParams({ username, password }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
  );
  logInfo("✅ OpenF1 token ok");
  return res.data.access_token;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (intentionalDisconnect) return;
  clearReconnectTimer();
  reconnectAttempts += 1;
  const exp = Math.min(
    baseReconnectDelay * Math.pow(2, Math.min(reconnectAttempts - 1, 8)),
    maxReconnectDelay,
  );
  const delay = Math.floor(exp * (0.8 + Math.random() * 0.4));
  if (reconnectAttempts === maxReconnectAttemptsBeforeSlow) {
    logWarn(`⚠️ Many reconnects — cap ${maxReconnectDelay}ms`);
  }
  logInfo(`🔄 Reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    // Reconnect MQTT only — keep pipeline state (segment, meeting, session best)
    connectMqttClient().catch((e) => {
      logError("Reconnect failed:", e.message);
      scheduleReconnect();
    });
  }, delay);
}

async function fanOut(alert) {
  const text = applyAlertTag(alert.text, {
    mqttSource: runtime?.mqttSource,
  });

  if (runtime.deliveryMode === "http") {
    const r = await deliverHttp(text);
    if (r.ok) {
      logInfo(
        `[deliver:http] → ${r.delivered ?? "?"}/${r.total ?? "?"} subscribers`,
      );
    } else {
      logError(`[deliver:http] failed: ${r.reason} ${r.error || ""}`);
    }
    return;
  }

  if (runtime.deliveryMode === "log" || runtime.deliveryMode === "none") {
    await deliver(bot, runtime, 0, text);
    return;
  }

  const users = [...usersCache.values()];
  if (users.length === 0) {
    logInfo(`[no-subscribers] ${text.replace(/\n/g, " | ")}`);
    return;
  }
  for (const user of users) {
    await deliver(bot, runtime, user.user_id, text);
  }
}

function lifecycleBannersEnabled() {
  const raw = process.env.LIFECYCLE_BANNERS;
  if (raw != null && String(raw).trim() !== "") {
    const v = String(raw).trim().toLowerCase();
    if (["0", "false", "off", "no", "none"].includes(v)) return false;
    if (["1", "true", "yes", "on"].includes(v)) return true;
  }
  // Default: announce when we actually fan out to people (or log for dry-run)
  return runtime && runtime.deliveryMode !== "none";
}

function lifecycleBannerText(kind) {
  const src =
    runtime?.mqttSource === "live" ? "OpenF1 live" : "local capture / broker";
  const mode = process.env.ENGINE_SESSION_KIND
    ? String(process.env.ENGINE_SESSION_KIND).trim()
    : "auto";
  if (kind === "up") {
    return (
      `🟢 GridWhisper live feed is online\n` +
      `Source: ${src} · session mode: ${mode}\n` +
      `Sparse alerts will appear here while this watcher is running.`
    );
  }
  return (
    `🔴 GridWhisper live feed is offline\n` +
    `Session watcher stopped — no more live moments until it comes back.`
  );
}

async function announceLifecycle(kind) {
  if (!lifecycleBannersEnabled()) return;
  const text = lifecycleBannerText(kind);
  logInfo(`[lifecycle] ${text.replace(/\n/g, " | ")}`);
  try {
    await fanOut({ text });
  } catch (e) {
    logError(`[lifecycle] ${kind} banner failed:`, e.message || e);
  }
}

function hookLifecycleSignals() {
  if (signalsHooked) return;
  signalsHooked = true;
  const go = (sig) => {
    stopMqttWorker(sig)
      .then(() => process.exit(0))
      .catch((e) => {
        logError("Shutdown error:", e.message || e);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => go("SIGINT"));
  process.once("SIGTERM", () => go("SIGTERM"));
}

async function onMessage(topic, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return;
  }
  // Local publish injects original capture receivedAt onto the payload; keep it
  // so dateless topics (stints) don't look like "now" for event-time silence.
  const recvFromPayload =
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.receivedAt
      ? payload.receivedAt
      : null;
  const line = {
    topic,
    payload,
    receivedAt: recvFromPayload || new Date().toISOString(),
    source: "mqtt",
  };
  for (const ev of expandOpenF1Line(line)) {
    const { alerts } = pipeline.push(ev);
    for (const alert of alerts) {
      await emitAlert(alert);
    }
  }
}

async function emitAlert(alert) {
  const eventTs = alert.moment.t
    ? String(alert.moment.t).slice(11, 19)
    : "??:??:??";
  logInfo(
    `⚡ ${eventTs} [${alert.moment.severity}] ${alert.moment.type} ${alert.text.replace(/\n/g, " | ")}`,
  );
  await fanOut(alert);
}

async function flushPendingPits() {
  if (!pipeline?.flushPending || shuttingDown) return;
  const { alerts } = pipeline.flushPending();
  for (const alert of alerts) {
    await emitAlert(alert);
  }
}

function ensurePitFlushTimer() {
  if (pitFlushTimer) return;
  // ~5s wait for stint compound; poll often enough to flush timeouts promptly
  pitFlushTimer = setInterval(() => {
    messageQueue = messageQueue
      .then(() => flushPendingPits())
      .catch((e) => logError("Pit flush error:", e));
  }, 500);
  if (typeof pitFlushTimer.unref === "function") pitFlushTimer.unref();
}

/**
 * Tear down any half-open client and connect (or reconnect) to MQTT.
 * Does not recreate the Cue pipeline — session state survives hiccups.
 */
async function connectMqttClient() {
  if (shuttingDown) return;

  intentionalDisconnect = false;
  clearReconnectTimer();

  if (client) {
    try {
      client.removeAllListeners();
      intentionalDisconnect = true; // suppress close→reconnect while swapping
      client.end(true);
    } catch {
      /* ignore */
    }
    client = null;
    intentionalDisconnect = false;
  }

  if (runtime.mqttSource === "live") {
    globalToken = await fetchToken();
  }

  const options = getMqttOptions(runtime, globalToken);
  logInfo(`🚀 MQTT ${options.protocol}://${options.host}:${options.port}`);
  client = mqtt.connect(options);

  client.on("connect", () => {
    logInfo("✅ MQTT connected");
    isConnected = true;
    reconnectAttempts = 0;
    client.subscribe(MQTT_TOPICS, { qos: 1 }, (err) => {
      if (err) logError("Subscribe error:", err);
      else logInfo("✅ Subscribed:", MQTT_TOPICS.join(", "));
      // One online banner per process (not on every MQTT reconnect)
      if (!startupBannerSent && !shuttingDown) {
        startupBannerSent = true;
        messageQueue = messageQueue
          .then(() => announceLifecycle("up"))
          .catch((e) => logError("Startup banner error:", e));
      }
    });
  });

  client.on("message", (topic, message) => {
    messageQueue = messageQueue
      .then(() => onMessage(topic, message))
      .catch((e) => logError("Handler error:", e));
  });

  client.on("error", (err) => logError("MQTT error:", err.message));
  client.on("close", () => {
    isConnected = false;
    if (!intentionalDisconnect && !shuttingDown) {
      logWarn("MQTT closed");
      scheduleReconnect();
    }
  });
}

export async function startMqttWorker() {
  if (!workerInitialized) {
    runtime = getRuntime();
    logRuntimeBanner(runtime);

    if (runtime.deliveryMode === "telegram") {
      requireTelegramToken();
      bot = new Telegraf(config.telegramToken);
    }

    if (runtime.mqttSource === "live") {
      if (!config.openf1Username && !process.env.OPENF1_USERNAME) {
        throw new Error("OPENF1_USERNAME required for live");
      }
      if (!config.openf1Password && !process.env.OPENF1_PASSWORD) {
        throw new Error("OPENF1_PASSWORD required for live");
      }
    }

    if (runtime.deliveryMode === "http") {
      logInfo("👥 Subscribers: managed by CF Worker KV (POST /deliver)");
      usersCache = new Map();
    } else if (runtime.deliveryMode === "telegram") {
      usersCache = loadSubscribers();
      logInfo(`👥 Subscribers: ${usersCache.size} (local file)`);
    } else {
      usersCache = new Map();
      logInfo(`👥 Subscribers: n/a (DELIVERY_MODE=${runtime.deliveryMode})`);
    }

    pipeline = createPipeline({
      domain: config.engineDomain,
      source: "mqtt",
      useLlm: false,
      usePrefs: false,
      minSeverity: config.minSeverity,
    });
    logInfo(
      `🧠 Pipeline domain=${pipeline.domainName} minSeverity=${pipeline.config.minSeverity}`,
    );

    hookLifecycleSignals();
    ensurePitFlushTimer();
    workerInitialized = true;
  }

  await connectMqttClient();
}

/**
 * Graceful stop: offline banner, then disconnect MQTT.
 * Safe to call multiple times.
 * @param {string} [reason]
 */
export async function stopMqttWorker(reason = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;
  intentionalDisconnect = true;
  clearReconnectTimer();
  if (pitFlushTimer) {
    clearInterval(pitFlushTimer);
    pitFlushTimer = null;
  }
  logInfo(`🛑 Stopping MQTT worker (${reason})…`);

  // Drain in-flight message handling, flush deferred pits, then announce offline
  try {
    await messageQueue;
  } catch {
    /* ignore */
  }
  try {
    await flushPendingPits();
  } catch {
    /* ignore */
  }
  await announceLifecycle("down");

  if (client) {
    try {
      client.end(true);
    } catch {
      /* ignore */
    }
    client = null;
  }
  isConnected = false;
}

export function refreshSubscribers() {
  usersCache = loadSubscribers();
  return usersCache.size;
}
