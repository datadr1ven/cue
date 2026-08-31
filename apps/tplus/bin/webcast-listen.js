#!/usr/bin/env node
/**
 * Webcast audio → ASR → phrase hits (TPlus hybrid assist).
 *
 * Offline / VOD first:
 *   npm run webcast:listen -- --file ~/vids/fh-replay.mp4
 *   npm run webcast:listen -- --file clip.mp4 --from 3600 --to 4200 --liftoff 3660
 *   npm run webcast:listen -- --url 'https://youtube.com/watch?v=…' --model tiny
 *
 * Requires: ffmpeg; optional yt-dlp for --url.
 * ASR: cue/.venv-webcast with faster-whisper (see README in src/webcast/).
 *
 * Prints human lines + optional NDJSON (--json).
 */

import { spawn } from "child_process";
import { copyFileSync, existsSync, readFileSync } from "fs";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { extractAudioWav } from "../src/webcast/extract-audio.js";
import {
  formatClock,
  gateHitAgainstScript,
  matchPhrases,
  normalizePhraseBook,
  scriptTPlusByAction,
} from "../src/webcast/match.js";
import { createLiftoffMarker } from "../src/webcast/mark-liftoff.js";
import { logError, logInfo, logWarn } from "cue/log.js";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
/** Monorepo root (apps/tplus → ../..) — .venv-webcast lives here */
const REPO_ROOT = resolve(APP_ROOT, "../..");
const ROOT = APP_ROOT;
const PHRASES_FALCON = join(
  ROOT,
  "src/webcast/phrases/falcon-default.json",
);
const PHRASES_STARSHIP = join(
  ROOT,
  "src/webcast/phrases/starship-default.json",
);
const DEFAULT_MISSION = join(
  ROOT,
  "missions/flights/roman-fh-script.json",
);
const DEFAULT_VENV_PY = join(REPO_ROOT, ".venv-webcast/bin/python");
const ASR_SCRIPT = join(ROOT, "src/webcast/asr_whisper.py");

