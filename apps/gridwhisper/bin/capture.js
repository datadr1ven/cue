#!/usr/bin/env node
/**
 * Capture OpenF1 MQTT to NDJSON (reconnect-safe append).
 *
 *   npm run capture -- dutch-2026/sq.ndjson
 *   MQTT_SOURCE=live npm run capture -- path/to/session.ndjson
 *   CAPTURE_OUT=dutch-2026/fp2.ndjson npm run capture
 *
 * Survives broker hiccups: same file, exponential reconnect, 5m heartbeats.
 * Ctrl+C to stop cleanly.
 */

import { resolve } from "path";
import { startCapture } from "../src/capture-mqtt.js";
import { logError, logInfo } from "cue/log.js";

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(`captures/mqtt-${stamp}.ndjson`);
}

async function main() {
  const arg = process.argv[2];
  const outPath =
    arg && !arg.startsWith("-")
      ? resolve(arg)
      : process.env.CAPTURE_OUT
        ? resolve(process.env.CAPTURE_OUT)
        : defaultOutPath();

  const mqttSource = (process.env.MQTT_SOURCE || "live").toLowerCase();
  logInfo(`Cue capture starting → ${outPath} (MQTT_SOURCE=${mqttSource})`);
  await startCapture({ outPath, mqttSource });
}

main().catch((err) => {
  logError("Capture failed:", err.message || err);
  process.exit(1);
});
