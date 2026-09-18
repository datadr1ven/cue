#!/usr/bin/env node
/**
 * Daily (or on-demand) TPlus webcast scheduler from Launch Library 2.
 *
 *   node bin/schedule-from-ll2.js              # write schedule.json only
 *   node bin/schedule-from-ll2.js --apply-crontab
 *
 * One LL2 call/day by default — well under the free 15/hour cap.
 *
 * Rewrites only the block between:
 *   # BEGIN TPLUS-WEBCAST (managed by schedule-from-ll2)
 *   # END TPLUS-WEBCAST
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import "cue/config.js";
import { ll2Fetch, pickOfficialWebcastUrl } from "../src/missions/ll2.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "../..");
const OUT_DIR = process.env.TPLUS_WEBCAST_DIR || join(REPO, "tplus-webcast");
const SCHEDULE_PATH = join(OUT_DIR, "schedule.json");
const CTL = join(ROOT, "scripts/webcast-ctl.sh");
const CRON_LOG = join(OUT_DIR, "logs/cron.log");
const SCHED_LOG = join(OUT_DIR, "logs/schedule.log");

const BEGIN = "# BEGIN TPLUS-WEBCAST (managed by schedule-from-ll2)";
const END = "# END TPLUS-WEBCAST";

const LEAD_MIN = 30;
const TRAIL_MIN = 30;
const HORIZON_H = Number(process.env.TPLUS_SCHEDULE_HORIZON_H || 72);
const MAX_LAUNCHES = Number(process.env.TPLUS_SCHEDULE_MAX || 8);

/** LL2 status abbrevs to skip (too vague / already done) */
const SKIP_STATUS = new Set([
  "Success",
  "Failure",
  "Partial Failure",
  "TBD", // often month-level placeholder
]);

/** Terminal / do-not-webcast statuses for --check-start */
const CANCEL_STATUS = new Set([
  ...SKIP_STATUS,
  "Cancelled",
  "Canceled",
  "Withdrawn",
  "Abandoned",
]);

/** Extra minutes beyond LEAD_MIN before we call a start "too early" vs new NET */
const CHECK_SLACK_MIN = 10;

/** Exit codes for --check-start (webcast-ctl.sh) */
export const CHECK_GO = 0;
export const CHECK_SLIP = 75; // NET moved later — reschedule, do not start
export const CHECK_CANCEL = 76; // scrubbed / done / past window — refresh, do not start

