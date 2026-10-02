/**
 * Cloudflare Worker — GridWhisper Telegram (enroll + deliver).
 *
 * Always-on surface: webhook for /start · /help · /status · /stop.
 * Admins (TELEGRAM_ADMIN_IDS): /note · /broadcast · /inbox · /reply
 * Free-text from users → KV inbox (digest-coalesce admin ping).
 * Race-day MQTT (laptop) POSTs alerts to POST /deliver; this worker fans out.
 * Schedule cache: desktop schedule-from-openf1 → POST /schedule-cache → KV.
 *
 * Bindings (wrangler.gridwhisper.toml):
 *   KV  GRIDWHISPER_KV
 * Secrets:
 *   TELEGRAM_TOKEN
 *   DELIVER_SECRET        (Bearer for /deliver and /schedule-cache)
 *   TELEGRAM_ADMIN_IDS    (comma-separated; required for ops)
 * Vars:
 *   ENROLL_OPEN=true
 *   WEBHOOK_SECRET        (optional path secret)
 */

import { GRIDWHISPER_USER_COMMANDS } from "../src/gridwhisper-commands.js";
import {
  INBOX_KV_KEY,
  INBOX_NOTIFY_KV_KEY,
  INBOX_USER_ACK,
  appendInbox,
  clearInboxNotifyPending,
  decideInboxNotify,
  formatInboxList,
  formatInboxNotify,
  inboxEntryFromMessage,
  normalizeInbox,
  normalizeNotifyState,
  parseReplyArgs,
  resolveInboxTarget,
} from "cue/telegram-inbox.js";
import {
  FEED_KV_KEY,
  FEED_SHOW,
  appendFeed,
  feedCorsHeaders,
  feedCorsOrigin,
  feedEntry,
  normalizeFeed,
} from "cue/public-feed.js";

const KV_USERS = "users:v1";
/** Desktop schedule-from-openf1 snapshot for GET /next */
const KV_SCHEDULE = "schedule:v1";

/** Once per isolate */
let commandsRegistered = false;

function deliverSecretOk(env, request) {
  const secret = env.DELIVER_SECRET;
  if (!secret) return false;
  const auth = request.headers.get("Authorization") || "";
  const headerSecret = request.headers.get("X-Deliver-Secret") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  return bearer === secret || headerSecret === secret;
}

function parseAdminIds(env) {
  const raw = env.TELEGRAM_ADMIN_IDS || env.TELEGRAM_ALLOWLIST || "";
  return raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function enrollOpen(env) {
  const v = env.ENROLL_OPEN;
  if (v == null || v === "") return true;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function isAdmin(env, userId) {
  const admins = parseAdminIds(env);
  if (!admins.length) return false;
  return admins.includes(Number(userId));
}

function canEnroll(env, userId) {
  if (enrollOpen(env)) return true;
  return isAdmin(env, userId);
}

async function kvGetJson(kv, key, fallback) {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function kvPutJson(kv, key, value) {
  await kv.put(key, JSON.stringify(value));
}

async function loadUsers(kv) {
  return kvGetJson(kv, KV_USERS, { users: {} });
}

async function saveUsers(kv, data) {
  await kvPutJson(kv, KV_USERS, data);
}

async function enrollUser(kv, env, userId, meta = {}) {
  const data = await loadUsers(kv);
  const id = String(userId);
  const admin = isAdmin(env, userId);
  data.users[id] = {
    user_id: Number(userId),
    enrolledAt: data.users[id]?.enrolledAt || new Date().toISOString(),
    role: admin ? "admin" : "subscriber",
    ...meta,
  };
  await saveUsers(kv, data);
  return Object.keys(data.users).length;
}

async function unenrollUser(kv, userId) {
  const data = await loadUsers(kv);
  const id = String(userId);
  const existed = Boolean(data.users[id]);
  delete data.users[id];
  await saveUsers(kv, data);
  return { existed, n: Object.keys(data.users).length };
}

async function subscriberIds(kv) {
  const data = await loadUsers(kv);
  return Object.values(data.users).map((u) => Number(u.user_id));
}

async function tg(env, method, body) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    console.error("telegram", method, json);
  }
  return json;
}

async function reply(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 4000),
    ...extra,
  });
}

