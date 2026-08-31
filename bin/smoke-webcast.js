#!/usr/bin/env node
/**
 * Offline smoke for webcast phrase match + script T± gate (no Whisper).
 *
 *   npm run smoke:webcast
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  formatClock,
  gateHitAgainstScript,
  matchPhrases,
  normalizePhraseBook,
  scriptTPlusByAction,
} from "../src/webcast/match.js";
import {
  createLiftoffMarker,
  parseClockOffset,
} from "../src/webcast/mark-liftoff.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const book = normalizePhraseBook(
  JSON.parse(
    readFileSync(join(root, "src/webcast/phrases/falcon-default.json"), "utf8"),
  ),
);
const starshipBook = normalizePhraseBook(
  JSON.parse(
    readFileSync(
      join(root, "src/webcast/phrases/starship-default.json"),
      "utf8",
    ),
  ),
);
const roman = JSON.parse(
  readFileSync(join(root, "missions/flights/roman-fh-script.json"), "utf8"),
);
const flight13 = JSON.parse(
  readFileSync(
    join(root, "missions/flights/starship-flight-13-script.json"),
    "utf8",
  ),
);
const scriptTPlus = scriptTPlusByAction(roman);
const ssTPlus = scriptTPlusByAction(flight13);

assert(scriptTPlus.get("liftoff") === 0, "roman liftoff T+0");
assert(scriptTPlus.get("meco") === 231, "roman meco");
assert(scriptTPlus.get("booster_landing") === 460, "roman landing");

// Word boundary: seco must not match "seconds"
{
  const { hits } = matchPhrases("T plus two minutes thirty seconds", book, {
    tSec: 100,
  });
  assert(!hits.some((h) => h.phraseId === "seco"), "seco≠seconds");
}

// Real MECO phrase hits
{
  const { hits } = matchPhrases("Main engine cutoff, MECO", book, { tSec: 50 });
  assert(hits.some((h) => h.actionId === "meco"), "meco pattern");
}

// Host spoiler early: "MECO" at T+10 while nominal is 231 → gated out
{
  const hit = { actionId: "meco", phraseId: "meco" };
  const early = gateHitAgainstScript(hit, {
    tPlusSec: 10,
    scriptTPlus,
    gateSec: 60,
  });
  assert(early.ok === false && early.reason === "outside-window", "early MECO gated");
  assert(Math.abs(early.deltaSec) > 60, "delta large");
}

// On-time MECO within ±60s of 231
{
  const hit = { actionId: "meco", phraseId: "meco" };
  const ok = gateHitAgainstScript(hit, {
    tPlusSec: 240,
    scriptTPlus,
    gateSec: 60,
  });
  assert(ok.ok === true, "on-time MECO allowed");
  assert(ok.nominalTPlus === 231, "nominal attached");
}

// hold always allowed far from script
{
  const hold = gateHitAgainstScript(
    { actionId: "hold" },
    { tPlusSec: -600, scriptTPlus, gateSec: 60 },
  );
  assert(hold.ok === true, "hold ungated");
}

// "nominal" → success not in roman script → suppressed when gating
{
  const nom = gateHitAgainstScript(
    { actionId: "success" },
    { tPlusSec: 100, scriptTPlus, gateSec: 60 },
  );
  assert(nom.ok === false && nom.reason === "not-in-script", "success not in script");
}

// Bare "nominal" / landing-leg "deploy" must not match anymore
{
  const { hits: h1 } = matchPhrases("M1D chamber pressure is nominal.", book, {
    tSec: 10,
  });
  assert(!h1.some((h) => h.phraseId === "nominal"), "bare nominal ignored");
  const { hits: h2 } = matchPhrases("Landing leg deploy.", book, { tSec: 20 });
  assert(!h2.some((h) => h.phraseId === "deploy"), "leg deploy ignored");
  const { hits: h3 } = matchPhrases("Starlink satellites deploy", book, {
    tSec: 30,
  });
  assert(h3.some((h) => h.actionId === "deploy_start"), "satellites deploy kept");
}

assert(formatClock(3660, 3600) === "T+01:00", "format T+");
assert(formatClock(3500, 3600) === "T-01:40", "format T-");

// Starship book: hot stage + ship landing burn; bare hold/abort ignored
{
  assert(starshipBook.id === "starship-default", "starship book id");
  assert(ssTPlus.get("hot_stage") === 141, "f13 hot_stage");
  const { hits: hot } = matchPhrases(
    "coming up on hot staging separation",
    starshipBook,
    { tSec: 140 },
  );
  assert(hot.some((h) => h.actionId === "hot_stage"), "hot_stage pattern");
  const gHot = gateHitAgainstScript(hot[0], {
    tPlusSec: 145,
    scriptTPlus: ssTPlus,
    gateSec: 60,
  });
  assert(gHot.ok === true, "hot_stage on-time kept");

  const { hits: shipBurn } = matchPhrases(
    "coming up to the ship landing burn",
    starshipBook,
    { tSec: 3900 },
  );
  assert(
    shipBurn.some((h) => h.actionId === "landing_burn_ship"),
    "ship landing burn ≠ booster",
  );

  const { hits: chatter } = matchPhrases(
    "we still have the ability to rapidly recycle the count",
    starshipBook,
    { tSec: 10 },
  );
  assert(!chatter.some((h) => h.actionId === "hold"), "bare recycle ignored");

  const { hits: realHold } = matchPhrases(
    "we are in a hold at T minus 40",
    starshipBook,
    { tSec: 20 },
  );
  assert(realHold.some((h) => h.actionId === "hold"), "real hold kept");
}

assert(parseClockOffset("550") === 550, "parse seconds");
assert(parseClockOffset("9:10") === 9 * 60 + 10, "parse mm:ss");
assert(parseClockOffset("1:02:03") === 3723, "parse hh:mm:ss");

{
  const m = createLiftoffMarker({
    fromSec: 100,
    log: () => {},
  });
  assert(!m.ready(), "marker starts unset");
  m.sync(100);
  // Simulate 30s wall after sync without sleeping: set absolute
  m.setLiftoffAbsolute(130);
  assert(m.ready() && m.getLiftoffSec() === 130, "absolute mark");
  const emitted = [];
  m.pushHit({ hit: { phraseId: "x" }, tSec: 120 }, (x) => emitted.push(x));
  // already ready → immediate emit
  assert(emitted.length === 1, "push emits when ready");
  const m2 = createLiftoffMarker({ fromSec: 0, log: () => {} });
  m2.pushHit({ hit: { a: 1 }, tSec: 5 }, () => {});
  assert(m2.pendingCount() === 1, "buffers before mark");
  m2.setLiftoffAbsolute(10);
  const out = [];
  m2.flushPending((x) => out.push(x));
  assert(out.length === 1 && m2.pendingCount() === 0, "flush after mark");
}

console.log("✓ webcast match + script gate");
console.log("OK smoke:webcast");
