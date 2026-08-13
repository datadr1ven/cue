/**
 * Outbound messages: telegram | log | none.
 * Optional photo via Telegram file_id (same bot must have received the file).
 */

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
