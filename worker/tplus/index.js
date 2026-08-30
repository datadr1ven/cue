/**
 * Cloudflare Worker — TPlus Telegram webhook (free tier).
 *
 * Bindings (wrangler.toml):
 *   KV  TPLUS_KV
 * Secrets:
 *   TELEGRAM_TOKEN
 *   TELEGRAM_ADMIN_IDS   (comma-separated)
 * Vars:
 *   ENROLL_OPEN=true
 *   WEBHOOK_SECRET       (optional path secret)
 */

import { createStarshipSession } from "../../src/starship-session.js";
import {
  formatTPlus,
  opsActionsForScript,
  opsInlineKeyboardRows,
} from "../../src/engine/domains/starship/index.js";
import {
  bundledLoadMission,
  bundledListMissions,
  bundledFormatEta,
} from "../../src/missions/bundle.js";
import {
  TPLUS_USER_COMMANDS,
  parseNoteOrBroadcast,
  largestPhotoFileId,
} from "../../src/tplus-commands.js";
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
} from "../../src/telegram-inbox.js";

const loader = {
  loadMission: bundledLoadMission,
  listMissions: bundledListMissions,
  formatEta: bundledFormatEta,
};

const KV_USERS = "users:v1";
const KV_SESSION = "session:v1";

/** Once per isolate — keep Telegram / menu in sync with TPLUS_USER_COMMANDS */
let commandsRegistered = false;

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
  if (!admins.length) return true;
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

/** Admin opened /inbox — drop pending digest count. */
async function markInboxSeen(kv) {
  const next = clearInboxNotifyPending(await loadNotifyState(kv));
  await saveNotifyState(kv, next);
}

/**
 * Digest-coalesce admin DM after a user inbox capture.
 * Skips when the sender is an admin (no self-ping).
 */
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

/** Store free-text / unlabeled photo; silent if nothing to store. */
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

async function loadUsers(kv) {
  const data = await kvGetJson(kv, KV_USERS, { users: {} });
  return data;
}

async function saveUsers(kv, data) {
  await kvPutJson(kv, KV_USERS, data);
}

async function enrollUser(kv, env, userId, meta = {}) {
  const data = await loadUsers(kv);
  const id = String(userId);
  const admin = isAdmin(env, userId);
  // seed admins
  for (const a of parseAdminIds(env)) {
    if (!data.users[String(a)]) {
      data.users[String(a)] = {
        user_id: a,
        enrolledAt: new Date().toISOString(),
        role: "admin",
      };
    }
  }
  data.users[id] = {
    user_id: Number(userId),
    enrolledAt: data.users[id]?.enrolledAt || new Date().toISOString(),
    role: admin ? "admin" : "subscriber",
    ...meta,
  };
  await saveUsers(kv, data);
  return Object.keys(data.users).length;
}

async function subscriberIds(kv, env) {
  const data = await loadUsers(kv);
  for (const a of parseAdminIds(env)) {
    if (!data.users[String(a)]) {
      data.users[String(a)] = {
        user_id: a,
        enrolledAt: new Date().toISOString(),
        role: "admin",
      };
      await saveUsers(kv, data);
    }
  }
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

/**
 * Fan-out text (and optional photo via file_id) to all subscribers.
 * @param {{ photoFileId?: string|null }} [media]
 */
async function fanOut(env, kv, text, media = {}) {
  const ids = await subscriberIds(kv, env);
  const photoFileId = media.photoFileId || null;
  const caption = String(text || "").slice(0, 1024);
  let n = 0;
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
  }
  return n;
}

async function ensureCommands(env) {
  if (commandsRegistered) return;
  commandsRegistered = true;
  try {
    await tg(env, "setMyCommands", { commands: TPLUS_USER_COMMANDS });
  } catch (e) {
    console.error("setMyCommands failed", e);
    commandsRegistered = false;
  }
}

/**
 * @param {'note'|'broadcast'} kind
 * @param {string} text
 * @param {string|null} photoFileId
 */
async function sendNoteOrBroadcast(env, kv, session, chatId, kind, text, photoFileId) {
  const body = (text || "").trim();
  if (!body && !photoFileId) {
    await reply(
      env,
      chatId,
      kind === "note"
        ? "Usage: /note <text> — or send a photo with caption /note …"
        : "Usage: /broadcast <text> — or send a photo with caption /broadcast …",
    );
    return;
  }
  const label = body || "📷";
  const r =
    kind === "note"
      ? await session.fireNote(label)
      : await session.fireBroadcast(label);
  if (!r.ok) {
    await reply(env, chatId, r.error || "failed");
    return;
  }
  await persistSession(kv, session);
  const alertText = r.alerts[0]?.text || label;
  const n = await fanOut(env, kv, alertText, { photoFileId });
  const withPhoto = photoFileId ? " (with photo)" : "";
  await reply(
    env,
    chatId,
    kind === "note"
      ? `Sent to ${n} subscriber(s)${withPhoto}.`
      : `Broadcast to ${n} subscriber(s)${withPhoto}.`,
  );
}

