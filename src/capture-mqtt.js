/**
 * Hardened OpenF1 MQTT → NDJSON capture.
 * Survives broker drops (reconnect + same file append) with heartbeats.
 */

import mqtt from "mqtt";
import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { getMqttOptions } from "./runtime.js";
import { captureTopics, CAPTURE_EXTRA_TOPICS } from "./mqtt-topics.js";
import { logInfo, logWarn, logError } from "./log.js";

export { captureTopics, CAPTURE_EXTRA_TOPICS };

const maxReconnectAttemptsBeforeSlow = 10;
const baseReconnectDelay = 1000;
const maxReconnectDelay = 5 * 60 * 1000;
const HEARTBEAT_MS = 5 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.outPath - NDJSON path (created/appended)
 * @param {'live'|'local'} [opts.mqttSource]
 * @param {number} [opts.heartbeatMs]
 */
export async function startCapture(opts) {
  const outPath = path.resolve(opts.outPath);
  const mqttSource = opts.mqttSource || process.env.MQTT_SOURCE || "live";
  if (mqttSource !== "live" && mqttSource !== "local") {
    throw new Error('mqttSource must be "live" or "local"');
  }
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const topics = captureTopics();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const stream = fs.createWriteStream(outPath, { flags: "a" });

  let client = null;
  let token = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let intentionalDisconnect = false;
  let shuttingDown = false;
  let lineCount = 0;
  let lastTopic = null;
  let lastRecvAt = null;
  let heartbeatTimer = null;
  let writeQueue = Promise.resolve();

  async function fetchToken() {
    const username = config.openf1Username || process.env.OPENF1_USERNAME;
    const password = config.openf1Password || process.env.OPENF1_PASSWORD;
    if (!username || !password) {
      throw new Error(
        "OPENF1_USERNAME / OPENF1_PASSWORD required for MQTT_SOURCE=live capture",
      );
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
    if (intentionalDisconnect || shuttingDown) return;
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
      connect().catch((e) => {
        logError("Reconnect failed:", e.message || e);
        scheduleReconnect();
      });
    }, delay);
  }

  function writeLine(obj) {
    writeQueue = writeQueue
      .then(
        () =>
          new Promise((resolve, reject) => {
            const ok = stream.write(`${JSON.stringify(obj)}\n`, (err) => {
              if (err) reject(err);
              else resolve();
            });
            if (!ok) stream.once("drain", resolve);
          }),
      )
      .catch((e) => logError("Write error:", e.message || e));
  }

  async function connect() {
    if (shuttingDown) return;
    intentionalDisconnect = false;
    clearReconnectTimer();

    if (client) {
      try {
        client.removeAllListeners();
        client.end(true);
      } catch {
        /* ignore */
      }
      client = null;
    }

    if (mqttSource === "live") {
      token = await fetchToken();
    }

    const options = getMqttOptions({ mqttSource }, token);
    logInfo(`🚀 Capture MQTT ${options.protocol}://${options.host}:${options.port}`);
    logInfo(`📁 Appending → ${outPath}`);
    client = mqtt.connect(options);

    client.on("connect", () => {
      logInfo("✅ MQTT connected");
      reconnectAttempts = 0;
      client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) logError("Subscribe error:", err);
        else logInfo("✅ Subscribed:", topics.join(", "));
      });
    });

    client.on("message", (topic, buf) => {
      let payload;
      try {
        payload = JSON.parse(buf.toString());
      } catch (e) {
        logError("Parse error:", e.message || e);
        return;
      }
      const receivedAt = new Date().toISOString();
      lineCount += 1;
      lastTopic = topic;
      lastRecvAt = receivedAt;
      writeLine({ topic, payload, receivedAt, source: "mqtt-capture" });
    });

    client.on("error", (err) => logError("MQTT error:", err.message || err));
    client.on("close", () => {
      if (!intentionalDisconnect && !shuttingDown) {
        logWarn("MQTT closed");
        scheduleReconnect();
      }
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      logInfo(
        `💓 still capturing · lines=${lineCount}` +
          (lastRecvAt ? ` · last=${lastRecvAt}` : "") +
          (lastTopic ? ` · topic=${lastTopic}` : ""),
      );
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  async function stop(reason = "shutdown") {
    if (shuttingDown) return;
    shuttingDown = true;
    intentionalDisconnect = true;
    clearReconnectTimer();
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    logInfo(`🛑 Stopping capture (${reason})… lines=${lineCount} → ${outPath}`);
    try {
      await writeQueue;
    } catch {
      /* ignore */
    }
    if (client) {
      try {
        client.end(true);
      } catch {
        /* ignore */
      }
      client = null;
    }
    await new Promise((resolve) => stream.end(resolve));
  }

  process.once("SIGINT", () => {
    stop("SIGINT")
      .then(() => process.exit(0))
      .catch((e) => {
        logError("Shutdown error:", e.message || e);
        process.exit(1);
      });
  });
  process.once("SIGTERM", () => {
    stop("SIGTERM")
      .then(() => process.exit(0))
      .catch((e) => {
        logError("Shutdown error:", e.message || e);
        process.exit(1);
      });
  });

  startHeartbeat();
  await connect();

  return { stop, outPath, getLineCount: () => lineCount };
}
