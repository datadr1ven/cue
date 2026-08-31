/**
 * Subscriber store — JSON file on disk.
 *
 * - Subscribers: anyone who /start (if ENROLL_OPEN) or SUBSCRIBER_IDS / seeds
 * - Admins: TELEGRAM_ADMIN_IDS or TELEGRAM_ALLOWLIST — ops commands only
 * - Delivery targets = users.json (not the admin list alone)
 */

import fs from "fs";
import { config } from "./config.js";

function ensureDir(filePath) {
  const dir = filePath.replace(/\/[^/]+$/, "");
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readRaw() {
  try {
    if (!fs.existsSync(config.usersFile)) return { users: {} };
    return JSON.parse(fs.readFileSync(config.usersFile, "utf8"));
  } catch {
    return { users: {} };
  }
}

function writeRaw(data) {
  ensureDir(config.usersFile);
  fs.writeFileSync(config.usersFile, JSON.stringify(data, null, 2));
}

/** Seed admins + SUBSCRIBER_IDS into the file so they receive alerts. */
export function loadSubscribers() {
  const data = readRaw();
  const map = new Map();
  const now = new Date().toISOString();

  for (const id of [...config.adminIds, ...config.subscriberSeedIds]) {
    if (!data.users[id]) {
      data.users[id] = {
        user_id: id,
        enrolledAt: now,
        role: config.adminIds.includes(id) ? "admin" : "subscriber",
      };
    }
  }

  for (const [id, u] of Object.entries(data.users)) {
    const n = Number(id);
    if (Number.isFinite(n)) map.set(n, { user_id: n, ...u });
  }

  writeRaw(data);
  return map;
}

export function enrollUser(userId, meta = {}) {
  const data = readRaw();
  const id = Number(userId);
  const isAdmin = config.adminIds.includes(id);
  data.users[id] = {
    user_id: id,
    enrolledAt: data.users[id]?.enrolledAt || new Date().toISOString(),
    role: isAdmin ? "admin" : "subscriber",
    ...meta,
  };
  writeRaw(data);
  return data.users[id];
}

export function isAdmin(userId) {
  const id = Number(userId);
  if (!config.adminIds.length) {
    // No admins configured → treat everyone as admin (dev convenience)
    return true;
  }
  return config.adminIds.includes(id);
}

/** @deprecated use isAdmin for ops; enrollment uses canEnroll */
export function isAllowed(userId) {
  return isAdmin(userId);
}

/**
 * Who may /start and become a subscriber.
 * - ENROLL_OPEN=true (default): anyone
 * - ENROLL_OPEN=false: only admins (private beta)
 */
export function canEnroll(userId) {
  if (config.enrollOpen) return true;
  return isAdmin(userId);
}

export function isSubscriber(userId) {
  const id = Number(userId);
  const data = readRaw();
  return Boolean(data.users[id]);
}
