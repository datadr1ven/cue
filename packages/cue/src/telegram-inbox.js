/**
 * Lightweight free-text inbox for CF Telegram workers (KV-backed).
 * Ops-only read/clear; user messages are not fan-out alerts.
 */

export const INBOX_KV_KEY = "inbox:v1";
/** Keep the newest N messages (FIFO drop). */
export const INBOX_MAX = 80;
/** Max body stored per message. */
export const INBOX_TEXT_MAX = 1000;
/** How many to show in /inbox by default. */
export const INBOX_SHOW = 20;

/**
 * @param {object} [data]
 * @returns {{ messages: object[] }}
 */
export function normalizeInbox(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return { messages };
}

/**
 * Build a storeable inbox row from a Telegram message.
 * @param {object} message
 * @param {{ text?: string|null, kind?: string }} [extra]
 */
export function inboxEntryFromMessage(message, extra = {}) {
  const from = message?.from || {};
  const raw =
    extra.text != null
      ? String(extra.text)
      : String(message?.text || message?.caption || "").trim();
  const text = raw.slice(0, INBOX_TEXT_MAX);
  return {
    id: `${Date.now()}-${from.id || "x"}-${Math.random().toString(36).slice(2, 7)}`,
    t: new Date().toISOString(),
    userId: from.id != null ? Number(from.id) : null,
    username: from.username || null,
    firstName: from.first_name || null,
    chatId: message?.chat?.id != null ? Number(message.chat.id) : null,
    /** Telegram message_id — used to thread ops replies when possible */
    messageId: message?.message_id != null ? Number(message.message_id) : null,
    kind: extra.kind || (message?.photo ? "photo" : "text"),
    text,
  };
}

/**
 * Resolve who to DM from /reply target token.
 * @param {{ messages?: object[] }} inbox
 * @param {string} ref - "last" | numeric user id | @username
 * @returns {{ ok: true, chatId: number, entry: object|null, label: string } | { ok: false, error: string }}
 */
export function resolveInboxTarget(inbox, ref) {
  const messages = normalizeInbox(inbox).messages;
  const s = String(ref || "").trim();
  if (!s) {
    return {
      ok: false,
      error: "Usage: /reply last <text>  or  /reply <userId|@user> <text>",
    };
  }

  const targetChat = (m) => {
    const id = m.chatId ?? m.userId;
    if (id == null || !Number.isFinite(Number(id))) return null;
    return Number(id);
  };

  if (s === "last" || s === "l" || s === ".") {
    if (!messages.length) return { ok: false, error: "Inbox empty." };
    const m = messages[messages.length - 1];
    const chatId = targetChat(m);
    if (chatId == null) return { ok: false, error: "Last inbox entry has no chat id." };
    return { ok: true, chatId, entry: m, label: formatSender(m) };
  }

  if (/^\d+$/.test(s)) {
    const id = Number(s);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.userId === id || m.chatId === id) {
        const chatId = targetChat(m) ?? id;
        return { ok: true, chatId, entry: m, label: formatSender(m) };
      }
    }
    // User may have /start'ed even if not in current inbox window
    return { ok: true, chatId: id, entry: null, label: `id:${id}` };
  }

  const uname = s.replace(/^@/, "").toLowerCase();
  if (!uname) {
    return { ok: false, error: "Usage: /reply @username <text>" };
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.username && String(m.username).toLowerCase() === uname) {
      const chatId = targetChat(m);
      if (chatId == null) continue;
      return { ok: true, chatId, entry: m, label: formatSender(m) };
    }
  }
  return {
    ok: false,
    error: `No inbox match for @${uname} — use numeric id from /inbox (e.g. /reply 123456 …)`,
  };
}

/**
 * Parse `/reply <target> <message body>`.
 * @param {string} raw - text after the /reply command
 * @returns {{ target: string, body: string }|null}
 */
export function parseReplyArgs(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = s.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) return null;
  const target = m[1].trim();
  const body = m[2].trim();
  if (!target || !body) return null;
  return { target, body };
}

/**
 * @param {{ messages: object[] }} inbox
 * @param {object} entry
 * @returns {{ messages: object[] }}
 */
export function appendInbox(inbox, entry) {
  const prev = normalizeInbox(inbox).messages;
  const messages = [...prev, entry].slice(-INBOX_MAX);
  return { messages };
}

/**
 * @param {object} entry
 */
export function formatSender(entry) {
  if (entry.username) return `@${entry.username}`;
  if (entry.firstName) return entry.firstName;
  if (entry.userId != null) return `id:${entry.userId}`;
  return "unknown";
}

/**
 * @param {{ messages: object[] }} inbox
 * @param {{ limit?: number }} [opts]
 */
