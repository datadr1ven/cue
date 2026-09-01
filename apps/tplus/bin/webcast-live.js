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
 *   npm run webcast:live -- --url 'https://x.com/i/broadcasts/…' --mission starlink-sl-15-23 --mode test
 *   npm run webcast:live -- --video /tmp/roman-window.mp4 --mission roman-fh --play --dry-run
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
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
} from "../src/webcast/tg-upload.js";

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
    mission: "roman-fh",
    python: process.env.WEBCAST_PYTHON || DEFAULT_PYTHON,
    pollSec: 45,
    ocrEverySec: 5,
    asrEverySec: 10,
    asr: true,
    artifacts: true,
    play: false,
    dryRun: false,
    mode: process.env.TPLUS_MODE || "test", // test | ops
    suggestUrl: process.env.TPLUS_SUGGEST_URL || null,
    suggestSecret: process.env.TPLUS_SUGGEST_SECRET || null,
    telegramToken: process.env.TELEGRAM_TOKEN || null,
    adminId: process.env.TELEGRAM_ADMIN_IDS?.split(",")[0]?.trim() || null,
    syncFileT: 0,
    leadSec: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") out.url = next();
    else if (a === "--video") out.video = next();
    else if (a === "--mission") out.mission = next();
    else if (a === "--python") out.python = next();
    else if (a === "--poll-sec") out.pollSec = Number(next());
    else if (a === "--ocr-every") out.ocrEverySec = Number(next());
    else if (a === "--asr-every") out.asrEverySec = Number(next());
    else if (a === "--no-asr") out.asr = false;
    else if (a === "--no-artifacts") out.artifacts = false;
    else if (a === "--play") out.play = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--mode") out.mode = next();
    else if (a === "--test") out.mode = "test";
    else if (a === "--ops") out.mode = "ops";
    else if (a === "--suggest-url") out.suggestUrl = next();
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
  webcast:live --url <x-broadcast> --mission <id> [--mode test|ops]
  webcast:live --video <mp4> --mission <id> [--play] [--dry-run] [--mode test]

Always-on consumer: park until media/clock available, hold-aware OCR lock,
POST milestones to CF /suggest for immediate fan-out.

  --mode test   admins only (default; safe rehearsal)
  --mode ops    all subscribers
  --test / --ops   aliases

