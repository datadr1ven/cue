/**
 * F1 SignalR livetiming → Cue engine → deliver()
 *
 *   ENGINE_SOURCE=signalr DELIVERY_MODE=http npm run worker
 *   npm run worker:live:signalr:http
 */

import { Telegraf } from "telegraf";
import { config, requireTelegramToken } from "cue/config.js";
import { getRuntime, logRuntimeBanner } from "./runtime.js";
import { deliver, deliverHttp, applyAlertTag } from "cue/delivery.js";
import { loadSubscribers } from "cue/users.js";
import { createPipeline } from "cue/engine/pipeline.js";
import {
  createSignalRMergeState,
  expandSignalRLine,
} from "cue/engine/ingest/signalr.js";
import { logInfo, logWarn, logError } from "cue/log.js";
import { startSignalRCapture } from "./capture-signalr.js";

let runtime = null;
let bot = null;
let usersCache = new Map();
let pipeline = null;
let merge = null;
let messageQueue = Promise.resolve();
let startupBannerSent = false;
let shuttingDown = false;
let signalsHooked = false;
let pitFlushTimer = null;
let signalrStop = null;

async function fanOut(alert) {
  const text = applyAlertTag(alert.text, {
    mqttSource: "signalr",
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
  return runtime && runtime.deliveryMode !== "none";
}

function lifecycleBannerText(kind) {
  const mode = process.env.ENGINE_SESSION_KIND
    ? String(process.env.ENGINE_SESSION_KIND).trim()
    : "auto";
  if (kind === "up") {
    return (
      `🟢 GridWhisper live feed is online\n` +
      `Source: F1 SignalR live · session mode: ${mode}\n` +
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
    stopSignalRWorker(sig)
      .then(() => process.exit(0))
      .catch((e) => {
        logError("Shutdown error:", e.message || e);
        process.exit(1);
      });
  };
  process.once("SIGINT", () => go("SIGINT"));
  process.once("SIGTERM", () => go("SIGTERM"));
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
  pitFlushTimer = setInterval(() => {
    messageQueue = messageQueue
      .then(() => flushPendingPits())
      .catch((e) => logError("Pit flush error:", e));
  }, 500);
  if (typeof pitFlushTimer.unref === "function") pitFlushTimer.unref();
}

async function onSignalRLine(line) {
  for (const ev of expandSignalRLine(line, merge)) {
    const { alerts } = pipeline.push(ev);
    for (const alert of alerts) {
      await emitAlert(alert);
    }
  }
}

export async function startSignalRWorker() {
  runtime = getRuntime();
  logRuntimeBanner(runtime);
  logInfo("📡 ENGINE_SOURCE=signalr (F1 livetiming hub)");

  if (runtime.deliveryMode === "telegram") {
    requireTelegramToken();
    bot = new Telegraf(config.telegramToken);
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
    source: "signalr",
    useLlm: false,
    usePrefs: false,
    minSeverity: config.minSeverity,
  });
  merge = createSignalRMergeState();
  logInfo(
    `🧠 Pipeline domain=${pipeline.domainName} minSeverity=${pipeline.config.minSeverity}`,
  );

  hookLifecycleSignals();
  ensurePitFlushTimer();

  // Live worker owns the hub; capture process is a separate twin for gold files.
  // Prefer noauth unless F1_TOKEN is set (full streams).
  const handle = await startSignalRCapture({
    onMessage: (line) => {
      messageQueue = messageQueue
        .then(() => onSignalRLine(line))
        .catch((e) => logError("SignalR handler error:", e));
    },
    stayAlive: false,
  });
  signalrStop = handle.stop;

  if (!startupBannerSent && !shuttingDown) {
    startupBannerSent = true;
    messageQueue = messageQueue
      .then(() => announceLifecycle("up"))
      .catch((e) => logError("Startup banner error:", e));
  }

  // Stay alive until SIGINT/SIGTERM
  await new Promise(() => {});
}

export async function stopSignalRWorker(reason = "shutdown") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pitFlushTimer) {
    clearInterval(pitFlushTimer);
    pitFlushTimer = null;
  }
  logInfo(`🛑 Stopping SignalR worker (${reason})…`);
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
  if (signalrStop) {
    try {
      await signalrStop();
    } catch {
      /* ignore */
    }
  }
}
