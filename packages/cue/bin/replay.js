#!/usr/bin/env node
/**
 * Offline NDJSON → engine → stdout
 *
 *   npm run replay -- path/to/session.ndjson
 *   npm run replay -- path/to/signalr.ndjson --signalr
 *   npm run replay -- path/to/session.ndjson --min-severity 7
 *   npm run replay -- path/to/session.ndjson --json
 *   ENGINE_SESSION_KIND=race npm run replay -- path/to/race.ndjson
 *   npm run replay -- path/to/race.ndjson --session-kind race
 *
 * Without --session-kind / ENGINE_SESSION_KIND, F1 may guess practice/quali/race
 * from duration — that guess is brittle. Live session-ctl always forces kind.
 */

import { resolve } from "path";
import { createPipeline } from "../src/engine/pipeline.js";
import { readNdjsonEvents } from "../src/engine/ingest/ndjson.js";

function parseArgs(argv) {
  const args = {
    file: null,
    minSeverity: 6,
    json: false,
    mode: "auto",
    sessionKind: process.env.ENGINE_SESSION_KIND || null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--signalr") args.mode = "signalr";
    else if (a === "--openf1") args.mode = "openf1";
    else if (a === "--min-severity") args.minSeverity = Number(argv[++i]);
    else if (a.startsWith("--min-severity="))
      args.minSeverity = Number(a.split("=")[1]);
    else if (a === "--session-kind") args.sessionKind = argv[++i];
    else if (a.startsWith("--session-kind="))
      args.sessionKind = a.split("=")[1];
    else if (!a.startsWith("-")) args.file = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    console.error(
      "Usage: npm run replay -- <capture.ndjson> [--signalr|--openf1] [--min-severity N] [--session-kind race|practice|qualifying|…] [--json]\n" +
        "  (or set ENGINE_SESSION_KIND — same as live session-ctl)",
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
    sessionKind: args.sessionKind || undefined,
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

  for await (const ev of readNdjsonEvents(file, { mode: args.mode })) {
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
