/**
 * Upload local media via Telegram Bot API → file_id (for /suggest artifacts).
 */

/**
 * @param {string} token
 * @param {number|string} chatId  admin chat to receive quiet preview upload
 * @param {string} filePath
 * @param {{ kind?: 'photo'|'voice', label?: string }} [opts]
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
  if (opts.label) form.append("caption", String(opts.label).slice(0, 200));

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    throw new Error(json.description || `telegram ${method} failed`);
  }
  if (kind === "voice") {
    return json.result?.voice?.file_id || null;
  }
  const photos = json.result?.photo || [];
  return photos.at(-1)?.file_id || null;
}
