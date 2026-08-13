import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

function parseIdList(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(",")
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isFinite(n));
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

/**
 * Ops / admin ids: TELEGRAM_ADMIN_IDS, else TELEGRAM_ALLOWLIST (legacy).
 * Subscribers: data/users.json via /start — not gated by admin list.
 */
const adminIds = (() => {
  const fromAdmin = parseIdList(process.env.TELEGRAM_ADMIN_IDS);
  if (fromAdmin.length) return fromAdmin;
  return parseIdList(process.env.TELEGRAM_ALLOWLIST);
})();

export const config = {
  telegramToken: process.env.TELEGRAM_TOKEN || null,
  /** @deprecated use adminIds — kept for runtime banner compatibility */
  telegramAllowlist: adminIds,
  adminIds,
  /** Seed into users.json on load (optional friends list without /start) */
  subscriberSeedIds: parseIdList(process.env.SUBSCRIBER_IDS),
  /**
   * If true, anyone can /start and receive alerts.
   * If false, only adminIds + existing file users (and SUBSCRIBER_IDS seeds).
   */
  enrollOpen: envBool("ENROLL_OPEN", true),
  openf1Username: process.env.OPENF1_USERNAME || null,
  openf1Password: process.env.OPENF1_PASSWORD || null,
  mqttLocalHost: process.env.MQTT_LOCAL_HOST || "localhost",
  mqttLocalPort: Number(process.env.MQTT_LOCAL_PORT || 1883),
  usersFile:
    process.env.USERS_FILE ||
    join(__dirname, "..", "data", "users.json"),
  engineDomain: process.env.ENGINE_DOMAIN || "f1",
  minSeverity: Number(process.env.ENGINE_MIN_SEVERITY || 6),
};

export function requireTelegramToken() {
  if (!config.telegramToken) {
    throw new Error("TELEGRAM_TOKEN is required");
  }
}
