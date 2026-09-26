#!/usr/bin/env node
/**
 * Live GridWhisper worker — OpenF1 MQTT or F1 SignalR → Cue pipeline → delivery
 *
 *   ENGINE_SOURCE=openf1 MQTT_SOURCE=live DELIVERY_MODE=http npm run worker
 *   ENGINE_SOURCE=signalr DELIVERY_MODE=http npm run worker
 *
 *   npm run worker:live:http              # OpenF1 (default)
 *   npm run worker:live:signalr:http      # SignalR
 *
 * Sends one Telegram banner when the watcher comes online and one when it
 * shuts down (SIGINT/SIGTERM). Disable with LIFECYCLE_BANNERS=off.
 */

import { startMqttWorker } from "../src/mqtt-worker.js";
import { startSignalRWorker } from "../src/signalr-worker.js";

const feed = String(process.env.ENGINE_SOURCE || "openf1")
  .trim()
  .toLowerCase();

const starter =
  feed === "signalr" ? startSignalRWorker : startMqttWorker;

if (feed !== "signalr" && feed !== "openf1" && feed !== "mqtt" && feed !== "ndjson") {
  console.warn(
    `ENGINE_SOURCE=${feed} not openf1|signalr — defaulting to OpenF1 MQTT`,
  );
}

starter().catch((err) => {
  console.error("Worker failed:", err.message || err);
  process.exit(1);
});