export function formatInboxList(inbox, opts = {}) {
  const limit = opts.limit ?? INBOX_SHOW;
  const all = normalizeInbox(inbox).messages;
  if (!all.length) {
    return "Inbox empty.";
  }
  const slice = all.slice(-limit);
  const skipped = all.length - slice.length;
  const lines = [
    `Inbox (${all.length} total${skipped ? `, showing last ${slice.length}` : ""})`,
    "",
  ];
  for (const m of slice) {
    const when = m.t ? String(m.t).replace("T", " ").replace(/\.\d+Z$/, "Z") : "?";
    const kind = m.kind && m.kind !== "text" ? ` [${m.kind}]` : "";
    const body = m.text || "(empty)";
    const idHint = m.userId != null ? ` · id:${m.userId}` : "";
    lines.push(`${when} · ${formatSender(m)}${idHint}${kind}`);
    lines.push(`  ${body}`);
    lines.push("");
  }
  lines.push("Admin: /reply last <text>  ·  /reply <userId|@user> <text>");
  lines.push("Admin: /inbox clear — wipe");
  return lines.join("\n").trim();
}

/** Short user-facing ack (not a promise of a reply). */
export const INBOX_USER_ACK =
  "Got it — noted for the operator. For bot help use /help.";

/** Coalesce state for admin inbox pings (separate from message list). */
export const INBOX_NOTIFY_KV_KEY = "inbox:notify:v1";
/** Quiet window after an admin ping before another digest may fire. */
export const INBOX_NOTIFY_COALESCE_MS = 10 * 60 * 1000;
/** Preview length in admin notify DMs. */
export const INBOX_NOTIFY_PREVIEW = 200;

/**
 * @param {object} [data]
 * @returns {{ lastNotifyAt: number|null, pendingCount: number }}
 */
export function normalizeNotifyState(data) {
  const last =
    data?.lastNotifyAt != null && Number.isFinite(Number(data.lastNotifyAt))
      ? Number(data.lastNotifyAt)
      : null;
  const pending = Number(data?.pendingCount);
  return {
    lastNotifyAt: last,
    pendingCount: Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0,
  };
}

/**
 * Decide whether to DM admins for a newly captured inbox entry.
 * Digest coalesce: first message after the quiet window pings immediately;
 * further messages only bump pendingCount until the window elapses.
 *
 * @param {object} [state]
 * @param {{ now?: number, coalesceMs?: number }} [opts]
 * @returns {{ shouldNotify: boolean, nextState: { lastNotifyAt: number|null, pendingCount: number }, batchedCount: number }}
 */
export function decideInboxNotify(state, opts = {}) {
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const coalesceMs =
    opts.coalesceMs != null ? Number(opts.coalesceMs) : INBOX_NOTIFY_COALESCE_MS;
  const cur = normalizeNotifyState(state);
  const quietOk =
    cur.lastNotifyAt == null || now - cur.lastNotifyAt >= coalesceMs;

  if (quietOk) {
    const batchedCount = cur.pendingCount + 1;
    return {
      shouldNotify: true,
      batchedCount,
      nextState: { lastNotifyAt: now, pendingCount: 0 },
    };
  }

  return {
    shouldNotify: false,
    batchedCount: 0,
    nextState: {
      lastNotifyAt: cur.lastNotifyAt,
      pendingCount: cur.pendingCount + 1,
    },
  };
}

/**
 * After admin /inbox (read or clear): drop pending so a later digest
 * doesn't re-count messages they already opened. Keep lastNotifyAt.
 *
 * @param {object} [state]
 */
export function clearInboxNotifyPending(state) {
  const cur = normalizeNotifyState(state);
  return { lastNotifyAt: cur.lastNotifyAt, pendingCount: 0 };
}

/**
 * @param {{ entry: object, batchedCount?: number, previewMax?: number }} opts
 */
export function formatInboxNotify(opts) {
  const entry = opts.entry || {};
  const batched = Math.max(1, Number(opts.batchedCount) || 1);
  const max = opts.previewMax ?? INBOX_NOTIFY_PREVIEW;
  const who = formatSender(entry);
  const idHint = entry.userId != null ? ` · id:${entry.userId}` : "";
  const kind = entry.kind && entry.kind !== "text" ? ` [${entry.kind}]` : "";
  let preview = String(entry.text || "(empty)");
  if (preview.length > max) preview = preview.slice(0, max - 1) + "…";

  const lines =
    batched <= 1
      ? [`📬 Inbox · ${who}${idHint}${kind}`, preview, "", "/inbox · /reply last <text>"]
      : [
          `📬 Inbox · ${batched} new since last ping`,
          `latest · ${who}${idHint}${kind}`,
          preview,
          "",
          "/inbox · /reply last <text>",
        ];
  return lines.join("\n");
}
