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

export const config = {
  telegramToken: process.env.TELEGRAM_TOKEN || null,
  telegramAllowlist: parseIdList(process.env.TELEGRAM_ALLOWLIST),
  /** Extra seed ids (merged into allowlist for delivery; bot still uses allowlist for /start) */
  subscriberSeedIds: parseIdList(process.env.SUBSCRIBER_IDS),
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