function parseArgs(argv) {
  /** @type {Record<string, string|boolean|null>} */
  const out = {
    file: null,
    url: null,
    phrases: null, // null → auto from mission (starship vs falcon)
    mission: DEFAULT_MISSION,
    model: process.env.WEBCAST_WHISPER_MODEL || "base",
    from: null,
    to: null,
    liftoff: null,
    gateSec: process.env.WEBCAST_GATE_SEC || "60",
    noGate: false,
    showGated: false,
    markLiftoff: false,
    json: false,
    keepWav: false,
    device: process.env.WEBCAST_WHISPER_DEVICE || "cpu",
    python: process.env.WEBCAST_PYTHON || DEFAULT_VENV_PY,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--file") out.file = next();
    else if (a === "--url") out.url = next();
    else if (a === "--phrases") out.phrases = next();
    else if (a === "--mission") out.mission = next();
    else if (a === "--model") out.model = next();
    else if (a === "--from") out.from = next();
    else if (a === "--to") out.to = next();
    else if (a === "--liftoff") out.liftoff = next();
    else if (a === "--gate-sec") out.gateSec = next();
    else if (a === "--no-gate") out.noGate = true;
    else if (a === "--show-gated") out.showGated = true;
    else if (a === "--mark-liftoff") out.markLiftoff = true;
    else if (a === "--device") out.device = next();
    else if (a === "--python") out.python = next();
    else if (a === "--json") out.json = true;
    else if (a === "--keep-wav") out.keepWav = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-") && !out.file) out.file = a;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  webcast-listen --file <video|audio> [options]
  webcast-listen --url <youtube-or-http> [options]

Options:
  --from SEC          Start offset in source file
  --to SEC            End offset in source file
  --liftoff SEC       File offset of liftoff (T+/- clocks + script gate)
  --mark-liftoff      Interactive: S=sync eyes to audio start, L=mark T+0
                        (wall-clock; buffers hits until marked). Live shadow.
  --mission PATH      Mission script JSON (default: roman-fh)
  --gate-sec N        Keep hits within ±N sec of script T+ (default: 60)
  --no-gate           Disable script T± filtering
  --show-gated        Print suppressed hits (prefix GATED)
  --phrases PATH      Phrase book JSON (default: auto from mission —
                        starship-* → starship-default, else falcon-default)
  --model NAME        Whisper model: tiny|base|small|… (default: base)
  --device cpu|cuda
  --python PATH       Python with faster-whisper (default: .venv-webcast)
  --json              Emit NDJSON events
  --keep-wav          Keep extracted wav under /tmp
`);
}

/**
 * Resolve --mission path (file path or missions/flights/<id>-script.json).
 * @param {string} ref
 */
function resolveMissionPath(ref) {
  const s = String(ref || "").trim();
  if (!s) return DEFAULT_MISSION;
  if (existsSync(s)) return resolve(s);
  const asPath = resolve(s);
  if (existsSync(asPath)) return asPath;
  const byId = join(ROOT, "missions/flights", `${s}-script.json`);
  if (existsSync(byId)) return byId;
  const byId2 = join(ROOT, "missions/flights", `${s}.json`);
  if (existsSync(byId2)) return byId2;
  throw new Error(`Mission script not found: ${s}`);
}

/**
 * Pick phrase book from explicit --phrases or mission id/vehicle.
 * @param {string|null} phrasesArg
 * @param {{ missionId?: string, vehicle?: string, missionName?: string }} scriptDoc
 */
function resolvePhraseBookPath(phrasesArg, scriptDoc) {
  if (phrasesArg) {
    const s = String(phrasesArg).trim();
    if (existsSync(s)) return resolve(s);
    const asPath = resolve(s);
    if (existsSync(asPath)) return asPath;
    const byId = join(ROOT, "src/webcast/phrases", `${s}.json`);
    if (existsSync(byId)) return byId;
    const byId2 = join(ROOT, "src/webcast/phrases", `${s}-default.json`);
    if (existsSync(byId2)) return byId2;
    throw new Error(`Phrase book not found: ${s}`);
  }
  const blob = [
    scriptDoc?.missionId,
    scriptDoc?.vehicle,
    scriptDoc?.missionName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (/\bstarship\b|\bsuper heavy\b/.test(blob)) return PHRASES_STARSHIP;
  return PHRASES_FALCON;
}

function resolveYtDlp() {
  if (process.env.YT_DLP) return process.env.YT_DLP;
  const venv = join(REPO_ROOT, ".venv-webcast/bin/yt-dlp");
  if (existsSync(venv)) return venv;
  return "yt-dlp";
}

async function downloadUrl(url, outDir) {
  const ytdlp = resolveYtDlp();
  const outTpl = join(outDir, "source.%(ext)s");
  // X SpaceX broadcasts often expose replay-* video+audio only (no separate audio).
  // Prefer modest A/V then ffmpeg extracts wav.
  await runCmd(ytdlp, [
    "-f",
    "bestaudio/best[height<=720]/best",
    "--no-playlist",
    "-o",
    outTpl,
    url,
  ]);
  // Find downloaded file
  const { readdir } = await import("fs/promises");
  const files = await readdir(outDir);
  const hit = files.find((f) => f.startsWith("source."));
  if (!hit) throw new Error("yt-dlp finished but no source.* file found");
  return join(outDir, hit);
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Command not found: ${cmd}. Install it or set YT_DLP / PATH.`,
          ),
        );
      } else reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

/**
 * Stream ASR JSON lines from Python helper.
 * @param {string} python
 * @param {string} audioPath
 * @param {{ model: string, device: string }} opts
 * @param {(obj: object) => void} onLine
 */
