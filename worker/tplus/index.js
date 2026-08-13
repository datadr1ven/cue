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
  STARSHIP_ACTIONS,
  formatTPlus,
} from "../../src/engine/domains/starship/index.js";
import {
  bundledLoadMission,
  bundledListMissions,
  bundledFormatEta,
} from "../../src/missions/bundle.js";

const loader = {
  loadMission: bundledLoadMission,
  listMissions: bundledListMissions,
  formatEta: bundledFormatEta,
};

const KV_USERS = "users:v1";
const KV_SESSION = "session:v1";

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

async function fanOut(env, kv, text) {
  const ids = await subscriberIds(kv, env);
  let n = 0;
  for (const id of ids) {
    const r = await reply(env, id, text);
    if (r.ok) n += 1;
  }
  return n;
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

function opsKeyboard() {
  const inline_keyboard = [];
  let row = [];
  for (const a of STARSHIP_ACTIONS) {
    row.push({
      text: `${a.key}:${a.label}`.slice(0, 64),
      callback_data: `ss:${a.id}`,
    });
    if (row.length === 2) {
      inline_keyboard.push(row);
      row = [];
    }
  }
  if (row.length) inline_keyboard.push(row);
  inline_keyboard.push([{ text: "T+ / status", callback_data: "ss:__status" }]);
  return { inline_keyboard };
}

function userHelp() {
  return (
    `TPlus — sparse Starship flight alerts\n\n` +
    `/missions — list flights\n` +
    `/mission <n> — browse nominal T+\n` +
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
    `/ops — milestone buttons\n` +
    `/note <text>\n` +
    `/broadcast <text>\n` +
    `/hype <hours>\n` +
    `/mission use <n>`
  );
}

function cmdText(message) {
  return (message?.text || "").trim();
}

function stripCmd(text, name) {
  const re = new RegExp(`^/${name}(@\\w+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

async function handleMessage(env, kv, message) {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const text = cmdText(message);
  if (!text.startsWith("/")) return;

  const session = await getSession(env, kv);
  const admin = isAdmin(env, userId);

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
      `Missions (* = default)\n${session.formatMissionList()}\n\n/mission <n> to browse`,
    );
    return;
  }

  if (text.startsWith("/mission")) {
    const raw = stripCmd(text, "mission");
    if (!raw) {
      const st = session.status();
      await reply(
        env,
        chatId,
        `Active: ${st.missionName || "—"}\n/mission <n> to browse` +
          (admin ? " · /mission use <n> for ops" : ""),
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
      st.missionName || "Starship",
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
    await reply(env, chatId, `Ops — ${st.missionName || "Starship"}`, {
      reply_markup: opsKeyboard(),
    });
    return;
  }

  if (text.startsWith("/note")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const note = stripCmd(text, "note");
    if (!note) {
      await reply(env, chatId, "Usage: /note <text>");
      return;
    }
    const r = await session.fireNote(note);
    await persistSession(kv, session);
    const alertText = r.alerts[0]?.text || note;
    const n = await fanOut(env, kv, alertText);
    await reply(env, chatId, `Sent to ${n} subscriber(s).`);
    return;
  }

  if (text.startsWith("/broadcast")) {
    if (!admin) {
      await reply(env, chatId, "Admin only.");
      return;
    }
    const body = stripCmd(text, "broadcast");
    if (!body) {
      await reply(env, chatId, "Usage: /broadcast <text>");
      return;
    }
    const r = await session.fireBroadcast(body);
    await persistSession(kv, session);
    const alertText = r.alerts[0]?.text || body;
    const n = await fanOut(env, kv, alertText);
    await reply(env, chatId, `Broadcast to ${n} subscriber(s).`);
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
    await persistSession(kv, session);
    const alertText = r.alerts[0]?.text || r.label;
    const n = await fanOut(env, kv, alertText);
    await reply(env, chatId, `Hype sent to ${n} subscriber(s).`);
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
