#!/usr/bin/env node
/**
 * Daily (or on-demand) GridWhisper session scheduler from OpenF1.
 *
 *   node bin/schedule-from-openf1.js
 *   node bin/schedule-from-openf1.js --apply-crontab
 *
 * Fetches https://api.openf1.org/v1/sessions?year=YYYY, maps Practice/Quali/Race
 * onto session-ctl.sh start|stop lines inside:
 *   # BEGIN GRIDWHISPER-SESSIONS (managed by schedule-from-openf1)
 *   # END GRIDWHISPER-SESSIONS
 *
 * Does not touch the TPLUS-WEBCAST block.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "../..");
const CTL = join(ROOT, "scripts/session-ctl.sh");
const SIGNALR_ROOT = process.env.SIGNALR_ROOT || REPO;
/** Worker feed for session-ctl starts (signalr recommended after Baku MQTT P1 gap). */
const ENGINE_SOURCE = process.env.ENGINE_SOURCE || "signalr";
/** Set after we know which meeting is next (or GRIDWHISPER_CAPTURE_DIR). */
let OUT_DIR =
  process.env.GRIDWHISPER_CAPTURE_DIR || join(REPO, "captures");
let SCHEDULE_PATH = join(OUT_DIR, "schedule.json");
let SCHED_LOG = join(OUT_DIR, "logs", "schedule.log");

const BEGIN = "# BEGIN GRIDWHISPER-SESSIONS (managed by schedule-from-openf1)";
const END = "# END GRIDWHISPER-SESSIONS";
const DAILY_MARKER = "GRIDWHISPER_SCHEDULE_DAILY";

const LEAD_MIN = Number(process.env.GRIDWHISPER_LEAD_MIN || 20);
const TRAIL_MIN = Number(process.env.GRIDWHISPER_TRAIL_MIN || 45);
const HORIZON_H = Number(process.env.GRIDWHISPER_HORIZON_H || 168); // 7d
const OPENF1_SESSIONS_URL =
  process.env.OPENF1_SESSIONS_URL ||
  `https://api.openf1.org/v1/sessions?year=${new Date().getUTCFullYear()}`;

function parseArgs(argv) {
  const out = { apply: false, dryRun: false, horizonH: HORIZON_H };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply-crontab") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--horizon-h") out.horizonH = Number(argv[++i]);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function readCrontab() {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch (e) {
    if (String(e.stderr || e.message || "").includes("no crontab")) return "";
    throw e;
  }
}

function writeCrontab(text) {
  execFileSync("crontab", ["-"], { input: text, encoding: "utf8" });
}

