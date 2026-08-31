/**
 * Interactive liftoff mark for live shadowing.
 *
 * Wall-clock sync: press sync when your eyes match file time `syncFileSec`
 * (usually 0 / --from), then mark liftoff when the vehicle leaves the pad.
 * ASR may run faster than realtime; the mark follows *your* watch of the stream.
 */

import { createInterface } from "readline";

/**
 * Parse file offset: seconds, mm:ss, or hh:mm:ss.
 * @param {string} raw
 * @returns {number|null}
 */
export function parseClockOffset(raw) {
  const t = String(raw || "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  const hms = t.match(/^(\d+):([0-5]?\d):([0-5]?\d)$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }
  const ms = t.match(/^(\d+):([0-5]?\d)$/);
  if (ms) {
    return Number(ms[1]) * 60 + Number(ms[2]);
  }
  return null;
}

/**
 * @param {{
 *   fromSec?: number|null,
 *   initialLiftoffSec?: number|null,
 *   log?: (msg: string) => void,
 * }} opts
 */
export function createLiftoffMarker(opts = {}) {
  const log = opts.log || ((msg) => console.error(msg));
  const fromSec =
    opts.fromSec != null && Number.isFinite(Number(opts.fromSec))
      ? Number(opts.fromSec)
      : 0;

  let syncWallMs = Date.now();
  let syncFileSec = fromSec;
  let liftoffSec =
    opts.initialLiftoffSec != null &&
    Number.isFinite(Number(opts.initialLiftoffSec))
      ? Number(opts.initialLiftoffSec)
      : null;

  /** @type {object[]} */
  const pending = [];
  /** @type {(() => void)[]} */
  const waiters = [];

  function notify() {
    while (waiters.length) waiters.shift()?.();
  }

  function sync(fileSec = syncFileSec) {
    syncWallMs = Date.now();
    syncFileSec =
      fileSec != null && Number.isFinite(Number(fileSec))
        ? Number(fileSec)
        : fromSec;
    log(
      `SYNC wall↔file · file t=${fmt(syncFileSec)} is "now" — press L at liftoff (or type mm:ss / seconds)`,
    );
  }

  function setLiftoffAbsolute(sec) {
    if (!Number.isFinite(sec)) return false;
    liftoffSec = sec;
    log(`LIFTOFF MARKED · file t=${fmt(liftoffSec)} (absolute)`);
    notify();
    return true;
  }

  function markLiftoffFromWall() {
    const sec = syncFileSec + (Date.now() - syncWallMs) / 1000;
    liftoffSec = sec;
    log(
      `LIFTOFF MARKED · file t=${fmt(liftoffSec)} (wall Δ since sync ${(Date.now() - syncWallMs) / 1000 | 0}s)`,
    );
    notify();
    return liftoffSec;
  }

  function ready() {
    return liftoffSec != null && Number.isFinite(liftoffSec);
  }

  /** @type {((liftoffSec: number) => void)|null} */
  let onMarked = null;

  function setOnMarked(fn) {
    onMarked = typeof fn === "function" ? fn : null;
  }

  function fireMarked() {
    if (ready() && onMarked) onMarked(liftoffSec);
  }

  /**
   * @param {string} line
   * @returns {'sync'|'liftoff'|'absolute'|'help'|'ignore'}
   */
  function handleCommand(line) {
    const t = String(line || "").trim().toLowerCase();
    if (!t || t === "l" || t === "liftoff" || t === "0") {
      markLiftoffFromWall();
      fireMarked();
      return "liftoff";
    }
    if (t === "s" || t === "sync") {
      sync();
      return "sync";
    }
    const abs = parseClockOffset(t);
    if (abs != null) {
      setLiftoffAbsolute(abs);
      fireMarked();
      return "absolute";
    }
    if (t === "h" || t === "help" || t === "?") {
      log(
        "Mark commands: L / Enter = liftoff now (wall) · S = re-sync now↔file · mm:ss or seconds = set absolute · help",
      );
      return "help";
    }
    log(`Unknown mark command "${t}" — try L, S, help, or a time like 9:10`);
    return "ignore";
  }

  /**
   * @param {object} item
   * @param {(item: object) => void} emit
   */
  function pushHit(item, emit) {
    if (ready()) emit(item);
    else pending.push(item);
  }

  /**
   * @param {(item: object) => void} emit
   * @returns {number} flushed count
   */
  function flushPending(emit) {
    const n = pending.length;
    while (pending.length) emit(pending.shift());
    return n;
  }

  function pendingCount() {
    return pending.length;
  }

  function getLiftoffSec() {
    return liftoffSec;
  }

  /** Resolve when liftoff is marked (already ready → immediate). */
  function waitUntilReady() {
    if (ready()) return Promise.resolve(liftoffSec);
    return new Promise((resolve) => {
      waiters.push(() => resolve(liftoffSec));
    });
  }

  /**
   * Attach stdin line reader. Returns disposer.
   * @param {{ prompt?: boolean }} [o]
   */
  function attachStdin(o = {}) {
    if (!process.stdin.isTTY) {
      log("WARN --mark-liftoff: stdin is not a TTY; type L/S won’t work (pass --liftoff instead)");
      return () => {};
    }
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    if (o.prompt !== false) {
      log(
        "MARK LIFTOFF ready · S = sync eyes to start of this audio · L / Enter = liftoff · or type mm:ss",
      );
      sync(fromSec);
    }
    rl.on("line", (line) => {
      const kind = handleCommand(line);
      if (kind === "liftoff" || kind === "absolute") {
        // caller flushes pending
      }
    });
    return () => {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    };
  }

  return {
    sync,
    markLiftoffFromWall,
    setLiftoffAbsolute,
    handleCommand,
    setOnMarked,
    ready,
    pushHit,
    flushPending,
    pendingCount,
    getLiftoffSec,
    waitUntilReady,
    attachStdin,
  };
}

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")} (${s}s)`;
}
