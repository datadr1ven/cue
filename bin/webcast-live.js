#!/usr/bin/env node
/**
 * Always-on webcast consumer (GridWhisper-style) for TPlus.
 *
 * Park on a broadcast URL (or replay a --video), OCR the mission clock
 * (hold-aware), optionally ASR every ~10s, and POST /suggest when the
 * mission script says a milestone is due — admin Approve/Dismiss (+ artifact toggles).
 *
 *   npm run webcast:live -- --url 'https://x.com/i/broadcasts/…' --mission starlink-sl-17-50
 *   npm run webcast:live -- --video /tmp/roman-window.mp4 --mission roman-fh --play --dry-run
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { logError, logInfo, logWarn } from "../src/log.js";
import {
  matchPhrases,
  normalizePhraseBook,
  gateHitAgainstScript,
  scriptTPlusByAction,
} from "../src/webcast/match.js";
import { uploadTelegramFile } from "../src/webcast/tg-upload.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OCR_PY = join(ROOT, "src/webcast/ocr_clock.py");
const ASR_PY = join(ROOT, "src/webcast/asr_whisper.py");
const DEFAULT_PYTHON = join(ROOT, ".venv-webcast/bin/python");
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
    suggestUrl: process.env.TPLUS_SUGGEST_URL || null,
    suggestSecret: process.env.TPLUS_SUGGEST_SECRET || null,
    telegramToken: process.env.TELEGRAM_TOKEN || null,
    adminId: process.env.TELEGRAM_ADMIN_IDS?.split(",")[0]?.trim() || null,
    syncFileT: 0,
    leadSec: 2,
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
    else if (a === "--suggest-url") out.suggestUrl = next();
    else if (a === "--suggest-secret") out.suggestSecret = next();
    else if (a === "--sync-file-t") out.syncFileT = Number(next());
    else if (a === "--lead-sec") out.leadSec = Number(next());
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  webcast:live --url <x-broadcast> --mission <id>
  webcast:live --video <mp4> --mission <id> [--play] [--dry-run]

Always-on consumer: park until media/clock available, hold-aware OCR lock,
schedule suggests to CF /suggest (Approve/Dismiss + artifact toggles).

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
  const venv = join(ROOT, ".venv-webcast/bin/yt-dlp");
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
  if (ssSec != null && Number.isFinite(ssSec)) args.push("-ss", String(ssSec));
  // For live HLS, read a small window
  args.push("-i", mediaPathOrUrl, "-frames:v", "1", "-q:v", "3", outJpg);
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
    `webcast:live mission=${scriptDoc.missionId} dryRun=${args.dryRun} asr=${args.asr} artifacts=${args.artifacts}`,
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

  logInfo("Entering observe loop (Ctrl+C to stop)");

  for (;;) {
    const wall = Date.now();
    try {
      // Frame position: live = tip; file = sync + elapsed
      let ss = null;
      if (fileMode) {
        ss = syncFileT + (wall - syncWallMs) / 1000;
      }
      await grabFrame(media, framePath, ss);
      const ocr = await ocrImage(args.python, framePath);
      if (ocr.ok && ocr.clockSec != null) {
        const b = clock.updateFromOcr(ocr.clockSec, wall);
        const stall =
          b.stallMs > 8000 ? ` HOLD~${(b.stallMs / 1000).toFixed(0)}s` : "";
        logInfo(`clock ${formatMissionClock(b.tPlusSec)} (${b.source})${stall}`);
      } else {
        logInfo("clock — (no HUD / OCR miss)");
      }

      // ASR cadence
      if (args.asr && wall - lastAsrAt > args.asrEverySec * 1000) {
        lastAsrAt = wall;
        try {
          const asrSs = fileMode
            ? Math.max(0, (ss || 0) - args.asrEverySec)
            : null;
          // live HLS: grab last N seconds is trickier; skip ss
          await grabAudioWav(
            media,
            wavPath,
            fileMode ? asrSs : null,
            args.asrEverySec + 2,
          );
          const segs = await asrFile(args.python, wavPath);
          const belief = clock.now(wall);
          /** @type {Record<string, number>} */
          let lastHit = {};
          const hits = [];
          for (const seg of segs) {
            const tPlus = belief?.tPlusSec ?? null;
            const { hits: h, lastHitById } = matchPhrases(seg.text, phrases, {
              tSec: belief?.tPlusSec ?? 0,
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
            logInfo(`asr hits: ${hits.map((h) => h.phraseId).join(", ")}`);
          }
        } catch (e) {
          logWarn(`asr: ${e.message || e}`);
        }
      }

      // Schedule emits
      const belief = clock.now(wall);
      if (belief && Number.isFinite(belief.tPlusSec)) {
        for (const row of script) {
          if (row?.actionId == null || row.tPlusSec == null) continue;
          const key = row.actionId;
          if (emitted.has(key)) continue;
          const dueAt = Number(row.tPlusSec) - args.leadSec;
          if (belief.tPlusSec + 0.5 < dueAt) continue;
          // don't fire far-future if clock jumped wrong
          if (belief.tPlusSec > Number(row.tPlusSec) + 120) continue;

          emitted.add(key);
          const asrHits = recentAsr.filter(
            (h) =>
              h.actionId === row.actionId ||
              (h.tPlusSec != null &&
                Math.abs(h.tPlusSec - row.tPlusSec) < 90),
          );
          const scroller = (ocr.scrollerPresent || [])
            .filter((b) =>
              String(b.text || "")
                .toUpperCase()
                .includes(String(row.label || row.actionId).slice(0, 6).toUpperCase()),
            )
            .map((b) => ({ label: b.text, atPresent: true }));

          const artifacts = [];
          if (
            args.artifacts &&
            !args.dryRun &&
            args.telegramToken &&
            args.adminId
          ) {
            try {
              // current frame as primary still
              const still = join(work, `art-${key}.jpg`);
              writeFileSync(still, readFileSync(framePath));
              const fileId = await uploadTelegramFile(
                args.telegramToken,
                args.adminId,
                still,
                { kind: "photo", label: `${row.label || key} frame` },
              );
              if (fileId) {
                artifacts.push({
                  id: "f0",
                  kind: "photo",
                  label: "event frame",
                  fileId,
                  defaultOn: true,
                });
              }
              // TODO: flame onset / T−2 / T+2 / engines-lit classifiers
              // TODO: audio snippet upload as voice
            } catch (e) {
              logWarn(`artifact upload: ${e.message || e}`);
            }
          }

          const body = {
            actionId: row.actionId,
            label: row.label || row.actionId,
            scriptTPlusSec: Number(row.tPlusSec),
            missionId: scriptDoc.missionId,
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
            `SUGGEST ${formatMissionClock(row.tPlusSec)} ${row.actionId} → ${args.dryRun ? "dry-run" : "telegram"}`,
          );
          if (args.dryRun) {
            console.log(JSON.stringify({ type: "suggest", ...body }));
          } else {
            const r = await postSuggest(
              args.suggestUrl,
              args.suggestSecret,
              body,
            );
            logInfo(`  posted ${r?.id || "ok"}`);
          }
        }
      }
    } catch (e) {
      logWarn(`loop: ${e.message || e}`);
      // live URL may rotate — re-probe occasionally
      if (!fileMode && args.url) {
        try {
          media = await probeMediaUrl(args.url);
        } catch {
          /* keep old */
        }
      }
    }

    await sleep(args.ocrEverySec * 1000);
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exit(1);
});
