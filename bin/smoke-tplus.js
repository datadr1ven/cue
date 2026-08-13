#!/usr/bin/env node
/**
 * Offline smoke: missions + session notes/broadcast/hype/eta without Telegram.
 *
 *   npm run smoke:tplus
 */

import {
  listMissions,
  loadMission,
  validateMissions,
  formatEta,
  MISSIONS_ROOT,
} from "../src/missions/registry.js";
import { createStarshipSession } from "../src/starship-session-node.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const v = validateMissions(MISSIONS_ROOT);
assert(v.ok, `validate failed: ${v.errors.join("; ")}`);
console.log("✓ mission registry validates");

const list = listMissions();
assert(list.length >= 2, "expected at least 2 missions");
console.log(`✓ listMissions: ${list.map((m) => m.number).join(", ")}`);

const m12 = loadMission(12);
assert(m12?.doc?.missionId === "starship-flight-12", "load 12");
const m13 = loadMission(13);
assert(m13?.doc?.missionId === "starship-flight-13", "load 13");
console.log("✓ load by number");

const session = createStarshipSession({
  missionRef: 13,
  minSeverity: 1,
});
assert(session.scriptDoc?.missionName, "session has mission");

const alerts = [];
session.pipeline; // warm
const s2 = createStarshipSession({
  missionRef: 13,
  minSeverity: 1,
  onAlert: async (a) => alerts.push(a.text),
});

let r = await s2.fire("liftoff");
assert(r.ok && r.alerts.length === 1, "liftoff");
r = await s2.fireNote("Test freeform note from smoke");
assert(r.ok && /Test freeform/.test(r.alerts[0]?.text || ""), "note");
r = await s2.fireBroadcast("Smoke broadcast hello");
assert(r.ok && /broadcast|Smoke/i.test(r.alerts[0]?.text || ""), "broadcast");
r = await s2.fireHype(48);
assert(!r.ok, "hype should refuse long-past mission");
console.log(`✓ hype blocked on past mission: ${r.error}`);

const eta = formatEta(s2.scriptDoc.launchApproxUtc, Date.now(), {
  missionName: s2.scriptDoc.missionName,
});
assert(eta.text, "eta text");
assert(!/launchApproxUtc|slipped|todo/i.test(eta.text), "no internal jargon in eta");
assert(
  eta.kind === "past" || eta.kind === "upcoming" || eta.kind === "recent",
  `eta kind ${eta.kind}`,
);
console.log(`✓ eta sample (${eta.kind}): ${eta.text}`);

const etaMissing = formatEta(null);
assert(/No upcoming|No launch NET/i.test(etaMissing.text), "missing net copy");
assert(!/launchApproxUtc/i.test(etaMissing.text), "no field name when missing");
console.log(`✓ eta missing NET: ${etaMissing.text}`);

const futureIso = new Date(Date.now() + 3 * 864e5).toISOString();
const etaFuture = formatEta(futureIso, Date.now(), { missionName: "Flight X" });
assert(etaFuture.kind === "upcoming" && /T−/.test(etaFuture.text), "future eta");
console.log(`✓ eta upcoming: ${etaFuture.text}`);

s2.loadMission(12);
assert(s2.scriptDoc.missionId.includes("12"), "switch mission");
console.log("✓ switch mission 13 → 12");

const browse = s2.formatTimeline(12);
assert(browse.includes("Liftoff") || browse.includes("liftoff") || browse.length > 20, "timeline");
console.log("✓ format timeline");

console.log(`✓ alerts fired: ${alerts.length}`);
console.log("OK smoke:tplus");
