#!/usr/bin/env node
/**
 * Offline NDJSON → engine → stdout
 *
 *   npm run replay -- path/to/session.ndjson
 *   npm run replay -- path/to/session.ndjson --min-severity 7
 *   npm run replay -- path/to/session.ndjson --json
 */

import { resolve } from "path";
import { createPipeline } from "../src/engine/pipeline.js";
import { readNdjsonEvents } from "../src/engine/ingest/ndjson.js";

function parseArgs(argv) {
  const args = { file: null, minSeverity: 6, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
    else if (a.startsWith("--min-severity="))
      args.minSeverity = Number(a.split("=")[1]);
    else if (!a.startsWith("-")) args.file = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error(
      "Usage: npm run replay -- <capture.ndjson> [--min-severity N] [--json]",
    );
    process.exit(2);
  }

  const file = resolve(args.file);
  const pipeline = createPipeline({
    domain: "f1",
    source: "ndjson",
    useLlm: false,
    usePrefs: false,
    minSeverity: args.minSeverity,
  });

  let events = 0;
  let alerts = 0;
  const byType = {};

  function printAlert(alert) {
    alerts += 1;
    byType[alert.moment.type] = (byType[alert.moment.type] || 0) + 1;
    if (args.json) {
      console.log(
        JSON.stringify({
          t: alert.moment.t,
          type: alert.moment.type,
          severity: alert.moment.severity,
          text: alert.text,
        }),
      );
    } else {
      const ts = alert.moment.t
        ? String(alert.moment.t).slice(11, 19)
        : "??:??:??";
      console.log(
        `${ts}  [${alert.moment.severity}] ${alert.moment.type.padEnd(22)} ${alert.text.replace(/\n/g, " | ")}`,
      );
    }
  }

  for await (const ev of readNdjsonEvents(file)) {
    events += 1;
    const { alerts: batch } = pipeline.push(ev);
    for (const alert of batch) printAlert(alert);
  }

  // Offline: force-expire any pit still waiting on a stint compound
  if (typeof pipeline.flushPending === "function") {
    const { alerts: rest } = pipeline.flushPending(Date.now() + 60_000);
    for (const alert of rest) printAlert(alert);
  }

  if (!args.json) {
    console.error("---");
    console.error(`alerts=${alerts} active_events=${events} file=${file}`);
    console.error(
      "by_type:",
      Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
