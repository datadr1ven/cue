/**
 * Telegram / menu commands (user-facing only; ops stay hidden).
 * Used by setMyCommands on Node bot and CF Worker.
 */

/** @type {{ command: string, description: string }[]} */
export const TPLUS_USER_COMMANDS = [
  { command: "start", description: "Subscribe to flight alerts" },
  { command: "help", description: "How TPlus works" },
  { command: "missions", description: "List flight timelines" },
  { command: "mission", description: "Browse a flight timeline" },
  { command: "eta", description: "Time until launch NET" },
  { command: "status", description: "Flight clock / phase" },
];

/**
 * Parse /note or /broadcast from a caption or plain command line.
 * @param {string} raw
 * @returns {{ kind: 'note'|'broadcast', text: string }|null}
 */
export function parseNoteOrBroadcast(raw) {
  const c = String(raw || "").trim();
  if (!c) return null;
  let m = c.match(/^\/note(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (m) return { kind: "note", text: (m[1] || "").trim() };
  m = c.match(/^\/broadcast(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (m) return { kind: "broadcast", text: (m[1] || "").trim() };
  return null;
}

/**
 * Largest photo size file_id from a Telegram message.
 * @param {object} message
 * @returns {string|null}
 */
export function largestPhotoFileId(message) {
  const photos = message?.photo;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos[photos.length - 1]?.file_id || null;
}
