/**
 * Outbound messages: telegram | log | none.
 *
 * Does NOT filter by admin allowlist — fan-out targets come from the
 * subscriber store (data/users.json). Ops gating is separate (isAdmin).
 */

/**
 * @param {import('telegraf').Telegraf|null} bot
 * @param {{ deliveryMode: string }} runtime
 * @param {number|string} userId
 * @param {string} text
 */
export async function deliver(bot, runtime, userId, text) {
  const message = String(text ?? "").trim();
  if (!message) return { ok: false, reason: "empty" };

  const mode = runtime.deliveryMode;

  if (mode === "none") return { ok: true, reason: "none" };

  if (mode === "log") {
    console.log(`[deliver:log] user=${userId} ${message.replace(/\n/g, " | ")}`);
    return { ok: true, reason: "log" };
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
