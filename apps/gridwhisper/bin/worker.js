#!/usr/bin/env node
/**
 * MQTT → Cue pipeline → delivery (http | telegram | log | none)
 *
 *   MQTT_SOURCE=local DELIVERY_MODE=log npm run worker
 *   npm run worker:live:log
 *   # GridWhisper race day (CF fan-out):
 *   DELIVER_URL=… DELIVER_SECRET=… npm run worker:live:http
 *
 * Sends one Telegram banner when the watcher comes online and one when it
 * shuts down (SIGINT/SIGTERM). Disable with LIFECYCLE_BANNERS=off.
 */

import { startMqttWorker } from "../src/mqtt-worker.js";

startMqttWorker().catch((err) => {
  console.error("Worker failed:", err.message || err);
  process.exit(1);
});
