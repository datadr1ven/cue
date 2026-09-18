#!/usr/bin/env node
/**
 * Always-on webcast consumer (GridWhisper-style) for TPlus.
 *
 * Park on a broadcast URL (or replay a --video), OCR the mission clock
 * (hold-aware), optionally ASR every ~10s, and POST /suggest when the
 * mission script says a milestone is due.
 *
 *   --mode test  → fan-out to admins only (default, safe for rehearsal)
 *   --mode ops   → fan-out to all subscribers
 *
 *   npm run webcast:live -- --ll2-id <uuid> --mode ops
 *   npm run webcast:live -- --ll2-search 'O3b mPower' --mode test
 *   npm run webcast:live -- --mission o3b-mpower-f --mode test
 *   npm run webcast:live -- --video /tmp/roman-window.mp4 --mission roman-fh --play --dry-run
 *
 * If --url/--video omitted, uses LL2 Official Webcast or mission webcastUrl.
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
// Side effect: load monorepo-root .env into process.env
import "cue/config.js";
import { logError, logInfo, logWarn } from "cue/log.js";
import {
  matchPhrases,
  normalizePhraseBook,
  gateHitAgainstScript,
  scriptTPlusByAction,
} from "../src/webcast/match.js";
import {
  uploadTelegramFile,
  deleteTelegramMessage,
  sendTelegramText,
} from "../src/webcast/tg-upload.js";
import { loadScriptDocFromLl2 } from "../src/missions/ll2.js";
import { createRunArchive } from "../src/webcast/run-archive.js";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Monorepo root (apps/tplus → ../..) — .venv-webcast lives here */
const REPO_ROOT = resolve(APP_ROOT, "../..");
const ROOT = APP_ROOT;
const OCR_PY = join(ROOT, "src/webcast/ocr_clock.py");
const ASR_PY = join(ROOT, "src/webcast/asr_whisper.py");
const DEFAULT_PYTHON = join(REPO_ROOT, ".venv-webcast/bin/python");
const PHRASES_FALCON = join(ROOT, "src/webcast/phrases/falcon-default.json");

function parseArgs(argv) {
  const out = {
    url: null,
    video: null,
    mission: null, // file id / path; optional when --ll2-* set
    ll2Id: null,
    ll2Slug: null,
    ll2Search: null,
    requireOfficialWebcast: true,
    python: process.env.WEBCAST_PYTHON || DEFAULT_PYTHON,
    pollSec: 45,
    ocrEverySec: 5,
    asrEverySec: 10,
    asr: true,
    artifacts: true,
    play: false,
    dryRun: false,
    mode: process.env.TPLUS_MODE || "test", // test | ops
    modeFromEnv: Boolean(process.env.TPLUS_MODE),
    modeFromCli: false,
    suggestUrl: process.env.TPLUS_SUGGEST_URL || null,
    suggestSecret: process.env.TPLUS_SUGGEST_SECRET || null,
    telegramToken: process.env.TELEGRAM_TOKEN || null,
    adminIds: (process.env.TELEGRAM_ADMIN_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    adminId: process.env.TELEGRAM_ADMIN_IDS?.split(",")[0]?.trim() || null,
    syncFileT: 0,
    leadSec: 0,
    /** @type {string|null|false} false=off; null=default path; string=parent dir */
    saveRun: null,
    saveFrames: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") out.url = next();
    else if (a === "--video") out.video = next();
    else if (a === "--mission") out.mission = next();
    else if (a === "--ll2-id") out.ll2Id = next();
    else if (a === "--ll2-slug") out.ll2Slug = next();
    else if (a === "--ll2-search") out.ll2Search = next();
    else if (a === "--allow-unofficial-webcast") out.requireOfficialWebcast = false;
    else if (a === "--python") out.python = next();
    else if (a === "--poll-sec") out.pollSec = Number(next());
    else if (a === "--ocr-every") out.ocrEverySec = Number(next());
    else if (a === "--asr-every") out.asrEverySec = Number(next());
    else if (a === "--no-asr") out.asr = false;
    else if (a === "--no-artifacts") out.artifacts = false;
    else if (a === "--play") out.play = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--save-run") {
      // optional path: --save-run  OR  --save-run /path/to/runs
      const peek = argv[i + 1];
      if (peek && !peek.startsWith("-")) {
        out.saveRun = next();
      } else {
        out.saveRun = ""; // default parent
      }
    } else if (a === "--no-save-run") out.saveRun = false;
    else if (a === "--no-save-frames") out.saveFrames = false;
    else if (a === "--mode") {
      out.mode = next();
      out.modeFromCli = true;
    } else if (a === "--test") {
      out.mode = "test";
      out.modeFromCli = true;
    } else if (a === "--ops") {
      out.mode = "ops";
      out.modeFromCli = true;
    } else if (a === "--suggest-url") out.suggestUrl = next();
    else if (a === "--suggest-secret") out.suggestSecret = next();
    else if (a === "--sync-file-t") out.syncFileT = Number(next());
    else if (a === "--lead-sec") out.leadSec = Number(next());
    else if (a === "--help" || a === "-h") out.help = true;
  }
  const m = String(out.mode || "test").toLowerCase();
  out.mode = m === "ops" || m === "live" ? "ops" : "test";
  return out;
}

