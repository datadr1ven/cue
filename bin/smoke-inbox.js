#!/usr/bin/env node
/**
 * Offline smoke for inbox digest-coalesce helpers (shared by TPlus + GridWhisper).
 *
 *   node bin/smoke-inbox.js
 */

import {
  INBOX_NOTIFY_COALESCE_MS,
  clearInboxNotifyPending,
  decideInboxNotify,
  formatInboxNotify,
  normalizeNotifyState,
} from "../src/telegram-inbox.js";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const t0 = 1_700_000_000_000;
const windowMs = INBOX_NOTIFY_COALESCE_MS;

// Fresh state → immediate ping
{
  const r = decideInboxNotify(null, { now: t0, coalesceMs: windowMs });
  assert(r.shouldNotify === true, "first message notifies");
  assert(r.batchedCount === 1, "first batchedCount is 1");
  assert(r.nextState.lastNotifyAt === t0, "records lastNotifyAt");
  assert(r.nextState.pendingCount === 0, "pending cleared after notify");
}

// Within quiet window → accumulate only
{
  let state = { lastNotifyAt: t0, pendingCount: 0 };
  const r1 = decideInboxNotify(state, { now: t0 + 60_000, coalesceMs: windowMs });
  assert(r1.shouldNotify === false, "within window: no notify");
  assert(r1.nextState.pendingCount === 1, "pending bumps to 1");
  state = r1.nextState;

  const r2 = decideInboxNotify(state, { now: t0 + 120_000, coalesceMs: windowMs });
  assert(r2.shouldNotify === false, "still within window");
  assert(r2.nextState.pendingCount === 2, "pending bumps to 2");
  state = r2.nextState;

  // After window → digest includes pending + this message
  const r3 = decideInboxNotify(state, {
    now: t0 + windowMs,
    coalesceMs: windowMs,
  });
  assert(r3.shouldNotify === true, "after window: notify");
  assert(r3.batchedCount === 3, "digest count = pending(2) + 1");
  assert(r3.nextState.pendingCount === 0, "pending reset after digest");
  assert(r3.nextState.lastNotifyAt === t0 + windowMs, "lastNotifyAt updated");
}

// /inbox clears pending but keeps lastNotifyAt
{
  const cleared = clearInboxNotifyPending({
    lastNotifyAt: t0,
    pendingCount: 5,
  });
  assert(cleared.pendingCount === 0, "clear pending");
  assert(cleared.lastNotifyAt === t0, "keep lastNotifyAt");
  const mid = decideInboxNotify(cleared, {
    now: t0 + 60_000,
    coalesceMs: windowMs,
  });
  assert(mid.shouldNotify === false, "still quiet after /inbox");
  assert(mid.nextState.pendingCount === 1, "new pending after clear");
}

// Format copy
{
  const single = formatInboxNotify({
    entry: { username: "alice", userId: 42, text: "hello ops", kind: "text" },
    batchedCount: 1,
  });
  assert(single.includes("📬 Inbox · @alice · id:42"), "single header");
  assert(single.includes("hello ops"), "single body");
  assert(single.includes("/reply last"), "reply hint");

  const long = "x".repeat(300);
  const batched = formatInboxNotify({
    entry: { firstName: "Bob", userId: 7, text: long, kind: "photo" },
    batchedCount: 4,
  });
  assert(batched.includes("4 new since last ping"), "batched header");
  assert(batched.includes("latest · Bob · id:7 [photo]"), "latest line");
  assert(batched.includes("…"), "preview truncated");
  assert(!batched.includes(long), "full long text not in notify");
}

assert(
  normalizeNotifyState({ pendingCount: -1 }).pendingCount === 0,
  "normalize rejects negative pending",
);

console.log("✓ inbox notify coalesce");
console.log("OK smoke:inbox");