function mergeCrontab(current, block) {
  // Drop legacy BAKU-only block if present
  let cleaned = current.replace(
    /# BEGIN GRIDWHISPER-BAKU[\s\S]*?# END GRIDWHISPER-BAKU\n?/g,
    "",
  );
  const parts = cleaned.split("\n");
  const s = parts.findIndex((l) => l.includes("BEGIN GRIDWHISPER-SESSIONS"));
  const e = parts.findIndex((l) => l.includes("END GRIDWHISPER-SESSIONS"));
  if (s >= 0 && e > s) {
    return [...parts.slice(0, s), ...block.trim().split("\n"), ...parts.slice(e + 1)]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return cleaned.replace(/\n+$/, "\n") + "\n" + block.trim() + "\n";
}

function captureDirFor(entries) {
  if (process.env.GRIDWHISPER_CAPTURE_DIR) {
    return process.env.GRIDWHISPER_CAPTURE_DIR;
  }
  const first = entries[0];
  if (!first?.circuit) return join(REPO, "captures");
  const slug = String(first.circuit)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const year = new Date(first.dateStart).getUTCFullYear();
  return join(REPO, "captures", `${slug}-${year}`);
}

/** @param {Date} d */
function toCronLocal(d) {
  // crontab uses machine local time
  const min = d.getMinutes();
  const hour = d.getHours();
  const dom = d.getDate();
  const mon = d.getMonth() + 1;
  return {
    line: `${min} ${hour} ${dom} ${mon} *`,
    label: d.toString(),
  };
}

function addMinutes(d, n) {
  return new Date(d.getTime() + n * 60_000);
}

/**
 * Map OpenF1 session_name / session_type → session-ctl key.
 * @param {object} s
 * @returns {string|null}
 */
function sessionCtlKey(s) {
  const name = String(s.session_name || "").toLowerCase();
  const type = String(s.session_type || "").toLowerCase();
  if (/practice\s*1|fp1/.test(name) || (type === "practice" && /1/.test(name)))
    return "fp1";
  if (/practice\s*2|fp2/.test(name) || (type === "practice" && /2/.test(name)))
    return "fp2";
  if (/practice\s*3|fp3/.test(name) || (type === "practice" && /3/.test(name)))
    return "fp3";
  if (type === "practice") {
    // fallback: first practice of day without number
    return "fp1";
  }
  if (type === "qualifying" || /qualifying|sprint.?shootout|sprint.?quali/.test(name))
    return "quali";
  if (type === "race" && /sprint/.test(name)) return "sprint";
  if (type === "race" || name === "race") return "race";
  if (type === "sprint") return "sprint";
  return null;
}

/**
 * Unique run slot when multiple meetings share fp1 etc. in horizon —
 * session-ctl uses fp1|fp2|… keys; one meeting at a time in a week is fine.
 * If two meetings overlap in horizon (rare), keep earliest only per key.
 */
function considerSession(s, now, horizonH) {
  const start = s.date_start ? new Date(s.date_start) : null;
  const end = s.date_end ? new Date(s.date_end) : start;
  if (!start || Number.isNaN(start.getTime())) {
    return { ok: false, reason: "no date_start" };
  }
  const key = sessionCtlKey(s);
  if (!key) return { ok: false, reason: `unmapped ${s.session_type}/${s.session_name}` };

  const horizonEnd = new Date(now.getTime() + horizonH * 3600_000);
  // Include sessions that haven't ended yet (or end within trail)
  if (end.getTime() + TRAIL_MIN * 60_000 < now.getTime()) {
    return { ok: false, reason: "already ended" };
  }
  if (start.getTime() > horizonEnd.getTime()) {
    return { ok: false, reason: "beyond horizon" };
  }

  const cronStartAt = addMinutes(start, -LEAD_MIN);
  const cronStopAt = addMinutes(end || start, TRAIL_MIN);
  if (cronStopAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "stop already past" };
  }

  return {
    ok: true,
    entry: {
      key,
      sessionName: s.session_name,
      sessionType: s.session_type,
      sessionKey: s.session_key,
      meetingKey: s.meeting_key,
      country: s.country_name || null,
      circuit: s.circuit_short_name || s.location || null,
      dateStart: start.toISOString(),
      dateEnd: (end || start).toISOString(),
      cronStart: toCronLocal(cronStartAt).line,
      cronStop: toCronLocal(cronStopAt).line,
      cronStartAt: cronStartAt.toISOString(),
      cronStopAt: cronStopAt.toISOString(),
    },
  };
}

function buildCrontabBlock(entries) {
  const lines = [
    BEGIN,
    `# Regenerated by schedule-from-openf1 · horizon=${HORIZON_H}h · lead=${LEAD_MIN}m trail=${TRAIL_MIN}m`,
    `# Do not hand-edit inside markers — run: npm run schedule:gridwhisper -w gridwhisper -- --apply-crontab`,
    `SHELL=/bin/bash`,
    `PATH=${REPO}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    `MAILTO=""`,
    `CUE_ROOT=${REPO}`,
    `SIGNALR_ROOT=${SIGNALR_ROOT}`,
    `ENGINE_SOURCE=${ENGINE_SOURCE}`,
    `OUT_DIR=${OUT_DIR}`,
    `CTL=${CTL}`,
    ``,
  ];
  for (const e of entries) {
    const where = [e.circuit, e.country].filter(Boolean).join(", ");
    lines.push(
      `# ${e.sessionName} · ${where || "?"} · ${e.dateStart} → ${e.dateEnd}`,
    );
    lines.push(
      `${e.cronStart} OUT_DIR=$OUT_DIR SIGNALR_ROOT=$SIGNALR_ROOT ENGINE_SOURCE=$ENGINE_SOURCE $CTL start ${e.key} >> $OUT_DIR/logs/cron.log 2>&1`,
    );
    lines.push(
      `${e.cronStop} OUT_DIR=$OUT_DIR SIGNALR_ROOT=$SIGNALR_ROOT ENGINE_SOURCE=$ENGINE_SOURCE $CTL stop ${e.key} >> $OUT_DIR/logs/cron.log 2>&1`,
    );
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n") + "\n";
}

