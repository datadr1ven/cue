/**
 * Hold-aware mission-clock belief for webcast:live.
 *
 * Signed T± OCR is trusted only when it is continuous with the prior belief.
 * Large jumps (Flight 15: T−11 → T+2:35 → T+22h) need confirming samples
 * before they can rewrite the clock and trigger catch-up spam.
 */

/**
 * @param {{
 *   minJumpRejectSec?: number,
 *   maxJumpFactor?: number,
 *   confirmSamples?: number,
 * }} [opts]
 */
export function createClockBelief(opts = {}) {
  const minJumpRejectSec = opts.minJumpRejectSec ?? 15;
  const maxJumpFactor = opts.maxJumpFactor ?? 3;
  const confirmSamples = opts.confirmSamples ?? 2;

  /** @type {{ tPlusSec: number, asOfWallMs: number, source: string, stallMs: number, liftoffWallMs: number|null, confidence: number, dir?: string }|null} */
  let belief = null;
  /** @type {{ magSec: number, wallMs: number, signed: boolean }|null} */
  let lastSample = null;
  /** @type {"countdown"|"countup"|null} */
  let dir = null;
  let dirVotes = 0;
  const DIR_VOTES_NEEDED = 2;
  /** @type {{ tPlusSec: number, votes: number, wallMs: number }|null} */
  let pendingJump = null;
  /** @type {{ rejected: boolean, from: number|null, to: number|null, reason: string|null }} */
  let lastUpdateMeta = {
    rejected: false,
    from: null,
    to: null,
    reason: null,
  };

  function commitSigned(tPlusSec, wallMs, stallMs, confidence, source = "ocr") {
    belief = {
      tPlusSec,
      asOfWallMs: wallMs,
      source,
      stallMs,
      liftoffWallMs: wallMs - tPlusSec * 1000,
      confidence,
      dir: dir || (tPlusSec < 0 ? "countdown" : "countup"),
    };
    pendingJump = null;
    lastUpdateMeta = {
      rejected: false,
      from: null,
      to: tPlusSec,
      reason: null,
    };
    return belief;
  }

  /**
   * Reject signed OCR that disagrees with coasted belief by more than the
   * wall-elapsed budget (same spirit as the bare-magnitude jump guard).
   * @returns {boolean} true if this sample should not commit yet
   */
  function signedJumpTooLarge(clockSec, wallMs) {
    if (!belief || !Number.isFinite(belief.tPlusSec)) return false;
    const dWall = Math.max(0, (wallMs - belief.asOfWallMs) / 1000);
    // Both countdown and countup advance tPlusSec ~+1s per wall second.
    const expected = belief.tPlusSec + dWall;
    const err = Math.abs(clockSec - expected);
    const limit = Math.max(minJumpRejectSec, maxJumpFactor * Math.max(dWall, 0.2));
    return err > limit;
  }

  return {
    /**
     * @param {number|null|undefined} clockSec signed T± seconds, or null
     * @param {number} [wallMs]
     * @param {{ unsignedSec?: number|null, signSource?: string|null }} [opts]
     */
    updateFromOcr(clockSec, wallMs = Date.now(), ocrOpts = {}) {
      lastUpdateMeta = {
        rejected: false,
        from: belief?.tPlusSec ?? null,
        to: null,
        reason: null,
      };
      const unsigned =
        ocrOpts.unsignedSec != null && Number.isFinite(ocrOpts.unsignedSec)
          ? Number(ocrOpts.unsignedSec)
          : null;

      // Explicit T± — lock direction, but reject discontinuous jumps.
      if (clockSec != null && Number.isFinite(clockSec)) {
        if (signedJumpTooLarge(clockSec, wallMs)) {
          if (
            pendingJump &&
            Math.abs(pendingJump.tPlusSec - clockSec) <= 5
          ) {
            pendingJump.votes += 1;
            pendingJump.wallMs = wallMs;
            if (pendingJump.votes >= confirmSamples) {
              dir = clockSec < 0 ? "countdown" : "countup";
              dirVotes = DIR_VOTES_NEEDED;
              lastSample = {
                magSec: Math.abs(clockSec),
                wallMs,
                signed: true,
              };
              return commitSigned(clockSec, wallMs, 0, 0.7, "ocr");
            }
          } else {
            pendingJump = { tPlusSec: clockSec, votes: 1, wallMs };
          }
          lastUpdateMeta = {
            rejected: true,
            from: belief?.tPlusSec ?? null,
            to: clockSec,
            reason: "signed_jump",
          };
          return belief;
        }

        dir = clockSec < 0 ? "countdown" : "countup";
        dirVotes = DIR_VOTES_NEEDED;
        const stall =
          lastSample && Math.abs(Math.abs(clockSec) - lastSample.magSec) < 0.5
            ? wallMs - lastSample.wallMs
            : 0;
        lastSample = { magSec: Math.abs(clockSec), wallMs, signed: true };
        return commitSigned(clockSec, wallMs, stall, stall > 0 ? 0.85 : 0.9);
      }

      // Final ~90s circle counter (bare "91","81",…) — always countdown
      if (ocrOpts.signSource === "circle" && unsigned != null) {
        dir = "countdown";
        dirVotes = DIR_VOTES_NEEDED;
        lastSample = { magSec: unsigned, wallMs, signed: false };
        return commitSigned(-unsigned, wallMs, 0, 0.8, "ocr");
      }

      // Bare magnitude — need motion to infer sign
      if (unsigned == null) return belief;

      if (!lastSample) {
        lastSample = { magSec: unsigned, wallMs, signed: false };
        return belief;
      }

      const prevMag = lastSample.magSec;
      const dMag = unsigned - prevMag;
      const dWall = (wallMs - lastSample.wallMs) / 1000;

      if (Math.abs(dMag) < 0.5) {
        lastSample = { magSec: unsigned, wallMs, signed: false };
        if (belief && dir) {
          belief = {
            ...belief,
            stallMs: (belief.stallMs || 0) + Math.max(0, dWall) * 1000,
            asOfWallMs: wallMs,
            tPlusSec: (dir === "countdown" ? -1 : 1) * unsigned,
          };
        }
        return belief;
      }

      // Reject OCR jumps (≫ wall elapsed)
      if (dWall > 0.2 && Math.abs(dMag) > Math.max(8, 3 * dWall)) {
        lastUpdateMeta = {
          rejected: true,
          from: belief?.tPlusSec ?? null,
          to: unsigned,
          reason: "bare_jump",
        };
        return belief;
      }

      lastSample = { magSec: unsigned, wallMs, signed: false };

      let vote = null;
      if (dWall > 0.2) {
        if (dMag < -0.5) vote = "countdown";
        else if (dMag > 0.5) vote = "countup";
      }
      if (
        dir === "countdown" &&
        vote === "countup" &&
        unsigned < 30 &&
        prevMag < 60
      ) {
        dir = "countup";
        dirVotes = DIR_VOTES_NEEDED;
      } else if (vote) {
        if (vote === dir) dirVotes += 1;
        else if (!dir) {
          dir = vote;
          dirVotes = 1;
        } else {
          dir = vote;
          dirVotes = 1;
        }
      }

      if (!dir || dirVotes < DIR_VOTES_NEEDED) return belief;

      const sign = dir === "countdown" ? -1 : 1;
      return commitSigned(sign * unsigned, wallMs, 0, 0.8, "ocr");
    },
    /** True once we have a signed mission clock (explicit T± or motion-locked). */
    hasLock: () => Boolean(belief && Number.isFinite(belief.tPlusSec)),
    /**
     * Coast from last OCR grab-time.
     * Countdown after HUD drop: keep coasting longer so we can still reach T+0.
     */
    now(wallMs = Date.now()) {
      if (!belief) return null;
      const age = wallMs - belief.asOfWallMs;
      if (belief.stallMs > 8000) {
        return { ...belief, source: "hold", ageMs: age };
      }
      const countingDown =
        belief.dir === "countdown" ||
        (Number.isFinite(belief.tPlusSec) && belief.tPlusSec < 0);
      const coastLimitMs = countingDown ? 240_000 : 60_000;
      if (age < coastLimitMs && (belief.source === "ocr" || belief.source === "coast")) {
        const coast = belief.tPlusSec + age / 1000;
        return {
          ...belief,
          tPlusSec: coast,
          source: "coast",
          ageMs: age,
        };
      }
      return { ...belief, source: "stale", ageMs: age };
    },
    raw: () => belief,
    /** Diagnostics for the most recent updateFromOcr call. */
    lastMeta: () => ({ ...lastUpdateMeta }),
  };
}

/** Default ascent/return split for long Starship-style scripts (~4h). */
export const ASCENT_MAX_TPLUS_SEC = Number(
  process.env.TPLUS_ASCENT_MAX_TPLUS_SEC || 4 * 3600,
);

/**
 * @param {Array<{ tPlusSec?: number|null, actionId?: string|null }>} script
 * @param {"ascent"|"return"|"all"} phase
 * @param {number} [ascentMaxSec]
 */
export function filterScriptByPhase(
  script,
  phase,
  ascentMaxSec = ASCENT_MAX_TPLUS_SEC,
) {
  const rows = Array.isArray(script) ? script : [];
  if (!phase || phase === "all") return rows;
  if (phase === "ascent") {
    return rows.filter(
      (r) => r && r.tPlusSec != null && Number(r.tPlusSec) <= ascentMaxSec,
    );
  }
  if (phase === "return") {
    return rows.filter(
      (r) => r && r.tPlusSec != null && Number(r.tPlusSec) > ascentMaxSec,
    );
  }
  return rows;
}