function usage() {
  console.log(`Usage:
  webcast:live --ll2-id <uuid> [--mode test|ops]
  webcast:live --ll2-search <query> [--mode test|ops]
  webcast:live --ll2-slug <slug> [--mode test|ops]
  webcast:live --mission <id> [--mode test|ops]
  webcast:live --video <mp4> --mission <id> [--play] [--dry-run]

Always-on consumer: park until media/clock available, hold-aware OCR lock,
POST milestones to CF /suggest for immediate fan-out.

  --ll2-*           load NET + Official Webcast + timeline from Launch Library 2
  --url / --video   optional when LL2/mission provides webcastUrl
  --save-run [dir]  durable archive under tplus-webcast/runs (or dir)
  --no-save-run     disable archive
  --mode test       admins only (default; safe rehearsal)
  --mode ops        all subscribers
  --test / --ops    aliases

Env: TPLUS_SUGGEST_URL, TPLUS_SUGGEST_SECRET, TELEGRAM_TOKEN, TELEGRAM_ADMIN_IDS
     LL2_TOKEN (optional; free tier is 15 req/hour/IP)
`);
}

function ll2OptsFromArgs(args) {
  const n = [args.ll2Id, args.ll2Slug, args.ll2Search].filter(Boolean).length;
  if (n === 0) return null;
  if (n > 1) {
    throw new Error("Use only one of --ll2-id, --ll2-slug, --ll2-search");
  }
  return {
    id: args.ll2Id || undefined,
    slug: args.ll2Slug || undefined,
    search: args.ll2Search || undefined,
    officialOnly: args.requireOfficialWebcast,
    requireWebcast: args.requireOfficialWebcast && !args.url && !args.video,
  };
}

function resolveMission(ref) {
  const s = String(ref || "").trim();
  for (const p of [
    s,
    resolve(s),
    join(ROOT, "missions/flights", `${s}-script.json`),
  ]) {
    if (p && existsSync(p)) return p;
  }
  throw new Error(`mission not found: ${ref}`);
}