function runAsr(python, audioPath, opts, onLine) {
  return new Promise((resolve, reject) => {
    if (!existsSync(python)) {
      reject(
        new Error(
          `Python not found: ${python}\nCreate venv:\n  python3 -m venv .venv-webcast && .venv-webcast/bin/pip install faster-whisper`,
        ),
      );
      return;
    }
    const child = spawn(
      python,
      [
        ASR_SCRIPT,
        "--audio",
        audioPath,
        "--model",
        opts.model,
        "--device",
        opts.device,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        onLine(JSON.parse(line));
      } catch {
        logWarn("bad ASR line:", line.slice(0, 120));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`asr_whisper.py exited ${code}`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.file && !args.url)) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  const missionPath = resolveMissionPath(String(args.mission));
  const scriptDoc = JSON.parse(readFileSync(missionPath, "utf8"));
  const phrasesPath = resolvePhraseBookPath(
    args.phrases != null ? String(args.phrases) : null,
    scriptDoc,
  );
  const book = normalizePhraseBook(
    JSON.parse(readFileSync(phrasesPath, "utf8")),
  );
  const scriptTPlus = scriptTPlusByAction(scriptDoc);
  const gateSec = Number(args.gateSec);
  const markMode = Boolean(args.markLiftoff);

  const work = await mkdtemp(join(tmpdir(), "cue-webcast-"));
  let sourcePath = args.file ? resolve(String(args.file)) : null;
  const fromSec = args.from != null ? Number(args.from) : null;
  const toSec = args.to != null ? Number(args.to) : null;
  const initialLiftoff =
    args.liftoff != null && Number.isFinite(Number(args.liftoff))
      ? Number(args.liftoff)
      : null;

  const marker = markMode
    ? createLiftoffMarker({
        fromSec: fromSec ?? 0,
        initialLiftoffSec: initialLiftoff,
        log: (msg) => logInfo(msg),
      })
    : null;

  /** Mutable: updated when user marks liftoff */
  let liftoffSec = initialLiftoff;

  function gateActive() {
    return (
      !args.noGate &&
      liftoffSec != null &&
      Number.isFinite(liftoffSec) &&
      scriptTPlus.size > 0
    );
  }

  let disposeMark = () => {};
  /** @type {Record<string, number>} */
  let lastHitById = {};
  let segments = 0;
  let hitCount = 0;
  let gatedCount = 0;

  /**
   * @param {object} hit
   * @param {number} tSec
   */
  function emitHit(hit, tSec) {
    const lift = liftoffSec;
    const tPlusSec =
      lift != null && Number.isFinite(lift) ? tSec - lift : null;
    const clock = formatClock(hit.tSec, lift);
    let gate = { ok: true, nominalTPlus: null, deltaSec: null };
    if (gateActive()) {
      gate = gateHitAgainstScript(hit, {
        tPlusSec,
        scriptTPlus,
        gateSec,
      });
    }

    if (!gate.ok) {
      gatedCount += 1;
      if (args.showGated || args.json) {
        const why =
          gate.reason === "outside-window"
            ? `Δ${gate.deltaSec >= 0 ? "+" : ""}${Math.round(gate.deltaSec)}s vs script ${formatClock(lift + gate.nominalTPlus, lift)}`
            : gate.reason;
        if (args.showGated) {
          console.log(
            `GATED ${clock}  ${hit.phraseId} suggest=${hit.actionId || "—"}  (${why})  raw="${String(hit.raw).replace(/\s+/g, " ").trim()}"`,
          );
        }
        if (args.json) {
          console.log(
            JSON.stringify({
              type: "gated",
              ...hit,
              clock,
              tPlusSec,
              gate,
            }),
          );
        }
      }
      return;
    }

    hitCount += 1;
    const suggest = hit.actionId ? ` suggest=${hit.actionId}` : " suggest=—";
    const delta =
      gate.deltaSec != null && Number.isFinite(gate.deltaSec)
        ? ` Δ${gate.deltaSec >= 0 ? "+" : ""}${Math.round(gate.deltaSec)}s`
        : "";
    const line = `${clock}  [${hit.severity}] ${hit.phraseId}${suggest}${delta}  pattern="${hit.pattern}"  raw="${String(hit.raw).replace(/\s+/g, " ").trim()}"`;
    console.log(line);
    if (args.json) {
      console.log(
        JSON.stringify({
          type: "hit",
          ...hit,
          clock,
          tPlusSec,
          gate,
        }),
      );
    }
  }

  function flushMarkerPending() {
    if (!marker) return;
    liftoffSec = marker.getLiftoffSec();
    const n = marker.flushPending((item) => emitHit(item.hit, item.tSec));
    if (n) logInfo(`Flushed ${n} buffered hit(s) through gate`);
  }

  try {
    if (args.url) {
      logInfo("Downloading audio/video…", args.url);
      sourcePath = await downloadUrl(String(args.url), work);
    }
    if (!sourcePath || !existsSync(sourcePath)) {
      throw new Error(`Source not found: ${sourcePath}`);
    }

    const wavPath = join(work, "audio.wav");
    logInfo(
      `Extracting wav…${fromSec != null ? ` from=${fromSec}` : ""}${toSec != null ? ` to=${toSec}` : ""}`,
    );
    await extractAudioWav(sourcePath, wavPath, {
      fromSec,
      toSec,
    });

    if (marker) {
      marker.setOnMarked(() => flushMarkerPending());
      disposeMark = marker.attachStdin();
    }

    logInfo(
      `ASR model=${args.model} device=${args.device} phrases=${book.id} (${book.phrases.length})`,
    );
    logInfo(
      `Mission ${scriptDoc.missionId || basename(missionPath)} · script milestones=${scriptTPlus.size}` +
        (gateActive()
          ? ` · gate=±${gateSec}s`
          : args.noGate
            ? " · gate=off (--no-gate)"
            : markMode
              ? " · gate=waiting for liftoff mark (S then L)"
              : " · gate=off (pass --liftoff or --mark-liftoff)"),
    );

    await runAsr(
      String(args.python),
      wavPath,
      { model: String(args.model), device: String(args.device) },
      (obj) => {
        if (obj.type === "meta") {
          logInfo(
            `ASR ready language=${obj.language || "?"} duration=${obj.duration ?? "?"}`,
          );
          return;
        }
        if (obj.type !== "segment") return;
        segments += 1;
        // Timestamps are relative to extracted wav → add --from offset
        const base = fromSec != null ? fromSec : 0;
        const tSec = base + Number(obj.start);
        if (marker?.ready()) liftoffSec = marker.getLiftoffSec();

        const { hits, lastHitById: next } = matchPhrases(obj.text, book, {
          tSec,
          lastHitById,
        });
        lastHitById = next;

        const lift = liftoffSec;
        const tPlusSec =
          lift != null && Number.isFinite(lift) ? tSec - lift : null;

        if (args.json) {
          console.log(
            JSON.stringify({
              type: "segment",
              tSec,
              tPlusSec,
              start: obj.start,
              end: obj.end,
              text: obj.text,
            }),
          );
        }

        for (const hit of hits) {
          if (marker && !marker.ready()) {
            marker.pushHit({ hit, tSec }, (item) => emitHit(item.hit, item.tSec));
            if (args.showGated) {
              console.log(
                `PENDING ${formatClock(hit.tSec, null)}  ${hit.phraseId} suggest=${hit.actionId || "—"}  (waiting for liftoff mark)  raw="${String(hit.raw).replace(/\s+/g, " ").trim()}"`,
              );
            }
            continue;
          }
          emitHit(hit, tSec);
        }
      },
    );

    if (marker && !marker.ready()) {
      if (!process.stdin.isTTY) {
        logWarn(
          `ASR done with ${marker.pendingCount()} pending hit(s) but no TTY to mark liftoff — pass --liftoff`,
        );
      } else {
        logInfo(
          `ASR finished with ${marker.pendingCount()} pending hit(s) — mark liftoff now (L / mm:ss), then results flush`,
        );
        await marker.waitUntilReady();
        flushMarkerPending();
      }
    } else if (marker?.ready()) {
      flushMarkerPending();
    }

    logInfo(
      `Done · segments=${segments} hits=${hitCount}` +
        (gateActive() || gatedCount ? ` gated=${gatedCount}` : "") +
        (liftoffSec != null ? ` liftoff@${Math.round(liftoffSec)}s` : ""),
    );

    if (args.keepWav) {
      const keepDir = join(tmpdir(), "cue-webcast-keep");
      await mkdir(keepDir, { recursive: true });
      const dest = join(keepDir, `${basename(sourcePath)}-${Date.now()}.wav`);
      copyFileSync(wavPath, dest);
      logInfo("Kept wav:", dest);
    }
  } finally {
    disposeMark();
    if (!args.keepWav) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((err) => {
  logError(err.message || err);
  process.exit(1);
});