function parseArgs(argv) {
  const out = {
    apply: false,
    dryRun: false,
    horizonH: HORIZON_H,
    checkStartId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply-crontab") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--horizon-h") out.horizonH = Number(argv[++i]);
    else if (a === "--check-start") out.checkStartId = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function runKeyForId(id) {
  return `ll2-${String(id).slice(0, 8)}`;
}

function toCronLocal(d) {
  // cron in local machine TZ (America/Denver on this host)
  return {
    minute: d.getMinutes(),
    hour: d.getHours(),
    day: d.getDate(),
    month: d.getMonth() + 1,
    line: `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`,
  };
}

function addMinutes(date, mins) {
  return new Date(date.getTime() + mins * 60 * 1000);
}

/**
 * @param {object} launch
 * @param {Date} now
 * @param {number} horizonH
 */
function considerLaunch(launch, now, horizonH) {
  const reasons = [];
  const status = launch.status?.abbrev || launch.status?.name || "";
  if (SKIP_STATUS.has(status)) {
    return { ok: false, reason: `status=${status}` };
  }

  const netStr = launch.net || launch.window_start;
  if (!netStr) return { ok: false, reason: "no net" };
  const net = new Date(netStr);
  if (Number.isNaN(net.getTime())) return { ok: false, reason: "bad net" };

  const windowEnd = new Date(launch.window_end || netStr);
  const horizonEnd = addMinutes(now, horizonH * 60);
  // Allow slight past (scrub slip / still in window)
  if (windowEnd.getTime() < now.getTime() - 60 * 60 * 1000) {
    return { ok: false, reason: "window already ended" };
  }
  if (net.getTime() > horizonEnd.getTime()) {
    return { ok: false, reason: `net beyond ${horizonH}h horizon` };
  }

  const precision = launch.net_precision?.abbrev || launch.net_precision?.name || "";
  if (["Month", "Quarter", "Half", "Year", "M", "Q", "Y"].includes(precision)) {
    return { ok: false, reason: `precision=${precision}` };
  }

  const webcastUrl = pickOfficialWebcastUrl(launch, { officialOnly: true });
  if (!webcastUrl) {
    return { ok: false, reason: "no Official Webcast" };
  }

  const timeline = launch.timeline || [];
  if (!timeline.length) {
    return { ok: false, reason: "empty timeline" };
  }

  const startAt = addMinutes(net, -LEAD_MIN);
  const stopAt = addMinutes(windowEnd, TRAIL_MIN);
  if (stopAt <= startAt) {
    return { ok: false, reason: "stop <= start" };
  }

  return {
    ok: true,
    warnings: reasons,
    entry: {
      ll2Id: launch.id,
      slug: launch.slug || null,
      name: launch.name,
      missionName: launch.mission?.name || null,
      lsp: launch.launch_service_provider?.name || null,
      status,
      net: net.toISOString(),
      windowEnd: windowEnd.toISOString(),
      webcastUrl,
      timelineEvents: timeline.length,
      runKey: runKeyForId(launch.id),
      startAt: startAt.toISOString(),
      stopAt: stopAt.toISOString(),
      cronStart: toCronLocal(startAt).line,
      cronStop: toCronLocal(stopAt).line,
    },
  };
}

function buildCrontabBlock(entries) {
  const lines = [
    BEGIN,
    `# Regenerated by schedule-from-ll2 · horizon=${HORIZON_H}h · lead=${LEAD_MIN}m trail=${TRAIL_MIN}m`,
    `# Do not hand-edit inside markers — run: npm run schedule:tplus -w tplus -- --apply-crontab`,
    `SHELL=/bin/bash`,
    `PATH=${REPO}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    `MAILTO=""`,
    `# CUE_ROOT/OUT_DIR: ctl also self-locates; set here so cron matches this checkout`,
    `CUE_ROOT=${REPO}`,
    `OUT_DIR=${OUT_DIR}`,
    ``,
  ];
  for (const e of entries) {
    const label = e.missionName || e.name;
    lines.push(
      `# ${label} · ${e.lsp || "?"} · NET ${e.net} · ${e.webcastUrl}`,
    );
    lines.push(
      `${e.cronStart} ${CTL} start --ll2-id ${e.ll2Id} >> ${CRON_LOG} 2>&1`,
    );
    lines.push(
      `${e.cronStop} ${CTL} stop ${e.runKey} >> ${CRON_LOG} 2>&1`,
    );
    lines.push("");
  }
  if (!entries.length) {
    lines.push("# (no launches with Official Webcast in horizon)");
    lines.push("");
  }
  lines.push(END);
  return lines.join("\n") + "\n";
}

function mergeCrontab(existing, block) {
  const text = existing.endsWith("\n") ? existing : existing + "\n";
  const beginIdx = text.indexOf(BEGIN);
  const endIdx = text.indexOf(END);

  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = text.slice(0, beginIdx).replace(/\n+$/, "\n\n");
    const after = text.slice(endIdx + END.length).replace(/^\n+/, "\n");
    return before + block + after;
  }

  // Migrate: strip old hand-managed TPlus webcast-ctl lines + header comments
  const kept = text
    .split("\n")
    .filter((line) => {
      if (line.includes("webcast-ctl.sh")) return false;
      if (line.includes("TPlus webcast")) return false;
      if (line.includes("Follow: tail -f") && line.includes("tplus-webcast"))
        return false;
      if (line.includes("O3b mPOWER —")) return false;
      if (line.includes("Vega-C Sentinel")) return false;
      if (line.includes("USSF-259 —")) return false;
      if (line.includes("Starlink 15-27 —")) return false;
      if (line.includes("Official webcast: YouTube")) return false;
      if (line.includes("T−30 → window close")) return false;
      if (line.includes("T−30 → NET+30")) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "\n");

  return kept + "\n" + block;
}

function readCrontab() {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch (e) {
    // empty crontab exits 1 on some systems
    return "";
  }
}

function writeCrontab(content) {
  execFileSync("crontab", ["-"], { input: content, encoding: "utf8" });
}

/**
 * Pre-start gate for webcast-ctl: fresh LL2 NET/window/status.
 * @param {string} ll2Id
 * @returns {Promise<{ code: number, action: string, reason: string, launch?: object }>}
 */
async function checkStart(ll2Id) {
  const launch = await ll2Fetch(`/launch/${encodeURIComponent(ll2Id)}/`);
  const status = launch.status?.abbrev || launch.status?.name || "";
  const netStr = launch.net || launch.window_start;
  const net = netStr ? new Date(netStr) : null;
  const windowEnd = new Date(launch.window_end || netStr || 0);
  const now = new Date();
  const name = launch.name || ll2Id;

  if (CANCEL_STATUS.has(status)) {
    return {
      code: CHECK_CANCEL,
      action: "cancel",
      reason: `status=${status}`,
      launch,
      name,
      net: net?.toISOString() || null,
      windowEnd: windowEnd.toISOString(),
    };
  }
  if (!net || Number.isNaN(net.getTime())) {
    return {
      code: CHECK_CANCEL,
      action: "cancel",
      reason: "no net",
      launch,
      name,
    };
  }
  // Window closed more than an hour ago
  if (windowEnd.getTime() < now.getTime() - 60 * 60 * 1000) {
    return {
      code: CHECK_CANCEL,
      action: "cancel",
      reason: "window ended",
      launch,
      name,
      net: net.toISOString(),
      windowEnd: windowEnd.toISOString(),
    };
  }
  // Start cron fired but NET slipped later — still more than lead+slack away
  const msUntilNet = net.getTime() - now.getTime();
  const tooEarlyMs = (LEAD_MIN + CHECK_SLACK_MIN) * 60 * 1000;
  if (msUntilNet > tooEarlyMs) {
    return {
      code: CHECK_SLIP,
      action: "slip",
      reason: `NET in ${Math.round(msUntilNet / 60000)}m (need ≤${LEAD_MIN + CHECK_SLACK_MIN}m)`,
      launch,
      name,
      net: net.toISOString(),
      windowEnd: windowEnd.toISOString(),
    };
  }
  return {
    code: CHECK_GO,
    action: "go",
    reason: "imminent or in window",
    launch,
    name,
    net: net.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      `Usage: schedule-from-ll2 [--apply-crontab] [--dry-run] [--horizon-h N]
       schedule-from-ll2 --check-start <ll2-uuid>`,
    );
    process.exit(0);
  }

  mkdirSync(join(OUT_DIR, "logs"), { recursive: true });

  if (args.checkStartId) {
    const r = await checkStart(args.checkStartId);
    console.log(
      JSON.stringify(
        {
          action: r.action,
          reason: r.reason,
          name: r.name,
          net: r.net || null,
          windowEnd: r.windowEnd || null,
        },
        null,
        0,
      ),
    );
    console.error(
      `check-start ${r.action}: ${r.name || args.checkStartId} — ${r.reason}`,
    );
    process.exit(r.code);
  }

  const now = new Date();
  console.log(
    `schedule-from-ll2 · ${now.toISOString()} · horizon=${args.horizonH}h`,
  );

  // Single list call — detailed for webcast + timeline fields
  const data = await ll2Fetch(
    `/launch/upcoming/?mode=detailed&limit=20&hide_recent_previous=true`,
  );
  const launches = data.results || [];
  console.log(`LL2 upcoming detailed: ${launches.length}`);

  const selected = [];
  const skipped = [];
  for (const launch of launches) {
    const r = considerLaunch(launch, now, args.horizonH);
    if (r.ok) {
      selected.push(r.entry);
      if (r.warnings?.length) {
        console.log(`  + ${r.entry.name} (warn: ${r.warnings.join("; ")})`);
      } else {
        console.log(`  + ${r.entry.name}`);
      }
    } else {
      skipped.push({ name: launch.name, reason: r.reason });
    }
    if (selected.length >= MAX_LAUNCHES) break;
  }

  selected.sort((a, b) => String(a.net).localeCompare(String(b.net)));

  const schedule = {
    generatedAt: now.toISOString(),
    horizonH: args.horizonH,
    leadMin: LEAD_MIN,
    trailMin: TRAIL_MIN,
    launches: selected,
    skipped: skipped.slice(0, 30),
  };

  if (!args.dryRun) {
    writeFileSync(SCHEDULE_PATH, JSON.stringify(schedule, null, 2) + "\n");
    console.log(`wrote ${SCHEDULE_PATH} (${selected.length} launches)`);
  } else {
    console.log(`dry-run: would write ${selected.length} launches`);
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
      console.log("crontab updated (TPLUS-WEBCAST block replaced)");
    }
  } else if (args.dryRun) {
    console.log("--- crontab block ---");
    console.log(block);
  }

  // Ensure daily planner line exists outside the managed block
  if (args.apply && !args.dryRun) {
    ensurePlannerCron();
  }
}

function ensurePlannerCron() {
  const current = readCrontab();
  // Unique token so we don't match the comment inside the managed block
  const marker = "TPLUS_SCHEDULE_DAILY";
  const planner =
    `0 6 * * * cd ${REPO} && /usr/bin/npm run schedule:tplus -w tplus -- --apply-crontab >> ${SCHED_LOG} 2>&1 # ${marker}`;
  // Already correct for this checkout — leave alone
  if (current.includes(planner)) {
    return;
  }
  // Drop any prior planner line (wrong REPO path, unmarked, etc.) then install
  const cleaned = current
    .split("\n")
    .filter(
      (l) =>
        !l.includes(marker) &&
        !l.includes("npm run schedule:tplus -w tplus -- --apply-crontab") &&
        !l.includes("TPlus daily LL2"),
    )
    .join("\n");
  const next =
    cleaned.replace(/\n+$/, "\n") +
    `\n# TPlus daily LL2 → crontab refresh (06:00 local · ~1 LL2 req/day)\n${planner}\n`;
  writeCrontab(next);
  console.log(
    current.includes(marker)
      ? `updated daily planner cron → cd ${REPO}`
      : "installed daily planner cron (06:00 local)",
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
