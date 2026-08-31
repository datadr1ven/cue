/**
 * Upload local media via Telegram Bot API → file_id (for /suggest artifacts).
 * Sends a silent, caption-less message to mint the file_id (Telegram has no
 * upload-without-send). Caller may deleteMessage(messageId) after fan-out.
 */

/**
 * @param {string} token
 * @param {number|string} chatId  admin chat to receive quiet mint upload
 * @param {string} filePath
 * @param {{ kind?: 'photo'|'voice', label?: string }} [opts]
 * @returns {Promise<{ fileId: string, messageId: number|null, chatId: number }>}
 */
export async function uploadTelegramFile(token, chatId, filePath, opts = {}) {
  const kind = opts.kind === "voice" ? "voice" : "photo";
  const method = kind === "voice" ? "sendVoice" : "sendPhoto";
  const field = kind === "voice" ? "voice" : "photo";
  const { readFileSync } = await import("fs");
  const { basename } = await import("path");
  const buf = readFileSync(filePath);
  const blob = new Blob([buf]);
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(field, blob, basename(filePath));
  form.append("disable_notification", "true");
  // No caption on mint — fan-out uses sendPhoto(caption=alert) as the UX message.

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(json.description || `telegram ${method} failed`);
  }
  const messageId = json.result?.message_id ?? null;
  let fileId = null;
  if (kind === "voice") {
    fileId = json.result?.voice?.file_id || null;
  } else {
    const photos = json.result?.photo || [];
    fileId = photos.at(-1)?.file_id || null;
  }
  if (!fileId) throw new Error("telegram upload returned no file_id");
  return { fileId, messageId, chatId: Number(chatId) };
}

/**
 * @param {string} token
 * @param {number|string} chatId
 * @param {number} messageId
 */
export async function deleteTelegramMessage(token, chatId, messageId) {
  if (messageId == null) return;
  await fetch(`https://api.telegram.org/bot${token}/deleteMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  }).catch(() => {});
}
