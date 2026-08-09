/**
 * Explicit worker posture — no silent defaults for MQTT/delivery.
 */

import { config } from "./config.js";

const MQTT_SOURCES = ["live", "local"];
const DELIVERY_MODES = ["telegram", "log", "none"];

function requireEnum(name, allowed) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") {
    return { missing: true, name, allowed };
  }
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) {
    return { invalid: true, name, allowed, value };
  }
  return { value };
}

/**
 * @returns {{ mqttSource: string, deliveryMode: string, telegramAllowlist: number[] }}
 */
export function getRuntime() {
  const mqtt = requireEnum("MQTT_SOURCE", MQTT_SOURCES);
  const delivery = requireEnum("DELIVERY_MODE", DELIVERY_MODES);
  const problems = [];
  for (const r of [mqtt, delivery]) {
    if (r.missing) {
      problems.push(`${r.name} is required (${r.allowed.join("|")})`);
    } else if (r.invalid) {
      problems.push(
        `${r.name}="${r.value}" invalid (one of ${r.allowed.join("|")})`,
      );
    }
  }
  if (problems.length) {
    throw new Error(
      `Runtime incomplete:\n  - ${problems.join("\n  - ")}\nExample:\n  MQTT_SOURCE=local DELIVERY_MODE=log npm run worker`,
    );
  }
  return {
    mqttSource: mqtt.value,
    deliveryMode: delivery.value,
    telegramAllowlist: config.telegramAllowlist,
  };
}

export function getMqttOptions(runtime, token) {
  if (runtime.mqttSource === "local") {
    return {
      host: config.mqttLocalHost,
      port: config.mqttLocalPort,
      protocol: "mqtt",
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 30000,
      keepalive: 60,
    };
  }
  return {
    host: "mqtt.openf1.org",
    port: 8883,
    protocol: "mqtts",
    username: "",
    password: token,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 30000,
    keepalive: 60,
  };
}

export function logRuntimeBanner(runtime) {
  const allow =
    runtime.telegramAllowlist.length > 0
      ? ` allowlist=[${runtime.telegramAllowlist.join(",")}]`
      : "";
  console.log(
    `Cue worker: MQTT=${runtime.mqttSource} DELIVERY=${runtime.deliveryMode}${allow}`,
  );
}
