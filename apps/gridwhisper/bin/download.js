#!/usr/bin/env node
/**
 * Download OpenF1 historical session → capture-shaped NDJSON.
 *
 *   npm run download -- <session_key>
 *   npm run download -- 11348 --out dutch-2026/sprint-downloaded.ndjson
 *
 * Free historical REST (no MQTT). Replay with:
 *   ENGINE_SESSION_KIND=sprint npm run replay -- 11348-downloaded.ndjson
 */

import { resolve } from "path";
import { downloadSession } from "../src/download-session.js";
import { logError, logInfo } from "cue/log.js";

function parseArgs(argv) {
  /** @type {{ sessionKey: string|null, out: string|null }} */
  const out = { sessionKey: null, out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a === "-o") {
      out.out = argv[++i];
    } else if (a.startsWith("--out=")) {
      out.out = a.slice(6);
    } else if (!a.startsWith("-") && !out.sessionKey) {
      out.sessionKey = a;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.sessionKey) {
    console.error(
      "Usage: npm run download -- <session_key> [--out path.ndjson]",
    );
    process.exit(2);
  }

  const outPath = args.out
    ? resolve(args.out)
    : resolve(`${args.sessionKey}-downloaded.ndjson`);

  logInfo(`Cue download session_key=${args.sessionKey}`);
  const result = await downloadSession(args.sessionKey, { outPath });
  logInfo(
    `Done · ${result.count} lines · replay with:\n  npm run replay -- ${result.outPath}`,
  );
}

main().catch((err) => {
  logError("Download failed:", err.message || err);
  process.exit(1);
});
