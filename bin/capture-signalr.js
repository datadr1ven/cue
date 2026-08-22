#!/usr/bin/env node
/**
 * Capture raw F1 livetiming SignalR → NDJSON (parallel to OpenF1 MQTT).
 *
 *   npm run capture:signalr -- dutch-2026/signalr-race.ndjson
 *   F1_TOKEN=... npm run capture:signalr -- dutch-2026/signalr-race.ndjson
 *   SIGNALR_TELEMETRY=1 npm run capture:signalr -- dutch-2026/signalr-telem.ndjson
 *
 * Keep the OpenF1 worker/capture running separately. This does not feed Cue.
 * Ctrl+C to stop.
 */

import { resolve } from "path";
import { startSignalRCapture } from "../src/capture-signalr.js";
import { logError, logInfo } from "../src/log.js";

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(`captures/signalr-${stamp}.ndjson`);
}

function parseArgs(argv) {
  const positional = [];
  let telemetry = process.env.SIGNALR_TELEMETRY === "1";
  for (const a of argv) {
    if (a === "--telemetry") telemetry = true;
    else if (!a.startsWith("-")) positional.push(a);
  }
  return { positional, telemetry };
}

async function main() {
  const { positional, telemetry } = parseArgs(process.argv.slice(2));
  const outPath = positional[0]
    ? resolve(positional[0])
    : process.env.CAPTURE_OUT
      ? resolve(process.env.CAPTURE_OUT)
      : defaultOutPath();

  const topicsEnv = process.env.SIGNALR_TOPICS;
  const topics = topicsEnv
    ? topicsEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  logInfo(
    `Cue SignalR capture starting → ${outPath}${telemetry ? " (+telemetry)" : ""}`,
  );
  await startSignalRCapture({ outPath, topics, telemetry });
}

main().catch((err) => {
  logError("SignalR capture failed:", err.message || err);
  process.exit(1);
});
