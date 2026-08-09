/**
 * Outbound messages: telegram | log | none (+ allowlist).
 */

/**
 * @param {import('telegraf').Telegraf|null} bot
 * @param {{ deliveryMode: string, telegramAllowlist: number[] }} runtime
 * @param {number|string} userId
 * @param {string} text
 */
export async function deliver(bot, runtime, userId, text) {
  const message = String(text ?? "").trim();
  if (!message) return { ok: false, reason: "empty" };

  const uid = Number(userId);
  const mode = runtime.deliveryMode;

  if (mode === "none") return { ok: true, reason: "none" };

  if (mode === "log") {
    console.log(`[deliver:log] user=${userId} ${message.replace(/\n/g, " | ")}`);
    return { ok: true, reason: "log" };
  }

  if (
    runtime.telegramAllowlist.length > 0 &&
    !runtime.telegramAllowlist.includes(uid)
  ) {
    console.log(`[deliver:skip-allowlist] user=${userId}`);
    return { ok: false, reason: "allowlist" };
  }

  if (!bot) {
    console.error("deliver: telegram mode but no bot instance");
    return { ok: false, reason: "no-bot" };
  }

  try {
    await bot.telegram.sendMessage(userId, message);
    return { ok: true, reason: "telegram" };
  } catch (error) {
    console.error(`❌ sendMessage ${userId}:`, error.message);
    return { ok: false, reason: "error", error };
  }
}