async function getSession(env, kv) {
  const saved = await kvGetJson(kv, KV_SESSION, null);
  const missionRef = saved?.missionId || env.STARSHIP_MISSION || "default";
  const session = createStarshipSession({
    missionRef,
    minSeverity: 1,
    loader,
  });
  if (saved) session.hydrate(saved);
  return session;
}

async function persistSession(kv, session) {
  await kvPutJson(kv, KV_SESSION, session.exportState());
}

/**
 * Mission-scoped ops pad: always-on (hold/go/anomaly/…) + active script.
 * @param {object|null|undefined} session
 */
function opsKeyboard(session) {
  const script = session?.scriptDoc?.script || [];
  const actions = opsActionsForScript(script);
  return { inline_keyboard: opsInlineKeyboardRows(actions, { columns: 1 }) };
}

function userHelp() {
  return (
    `TPlus — sparse SpaceX launch alerts\n\n` +
    `/missions — list missions\n` +
    `/mission — active mission timeline\n` +
    `/mission <id|n> — browse nominal T+\n` +
    `/eta — countdown to NET\n` +
    `/status — flight clock\n` +
    `/help — this message\n\n` +
    `Unofficial; not affiliated with SpaceX.`
  );
}

function opsHelp() {
  return (
    userHelp() +
    `\n\nOps (admin)\n` +
    `/ops — mission milestones + hold/go/anomaly\n` +
    `/note <text> — freeform alert (or photo + caption /note …)\n` +
    `/broadcast <text> — announcement (or photo + caption /broadcast …)\n` +
    `/hype <hours>\n` +
    `/mission use <id|n> — switch active mission\n` +
    `/inbox — read free-text messages from users\n` +
    `/inbox clear — wipe inbox\n` +
    `/reply last <text> — DM the last inbox user\n` +
    `/reply <userId|@user> <text> — DM that user\n` +
    `(new inbox messages ping admins; batched ~10m)`
  );
}

/** Command line from text message or photo caption. */
function cmdText(message) {
  return (message?.text || message?.caption || "").trim();
}

