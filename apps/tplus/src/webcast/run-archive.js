/**
 * Durable on-disk archive for a webcast:live run.
 *
 *   <runDir>/
 *     meta.json
 *     script.json
 *     ll2-raw.json          (optional)
 *     events.ndjson
 *     suggest/<actionId>.json
 *     frames/              (optional stills)
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * @param {object} opts
 * @param {string} opts.parentDir  e.g. …/tplus-webcast/runs
 * @param {string} opts.missionId
 * @param {string} [opts.mode]
 * @param {string} [opts.webcastUrl]
 * @returns {{ runId: string, runDir: string, appendEvent: Function, writeMeta: Function, writeScript: Function, writeLl2Raw: Function, writeSuggest: Function, saveFrame: Function, finalize: Function }}
 */
export function createRunArchive(opts) {
  const parentDir = opts.parentDir;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeId = String(opts.missionId || "run")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 60);
  const runId = `${stamp}-${safeId}`;
  const runDir = join(parentDir, runId);
  const suggestDir = join(runDir, "suggest");
  const framesDir = join(runDir, "frames");
  mkdirSync(suggestDir, { recursive: true });
  mkdirSync(framesDir, { recursive: true });

  const startedAt = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  let meta = {
    runId,
    startedAt,
    endedAt: null,
    missionId: opts.missionId || null,
    missionName: opts.missionName || null,
    mode: opts.mode || null,
    webcastUrl: opts.webcastUrl || null,
    ll2LaunchId: opts.ll2LaunchId || null,
    dryRun: Boolean(opts.dryRun),
    pid: process.pid,
  };

  writeJson(join(runDir, "meta.json"), meta);

  function appendEvent(type, payload = {}) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      type,
      ...payload,
    });
    appendFileSync(join(runDir, "events.ndjson"), line + "\n");
  }

  function writeMeta(patch = {}) {
    meta = { ...meta, ...patch };
    writeJson(join(runDir, "meta.json"), meta);
  }

  function writeScript(scriptDoc) {
    writeJson(join(runDir, "script.json"), scriptDoc);
  }

  function writeLl2Raw(launch) {
    if (!launch) return;
    writeJson(join(runDir, "ll2-raw.json"), launch);
  }

  function writeSuggest(actionId, requestBody, response) {
    const safe = String(actionId || "unknown").replace(/[^a-zA-Z0-9._-]+/g, "_");
    writeJson(join(suggestDir, `${safe}.json`), {
      t: new Date().toISOString(),
      request: requestBody,
      response: response ?? null,
    });
  }

  /**
   * Copy a still into frames/ (best-effort).
   * @param {string} srcPath
   * @param {string} name e.g. meco.jpg
   */
  function saveFrame(srcPath, name) {
    if (!srcPath || !existsSync(srcPath)) return null;
    const dest = join(framesDir, name);
    try {
      copyFileSync(srcPath, dest);
      return dest;
    } catch {
      return null;
    }
  }

  function finalize(patch = {}) {
    writeMeta({
      endedAt: new Date().toISOString(),
      ...patch,
    });
    appendEvent("run_end", patch);
  }

  appendEvent("run_start", {
    missionId: meta.missionId,
    mode: meta.mode,
    webcastUrl: meta.webcastUrl,
  });

  return {
    runId,
    runDir,
    appendEvent,
    writeMeta,
    writeScript,
    writeLl2Raw,
    writeSuggest,
    saveFrame,
    finalize,
  };
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
