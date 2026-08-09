#!/usr/bin/env node
/**
 * MQTT → Cue pipeline → delivery (telegram | log | none)
 *
 *   MQTT_SOURCE=local DELIVERY_MODE=log npm run worker
 *   npm run worker:live:log
 *   npm run worker:live
 */

import { startMqttWorker } from "../src/mqtt-worker.js";

startMqttWorker().catch((err) => {
  console.error("Worker failed:", err.message || err);
  process.exit(1);
});
