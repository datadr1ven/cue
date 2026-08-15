/**
 * MQTT → Cue engine → deliver()
 */

import mqtt from "mqtt";
import axios from "axios";
import { Telegraf } from "telegraf";
import { config, requireTelegramToken } from "./config.js";
import { getRuntime, getMqttOptions, logRuntimeBanner } from "./runtime.js";
import { deliver, deliverHttp } from "./delivery.js";
import { loadSubscribers } from "./users.js";
import { createPipeline } from "./engine/pipeline.js";
import { expandOpenF1Line } from "./engine/ingest/openf1.js";

export const MQTT_TOPICS = [
  "v1/drivers",
  "v1/position",
  "v1/pit",
  "v1/stints",
  "v1/race_control",
  "v1/weather",
  "v1/team_radio",
  "v1/session_result",
  "v1/starting_grid",
  "v1/sessions",
  "v1/meetings",
  "v1/laps", // quali session-best
];

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
  console.log("✅ OpenF1 token ok");
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
    console.warn(`⚠️ Many reconnects — cap ${maxReconnectDelay}ms`);
  }
  console.log(`🔄 Reconnect in ${delay}ms (attempt ${reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startMqttWorker().catch((e) => {
      console.error("Reconnect failed:", e.message);
      scheduleReconnect();
    });
  }, delay);
}

async function fanOut(alert) {
  if (runtime.deliveryMode === "http") {
    const r = await deliverHttp(alert.text);
    if (r.ok) {
      console.log(
        `[deliver:http] → ${r.delivered ?? "?"}/${r.total ?? "?"} subscribers`,
      );
    } else {
      console.error(`[deliver:http] failed: ${r.reason} ${r.error || ""}`);
    }
    return;
  }

  if (runtime.deliveryMode === "log" || runtime.deliveryMode === "none") {
    await deliver(bot, runtime, 0, alert.text);
    return;
  }

  const users = [...usersCache.values()];
  if (users.length === 0) {
    console.log(`[no-subscribers] ${alert.text.replace(/\n/g, " | ")}`);
    return;
  }
  for (const user of users) {
    await deliver(bot, runtime, user.user_id, alert.text);
  }
}

async function onMessage(topic, buf) {
  let payload;
  try {
    payload = JSON.parse(buf.toString());
  } catch {
    return;
  }
  const line = {
    topic,
    payload,
    receivedAt: new Date().toISOString(),
    source: "mqtt",
  };
  for (const ev of expandOpenF1Line(line)) {
    const { alerts } = pipeline.push(ev);
    for (const alert of alerts) {
      const ts = alert.moment.t
        ? String(alert.moment.t).slice(11, 19)
        : new Date().toISOString().slice(11, 19);
      console.log(
        `⚡ ${ts} [${alert.moment.severity}] ${alert.moment.type} ${alert.text.replace(/\n/g, " | ")}`,
      );
      await fanOut(alert);
    }
  }
}

export async function startMqttWorker() {
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
    console.log("👥 Subscribers: managed by CF Worker KV (POST /deliver)");
    usersCache = new Map();
  } else if (runtime.deliveryMode === "telegram") {
    usersCache = loadSubscribers();
    console.log(`👥 Subscribers: ${usersCache.size} (local file)`);
  } else {
    usersCache = new Map();
    console.log(`👥 Subscribers: n/a (DELIVERY_MODE=${runtime.deliveryMode})`);
  }

  pipeline = createPipeline({
    domain: config.engineDomain,
    source: "mqtt",
    useLlm: false,
    usePrefs: false,
    minSeverity: config.minSeverity,
  });
  console.log(
    `🧠 Pipeline domain=${pipeline.domainName} minSeverity=${pipeline.config.minSeverity}`,
  );

  intentionalDisconnect = false;
  clearReconnectTimer();

  if (runtime.mqttSource === "live") {
    globalToken = await fetchToken();
  }

  const options = getMqttOptions(runtime, globalToken);
  console.log(
    `🚀 MQTT ${options.protocol}://${options.host}:${options.port}`,
  );
  client = mqtt.connect(options);

  client.on("connect", () => {
    console.log("✅ MQTT connected");
    isConnected = true;
    reconnectAttempts = 0;
    client.subscribe(MQTT_TOPICS, { qos: 1 }, (err) => {
      if (err) console.error("Subscribe error:", err);
      else console.log("✅ Subscribed:", MQTT_TOPICS.join(", "));
    });
  });

  client.on("message", (topic, message) => {
    messageQueue = messageQueue
      .then(() => onMessage(topic, message))
      .catch((e) => console.error("Handler error:", e));
  });

  client.on("error", (err) => console.error("MQTT error:", err.message));
  client.on("close", () => {
    isConnected = false;
    if (!intentionalDisconnect) {
      console.warn("MQTT closed");
      scheduleReconnect();
    }
  });
}

export function refreshSubscribers() {
  usersCache = loadSubscribers();
  return usersCache.size;
}