async function fanOut(env, kv, text, media = {}) {
  const ids = await subscriberIds(kv);
  const photoFileId = media.photoFileId || null;
  const caption = String(text || "").slice(0, 1024);
  let n = 0;
  const errors = [];
  for (const id of ids) {
    let r;
    if (photoFileId) {
      r = await tg(env, "sendPhoto", {
        chat_id: id,
        photo: photoFileId,
        caption: caption || undefined,
      });
    } else {
      r = await reply(env, id, text);
    }
    if (r.ok) n += 1;
    else errors.push({ id, description: r.description });
  }
  return { n, total: ids.length, errors };
}

async function ensureCommands(env) {
  if (commandsRegistered) return;
  commandsRegistered = true;
  try {
    await tg(env, "setMyCommands", { commands: GRIDWHISPER_USER_COMMANDS });
  } catch (e) {
    console.error("setMyCommands failed", e);
    commandsRegistered = false;
  }
}

function helpText(admin = false) {
  let s =
    `GridWhisper — sparse F1 race alerts\n\n` +
    `High-signal moments only (overtakes, pits, flags, session turns).\n` +
    `No feed spam.\n\n` +
    `/start — subscribe\n` +
    `/status — am I subscribed?\n` +
    `/stop — unsubscribe\n` +
    `/help — this message\n\n` +
    `Alerts use live timing telemetry — not an official F1 feed. ` +
    `Lap times, order, and standings can lag or be incomplete.\n\n` +
    `Unofficial; not affiliated with Formula 1.`;
  if (admin) {
    s +=
      `\n\nOps (admin)\n` +
      `/note <text> — freeform alert to all subscribers\n` +
      `/broadcast <text> — announcement to all subscribers\n` +
      `/inbox — read free-text messages from users\n` +
      `/inbox clear — wipe inbox\n` +
      `/reply last <text> — DM the last inbox user\n` +
      `/reply <userId|@user> <text> — DM that user\n` +
      `(new inbox messages ping admins; batched ~10m)`;
  }
  return s;
}

