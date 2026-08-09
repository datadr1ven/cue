/**
 * Minimal subscriber store — JSON file, no Redis/SQLite.
 * /start enrolls allowlisted users; SUBSCRIBER_IDS seeds the file.
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

/** Seed from env + return Map user_id -> { user_id } */
export function loadSubscribers() {
  const data = readRaw();
  const map = new Map();

  for (const id of [
    ...config.subscriberSeedIds,
    ...config.telegramAllowlist,
  ]) {
    if (!data.users[id]) {
      data.users[id] = { user_id: id, enrolledAt: new Date().toISOString() };
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
  data.users[id] = {
    user_id: id,
    enrolledAt: data.users[id]?.enrolledAt || new Date().toISOString(),
    ...meta,
  };
  writeRaw(data);
  return data.users[id];
}

export function isAllowed(userId) {
  const id = Number(userId);
  if (config.telegramAllowlist.length === 0) return true;
  return config.telegramAllowlist.includes(id);
}
