#!/usr/bin/env node
/**
 * Backfill the public Pages feed from a local webcast run archive.
 *
 * Uses Worker POST /suggest with mode=feed (no Telegram fan-out).
 * Prefers vision-ranked stills when available; falls back to frames/<action>.jpg.
 *
 *   npm run webcast:feed-backfill -- --run-dir tplus-webcast/runs/<id>
 *   npm run webcast:feed-backfill -- --run-dir …/flight-14 --run-dir …/starlink-15-27
 *
 * Env: TPLUS_SUGGEST_URL, TPLUS_SUGGEST_SECRET (same as webcast:live)
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { config as dotenv } from "dotenv";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REPO_ROOT = resolve(APP_ROOT, "../..");
dotenv({ path: join(REPO_ROOT, ".env") });

function parseArgs(argv) {
  const out = {
    runDirs: [],
    dryRun: false,
    freshTimestamps: true,
    preferVision: true,
    delayMs: 250,
    actions: null, // null = all suggests
  };
  const a = [...argv];
  while (a.length) {
    const x = a.shift();
    if (x === "--run-dir") out.runDirs.push(a.shift());
    else if (x === "--dry-run") out.dryRun = true;
    else if (x === "--historical-timestamps") out.freshTimestamps = false;
    else if (x === "--emit-frames-only") out.preferVision = false;
    else if (x === "--delay-ms") out.delayMs = Number(a.shift()) || 250;
    else if (x === "--actions")
      out.actions = String(a.shift() || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (x === "--help" || x === "-h") out.help = true;
    else {
      console.error(`unknown arg: ${x}`);
      out.help = true;
    }
  }
  return out;
}

function usage() {
  console.log(`Usage:
  webcast:feed-backfill --run-dir <path> [--run-dir <path> ...]
    [--dry-run] [--historical-timestamps] [--emit-frames-only]
    [--actions liftoff,seco,...] [--delay-ms 250]

Posts mode=feed suggests with stills. No Telegram. Updates t-plus.pages.dev feed.`);
}

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function findPython() {
  const candidates = [
    join(REPO_ROOT, ".venv-webcast/bin/python"),
    join(REPO_ROOT, ".venv/bin/python"),
    "python3",
  ];
  for (const c of candidates) {
    if (c === "python3" || existsSync(c)) return c;
  }
  return "python3";
}

/**
 * Prefer eval_enrich top pick under vision/frames; else emit still; else mid vision frame.
 */
function pickStill(runDir, actionId, preferVision) {
  const emit = join(runDir, "frames", `${actionId}.jpg`);
  const visionDir = join(runDir, "vision", "frames");
  if (preferVision && existsSync(visionDir)) {
    const evalPy = join(APP_ROOT, "src/webcast/vision/eval_enrich.py");
    const py = findPython();
    if (existsSync(evalPy)) {
      const r = spawnSync(
        py,
        [evalPy, "--run-dir", runDir, "--action", actionId, "--top", "1"],
        { encoding: "utf8", timeout: 120_000 },
      );
      if (r.status === 0) {
        try {
          const doc = JSON.parse(r.stdout);
          const path = doc?.pick?.path;
          if (path && existsSync(path)) return path;
        } catch {
          /* fall through */
        }
      }
    }
    const files = readdirSync(visionDir)
      .filter(
        (f) =>
          f.toLowerCase().startsWith(actionId.toLowerCase() + "_") &&
          /\.(jpe?g|png|webp)$/i.test(f),
      )
      .sort();
    if (files.length) {
      return join(visionDir, files[Math.floor(files.length / 2)]);
    }
  }
  if (existsSync(emit)) return emit;
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postSuggest(url, secret, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(`suggest ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

function collectEvents(runDir, actionsFilter) {
  const suggestDir = join(runDir, "suggest");
  if (!existsSync(suggestDir)) return [];
  const events = [];
  for (const name of readdirSync(suggestDir)) {
    if (!name.endsWith(".json")) continue;
    const doc = loadJson(join(suggestDir, name));
    const req = doc.request || {};
    const actionId = req.actionId || name.replace(/\.json$/, "");
    if (actionsFilter && !actionsFilter.includes(actionId)) continue;
    events.push({
      wall: doc.t || null,
      actionId,
      label: req.label || actionId,
      scriptTPlusSec:
        req.scriptTPlusSec != null && Number.isFinite(Number(req.scriptTPlusSec))
          ? Number(req.scriptTPlusSec)
          : null,
      missionName: req.missionName || null,
    });
  }
  events.sort((a, b) => {
    const ta = a.scriptTPlusSec ?? 1e12;
    const tb = b.scriptTPlusSec ?? 1e12;
    if (ta !== tb) return ta - tb;
    return String(a.wall || "").localeCompare(String(b.wall || ""));
  });
  return events;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.runDirs.length) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const suggestUrl =
    process.env.TPLUS_SUGGEST_URL ||
    process.env.TPLUS_FEED_URL ||
    "";
  const secret = process.env.TPLUS_SUGGEST_SECRET || "";
  if (!args.dryRun && (!suggestUrl || !secret)) {
    console.error("Need TPLUS_SUGGEST_URL and TPLUS_SUGGEST_SECRET in .env");
    process.exit(1);
  }

  let posted = 0;
  let skipped = 0;
  // Stagger "fresh" timestamps so feed order is stable if sorted by t
  let freshBase = Date.now() - args.runDirs.length * 60_000;

  for (const raw of args.runDirs) {
    const runDir = resolve(raw);
    if (!existsSync(runDir)) {
      console.error(`missing run-dir: ${runDir}`);
      process.exit(1);
    }
    const events = collectEvents(runDir, args.actions);
    console.log(
      `[backfill] ${basename(runDir)}: ${events.length} milestones (vision=${args.preferVision})`,
    );

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const still = pickStill(runDir, ev.actionId, args.preferVision);
      if (!still) {
        console.warn(`  skip ${ev.actionId}: no still`);
        skipped++;
        continue;
      }
      const imageBase64 = readFileSync(still).toString("base64");
      const t = args.freshTimestamps
        ? new Date(freshBase + posted * 2000).toISOString()
        : ev.wall;
      const body = {
        mode: "feed",
        actionId: ev.actionId,
        label: ev.label,
        scriptTPlusSec: ev.scriptTPlusSec,
        missionName: ev.missionName,
        imageBase64,
        t,
      };
      console.log(
        `  ${ev.actionId} ← ${still.replace(runDir + "/", "")} (${Math.round(imageBase64.length / 1024)}kb b64)`,
      );
      if (args.dryRun) {
        posted++;
        continue;
      }
      const res = await postSuggest(suggestUrl, secret, body);
      console.log(
        `    → delivered=${res.delivered} image=${Boolean(res.imageUrl)} mode=${res.mode}`,
      );
      posted++;
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
    freshBase += 60_000;
  }

  console.log(
    JSON.stringify(
      { ok: true, posted, skipped, dryRun: args.dryRun },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
