#!/usr/bin/env node
/**
 * Offline smoke for LL2 → scriptDoc mapping (no network).
 *
 *   npm run smoke:ll2 -w tplus
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  parseLl2Duration,
  pickOfficialWebcastUrl,
  launchToScriptDoc,
} from "../src/missions/ll2.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(parseLl2Duration("P0D") === 0, "P0D");
assert(parseLl2Duration("PT1M12S") === 72, "PT1M12S");
assert(parseLl2Duration("PT2M27S") === 147, "PT2M27S");
assert(parseLl2Duration("-PT38M") === -2280, "-PT38M");
assert(parseLl2Duration("-PT45S") === -45, "-PT45S");
assert(parseLl2Duration("PT1H51S") === 3651, "PT1H51S");
assert(parseLl2Duration("PT1H57M14S") === 7034, "PT1H57M14S");
assert(parseLl2Duration("nope") == null, "bad duration");
console.log("✓ parseLl2Duration");

const mpower = JSON.parse(
  readFileSync(join(ROOT, "fixtures/ll2/ll2-mpower-detailed.json"), "utf8"),
).results[0];

const official = pickOfficialWebcastUrl(mpower);
assert(
  official === "https://x.com/i/broadcasts/1RKjpbVdykQJw",
  `official webcast want X got ${official}`,
);
assert(
  !pickOfficialWebcastUrl({ vidURLs: mpower.vidURLs.filter((v) => v.type?.name !== "Official Webcast") }),
  "officialOnly finds nothing without Official",
);
console.log("✓ pickOfficialWebcastUrl");

const { scriptDoc, warnings, unmapped } = launchToScriptDoc(mpower);
assert(scriptDoc.missionId, "missionId");
assert(scriptDoc.webcastUrl === official, "webcastUrl");
assert(scriptDoc.launchApproxUtc === mpower.net, "net");
assert(scriptDoc.script.some((r) => r.actionId === "liftoff"), "liftoff");
assert(scriptDoc.script.some((r) => r.actionId === "meco"), "meco");
assert(scriptDoc.script.some((r) => r.actionId === "booster_landing"), "landing");
assert(scriptDoc.script.some((r) => r.actionId === "deploy_start"), "deploy_start");
assert(scriptDoc.script.some((r) => r.actionId === "deploy_done"), "deploy_done");
const ids = scriptDoc.script.map((r) => r.actionId);
assert(new Set(ids).size === ids.length, "unique actionIds");
assert(scriptDoc.countdown.length > 0, "countdown");
console.log(
  `✓ mPOWER scriptDoc events=${scriptDoc.script.length} countdown=${scriptDoc.countdown.length} warnings=${warnings.length} unmapped=${unmapped.length}`,
);

const vega = JSON.parse(
  readFileSync(join(ROOT, "fixtures/ll2/ll2-vega-detailed.json"), "utf8"),
).results[0];
const v = launchToScriptDoc(vega);
assert(v.scriptDoc.webcastUrl?.includes("youtube"), "vega youtube official");
assert(v.scriptDoc.script.some((r) => r.actionId === "liftoff"), "vega liftoff");
console.log(
  `✓ Vega scriptDoc events=${v.scriptDoc.script.length} webcast=${v.scriptDoc.webcastUrl}`,
);

console.log("OK smoke:ll2");
