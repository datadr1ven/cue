/**
 * Outbound messages: telegram | http | log | none.
 * Optional photo via Telegram file_id (same bot must have received the file).
 *
 * http mode: POST once to CF Worker /deliver (Worker fans out from KV).
 * Use deliverHttp() from the MQTT worker; per-user deliver() is for telegram/log.
 */

import { config } from "./config.js";

/**
 * Prefix outbound alerts for replay/test vs live.
 *
 * - ALERT_TAG=…        → use that string (e.g. "🧪 REPLAY")
 * - ALERT_TAG=off      → never tag
 * - unset + MQTT local → "🧪 REPLAY" (safe default for capture replays)
 * - unset + MQTT live  → no tag
 *
 * @param {string} text
 * @param {{ mqttSource?: string|null, tag?: string|null }} [opts]
 */
export function applyAlertTag(text, opts = {}) {
  const message = String(text ?? "").trim();
  if (!message) return message;

  const off = (v) =>
    ["0", "false", "off", "none", "no"].includes(String(v).toLowerCase());

  let tag = null;
  if (opts.tag != null && String(opts.tag).trim() !== "") {
    tag = off(opts.tag) ? null : String(opts.tag).trim();
  } else {
    const raw = process.env.ALERT_TAG;
    if (raw != null && String(raw).trim() !== "") {
      tag = off(raw) ? null : String(raw).trim();
    } else if (opts.mqttSource === "local") {
      tag = "🧪 REPLAY";
    }
  }

  if (!tag) return message;
  if (message.startsWith(tag) || message.startsWith("🧪 REPLAY")) return message;
  return `${tag}\n${message}`;
}

/**
 * Fan-out via GridWhisper (or compatible) CF Worker.
 * @param {string} text
 * @param {{ photoFileId?: string|null, url?: string|null, secret?: string|null }} [opts]
 * @returns {Promise<{ ok: boolean, delivered?: number, total?: number, reason?: string, error?: string }>}
 */
export async function deliverHttp(text, opts = {}) {
  const message = String(text ?? "").trim();
  const photoFileId = opts.photoFileId || null;
  if (!message && !photoFileId) return { ok: false, reason: "empty" };

  const url = opts.url || config.deliverUrl;
  const secret = opts.secret || config.deliverSecret;
  if (!url || !secret) {
    return { ok: false, reason: "missing-url-or-secret" };
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: message || undefined,
        photoFileId: photoFileId || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`❌ deliverHttp ${res.status}:`, body);
      return {
        ok: false,
        reason: "http-error",
        error: body?.error || String(res.status),
      };
    }
    return {
      ok: true,
      reason: "http",
      delivered: body.delivered,
      total: body.total,
    };
  } catch (error) {
    console.error(`❌ deliverHttp:`, error.message);
    return { ok: false, reason: "error", error: error.message };
  }
}

/**
 * @param {import('telegraf').Telegraf|null} bot
 * @param {{ deliveryMode: string }} runtime
 * @param {number|string} userId
 * @param {string} text
 * @param {{ photoFileId?: string|null }} [opts]
 */
export async function deliver(bot, runtime, userId, text, opts = {}) {
  const message = String(text ?? "").trim();
  const photoFileId = opts.photoFileId || null;
  if (!message && !photoFileId) return { ok: false, reason: "empty" };

  const mode = runtime.deliveryMode;

  if (mode === "none") return { ok: true, reason: "none" };

  if (mode === "log") {
    const media = photoFileId ? ` photo=${photoFileId.slice(0, 12)}…` : "";
    console.log(
      `[deliver:log] user=${userId}${media} ${(message || "(photo)").replace(/\n/g, " | ")}`,
    );
    return { ok: true, reason: "log" };
  }

  if (!bot) {
    console.error("deliver: telegram mode but no bot instance");
    return { ok: false, reason: "no-bot" };
  }

  try {
    if (photoFileId) {
      await bot.telegram.sendPhoto(userId, photoFileId, {
        caption: message ? message.slice(0, 1024) : undefined,
      });
    } else {
      await bot.telegram.sendMessage(userId, message);
    }
    return { ok: true, reason: "telegram" };
  } catch (error) {
    console.error(`❌ deliver ${userId}:`, error.message);
    return { ok: false, reason: "error", error };
  }
}