function ensurePlannerCron() {
  const current = readCrontab();
  const planner =
    `30 5 * * * cd ${REPO} && /usr/bin/npm run schedule:gridwhisper -w gridwhisper -- --apply-crontab >> ${SCHED_LOG} 2>&1 # ${DAILY_MARKER}`;
  if (current.includes(planner)) return;
  const cleaned = current
    .split("\n")
    .filter(
      (l) =>
        !l.includes(DAILY_MARKER) &&
        !l.includes("npm run schedule:gridwhisper") &&
        !l.includes("GridWhisper daily OpenF1"),
    )
    .join("\n");
  const next =
    cleaned.replace(/\n+$/, "\n") +
    `\n# GridWhisper daily OpenF1 → crontab refresh (05:30 local)\n${planner}\n`;
  writeCrontab(next);
  console.log(
    current.includes(DAILY_MARKER)
      ? `updated daily GridWhisper planner → cd ${REPO}`
      : "installed daily GridWhisper planner cron (05:30 local)",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      `Usage: schedule-from-openf1 [--apply-crontab] [--dry-run] [--horizon-h N]`,
    );
    process.exit(0);
  }

  const now = new Date();
  console.log(
    `schedule-from-openf1 · ${now.toISOString()} · horizon=${args.horizonH}h`,
  );
  console.log(`GET ${OPENF1_SESSIONS_URL}`);

  const res = await fetch(OPENF1_SESSIONS_URL);
  if (!res.ok) {
    throw new Error(`OpenF1 sessions ${res.status}`);
  }
  const sessions = await res.json();
  if (!Array.isArray(sessions)) {
    throw new Error("OpenF1 sessions: expected array");
  }
  console.log(`OpenF1 sessions: ${sessions.length}`);

  const selected = [];
  const skipped = [];
  /** @type {Map<string, object>} */
  const byKey = new Map();

  for (const s of sessions) {
    const r = considerSession(s, now, args.horizonH);
    if (!r.ok) {
      skipped.push({
        name: s.session_name,
        reason: r.reason,
        start: s.date_start,
      });
      continue;
    }
    const prev = byKey.get(r.entry.key);
    // Prefer earlier start if duplicate keys in horizon
    if (!prev || r.entry.dateStart < prev.dateStart) {
      byKey.set(r.entry.key, r.entry);
    }
  }

  for (const e of byKey.values()) selected.push(e);
  selected.sort((a, b) => String(a.dateStart).localeCompare(String(b.dateStart)));

  OUT_DIR = captureDirFor(selected);
  SCHEDULE_PATH = join(OUT_DIR, "schedule.json");
  SCHED_LOG = join(OUT_DIR, "logs", "schedule.log");
  mkdirSync(join(OUT_DIR, "logs"), { recursive: true });
  console.log(`OUT_DIR=${OUT_DIR}`);

  for (const e of selected) {
    console.log(
      `  + ${e.key.padEnd(6)} ${e.sessionName} · ${e.circuit || "?"} · ${e.dateStart}`,
    );
  }

  const schedule = {
    generatedAt: now.toISOString(),
    horizonH: args.horizonH,
    leadMin: LEAD_MIN,
    trailMin: TRAIL_MIN,
    source: OPENF1_SESSIONS_URL,
    outDir: OUT_DIR,
    sessions: selected,
    skipped: skipped.filter((s) => s.reason !== "already ended").slice(0, 40),
  };

  if (!args.dryRun) {
    writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2) + "\n");
    console.log(`wrote ${SCHEDULE_PATH} (${selected.length} sessions)`);
  }

  const block = buildCrontabBlock(selected);
  if (args.apply) {
    const current = readCrontab();
    const next = mergeCrontab(current, block);
    if (args.dryRun) {
      console.log("--- crontab block ---");
      console.log(block);
    } else {
      writeCrontab(next);
      console.log("crontab updated (GRIDWHISPER-SESSIONS block replaced)");
      ensurePlannerCron();
    }
  } else if (args.dryRun) {
    console.log("--- crontab block ---");
    console.log(block);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
