#!/usr/bin/env node
/**
 * Regression: Flight 15-style signed OCR jumps must not rewrite belief
 * on a single sample (that previously dump-fired Max-Q→catch pre-liftoff).
 */
import {
  ASCENT_MAX_TPLUS_SEC,
  createClockBelief,
  filterScriptByPhase,
} from "./clock_belief.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assert failed");
}

function approx(a, b, tol = 2) {
  return Math.abs(a - b) <= tol;
}

function testFlight15JumpRejected() {
  const clock = createClockBelief();
  let t0 = 1_000_000;
  // Steady countdown ~T−11m
  clock.updateFromOcr(-(11 * 60 + 6), t0);
  assert(approx(clock.raw().tPlusSec, -(11 * 60 + 6)), "lock countdown");

  // Flight 15: ~17s later OCR spuriously reads T+2:35
  t0 += 17_000;
  clock.updateFromOcr(2 * 60 + 35, t0);
  const meta1 = clock.lastMeta();
  assert(meta1.rejected === true, "first jump rejected");
  assert(approx(clock.raw().tPlusSec, -(11 * 60 + 6)), "belief unchanged after 1st jump");

  // Worse junk: T+1295:53
  t0 += 50_000;
  clock.updateFromOcr(1295 * 60 + 53, t0);
  assert(clock.lastMeta().rejected === true, "second jump rejected");
  assert(
    clock.raw().tPlusSec < 0,
    `still countdown, got ${clock.raw().tPlusSec}`,
  );

  // Real countdown resumes ~T−9:03 (consistent with coasted prior)
  t0 += 50_000;
  // Prior belief was frozen at T−11:06; coasted now() would be higher, but
  // updateFromOcr compares against belief.tPlusSec + dWall from asOfWallMs.
  // Re-seed a fresh nearby countdown sample path: accept continuous T−9.
  // After long wall gap, expected = -666 + 117 ≈ -549; T−9:03=-543 → within limit.
  clock.updateFromOcr(-(9 * 60 + 3), t0);
  assert(clock.lastMeta().rejected === false, "consistent countdown accepted");
  assert(approx(clock.raw().tPlusSec, -(9 * 60 + 3)), "back on countdown");
  console.log("ok Flight15 jump rejected");
}

function testConfirmThenAccept() {
  const clock = createClockBelief({ confirmSamples: 2 });
  let t = 5_000_000;
  clock.updateFromOcr(100, t);
  // Jump to 500
  t += 5_000;
  clock.updateFromOcr(500, t);
  assert(clock.lastMeta().rejected, "jump 1 pending");
  assert(approx(clock.raw().tPlusSec, 100), "still 100");
  // Confirming sample near 500
  t += 5_000;
  clock.updateFromOcr(505, t);
  assert(clock.lastMeta().rejected === false, "confirmed");
  assert(approx(clock.raw().tPlusSec, 505, 1), "accepted ~505");
  console.log("ok confirm then accept");
}

function testPhaseFilter() {
  const script = [
    { actionId: "liftoff", tPlusSec: 0 },
    { actionId: "seco", tPlusSec: 489 },
    { actionId: "deploy_done", tPlusSec: 4660 },
    { actionId: "ses2", tPlusSec: 77757 },
    { actionId: "starship_catch", tPlusSec: 81154 },
  ];
  const ascent = filterScriptByPhase(script, "ascent");
  const ret = filterScriptByPhase(script, "return");
  assert(ascent.every((r) => r.tPlusSec <= ASCENT_MAX_TPLUS_SEC), "ascent only");
  assert(ret.every((r) => r.tPlusSec > ASCENT_MAX_TPLUS_SEC), "return only");
  assert(ascent.length === 3, `ascent n=${ascent.length}`);
  assert(ret.length === 2, `return n=${ret.length}`);
  assert(ASCENT_MAX_TPLUS_SEC === 14400, `ascent max ${ASCENT_MAX_TPLUS_SEC}`);
  console.log("ok phase filter");
}

testFlight15JumpRejected();
testConfirmThenAccept();
testPhaseFilter();
console.log("all clock_belief tests passed");