function stripCmd(text, name) {
  const re = new RegExp(`^/${name}(@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

/** Command line from text message or photo caption. */
function cmdText(message) {
  return (message?.text || message?.caption || "").trim();
}

function largestPhotoFileId(message) {
  const photos = message?.photo;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  return photos[photos.length - 1]?.file_id || null;
}

async function loadInbox(kv) {
  return normalizeInbox(await kvGetJson(kv, INBOX_KV_KEY, { messages: [] }));
}

async function saveInbox(kv, inbox) {
  await kvPutJson(kv, INBOX_KV_KEY, normalizeInbox(inbox));
}

async function loadNotifyState(kv) {
  return normalizeNotifyState(
    await kvGetJson(kv, INBOX_NOTIFY_KV_KEY, null),
  );
}

async function saveNotifyState(kv, state) {
  await kvPutJson(kv, INBOX_NOTIFY_KV_KEY, normalizeNotifyState(state));
}

async function markInboxSeen(kv) {
  const next = clearInboxNotifyPending(await loadNotifyState(kv));
  await saveNotifyState(kv, next);
}

async function maybeNotifyAdmins(env, kv, entry, { adminSender = false } = {}) {
  if (!entry || adminSender) return;
  const admins = parseAdminIds(env);
  if (!admins.length) return;

  const decision = decideInboxNotify(await loadNotifyState(kv));
  await saveNotifyState(kv, decision.nextState);
  if (!decision.shouldNotify) return;

  const text = formatInboxNotify({
    entry,
    batchedCount: decision.batchedCount,
  });
  for (const id of admins) {
    await reply(env, id, text);
  }
}

async function captureToInbox(kv, message, extra = {}) {
  const entry = inboxEntryFromMessage(message, extra);
  if (!entry.text && entry.kind === "text") return null;
  if (!entry.text && entry.kind === "photo") {
    entry.text = "(photo, no caption)";
  }
  const next = appendInbox(await loadInbox(kv), entry);
  await saveInbox(kv, next);
  return entry;
}

async function handleMessage(env, kv, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = cmdText(message);
  const photoFileId = largestPhotoFileId(message);
  const admin = isAdmin(env, userId);

  // Unlabeled photo → inbox
  if (photoFileId && !text.startsWith("/")) {
    const entry = await captureToInbox(kv, message, {
      text: text || "(photo, no caption)",
      kind: "photo",
    });
    if (admin) {
      await reply(
        env,
        chatId,
        "Photo saved to /inbox.\nTo fan out to subscribers, caption with:\n/note your text\nor\n/broadcast your text",
      );
    } else {
      await maybeNotifyAdmins(env, kv, entry, { adminSender: false });
      await reply(env, chatId, INBOX_USER_ACK);
    }
    return;
  }

  // Free-text (not a command) → KV inbox for ops
  if (!text.startsWith("/")) {
    if (!text.trim()) return;
    const entry = await captureToInbox(kv, message, { text, kind: "text" });
    await maybeNotifyAdmins(env, kv, entry, { adminSender: admin });
    await reply(env, chatId, INBOX_USER_ACK);
    return;
  }

  if (text.startsWith("/start")) {
    if (!canEnroll(env, userId)) {
      await reply(env, chatId, "Enrollment is closed.");
      return;
    }
    const n = await enrollUser(kv, env, userId, {
      username: message.from?.username || null,
      first_name: message.from?.first_name || null,
    });
    await reply(
      env,
      chatId,
      `Subscribed to GridWhisper (${n} subscriber${n === 1 ? "" : "s"}).\n\n` +
        helpText(admin),
    );
    return;
  }

  if (text.startsWith("/help")) {
    await reply(env, chatId, helpText(admin));
    return;
  }

  if (text.startsWith("/status")) {
    const data = await loadUsers(kv);
    const me = data.users[String(userId)];
    const total = Object.keys(data.users).length;
    if (!me) {
      await reply(
        env,
        chatId,
        `Not subscribed. /start to join.\n(${total} subscriber${total === 1 ? "" : "s"} total)`,
      );
      return;
    }
    await reply(
      env,
      chatId,
      `Subscribed since ${me.enrolledAt || "—"}\n` +
        `role: ${me.role || "subscriber"}\n` +
        `total subscribers: ${total}`,
    );
    return;
  }

  if (text.startsWith("/stop")) {
    const { existed, n } = await unenrollUser(kv, userId);
    if (!existed) {
      await reply(env, chatId, "You were not subscribed.");
      return;
    }
    await reply(
      env,
      chatId,
      `Unsubscribed. (${n} remaining)\n/start anytime to rejoin.`,
    );
    return;
  }

  if (text.startsWith("/note") || text.startsWith("/broadcast")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const kind = text.startsWith("/note") ? "note" : "broadcast";
    const body = stripCmd(text, kind);
    if (!body && !photoFileId) {
      await reply(
        env,
        chatId,
        kind === "note"
          ? "Usage: /note <text>"
          : "Usage: /broadcast <text>",
      );
      return;
    }
    const alertText =
      kind === "note"
        ? body
          ? `📝 ${body}`
          : "📝"
        : body
          ? `📢 ${body}`
          : "📢";
    const { n, total } = await fanOut(env, kv, alertText, { photoFileId });
    await reply(
      env,
      chatId,
      kind === "note"
        ? `Note sent to ${n}/${total} subscriber(s).`
        : `Broadcast sent to ${n}/${total} subscriber(s).`,
    );
    return;
  }

  if (text.startsWith("/inbox")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const raw = stripCmd(text, "inbox").toLowerCase();
    if (raw === "clear" || raw === "wipe" || raw === "empty") {
      await saveInbox(kv, { messages: [] });
      await markInboxSeen(kv);
      await reply(env, chatId, "Inbox cleared.");
      return;
    }
    await markInboxSeen(kv);
    const body = formatInboxList(await loadInbox(kv));
    await reply(
      env,
      chatId,
      body.length > 3900 ? body.slice(0, 3900) + "\n…" : body,
    );
    return;
  }

  if (text.startsWith("/reply")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const parsed = parseReplyArgs(stripCmd(text, "reply"));
    if (!parsed) {
      await reply(
        env,
        chatId,
        "Usage:\n/reply last <text>\n/reply <userId> <text>\n/reply @username <text>\n\n(userId is shown on each /inbox line)",
      );
      return;
    }
    const target = resolveInboxTarget(await loadInbox(kv), parsed.target);
    if (!target.ok) {
      await reply(env, chatId, target.error);
      return;
    }
    const outbound = `💬 ${parsed.body}`.slice(0, 4000);
    const extra = {};
    if (target.entry?.messageId != null) {
      extra.reply_to_message_id = target.entry.messageId;
      extra.allow_sending_without_reply = true;
    }
    const r = await reply(env, target.chatId, outbound, extra);
    if (!r?.ok) {
      await reply(
        env,
        chatId,
        `Failed to DM ${target.label} (${target.chatId}). ` +
          `They must have opened the bot at least once. ` +
          `(${r?.description || "telegram error"})`,
      );
      return;
    }
    await reply(
      env,
      chatId,
      `Replied to ${target.label} (chat ${target.chatId}).`,
    );
    return;
  }
}

/**
 * POST /deliver — race-day laptop (or any trusted client) fans out an alert.
 * Auth: Authorization: Bearer <DELIVER_SECRET>
 * Body: { "text": "…" }  optional photoFileId
 */
async function handleDeliver(request, env, kv) {
  if (!env.DELIVER_SECRET) {
    return new Response("DELIVER_SECRET not configured", { status: 500 });
  }
  if (!deliverSecretOk(env, request)) {
    return new Response("unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const text = body?.text != null ? String(body.text).trim() : "";
  const photoFileId = body?.photoFileId || null;
  if (!text && !photoFileId) {
    return new Response('need { "text": "…" }', { status: 400 });
  }

  const result = await fanOut(env, kv, text || "📷", {
    photoFileId,
  });

  // Public read-only feed for Pages /live (moments from /deliver only)
  if (text) {
    try {
      const prev = await kvGetJson(kv, FEED_KV_KEY, null);
      const next = appendFeed(
        prev,
        feedEntry({ text, source: "deliver" }),
      );
      await kvPutJson(kv, FEED_KV_KEY, next);
    } catch (e) {
      console.error("feed append error", e);
    }
  }

  return Response.json({
    ok: true,
    delivered: result.n,
    total: result.total,
  });
}

/**
 * GET /recent — public sparse alert feed for the landing /live page.
 */
async function handleRecent(request, env, kv) {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit") || FEED_SHOW);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, Math.floor(limitRaw)), 50)
    : FEED_SHOW;
  const feed = normalizeFeed(await kvGetJson(kv, FEED_KV_KEY, null));
  const items = feed.items.slice(-limit);
  const allowOrigin = feedCorsOrigin(env, request);
  return Response.json(
    {
      product: "gridwhisper",
      updatedAt: feed.updatedAt,
      items,
    },
    {
      headers: {
        ...feedCorsHeaders(allowOrigin),
        "Cache-Control": "public, max-age=5",
      },
    },
  );
}

/**
 * @param {object|null} schedule
 * @returns {object[]}
 */
function scheduleSessions(schedule) {
  const list = Array.isArray(schedule?.sessions) ? schedule.sessions : [];
  const now = Date.now();
  return list
    .filter((s) => {
      if (!s?.dateStart) return false;
      const end = Date.parse(s.dateEnd || s.dateStart);
      // Keep until ~45m after official end (matches trail default)
      return Number.isFinite(end) ? end + 45 * 60_000 > now : true;
    })
    .sort((a, b) => String(a.dateStart).localeCompare(String(b.dateStart)));
}

/**
 * Slim public next-session for Pages status line.
 * @param {object|null} schedule
 */
function publicNextSession(schedule) {
  const list = scheduleSessions(schedule);
  if (!list.length) return null;
  const s = list[0];
  const now = Date.now();
  const startMs = Date.parse(s.dateStart);
  const endMs = Date.parse(s.dateEnd || s.dateStart);
  const live =
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    now >= startMs &&
    now <= endMs;
  return {
    kind: "session",
    key: s.key || null,
    sessionName: s.sessionName || null,
    circuit: s.circuit || null,
    country: s.country || null,
    dateStart: s.dateStart || null,
    dateEnd: s.dateEnd || null,
    live: !!live,
  };
}

/**
 * GET /next — public next session for Pages (CORS, no secrets).
 */
async function handleNext(request, env, kv) {
  const schedule = await kvGetJson(kv, KV_SCHEDULE, null);
  const allowOrigin = feedCorsOrigin(env, request);
  return Response.json(
    {
      product: "gridwhisper",
      generatedAt: schedule?.generatedAt || null,
      next: publicNextSession(schedule),
    },
    {
      headers: {
        ...feedCorsHeaders(allowOrigin),
        "Cache-Control": "public, max-age=30",
      },
    },
  );
}

/**
 * Desktop schedule-from-openf1 → cache for GET /next.
 * Auth: same Bearer as /deliver.
 */
async function handleScheduleCachePost(request, env, kv) {
  if (!env.DELIVER_SECRET) {
    return new Response("DELIVER_SECRET not configured", { status: 500 });
  }
  if (!deliverSecretOk(env, request)) {
    return new Response("unauthorized", { status: 401 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return new Response("need schedule object", { status: 400 });
  }
  const sessions = Array.isArray(body.sessions) ? body.sessions : [];
  const slim = {
    generatedAt: body.generatedAt || new Date().toISOString(),
    pushedAt: new Date().toISOString(),
    horizonH: body.horizonH ?? null,
    leadMin: body.leadMin ?? null,
    trailMin: body.trailMin ?? null,
    sessions: sessions.slice(0, 24).map((s) => ({
      key: s.key || null,
      sessionName: s.sessionName || null,
      sessionType: s.sessionType || null,
      sessionKey: s.sessionKey ?? null,
      meetingKey: s.meetingKey ?? null,
      country: s.country || null,
      circuit: s.circuit || null,
      dateStart: s.dateStart || null,
      dateEnd: s.dateEnd || null,
    })),
  };
  await kvPutJson(kv, KV_SCHEDULE, slim);
  return Response.json({
    ok: true,
    stored: slim.sessions.length,
    generatedAt: slim.generatedAt,
  });
}

export default {
  async fetch(request, env) {
    if (!env.TELEGRAM_TOKEN) {
      return new Response("TELEGRAM_TOKEN not configured", { status: 500 });
    }
    if (!env.GRIDWHISPER_KV) {
      return new Response("GRIDWHISPER_KV binding missing", { status: 500 });
    }

    const url = new URL(request.url);
    const kv = env.GRIDWHISPER_KV;

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("GridWhisper worker ok", { status: 200 });
    }

    if (url.pathname === "/recent" || url.pathname === "/feed") {
      if (request.method === "OPTIONS") {
        const allowOrigin = feedCorsOrigin(env, request);
        return new Response(null, {
          status: 204,
          headers: feedCorsHeaders(allowOrigin),
        });
      }
      if (request.method === "GET") {
        try {
          return await handleRecent(request, env, kv);
        } catch (e) {
          console.error("recent error", e);
          return new Response("error", { status: 500 });
        }
      }
    }

    if (url.pathname === "/next") {
      if (request.method === "OPTIONS") {
        const allowOrigin = feedCorsOrigin(env, request);
        return new Response(null, {
          status: 204,
          headers: feedCorsHeaders(allowOrigin),
        });
      }
      if (request.method === "GET") {
        try {
          return await handleNext(request, env, kv);
        } catch (e) {
          console.error("next error", e);
          return new Response("error", { status: 500 });
        }
      }
    }

    // Desktop schedule-from-openf1 → KV for GET /next
    if (request.method === "POST" && url.pathname === "/schedule-cache") {
      try {
        return await handleScheduleCachePost(request, env, kv);
      } catch (e) {
        console.error("schedule-cache error", e);
        return new Response("error", { status: 500 });
      }
    }

    if (request.method === "GET" && url.pathname === "/schedule-cache") {
      if (!deliverSecretOk(env, request)) {
        return new Response("unauthorized", { status: 401 });
      }
      const schedule = await kvGetJson(kv, KV_SCHEDULE, null);
      return Response.json(schedule || { sessions: [] });
    }

    // Race-day alert inject
    if (request.method === "POST" && url.pathname === "/deliver") {
      try {
        return await handleDeliver(request, env, kv);
      } catch (e) {
        console.error("deliver error", e);
        return new Response("error", { status: 500 });
      }
    }

    // Telegram webhook: /telegram or /telegram/<WEBHOOK_SECRET>
    const secret = env.WEBHOOK_SECRET;
    const expected =
      secret != null && secret !== ""
        ? `/telegram/${secret}`
        : "/telegram";

    if (request.method === "POST" && url.pathname === expected) {
      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("bad json", { status: 400 });
      }

      await ensureCommands(env);

      try {
        if (update.message) {
          await handleMessage(env, kv, update.message);
        }
      } catch (e) {
        console.error("handler error", e);
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