function stripCmd(text, name) {
  const re = new RegExp(`^/${name}(@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

async function handleMessage(env, kv, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = cmdText(message);
  const photoFileId = largestPhotoFileId(message);
  const session = await getSession(env, kv);
  const admin = isAdmin(env, userId);

  // Photo with caption /note … or /broadcast … (or inbox if unlabeled free-text)
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

  if (photoFileId) {
    const parsed = parseNoteOrBroadcast(text);
    if (parsed) {
      if (!admin) {
        await reply(env, chatId, "Admin only.");
        return;
      }
      await sendNoteOrBroadcast(
        env,
        kv,
        session,
        chatId,
        parsed.kind,
        parsed.text,
        photoFileId,
      );
      return;
    }
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
    const st = session.status();
    await reply(
      env,
      chatId,
      `Subscribed to TPlus (${n} subscribers).\nActive: ${st.missionName || "—"}\n\n` +
        (admin ? opsHelp() : userHelp()),
    );
    return;
  }

  if (text.startsWith("/help")) {
    await reply(env, chatId, admin ? opsHelp() : userHelp());
    return;
  }

  if (text.startsWith("/missions")) {
    await reply(
      env,
      chatId,
      `Missions (* = default)\n${session.formatMissionList()}\n\n` +
        `/mission — active timeline\n` +
        `/mission <id|n> — browse\n` +
        `/mission use <id|n> — switch (admin)`,
    );
    return;
  }

  if (text.startsWith("/mission")) {
    const raw = stripCmd(text, "mission");
    if (!raw) {
      // Bare /mission → active mission nominal timeline
      const body = session.formatTimeline(null);
      await reply(
        env,
        chatId,
        body.length > 3500 ? body.slice(0, 3500) + "\n…" : body,
      );
      return;
    }
    if (raw.toLowerCase().startsWith("use ")) {
      if (!admin) {
        await reply(env, chatId, "Admin only.");
        return;
      }
      const ref = raw.slice(4).trim();
      const r = session.loadMission(ref);
      if (!r.ok) {
        await reply(env, chatId, r.error);
        return;
      }
      await persistSession(kv, session);
      await reply(env, chatId, `Active mission → ${r.doc.missionName || r.entry.id}`);
      return;
    }
    const body = session.formatTimeline(raw);
    await reply(env, chatId, body.length > 3500 ? body.slice(0, 3500) + "\n…" : body);
    return;
  }

  if (text.startsWith("/eta")) {
    const st = session.status();
    await reply(env, chatId, st.etaText);
    return;
  }

  if (text.startsWith("/status")) {
    const st = session.status();
    const lines = [
      st.missionName || "TPlus",
      st.tPlusLabel,
      `phase: ${st.phase}`,
      `last: ${st.lastActionId || "—"}`,
    ];
    if (st.statusEtaLine) lines.push(st.statusEtaLine);
    await reply(env, chatId, lines.join("\n"));
    return;
  }

  if (text.startsWith("/ops")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const st = session.status();
    const n = opsActionsForScript(session.scriptDoc?.script || []).length;
    await reply(
      env,
      chatId,
      `Ops — ${st.missionName || "mission"} (${n} buttons · script + hold/go/anomaly)`,
      { reply_markup: opsKeyboard(session) },
    );
    return;
  }

  if (text.startsWith("/note")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    await sendNoteOrBroadcast(
      env,
      kv,
      session,
      chatId,
      "note",
      stripCmd(text, "note"),
      photoFileId,
    );
    return;
  }

  if (text.startsWith("/broadcast")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    await sendNoteOrBroadcast(
      env,
      kv,
      session,
      chatId,
      "broadcast",
      stripCmd(text, "broadcast"),
      photoFileId,
    );
    return;
  }

  if (text.startsWith("/hype")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const raw = stripCmd(text, "hype");
    const hours = raw ? Number(raw) : 48;
    if (!Number.isFinite(hours) || hours <= 0) {
      await reply(env, chatId, "Usage: /hype <hours>");
      return;
    }
    const r = await session.fireHype(hours);
    if (!r.ok) {
      await reply(env, chatId, r.error || "hype failed");
      return;
    }
    await persistSession(kv, session);
    const alertText = r.alerts[0]?.text || r.label;
    const n = await fanOut(env, kv, alertText);
    await reply(env, chatId, `Hype sent to ${n} subscriber(s).`);
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

async function handleCallback(env, kv, cq) {
  const userId = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  if (!isAdmin(env, userId)) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: "Admin only",
    });
    return;
  }

  const data = cq.data || "";
  if (!data.startsWith("ss:")) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    return;
  }
  const id = data.slice(3);
  const session = await getSession(env, kv);

  if (id === "__status") {
    const st = session.status();
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: st.tPlusLabel,
    });
    await reply(env, chatId, `${st.tPlusLabel} · phase ${st.phase}`);
    return;
  }

  const result = await session.fire(id);
  await persistSession(kv, session);
  if (!result.ok) {
    await tg(env, "answerCallbackQuery", {
      callback_query_id: cq.id,
      text: result.error || "error",
    });
    return;
  }

  const alertText = result.alerts[0]?.text || `Marked ${id}`;
  let extra = "";
  if (
    result.tPlusSec != null &&
    result.action?.scriptTPlusSec != null &&
    id !== "liftoff"
  ) {
    const delta = result.tPlusSec - result.action.scriptTPlusSec;
    extra = `\n(script T+${formatTPlus(result.action.scriptTPlusSec)}, Δ ${delta >= 0 ? "+" : ""}${Math.round(delta)}s)`;
  }

  await tg(env, "answerCallbackQuery", {
    callback_query_id: cq.id,
    text: "ok",
  });
  const n = await fanOut(env, kv, alertText);
  await reply(env, chatId, `${alertText}${extra}\n→ ${n} subscriber(s)`);
}

export default {
  async fetch(request, env) {
    if (!env.TELEGRAM_TOKEN) {
      return new Response("TELEGRAM_TOKEN not configured", { status: 500 });
    }
    if (!env.TPLUS_KV) {
      return new Response("TPLUS_KV binding missing", { status: 500 });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("TPlus worker ok", { status: 200 });
    }

    // Webhook: /telegram or /telegram/<WEBHOOK_SECRET>
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

      // Best-effort: register user-facing / menu (ops stay out of BotFather list)
      await ensureCommands(env);

      try {
        if (update.message) {
          await handleMessage(env, env.TPLUS_KV, update.message);
        } else if (update.callback_query) {
          await handleCallback(env, env.TPLUS_KV, update.callback_query);
        }
      } catch (e) {
        console.error("handler error", e);
      }
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },
};
