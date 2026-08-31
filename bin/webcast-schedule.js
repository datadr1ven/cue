#!/usr/bin/env node
/**
 * Schedule-driven TPlus suggestions from a locked webcast clock.
 *
 * 1) OCR-lock liftoff file offset (or pass --liftoff-file-sec)
 * 2) Walk mission script milestones
 * 3) POST each to CF TPlus /suggest for admin Approve / Dismiss
 *
 *   # Liftoff at file 300s; start watching from the beginning of the tape:
 *   npm run webcast:schedule -- \
 *     --video /tmp/roman-window.mp4 --mission roman-fh \
 *     --liftoff-file-sec 300 --sync-file-t 0 --play \
 *     --suggest-url … --suggest-secret …
 *
 *   # If --sync-file-t equals liftoff file time, you are already at T+0
 *   # (suggests fire immediately) — that is intentional.
 *
 * Dry run (no Telegram):
 *   npm run webcast:schedule -- --video … --mission roman-fh --dry-run
 */

import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { logError, logInfo, logWarn } from "../src/log.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OCR_PY = join(ROOT, "src/webcast/ocr_clock.py");
const DEFAULT_PYTHON = join(ROOT, ".venv-webcast/bin/python");

function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const out = {
    video: null,
    mission: "roman-fh",
    python: process.env.WEBCAST_PYTHON || DEFAULT_PYTHON,
    lockFrom: 100,
    lockTo: 400,
    lockEvery: 40,
    liftoffFileSec: null,
    syncFileT: null,
    leadSec: 0,
    fromTPlus: null,
    toTPlus: null,
    dryRun: false,
    suggestUrl: process.env.TPLUS_SUGGEST_URL || null,
    suggestSecret: process.env.TPLUS_SUGGEST_SECRET || null,
    once: false,
    play: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--video") out.video = next();
    else if (a === "--mission") out.mission = next();
    else if (a === "--python") out.python = next();
    else if (a === "--lock-from") out.lockFrom = Number(next());
    else if (a === "--lock-to") out.lockTo = Number(next());
    else if (a === "--lock-every") out.lockEvery = Number(next());
    else if (a === "--liftoff-file-sec") out.liftoffFileSec = Number(next());
    else if (a === "--sync-file-t") out.syncFileT = Number(next());
    else if (a === "--lead-sec") out.leadSec = Number(next());
    else if (a === "--from-tplus") out.fromTPlus = Number(next());
    else if (a === "--to-tplus") out.toTPlus = Number(next());
    else if (a === "--suggest-url") out.suggestUrl = next();
    else if (a === "--suggest-secret") out.suggestSecret = next();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--once") out.once = true;
    else if (a === "--play") out.play = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  webcast-schedule --video <mp4> --mission <id> [options]

Clock lock (where T+0 is on the file timeline):
  --lock-from/--lock-to/--lock-every   OCR sample window (default 100–400 / 40s)
  --liftoff-file-sec N                 Skip OCR; file offset of liftoff (T+0)

Playback sync (where you are NOW on that file timeline):
  --sync-file-t N   Wall-clock "now" corresponds to this file second.
                    Mission T+ = (syncFileT - liftoffFileSec), then advances
                    with wall time. Default: lock window start (NOT 0).

  Example: liftoff at file 300s, start at beginning of tape:
    --liftoff-file-sec 300 --sync-file-t 0 --play
    → you are at T−5:00; liftoff suggest in ~5 minutes of wall clock.

  Anti-example: --sync-file-t 300 with liftoff at 300 → already T+0
    (first suggest fires immediately).

  --play            Open ffplay at --sync-file-t (realtime) alongside schedule

Emit:
  --lead-sec N      Fire suggest this many seconds before script T+ (default 0)
  --from-tplus N    Skip milestones before this T+
  --to-tplus N      Stop after this T+
  --once            Emit currently-due milestones only (no sleep) — testing
  --dry-run         Print suggests only

Telegram (CF TPlus):
  --suggest-url URL
  --suggest-secret SECRET
  (or env TPLUS_SUGGEST_URL / TPLUS_SUGGEST_SECRET)
`);
}

function formatMissionClock(tPlusSec) {
  const sign = tPlusSec < 0 ? "-" : "+";
  const a = Math.abs(Math.round(tPlusSec));
  const m = Math.floor(a / 60);
  const s = a % 60;
  return `T${sign}${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Start ffplay at file offset; returns ChildProcess or null.
 * @param {string} video
 * @param {number} startSec
 */
function startFfplay(video, startSec) {
  if (!existsSync(video)) return null;
  // -ss before -i: fast seek; -autoexit when done
  const child = spawn(
    "ffplay",
    [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-autoexit",
      "-ss",
      String(Math.max(0, startSec)),
      video,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  child.on("error", (err) => {
    logWarn(`ffplay failed (${err.message}) — install ffmpeg/ffplay or omit --play`);
  });
  return child;
}

function resolveMissionPath(ref) {
  const s = String(ref || "").trim();
  const candidates = [
    s,
    resolve(s),
    join(ROOT, "missions/flights", `${s}-script.json`),
    join(ROOT, "missions/flights", `${s}.json`),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(`mission not found: ${ref}`);
}

function runOcrLock({ python, video, lockFrom, lockTo, lockEvery }) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      OCR_PY,
      "--video",
      video,
      "--from",
      String(lockFrom),
      "--to",
      String(lockTo),
      "--every",
      String(lockEvery),
      "--lock",
    ];
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ocr_clock --lock exited ${code}`));
        return;
      }
      const line = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      try {
        resolvePromise(JSON.parse(line));
      } catch (e) {
        reject(new Error(`bad lock JSON: ${line?.slice(0, 200)}`));
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} lock
 * @param {{ syncFileT: number, syncWallMs: number }} sync
 */
function missionTPlusNow(lock, sync) {
  const fileNow =
    sync.syncFileT + (Date.now() - sync.syncWallMs) / 1000;
  return fileNow - lock.liftoffFileSec;
}

async function postSuggest(url, secret, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
      "X-Suggest-Secret": secret,
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
    throw new Error(`suggest HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return json || { ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.video) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!existsSync(args.video)) {
    throw new Error(`video not found: ${args.video}`);
  }
  if (!args.dryRun) {
    if (!args.suggestUrl || !args.suggestSecret) {
      throw new Error(
        "Need --suggest-url and --suggest-secret (or dry-run). Set TPLUS_SUGGEST_* env.",
      );
    }
  }

  const missionPath = resolveMissionPath(args.mission);
  const scriptDoc = JSON.parse(readFileSync(missionPath, "utf8"));
  const script = Array.isArray(scriptDoc.script) ? scriptDoc.script : [];
  if (!script.length) throw new Error("mission has empty script[]");

  let lock;
  if (args.liftoffFileSec != null && Number.isFinite(args.liftoffFileSec)) {
    lock = {
      ok: true,
      method: "manual",
      liftoffFileSec: args.liftoffFileSec,
      spreadSec: 0,
      hitCount: 0,
      fuse: { sources: ["manual"], todo: ["ocr_clock", "asr_phrase_hits"] },
    };
    logInfo(`Clock lock (manual): liftoff @ file ${lock.liftoffFileSec}s`);
  } else {
    if (!existsSync(args.python)) {
      throw new Error(`Python not found: ${args.python}`);
    }
    logInfo(
      `OCR clock lock ${args.lockFrom}→${args.lockTo}s every ${args.lockEvery}s…`,
    );
    lock = await runOcrLock({
      python: args.python,
      video: resolve(args.video),
      lockFrom: args.lockFrom,
      lockTo: args.lockTo,
      lockEvery: args.lockEvery,
    });
    if (!lock?.ok) throw new Error(lock?.error || "clock lock failed");
    logInfo(
      `Clock lock (OCR): liftoff @ file ${lock.liftoffFileSec.toFixed(1)}s · hits=${lock.hitCount} · spread=${lock.spreadSec?.toFixed?.(1) ?? lock.spreadSec}s`,
    );
    if (lock.spreadSec > 45) {
      logWarn(
        "OCR liftoff estimates are spread >45s — consider more samples or --liftoff-file-sec",
      );
    }
  }

  // Default sync = start of tape (file 0). Pass --sync-file-t if you're
  // mid-playback. (Older default was lockFrom, which made "just locked"
  // runs look like they skipped the countdown.)
  const syncFileT =
    args.syncFileT != null && Number.isFinite(args.syncFileT)
      ? args.syncFileT
      : 0;
  const sync = { syncFileT, syncWallMs: Date.now() };
  const tNow = missionTPlusNow(lock, sync);
  const untilLiftoff = lock.liftoffFileSec - syncFileT;
  logInfo(
    `Sync: wall now = file t=${syncFileT}s → mission ${formatMissionClock(tNow)}` +
      (untilLiftoff > 0
        ? ` · liftoff in ~${untilLiftoff.toFixed(0)}s wall-clock`
        : untilLiftoff < 0
          ? ` · already ${formatMissionClock(tNow)} past liftoff`
          : ` · at liftoff`),
  );
  if (Math.abs(syncFileT - lock.liftoffFileSec) < 1) {
    logWarn(
      "sync-file-t ≈ liftoff-file-sec → you are at T+0; first milestones fire immediately. " +
        "To replay from T−5:00 with liftoff at file 300s, use --sync-file-t 0 --liftoff-file-sec 300",
    );
  }
  logInfo(
    `Mission ${scriptDoc.missionId || args.mission} · ${script.length} milestones · dryRun=${args.dryRun}`,
  );

  /** @type {import('child_process').ChildProcess|null} */
  let player = null;
  if (args.play) {
    logInfo(`Playing video from file t=${syncFileT}s (ffplay)…`);
    player = startFfplay(resolve(args.video), syncFileT);
  }

  /** @type {object[]} */
  const due = [];
  for (const row of script) {
    if (row?.actionId == null || row.tPlusSec == null) continue;
    const tPlus = Number(row.tPlusSec);
    if (!Number.isFinite(tPlus)) continue;
    if (args.fromTPlus != null && tPlus < args.fromTPlus) continue;
    if (args.toTPlus != null && tPlus > args.toTPlus) continue;
    due.push({
      actionId: row.actionId,
      label: row.label || row.actionId,
      scriptTPlusSec: tPlus,
      fireAtTPlus: tPlus - (Number(args.leadSec) || 0),
    });
  }
  due.sort((a, b) => a.fireAtTPlus - b.fireAtTPlus);

  for (const ev of due) {
    const body = {
      actionId: ev.actionId,
      label: ev.label,
      scriptTPlusSec: ev.scriptTPlusSec,
      missionId: scriptDoc.missionId || null,
      evidence: {
        sources: ["schedule", ...(lock.fuse?.sources || [])],
        clockLock: {
          method: lock.method,
          liftoffFileSec: lock.liftoffFileSec,
          spreadSec: lock.spreadSec ?? null,
          hitCount: lock.hitCount ?? null,
        },
        // Future fusion hooks (ASR phrase near window, plume, HUD arc label)
        todo: lock.fuse?.todo || [
          "asr_phrase_hits",
          "plume_liftoff_vision",
          "hud_event_labels",
        ],
      },
    };

    let now = missionTPlusNow(lock, sync);
    let wait = ev.fireAtTPlus - now;

    if (args.once && wait > 0) {
      logInfo(
        `skip T+${ev.scriptTPlusSec} ${ev.actionId} (not due for ${wait.toFixed(0)}s)`,
      );
      continue;
    }

    if (!args.once && !args.dryRun) {
      while (wait > 0) {
        logInfo(
          `waiting ${wait.toFixed(0)}s for T+${ev.scriptTPlusSec} ${ev.label}…`,
        );
        await sleep(Math.min(wait, 5) * 1000);
        now = missionTPlusNow(lock, sync);
        wait = ev.fireAtTPlus - now;
      }
    }

    if (args.dryRun) {
      console.log(
        JSON.stringify({ type: "suggest", ...body, waitSec: Math.max(0, wait) }),
      );
      continue;
    }

    const r = await postSuggest(args.suggestUrl, args.suggestSecret, body);
    logInfo(
      `suggest T+${ev.scriptTPlusSec} ${ev.actionId} → ${r?.id || "ok"} (approve in Telegram)`,
    );
  }

  logInfo("Schedule complete.");
  if (player && !player.killed) {
    try {
      player.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exit(1);
});
