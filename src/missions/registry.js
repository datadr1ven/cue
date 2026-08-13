/**
 * Mission catalog: index.json + per-flight script JSON under missions/.
 */

import { readFileSync, existsSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { actionById } from "../engine/domains/starship/actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MISSIONS_ROOT = join(__dirname, "..", "..", "missions");

/**
 * @param {string} [root]
 */
export function loadIndex(root = MISSIONS_ROOT) {
  const indexPath = join(root, "index.json");
  if (!existsSync(indexPath)) {
    throw new Error(`Mission index not found: ${indexPath}`);
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  if (!Array.isArray(index.missions)) {
    throw new Error("index.json: missions[] required");
  }
  return index;
}

/**
 * @param {string|number} ref - mission id, number, or "latest" / "default"
 * @param {string} [root]
 */
export function resolveMissionRef(ref, root = MISSIONS_ROOT) {
  const index = loadIndex(root);
  if (ref == null || ref === "" || ref === "default" || ref === "latest") {
    const id = index.defaultMissionId || index.missions.at(-1)?.id;
    return index.missions.find((m) => m.id === id) || null;
  }
  const s = String(ref).trim();
  const asNum = Number(s);
  if (Number.isFinite(asNum) && String(asNum) === s) {
    return index.missions.find((m) => m.number === asNum) || null;
  }
  return (
    index.missions.find((m) => m.id === s) ||
    index.missions.find((m) => m.id.endsWith(`-${s}`)) ||
    null
  );
}

/**
 * @param {object} entry - index entry
 * @param {string} [root]
 */
export function loadMissionDoc(entry, root = MISSIONS_ROOT) {
  if (!entry?.file) throw new Error("Mission entry missing file");
  const path = join(root, entry.file);
  if (!existsSync(path)) throw new Error(`Mission file not found: ${path}`);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return { entry, path, doc };
}

/**
 * @param {string|number} ref
 * @param {string} [root]
 */
export function loadMission(ref, root = MISSIONS_ROOT) {
  const entry = resolveMissionRef(ref, root);
  if (!entry) return null;
  return loadMissionDoc(entry, root);
}

export function listMissions(root = MISSIONS_ROOT) {
  const index = loadIndex(root);
  return index.missions.map((m) => ({
    ...m,
    isDefault: m.id === index.defaultMissionId,
  }));
}

/**
 * Map actionId → nominal tPlusSec from mission script.
 * @param {object} doc
 */
export function scriptTPlusMap(doc) {
  /** @type {Map<string, number>} */
  const map = new Map();
  for (const row of doc?.script || []) {
    if (row.actionId != null && row.tPlusSec != null) {
      map.set(row.actionId, Number(row.tPlusSec));
    }
  }
  return map;
}

/**
 * Validate index + one or all mission files.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validateMissions(root = MISSIONS_ROOT, onlyId = null) {
  const errors = [];
  const warnings = [];
  let index;
  try {
    index = loadIndex(root);
  } catch (e) {
    return { ok: false, errors: [e.message], warnings };
  }

  if (index.defaultMissionId) {
    const d = index.missions.find((m) => m.id === index.defaultMissionId);
    if (!d) errors.push(`defaultMissionId not in missions: ${index.defaultMissionId}`);
  }

  const seenIds = new Set();
  const seenNums = new Set();
  for (const m of index.missions) {
    if (!m.id) errors.push("mission missing id");
    if (seenIds.has(m.id)) errors.push(`duplicate mission id: ${m.id}`);
    seenIds.add(m.id);
    if (m.number != null) {
      if (seenNums.has(m.number)) errors.push(`duplicate number: ${m.number}`);
      seenNums.add(m.number);
    }
    if (onlyId && m.id !== onlyId && m.number !== Number(onlyId)) continue;

    try {
      const { doc, path } = loadMissionDoc(m, root);
      validateMissionDoc(doc, path, errors, warnings);
    } catch (e) {
      errors.push(`${m.id}: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @param {object} doc
 * @param {string} path
 * @param {string[]} errors
 * @param {string[]} warnings
 */
export function validateMissionDoc(doc, path, errors = [], warnings = []) {
  const p = path || doc.missionId || "mission";
  if (!doc.missionId) errors.push(`${p}: missionId required`);
  if (!doc.missionName) warnings.push(`${p}: missionName missing`);
  if (!doc.launchApproxUtc) {
    warnings.push(`${p}: launchApproxUtc missing (/eta and hype weaker)`);
  } else if (Number.isNaN(Date.parse(doc.launchApproxUtc))) {
    errors.push(`${p}: launchApproxUtc not parseable ISO date`);
  }
  if (!Array.isArray(doc.script) || doc.script.length === 0) {
    errors.push(`${p}: script[] required and non-empty`);
    return { errors, warnings };
  }

  let lastT = -1;
  const ids = new Set();
  for (const [i, row] of doc.script.entries()) {
    if (!row.actionId) {
      errors.push(`${p}: script[${i}] missing actionId`);
      continue;
    }
    if (ids.has(row.actionId)) {
      warnings.push(`${p}: duplicate actionId in script: ${row.actionId}`);
    }
    ids.add(row.actionId);
    if (actionById(row.actionId) == null && row.actionId !== "note") {
      warnings.push(
        `${p}: script actionId "${row.actionId}" not in STARSHIP_ACTIONS (still ok for display)`,
      );
    }
    if (row.tPlusSec == null || !Number.isFinite(Number(row.tPlusSec))) {
      errors.push(`${p}: script[${i}] (${row.actionId}) tPlusSec required`);
    } else {
      const t = Number(row.tPlusSec);
      if (t < lastT) {
        warnings.push(
          `${p}: script tPlusSec not monotonic at ${row.actionId} (${t} < ${lastT})`,
        );
      }
      lastT = t;
    }
  }

  if (!ids.has("liftoff")) {
    warnings.push(`${p}: script has no liftoff row (T+0 mark still works via ops)`);
  }

  return { errors, warnings };
}

/**
 * Format eta from launchApproxUtc.
 * @param {string|null} iso
 * @param {number} [nowMs]
 */
export function formatEta(iso, nowMs = Date.now()) {
  if (!iso) return { ok: false, text: "No launch time set for this mission (launchApproxUtc)." };
  const target = Date.parse(iso);
  if (Number.isNaN(target)) {
    return { ok: false, text: `Invalid launchApproxUtc: ${iso}` };
  }
  const deltaMs = target - nowMs;
  const abs = Math.abs(deltaMs);
  const sec = Math.floor(abs / 1000);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h || d) parts.push(`${h}h`);
  parts.push(`${m}m`);
  const span = parts.join(" ");
  if (deltaMs > 0) {
    return {
      ok: true,
      text: `T−${span} until NET ${iso} (approx)`,
      deltaMs,
      past: false,
    };
  }
  return {
    ok: true,
    text: `NET ${iso} was ~${span} ago (update launchApproxUtc if slipped)`,
    deltaMs,
    past: true,
  };
}

/**
 * Absolute path helper for external --script files
 */
export function loadMissionFromPath(filePath) {
  const path = resolve(filePath);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return {
    entry: {
      id: doc.missionId,
      label: doc.missionName,
      file: path,
      number: null,
    },
    path,
    doc,
  };
}
