/**
 * Extract mono 16 kHz wav from video/audio via ffmpeg.
 */

import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { dirname } from "path";

/**
 * @param {string} inputPath
 * @param {string} outWav
 * @param {{ fromSec?: number|null, toSec?: number|null }} [opts]
 * @returns {Promise<void>}
 */
export function extractAudioWav(inputPath, outWav, opts = {}) {
  return new Promise(async (resolve, reject) => {
    await mkdir(dirname(outWav), { recursive: true });
    /** @type {string[]} */
    const args = ["-y", "-hide_banner", "-loglevel", "error"];
    if (opts.fromSec != null && Number.isFinite(opts.fromSec)) {
      args.push("-ss", String(opts.fromSec));
    }
    args.push("-i", inputPath);
    if (opts.toSec != null && Number.isFinite(opts.toSec)) {
      const from = opts.fromSec != null ? Number(opts.fromSec) : 0;
      const dur = Number(opts.toSec) - from;
      if (dur > 0) args.push("-t", String(dur));
    }
    args.push(
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      outWav,
    );

    const child = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}