Env: TPLUS_SUGGEST_URL, TPLUS_SUGGEST_SECRET, TELEGRAM_TOKEN, TELEGRAM_ADMIN_IDS
`);
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
  const { out } = await runCmd(ytdlp, [
    "-f",
    "bestaudio/best[height<=720]/best",
    "-g",
    pageUrl,
  ]);
  const line = out.trim().split("\n").filter(Boolean).at(-1);
  if (!line) throw new Error("yt-dlp returned no media URL");
  return line;
}

async function grabFrame(mediaPathOrUrl, outJpg, ssSec = null) {
  const args = ["-y", "-hide_banner", "-loglevel", "error"];
  // File seeks: put -ss AFTER -i for frame-accurate HUD (slower, avoids keyframe snap).
  // Live URLs: no -ss (grab near the live edge).
  const accurateSs = ssSec != null && Number.isFinite(ssSec);
  args.push("-i", mediaPathOrUrl);
  if (accurateSs) args.push("-ss", String(ssSec));
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

/** Hold-aware clock belief */
function createClockBelief() {
  /** @type {{ tPlusSec: number, asOfWallMs: number, source: string, stallMs: number, liftoffWallMs: number|null, confidence: number }|null} */
  let belief = null;
  let lastOcr = null;

  return {
    updateFromOcr(clockSec, wallMs = Date.now()) {
      if (clockSec == null || !Number.isFinite(clockSec)) return belief;
      if (lastOcr && Math.abs(clockSec - lastOcr.clockSec) < 0.5) {
        // stalled HUD (hold)
        const stallMs = wallMs - lastOcr.wallMs;
        belief = {
          tPlusSec: clockSec,
          asOfWallMs: wallMs,
          source: "ocr",
          stallMs,
          liftoffWallMs:
            belief?.liftoffWallMs ?? wallMs - clockSec * 1000,
          confidence: 0.85,
        };
      } else {
        belief = {
          tPlusSec: clockSec,
          asOfWallMs: wallMs,
          source: "ocr",
          stallMs: 0,
          liftoffWallMs: wallMs - clockSec * 1000,
          confidence: 0.9,
        };
      }
      lastOcr = { clockSec, wallMs };
      return belief;
    },
    /** Coast only briefly if OCR is fresh and not stalled */
    now(wallMs = Date.now()) {
      if (!belief) return null;
      const age = wallMs - belief.asOfWallMs;
      if (belief.stallMs > 8000) {
        // hold: freeze at last OCR
        return { ...belief, source: "hold", ageMs: age };
      }
      if (age < 12000 && belief.source === "ocr") {
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
  if (args.help || (!args.url && !args.video)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  if (!args.dryRun && (!args.suggestUrl || !args.suggestSecret)) {
    throw new Error("Need TPLUS_SUGGEST_URL + TPLUS_SUGGEST_SECRET (or --dry-run)");
  }
  if (!existsSync(args.python)) {
    throw new Error(`Python missing: ${args.python}`);
  }

  const missionPath = resolveMission(args.mission);
  const scriptDoc = JSON.parse(readFileSync(missionPath, "utf8"));
  const script = scriptDoc.script || [];
  const scriptTPlus = scriptTPlusByAction(scriptDoc);
  const phrases = normalizePhraseBook(
    JSON.parse(readFileSync(PHRASES_FALCON, "utf8")),
  );

  const work = join(tmpdir(), `cue-live-${Date.now()}`);
  mkdirSync(work, { recursive: true });
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

  logInfo(
    `webcast:live mission=${scriptDoc.missionId} mode=${args.mode} dryRun=${args.dryRun} asr=${args.asr} artifacts=${args.artifacts}`,
  );

  // Park until media available
  if (!media) {
    logInfo(`Parking on URL (poll ${args.pollSec}s): ${args.url}`);
    for (;;) {
      try {
        media = await probeMediaUrl(args.url);
        logInfo(`Media up: ${media.slice(0, 80)}…`);
        break;
      } catch (e) {
        logWarn(`waiting for broadcast… (${e.message || e})`);
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
   * Always runs BEFORE OCR so stills are not lagged by RapidOCR.
   * @param {string} reason
   * @param {object} [ocrSnap]
   */
  async function emitDueMilestones(reason, ocrSnap = {}) {
    const nowWall = Date.now();
    const belief = clock.now(nowWall);
    if (!belief || !Number.isFinite(belief.tPlusSec)) return;
    if ((belief.stallMs || 0) >= 8000 && reason !== "catch-up") {
      // During hold, only catch-up path after a fresh OCR should fire.
      return;
    }
    const ssNow = fileSsAt(nowWall);
    for (const row of script) {
      if (row?.actionId == null || row.tPlusSec == null) continue;
      if (emitted.has(row.actionId)) continue;
      const dueAt = Number(row.tPlusSec) - args.leadSec;
      // earlyε 0.35s: fire slightly before due so grab lands on script T+
      if (belief.tPlusSec + 0.35 < dueAt) continue;
      if (belief.tPlusSec > Number(row.tPlusSec) + 120) continue;
      logInfo(
        `${reason} ${row.actionId} @ clock ${formatMissionClock(belief.tPlusSec)} ` +
          `(script ${formatMissionClock(row.tPlusSec)})`,
      );
      await emitRow(row, belief, ssNow, ocrSnap);
    }
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
      }
    }

    const body = {
      actionId: row.actionId,
      label: row.label || row.actionId,
      scriptTPlusSec: Number(row.tPlusSec),
      missionId: scriptDoc.missionId,
      mode: args.mode,
      evidence: {
        sources: [
          "schedule",
          "ocr_clock",
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
    if (args.dryRun) {
      console.log(JSON.stringify({ type: "suggest", ...body }));
      return;
    }
    const r = await postSuggest(args.suggestUrl, args.suggestSecret, body);
    logInfo(`  delivered=${r?.delivered ?? "?"} mode=${r?.mode || args.mode}`);
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
      await grabFrame(media, framePath, ssGrab);
      const ocr = await ocrImage(args.python, framePath);
      if (ocr.ok && ocr.clockSec != null) {
        const b = clock.updateFromOcr(ocr.clockSec, grabWall);
        const stall =
          b.stallMs > 8000 ? ` HOLD~${(b.stallMs / 1000).toFixed(0)}s` : "";
        logInfo(`clock ${formatMissionClock(b.tPlusSec)} (${b.source})${stall}`);
      } else {
        logInfo("clock — (no HUD / OCR miss)");
      }

      // 4) Catch-up (hold recovery / OCR crossed a due time during step 3)
      await emitDueMilestones("catch-up", ocr);

      // 5) ASR cadence (evidence only — not shown to users yet)
      if (args.asr && wall - lastAsrAt > args.asrEverySec * 1000) {
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
      }
    } catch (e) {
      logWarn(`loop: ${e.message || e}`);
      if (!fileMode && args.url) {
        try {
          media = await probeMediaUrl(args.url);
        } catch {
          /* keep old */
        }
      }
    }

    // 6) Sleep until next milestone or OCR poll. Holds → OCR cadence only.
    let sleepSec = args.ocrEverySec;
    const beliefForSleep = clock.now(Date.now());
    if (
      beliefForSleep &&
      Number.isFinite(beliefForSleep.tPlusSec) &&
      (beliefForSleep.stallMs || 0) < 8000
    ) {
      const next = nextMilestone(beliefForSleep);
      if (next && next.until > 0) {
        // Always sleep the lesser of OCR cadence and time-to-milestone.
        // When until > ocrEverySec we wake for OCR first; step 2 then sleeps
        // the remainder and emits before the next OCR.
        sleepSec = Math.min(sleepSec, Math.max(0.05, next.until));
        if (next.until <= args.ocrEverySec) {
          logInfo(
            `next ${next.row.actionId} in ${next.until.toFixed(2)}s ` +
              `(script ${formatMissionClock(next.row.tPlusSec)}) — precision wake`,
          );
        }
      }
    }
    await sleep(sleepSec * 1000);
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exit(1);
});