function resolveYtDlp() {
  const venv = join(REPO_ROOT, ".venv-webcast/bin/yt-dlp");
  if (existsSync(venv)) return venv;
  return "yt-dlp";
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.stdio || ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (b) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b) => {
      err += b.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveP({ out, err });
      else reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`));
    });
  });
}

async function probeMediaUrl(pageUrl) {
  const ytdlp = resolveYtDlp();
  // Prefer ≤720p VIDEO. Leading with bestaudio (old string) matches first on
  // YouTube and returns an audio-only URL — grabFrame then never sees a HUD
  // (Vega VV30: startup ping, zero OCR lock / no artifacts).
  // X SpaceX replays are muxed m3u8 → best[height<=720] still works.
  const { out } = await runCmd(ytdlp, [
    "-f",
    "bestvideo[height<=720]/best[height<=720]/best",
    "-g",
    pageUrl,
  ]);
  const lines = out.trim().split("\n").filter(Boolean);
  // If a merge format ever sneaks in, yt-dlp -g prints video then audio.
  const line = lines[0];
  if (!line) throw new Error("yt-dlp returned no media URL");
  return line;
}

async function grabFrame(mediaPathOrUrl, outJpg, ssSec = null) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  // File seeks: -ss BEFORE -i (input seek). After -i forces a full decode from t=0
  // to the target — on a 30–60min webcast that made the first OCR take minutes and
  // left the loop stuck far behind --play. Keyframe snap (~1s) is fine for HUD OCR.
  // Live URLs: no -ss (grab near the live edge).
  const seek = ssSec != null && Number.isFinite(ssSec);
  if (seek) args.push("-ss", String(ssSec));
  args.push("-i", mediaPathOrUrl);
  args.push("-frames:v", "1", "-q:v", "3", outJpg);
  await runCmd("ffmpeg", args);
  return outJpg;
}

async function grabAudioWav(mediaPathOrUrl, outWav, ssSec, durSec) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  if (ssSec != null) args.push("-ss", String(ssSec));
  args.push(
    "-i",
    mediaPathOrUrl,
    "-t",
    String(durSec),
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    outWav,
  );
  await runCmd("ffmpeg", args);
  return outWav;
}

async function ocrImage(python, imagePath) {
  const { out } = await runCmd(python, [OCR_PY, "--image", imagePath]);
  const line = out.trim().split("\n").filter(Boolean).at(-1);
  return JSON.parse(line);
}

async function asrFile(python, wavPath) {
  const { out } = await runCmd(python, [
    ASR_PY,
    "--audio",
    wavPath,
    "--model",
    process.env.WEBCAST_WHISPER_MODEL || "tiny",
    "--device",
    "cpu",
  ]);
  const segments = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === "segment") segments.push(obj);
    } catch {
      /* ignore */
    }
  }
  return segments;
}

function formatMissionClock(tPlusSec) {
  if (tPlusSec == null || !Number.isFinite(tPlusSec)) return "T?—";
  const sign = tPlusSec < 0 ? "-" : "+";
  const a = Math.abs(Math.round(tPlusSec));
  const m = Math.floor(a / 60);
  const s = a % 60;
  return `T${sign}${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Hold-aware clock belief.
 * SpaceX HUDs deliver signed T± via OCR. NASA+/bare HH:MM:SS deliver magnitude
 * only — we lock direction from motion (countdown→T−, countup→T+) after a few
 * agreeing samples before coast/emit.
 */
function createClockBelief() {
  /** @type {{ tPlusSec: number, asOfWallMs: number, source: string, stallMs: number, liftoffWallMs: number|null, confidence: number, dir?: string }|null} */
  let belief = null;
  /** @type {{ magSec: number, wallMs: number, signed: boolean }|null} */
  let lastSample = null;
  /** @type {"countdown"|"countup"|null} */
  let dir = null;
  let dirVotes = 0; // consecutive agreeing motion samples toward dir lock
  const DIR_VOTES_NEEDED = 2;

  function commitSigned(tPlusSec, wallMs, stallMs, confidence, source = "ocr") {
    belief = {
      tPlusSec,
      asOfWallMs: wallMs,
      source,
      stallMs,
      liftoffWallMs: wallMs - tPlusSec * 1000,
      confidence,
      dir: dir || (tPlusSec < 0 ? "countdown" : "countup"),
    };
    return belief;
  }

  return {
    /**
     * @param {number|null|undefined} clockSec signed T± seconds, or null
     * @param {number} [wallMs]
     * @param {{ unsignedSec?: number|null, signSource?: string|null }} [opts]
     */
    updateFromOcr(clockSec, wallMs = Date.now(), opts = {}) {
      const unsigned =
        opts.unsignedSec != null && Number.isFinite(opts.unsignedSec)
          ? Number(opts.unsignedSec)
          : null;

      // Explicit T± — lock direction immediately
      if (clockSec != null && Number.isFinite(clockSec)) {
        dir = clockSec < 0 ? "countdown" : "countup";
        dirVotes = DIR_VOTES_NEEDED;
        const stall =
          lastSample && Math.abs(Math.abs(clockSec) - lastSample.magSec) < 0.5
            ? wallMs - lastSample.wallMs
            : 0;
        lastSample = { magSec: Math.abs(clockSec), wallMs, signed: true };
        return commitSigned(clockSec, wallMs, stall, stall > 0 ? 0.85 : 0.9);
      }

      // Bare magnitude — need motion to infer sign
      if (unsigned == null) return belief;

      if (!lastSample) {
        lastSample = { magSec: unsigned, wallMs, signed: false };
        return belief; // no dir yet
      }

      const prevMag = lastSample.magSec;
      const dMag = unsigned - prevMag;
      const dWall = (wallMs - lastSample.wallMs) / 1000;

      // Hold / noise
      if (Math.abs(dMag) < 0.5) {
        lastSample = { magSec: unsigned, wallMs, signed: false };
        if (belief && dir) {
          belief = {
            ...belief,
            stallMs: (belief.stallMs || 0) + Math.max(0, dWall) * 1000,
            asOfWallMs: wallMs,
            tPlusSec: (dir === "countdown" ? -1 : 1) * unsigned,
          };
        }
        return belief;
      }

      // Reject OCR jumps (≫ wall elapsed)
      if (dWall > 0.2 && Math.abs(dMag) > Math.max(8, 3 * dWall)) {
        return belief; // keep lastSample
      }

      lastSample = { magSec: unsigned, wallMs, signed: false };

      // Motion vote
      let vote = null;
      if (dWall > 0.2) {
        if (dMag < -0.5) vote = "countdown";
        else if (dMag > 0.5) vote = "countup";
      }
      // Near-zero flip: was counting down through liftoff
      if (
        dir === "countdown" &&
        vote === "countup" &&
        unsigned < 30 &&
        prevMag < 60
      ) {
        dir = "countup";
        dirVotes = DIR_VOTES_NEEDED;
      } else if (vote) {
        if (vote === dir) dirVotes += 1;
        else if (!dir) {
          dir = vote;
          dirVotes = 1;
        } else {
          // conflicting — require re-agree
          dir = vote;
          dirVotes = 1;
        }
      }

      if (!dir || dirVotes < DIR_VOTES_NEEDED) return belief;

      const sign = dir === "countdown" ? -1 : 1;
      return commitSigned(sign * unsigned, wallMs, 0, 0.8, "ocr");
    },
    /** True once we have a signed mission clock (explicit T± or motion-locked). */
    hasLock: () => Boolean(belief && Number.isFinite(belief.tPlusSec)),
    /**
     * Coast from last OCR grab-time.
     * Normal: ~60s (covers whisper + sleep-to-milestone).
     * Countdown after HUD drop (NASA+ etc.): keep coasting longer so we can
     * still reach T+0 when the clock vanishes ~T−1–2m (hybrid fallback).
     */
    now(wallMs = Date.now()) {
      if (!belief) return null;
      const age = wallMs - belief.asOfWallMs;
      if (belief.stallMs > 8000) {
        // hold: freeze at last OCR
        return { ...belief, source: "hold", ageMs: age };
      }
      const countingDown =
        belief.dir === "countdown" ||
        (Number.isFinite(belief.tPlusSec) && belief.tPlusSec < 0);
      // HUD often drops ~T−1–2m (NASA+); keep coasting so T+0 is reachable.
      const coastLimitMs = countingDown ? 240_000 : 60_000;
      if (age < coastLimitMs && (belief.source === "ocr" || belief.source === "coast")) {
        const coast = belief.tPlusSec + age / 1000;
        return {
          ...belief,
          tPlusSec: coast,
          source: "coast",
          ageMs: age,
        };
      }
      // stale: return last snap without coasting far
      return { ...belief, source: "stale", ageMs: age };
    },
    raw: () => belief,
  };
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
  if (!res.ok) throw new Error(`suggest ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.dryRun && (!args.suggestUrl || !args.suggestSecret)) {
    throw new Error("Need TPLUS_SUGGEST_URL + TPLUS_SUGGEST_SECRET (or --dry-run)");
  }
  if (!existsSync(args.python)) {
    throw new Error(`Python missing: ${args.python}`);
  }

  const ll2opts = ll2OptsFromArgs(args);
  /** @type {object} */
  let scriptDoc;
  /** @type {object|null} */
  let ll2Launch = null;
  if (ll2opts) {
    logInfo(
      `Fetching LL2 launch (${args.ll2Id ? "id" : args.ll2Slug ? "slug" : "search"}=${args.ll2Id || args.ll2Slug || args.ll2Search})…`,
    );
    try {
      const loaded = await loadScriptDocFromLl2(ll2opts);
      scriptDoc = loaded.scriptDoc;
      ll2Launch = loaded.launch || null;
      for (const w of loaded.warnings || []) logWarn(`ll2: ${w}`);
      if (loaded.unmapped?.length) {
        logWarn(
          `ll2 unmapped abbrevs: ${[...new Set(loaded.unmapped)].join(", ")}`,
        );
      }
      logInfo(
        `LL2 → ${scriptDoc.missionId} · ${scriptDoc.missionName} · NET ${scriptDoc.launchApproxUtc} · script=${(scriptDoc.script || []).length} events`,
      );
    } catch (e) {
      if (args.mission) {
        logWarn(
          `LL2 failed (${e.message || e}); falling back to --mission ${args.mission}`,
        );
        const missionPath = resolveMission(args.mission);
        scriptDoc = JSON.parse(readFileSync(missionPath, "utf8"));
      } else {
        throw e;
      }
    }
  } else {
    if (!args.mission) {
      usage();
      logError("Need --ll2-id|--ll2-slug|--ll2-search or --mission");
      process.exit(1);
    }
    const missionPath = resolveMission(args.mission);
    scriptDoc = JSON.parse(readFileSync(missionPath, "utf8"));
  }

  if (!args.url && !args.video && scriptDoc.webcastUrl) {
    args.url = String(scriptDoc.webcastUrl).trim();
    logInfo(`Using webcastUrl: ${args.url}`);
  }
  if (!args.url && !args.video) {
    usage();
    logError(
      `Need --url, --video, or webcastUrl from LL2/mission (mission=${scriptDoc.missionId})`,
    );
    process.exit(1);
  }
  const script = scriptDoc.script || [];
  const scriptTPlus = scriptTPlusByAction(scriptDoc);
  const phrases = normalizePhraseBook(
    JSON.parse(readFileSync(PHRASES_FALCON, "utf8")),
  );

  const work = join(tmpdir(), `cue-live-${Date.now()}`);
  mkdirSync(work, { recursive: true });

  /** @type {ReturnType<typeof createRunArchive>|null} */
  let archive = null;
  if (args.saveRun !== false && args.saveRun != null) {
    const parent =
      args.saveRun === ""
        ? join(REPO_ROOT, "tplus-webcast", "runs")
        : resolve(args.saveRun);
    archive = createRunArchive({
      parentDir: parent,
      missionId: scriptDoc.missionId,
      missionName: scriptDoc.missionName,
      mode: args.mode,
      webcastUrl: args.url,
      ll2LaunchId: scriptDoc.ll2LaunchId || ll2Launch?.id || null,
      dryRun: args.dryRun,
    });
    archive.writeScript(scriptDoc);
    if (ll2Launch) archive.writeLl2Raw(ll2Launch);
    logInfo(`run archive → ${archive.runDir}`);
  }

  const clock = createClockBelief();
  const emitted = new Set();
  /** @type {{ phraseId: string, actionId: string|null, raw: string, tPlusSec: number|null }[]} */
  let recentAsr = [];
  let lastAsrAt = 0;
  let media = args.video ? resolve(args.video) : null;
  let fileMode = Boolean(args.video);
  let syncWallMs = Date.now();
  let syncFileT = args.syncFileT || 0;
  let player = null;

  const shutdown = (reason) => {
    try {
      archive?.finalize({ reason });
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
    process.exit(143);
  });

  logInfo(
    `webcast:live mission=${scriptDoc.missionId} mode=${args.mode} dryRun=${args.dryRun} asr=${args.asr} artifacts=${args.artifacts}`,
  );
  if (args.mode === "test") {
    const via = args.modeFromCli
      ? "CLI --mode/--test"
      : args.modeFromEnv
        ? "TPLUS_MODE in .env"
        : "default";
    logWarn(
      `Fan-out is TEST (admins only) — source=${via}. Pass --ops for all subscribers.`,
    );
  }

  const adminChatIds = args.adminIds.length
    ? args.adminIds
    : args.adminId
      ? [args.adminId]
      : [];

  /** Admin-only health pings (never fan-out to subscribers). */
  async function notifyAdmins(text) {
    if (args.dryRun || !args.telegramToken || !adminChatIds.length) return;
    for (const chatId of adminChatIds) {
      try {
        await sendTelegramText(args.telegramToken, chatId, text);
      } catch (e) {
        logWarn(`admin health ping failed (${chatId}): ${e.message || e}`);
      }
    }
  }

  const sourceHint = fileMode
    ? `file ${media}`
    : args.url
      ? `url ${args.url}`
      : "—";
  await notifyAdmins(
    `TPlus webcast UP\n` +
      `${scriptDoc.missionName || scriptDoc.missionId}\n` +
      `mode=${args.mode} · asr=${args.asr ? "on" : "off"}\n` +
      `NET ${scriptDoc.launchApproxUtc || "—"}\n` +
      `${sourceHint}`,
  );
  archive?.appendEvent("health_startup", {
    missionId: scriptDoc.missionId,
    mode: args.mode,
  });

  // Park until media available
  if (!media) {
    logInfo(`Parking on URL (poll ${args.pollSec}s): ${args.url}`);
    archive?.appendEvent("park_start", { url: args.url, pollSec: args.pollSec });
    for (;;) {
      try {
        media = await probeMediaUrl(args.url);
        logInfo(`Media up: ${media.slice(0, 80)}…`);
        archive?.appendEvent("media_up", { url: args.url });
        archive?.writeMeta({ mediaUpAt: new Date().toISOString() });
        break;
      } catch (e) {
        logWarn(`waiting for broadcast… (${e.message || e})`);
        archive?.appendEvent("park_wait", { error: String(e.message || e) });
        await sleep(args.pollSec * 1000);
      }
    }
  } else {
    logInfo(`File mode: ${media}`);
    if (args.play) {
      player = spawn(
        "ffplay",
        ["-hide_banner", "-loglevel", "warning", "-ss", String(syncFileT), media],
        { stdio: "ignore" },
      );
    }
  }

  const framePath = join(work, "frame.jpg");
  const wavPath = join(work, "snip.wav");

  function fileSsAt(wallMs = Date.now()) {
    if (!fileMode) return null;
    return syncFileT + (wallMs - syncWallMs) / 1000;
  }

  /** File seek for a mission T+ using OCR↔wall liftoff mapping (frame-accurate catch-up). */
  function fileSsForMissionTPlus(tPlusSec) {
    if (!fileMode) return null;
    const raw = clock.raw();
    if (raw?.liftoffWallMs != null && Number.isFinite(raw.liftoffWallMs)) {
      return (
        syncFileT + (raw.liftoffWallMs + Number(tPlusSec) * 1000 - syncWallMs) / 1000
      );
    }
    return fileSsAt();
  }

  /**
   * Next unemitted script row and seconds until due (coasted clock).
   * @returns {{ row: object, dueAt: number, until: number }|null}
   */
  function nextMilestone(belief) {
    if (!belief || !Number.isFinite(belief.tPlusSec)) return null;
    let best = null;
    for (const row of script) {
      if (row?.actionId == null || row.tPlusSec == null) continue;
      if (emitted.has(row.actionId)) continue;
      const dueAt = Number(row.tPlusSec) - args.leadSec;
      const until = dueAt - belief.tPlusSec;
      if (!best || until < best.until) best = { row, dueAt, until };
    }
    return best;
  }

  /**
   * Grab+emit any milestone that is due now (within earlyε) or overdue.
   * @param {string} reason
   * @param {object} [ocrSnap]
   * @param {{ atWall?: number }} [opts] — evaluate belief at this wall (use grabWall
   *   after OCR so we do not coast by RapidOCR duration into a false “late” clock)
   */
  async function emitDueMilestones(reason, ocrSnap = {}, opts = {}) {
    const atWall = opts.atWall ?? Date.now();
    const belief = clock.now(atWall);
    if (!belief || !Number.isFinite(belief.tPlusSec)) return;
    if ((belief.stallMs || 0) >= 8000 && reason !== "catch-up") {
      // During hold, only catch-up path after a fresh OCR should fire.
      return;
    }
    for (const row of script) {
      if (row?.actionId == null || row.tPlusSec == null) continue;
      if (emitted.has(row.actionId)) continue;
      const dueAt = Number(row.tPlusSec) - args.leadSec;
      // earlyε 0.35s: fire slightly before due so grab lands on script T+
      if (belief.tPlusSec + 0.35 < dueAt) continue;
      if (belief.tPlusSec > Number(row.tPlusSec) + 120) continue;
      const overdue = belief.tPlusSec - dueAt;
      // Precision wake: grab at wall "now". Catch-up / overdue: seek the script
      // T+ frame (OCR may have finished seconds after grabWall).
      const ssNow = !fileMode
        ? null
        : reason === "catch-up" || overdue > 0.5
          ? fileSsForMissionTPlus(dueAt)
          : fileSsAt(Date.now());
      logInfo(
        `${reason} ${row.actionId} @ clock ${formatMissionClock(belief.tPlusSec)} ` +
          `(script ${formatMissionClock(row.tPlusSec)})` +
          (overdue > 0.5 ? ` overdue=${overdue.toFixed(1)}s` : ""),
      );
      await emitRow(row, belief, ssNow, ocrSnap);
    }
  }

  /**
   * Hybrid liftoff: if we locked a countdown and the HUD then disappeared,
   * fire liftoff from OCR-extrapolated liftoff wall (or LL2 NET when live).
   * Does not invent the rest of the timeline.
   */
  async function maybeEmitLiftoffFallback(ocrSnap = {}) {
    if (emitted.has("liftoff")) return;
    const row = script.find((r) => r?.actionId === "liftoff");
    if (!row) return;

    const raw = clock.raw();
    if (!raw || !Number.isFinite(raw.tPlusSec)) return;
    const wasCountdown =
      raw.dir === "countdown" || raw.tPlusSec < 0;
    if (!wasCountdown) return;
    if ((raw.stallMs || 0) >= 8000) return; // hold — don't guess liftoff

    const wall = Date.now();
    const silenceMs = wall - raw.asOfWallMs;
    // Still receiving clocks (or just lost) — let normal coast/emit handle it
    if (silenceMs < 15_000) return;

    /** @type {number|null} */
    let liftoffWall = null;
    let via = null;
    if (raw.liftoffWallMs != null && Number.isFinite(raw.liftoffWallMs)) {
      liftoffWall = raw.liftoffWallMs;
      via = "ocr-extrapolated";
    }
    if (
      liftoffWall == null &&
      !fileMode &&
      scriptDoc.launchApproxUtc
    ) {
      const net = Date.parse(String(scriptDoc.launchApproxUtc));
      if (Number.isFinite(net)) {
        liftoffWall = net;
        via = "ll2-net";
      }
    }
    if (liftoffWall == null) return;

    // Not yet / too late (same ±120s catch-up spirit as emitDueMilestones)
    if (wall < liftoffWall - 500) return;
    if (wall > liftoffWall + 120_000) return;

    const belief = {
      tPlusSec: (wall - liftoffWall) / 1000,
      asOfWallMs: wall,
      source: "net_fallback",
      stallMs: 0,
      liftoffWallMs: liftoffWall,
      confidence: 0.55,
      dir: "countup",
    };
    const ssNow = fileMode ? fileSsForMissionTPlus(0) : null;
    logInfo(
      `liftoff via ${via} fallback (HUD lost after countdown lock, ` +
        `silence=${(silenceMs / 1000).toFixed(0)}s)`,
    );
    archive?.appendEvent("liftoff_fallback", {
      via,
      silenceMs,
      liftoffWallMs: liftoffWall,
      wallMs: wall,
    });
    await emitRow(row, belief, ssNow, ocrSnap);
  }

  /**
   * Emit one milestone with a still grabbed at *this* wall/file time.
   * @param {object} row
   * @param {object} belief
   * @param {number|null} ss
   * @param {object} ocrSnap
   */
  async function emitRow(row, belief, ss, ocrSnap) {
    const key = row.actionId;
    if (emitted.has(key)) return;
    emitted.add(key);

    const asrHits = recentAsr.filter(
      (h) =>
        h.actionId === row.actionId ||
        (h.tPlusSec != null && Math.abs(h.tPlusSec - row.tPlusSec) < 90),
    );
    const scroller = (ocrSnap?.scrollerPresent || [])
      .filter((b) =>
        String(b.text || "")
          .toUpperCase()
          .includes(String(row.label || row.actionId).slice(0, 6).toUpperCase()),
      )
      .map((b) => ({ label: b.text, atPresent: true }));

    const artifacts = [];
    /** @type {{ chatId: number, messageId: number|null }[]} */
    const mintMsgs = [];
    if (
      args.artifacts &&
      !args.dryRun &&
      args.telegramToken &&
      args.adminId
    ) {
      try {
        const still = join(work, `art-${key}.jpg`);
        // Grab NOW — this is the scheduled moment
        await grabFrame(media, still, ss);
        if (args.saveFrames && archive) {
          archive.saveFrame(still, `${key}.jpg`);
        }
        const up = await uploadTelegramFile(
          args.telegramToken,
          args.adminId,
          still,
          { kind: "photo" },
        );
        artifacts.push({
          id: "f0",
          kind: "photo",
          label: row.label || key,
          fileId: up.fileId,
          defaultOn: true,
        });
        mintMsgs.push({ chatId: up.chatId, messageId: up.messageId });
      } catch (e) {
        logWarn(`artifact upload: ${e.message || e}`);
        archive?.appendEvent("artifact_error", {
          actionId: key,
          error: String(e.message || e),
        });
      }
    }

    const body = {
      actionId: row.actionId,
      label: row.label || row.actionId,
      scriptTPlusSec: Number(row.tPlusSec),
      missionId: scriptDoc.missionId,
      missionName: scriptDoc.missionName || null,
      mode: args.mode,
      evidence: {
        sources: [
          "schedule",
          belief.source === "net_fallback" ? "net_fallback" : "ocr_clock",
          ...(asrHits.length ? ["asr"] : []),
          ...(scroller.length ? ["hud_scroller"] : []),
        ],
        clock: {
          tPlusSec: belief.tPlusSec,
          source: belief.source,
          stallMs: belief.stallMs,
          confidence: belief.confidence,
        },
        asrHits,
        scroller,
        todo: [
          "vision_stage_sep",
          "plume_flame_onset",
          "telemetry_engines",
          "audio_clip_artifact",
        ],
      },
      artifacts,
    };

    logInfo(
      `EMIT script ${formatMissionClock(row.tPlusSec)} ${row.actionId} ` +
        `(clock ${formatMissionClock(belief.tPlusSec)}) → ${args.dryRun ? "dry-run" : args.mode}`,
    );
    archive?.appendEvent("emit", {
      actionId: row.actionId,
      scriptTPlusSec: row.tPlusSec,
      clockTPlusSec: belief.tPlusSec,
      dryRun: args.dryRun,
    });
    if (args.dryRun) {
      console.log(JSON.stringify({ type: "suggest", ...body }));
      archive?.writeSuggest(key, body, { dryRun: true });
      return;
    }
    const r = await postSuggest(args.suggestUrl, args.suggestSecret, body);
    logInfo(`  delivered=${r?.delivered ?? "?"} mode=${r?.mode || args.mode}`);
    archive?.writeSuggest(key, body, r);
    archive?.appendEvent("suggest_ok", {
      actionId: key,
      delivered: r?.delivered ?? null,
      mode: r?.mode || args.mode,
    });
    if (args.telegramToken) {
      for (const m of mintMsgs) {
        await deleteTelegramMessage(
          args.telegramToken,
          m.chatId,
          m.messageId,
        );
      }
    }
  }

  logInfo("Entering observe loop (Ctrl+C to stop)");
  let firstOcrNotified = false;

  for (;;) {
    const wall = Date.now();
    try {
      // 1) Anything already due → grab+emit BEFORE OCR (coasted clock).
      await emitDueMilestones("precision wake");

      // 2) If the next milestone is inside the OCR interval, sleep until it
      //    and emit — do not burn the window on RapidOCR first.
      {
        const b = clock.now(Date.now());
        if (b && Number.isFinite(b.tPlusSec) && (b.stallMs || 0) < 8000) {
          const next = nextMilestone(b);
          if (next && next.until > 0.05 && next.until <= args.ocrEverySec) {
            logInfo(
              `next ${next.row.actionId} in ${next.until.toFixed(2)}s ` +
                `(script ${formatMissionClock(next.row.tPlusSec)}) — precision wake`,
            );
            await sleep(next.until * 1000);
            await emitDueMilestones("precision wake");
          }
        }
      }

      // 3) OCR resync — stamp belief with grab-time wall, not post-OCR wall
      //    (OCR duration was skewing coast ahead of the pixels).
      const grabWall = Date.now();
      const ssGrab = fileSsAt(grabWall);
      const tGrab0 = Date.now();
      await grabFrame(media, framePath, ssGrab);
      const ocr = await ocrImage(args.python, framePath);
      const grabMs = Date.now() - tGrab0;
      if (grabMs > 2500) {
        logWarn(
          `slow frame+ocr ${grabMs}ms (fileSs=${ssGrab != null ? ssGrab.toFixed(1) : "live"})`,
        );
      }
      if (ocr.ok && (ocr.clockSec != null || ocr.unsignedSec != null)) {
        const b = clock.updateFromOcr(ocr.clockSec, grabWall, {
          unsignedSec: ocr.unsignedSec,
          signSource: ocr.signSource,
        });
        if (b && clock.hasLock()) {
          const stall =
            b.stallMs > 8000 ? ` HOLD~${(b.stallMs / 1000).toFixed(0)}s` : "";
          logInfo(`clock ${formatMissionClock(b.tPlusSec)} (${b.source})${stall}`);
          if (!firstOcrNotified) {
            firstOcrNotified = true;
            await notifyAdmins(
              `TPlus webcast OCR lock\n` +
                `${scriptDoc.missionName || scriptDoc.missionId}\n` +
                `clock ${formatMissionClock(b.tPlusSec)} (${b.source}` +
                `${b.dir ? `/${b.dir}` : ""})\n` +
                `frame+ocr ${grabMs}ms`,
            );
            archive?.appendEvent("health_first_ocr", {
              clockSec: b.tPlusSec,
              source: b.source,
              dir: b.dir || null,
              grabMs,
            });
          }
        } else if (ocr.unsignedSec != null) {
          logInfo(
            `clock — (bare ${ocr.raw || ocr.unsignedSec}s, waiting for motion lock)`,
          );
        } else {
          logInfo("clock — (no HUD / OCR miss)");
        }
      } else {
        logInfo("clock — (no HUD / OCR miss)");
      }

      // 4) Catch-up at grabWall — do NOT coast by OCR duration (that was
      //    reporting T+0:07 for a T+0:00 frame and seeking wall-late).
      await emitDueMilestones("catch-up", ocr, { atWall: grabWall });
      // 4b) Countdown HUD gone → liftoff from OCR-extrapolated / LL2 NET wall
      await maybeEmitLiftoffFallback(ocr);

      // 5) Sleep plan BEFORE ASR — whisper was eating the precision window.
      let sleepSec = args.ocrEverySec;
      let nextForSleep = null;
      const beliefForSleep = clock.now(Date.now());
      if (
        beliefForSleep &&
        Number.isFinite(beliefForSleep.tPlusSec) &&
        (beliefForSleep.stallMs || 0) < 8000
      ) {
        nextForSleep = nextMilestone(beliefForSleep);
        if (nextForSleep && nextForSleep.until > 0) {
          sleepSec = Math.min(sleepSec, Math.max(0.05, nextForSleep.until));
          if (nextForSleep.until <= args.ocrEverySec) {
            logInfo(
              `next ${nextForSleep.row.actionId} in ${nextForSleep.until.toFixed(2)}s ` +
                `(script ${formatMissionClock(nextForSleep.row.tPlusSec)}) — precision wake`,
            );
          }
        }
      }
      // If HUD is gone but liftoff still pending, sleep toward extrapolated T+0
      if (!emitted.has("liftoff") && beliefForSleep?.dir === "countdown") {
        const raw = clock.raw();
        const loft = raw?.liftoffWallMs;
        if (loft != null && Number.isFinite(loft)) {
          const untilLoft = (loft - Date.now()) / 1000;
          if (untilLoft > 0.05 && untilLoft < 180) {
            sleepSec = Math.min(sleepSec, Math.max(0.05, untilLoft));
          }
        }
      }

      // 6) ASR only when the next milestone is not imminent (evidence-only).
      const asrBudgetOk =
        !nextForSleep || nextForSleep.until > Math.max(12, args.asrEverySec + 2);
      if (
        args.asr &&
        asrBudgetOk &&
        wall - lastAsrAt > args.asrEverySec * 1000
      ) {
        lastAsrAt = wall;
        try {
          const asrSs = fileMode
            ? Math.max(0, (ssGrab || 0) - args.asrEverySec)
            : null;
          await grabAudioWav(
            media,
            wavPath,
            fileMode ? asrSs : null,
            args.asrEverySec + 2,
          );
          const segs = await asrFile(args.python, wavPath);
          const beliefNow = clock.now(Date.now());
          /** @type {Record<string, number>} */
          let lastHit = {};
          const hits = [];
          for (const seg of segs) {
            const tPlus = beliefNow?.tPlusSec ?? null;
            const { hits: h, lastHitById } = matchPhrases(seg.text, phrases, {
              tSec: beliefNow?.tPlusSec ?? 0,
              lastHitById: lastHit,
            });
            lastHit = lastHitById;
            for (const hit of h) {
              if (
                tPlus != null &&
                hit.actionId &&
                scriptTPlus.has(hit.actionId)
              ) {
                const g = gateHitAgainstScript(hit, {
                  tPlusSec: tPlus,
                  scriptTPlus,
                  gateSec: 90,
                });
                if (!g.ok && g.reason === "outside-window") continue;
              }
              hits.push({
                phraseId: hit.phraseId,
                actionId: hit.actionId,
                raw: String(hit.raw || "").slice(0, 120),
                tPlusSec: tPlus,
              });
            }
          }
          if (hits.length) {
            recentAsr = [...hits, ...recentAsr].slice(0, 12);
            logInfo(
              `asr hits (internal): ${hits.map((h) => h.phraseId).join(", ")}`,
            );
          }
        } catch (e) {
          logWarn(`asr: ${e.message || e}`);
        }
        // Recompute sleep after ASR so we don't undershoot the milestone.
        const b2 = clock.now(Date.now());
        if (b2 && (b2.stallMs || 0) < 8000) {
          const n2 = nextMilestone(b2);
          if (n2 && n2.until > 0) {
            sleepSec = Math.min(args.ocrEverySec, Math.max(0.05, n2.until));
          }
        }
      }

      await sleep(sleepSec * 1000);
    } catch (e) {
      logWarn(`loop: ${e.message || e}`);
      if (!fileMode && args.url) {
        try {
          media = await probeMediaUrl(args.url);
        } catch {
          /* keep old */
        }
      }
      await sleep(args.ocrEverySec * 1000);
    }
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exit(1);
});
