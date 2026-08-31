#!/usr/bin/env node
/**
 * TPlus — local Telegram bot (Cue launch domain). Prefer CF Worker in prod.
 *
 * Subscribers: /start → data/users.json → alerts
 * Admins: TELEGRAM_ADMIN_IDS → /ops /note /broadcast /hype /mission use
 * Photo: send image with caption "/note …" or "/broadcast …"
 *
 *   TELEGRAM_TOKEN=… TELEGRAM_ADMIN_IDS=you DELIVERY_MODE=telegram npm run starship:bot
 */

import { Telegraf, Markup } from "telegraf";
import { config, requireTelegramToken } from "cue/config.js";
import {
  isAdmin,
  canEnroll,
  loadSubscribers,
  enrollUser,
} from "cue/users.js";
import { deliver } from "cue/delivery.js";
import {
  formatTPlus,
  opsActionsForScript,
  opsInlineKeyboardRows,
} from "cue/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session-node.js";
import {
  TPLUS_USER_COMMANDS,
  parseNoteOrBroadcast,
  largestPhotoFileId,
} from "../src/tplus-commands.js";

requireTelegramToken();

const deliveryMode =
  process.env.DELIVERY_MODE ||
  (config.telegramToken ? "telegram" : "log");

const runtime = {
  deliveryMode,
};

const bot = new Telegraf(config.telegramToken);
let subscribers = loadSubscribers();

const session = createStarshipSession({
  missionRef: process.env.STARSHIP_SCRIPT
    ? undefined
    : process.env.STARSHIP_MISSION || "default",
  scriptPath: process.env.STARSHIP_SCRIPT || undefined,
  minSeverity: 1,
});

function reloadSubscribers() {
  subscribers = loadSubscribers();
  return subscribers.size;
}

function requireAdmin(ctx) {
  return isAdmin(ctx.from?.id);
}

/**
 * @param {string} text
 * @param {{ photoFileId?: string|null, excludeChatIds?: Array<number|string|null|undefined> }} [media]
 */
async function fanOut(text, media = {}) {
  reloadSubscribers();
  const exclude = new Set(
    (media.excludeChatIds || [])
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n)),
  );
  const users = [...subscribers.values()];
  if (users.length === 0) {
    console.log(`[no-subscribers] ${text.replace(/\n/g, " | ")}`);
    return { n: 0 };
  }
  let n = 0;
  for (const user of users) {
    if (exclude.has(Number(user.user_id))) continue;
    const r = await deliver(bot, runtime, user.user_id, text, {
      photoFileId: media.photoFileId,
    });
    if (r.ok) n += 1;
  }
  if (runtime.deliveryMode === "log") {
    console.log(
      `[deliver:log] → ${n} users photo=${Boolean(media.photoFileId)}: ${text.replace(/\n/g, " | ")}`,
    );
  }
  return { n };
}

function opsKeyboard() {
  const actions = opsActionsForScript(session.scriptDoc?.script || []);
  const rows = opsInlineKeyboardRows(actions, { columns: 1 }).map((row) =>
    row.map((b) => Markup.button.callback(b.text, b.callback_data)),
  );
  return Markup.inlineKeyboard(rows);
}

function userHelp() {
  return (
    `TPlus — sparse SpaceX launch alerts\n\n` +
    `/missions — list missions\n` +
    `/mission — active mission timeline\n` +
    `/mission <id|n> — browse nominal T+\n` +
    `/eta — countdown to NET\n` +
    `/status — flight clock (if live)\n` +
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
    `/hype <hours> — e.g. /hype 48\n` +
    `/mission use <n|id> — set active mission`
  );
}

/**
 * @param {'note'|'broadcast'} kind
 * @param {string} text
 * @param {string|null} photoFileId
 */
async function sendNoteOrBroadcast(ctx, kind, text, photoFileId) {
  const body = (text || "").trim();
  if (!body && !photoFileId) {
    await ctx.reply(
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
    await ctx.reply(r.error);
    return;
  }
  const alertText = r.alerts[0]?.text || label;
  const { n } = await fanOut(alertText, { photoFileId });
  await ctx.reply(
    kind === "note"
      ? `Sent to ${n} subscriber(s)${photoFileId ? " (with photo)" : ""}.`
      : `Broadcast to ${n} subscriber(s)${photoFileId ? " (with photo)" : ""}.`,
  );
}

// —— subscribers ——

bot.command("start", async (ctx) => {
  const id = ctx.from.id;
  if (!canEnroll(id)) {
    await ctx.reply("Enrollment is closed. Contact the operator.");
    return;
  }
  enrollUser(id, {
    username: ctx.from.username || null,
    first_name: ctx.from.first_name || null,
  });
  const n = reloadSubscribers();
  const st = session.status();
  const admin = isAdmin(id);
  await ctx.reply(
    `Subscribed to TPlus (${n} subscribers).\n` +
      `Active: ${st.missionName || "—"}\n\n` +
      (admin ? opsHelp() : userHelp()),
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(isAdmin(ctx.from.id) ? opsHelp() : userHelp());
});

bot.command("missions", async (ctx) => {
  if (!canEnroll(ctx.from.id) && !isAdmin(ctx.from.id)) {
    await ctx.reply("Use /start first.");
    return;
  }
  const list = session.formatMissionList();
  await ctx.reply(
    `Missions (> = active · * = default)\n${list}\n\n/mission — active timeline\n/mission <id|n> — browse\n/mission use <id|n> — switch (admin)`,
  );
});

bot.command("mission", async (ctx) => {
  if (!canEnroll(ctx.from.id) && !isAdmin(ctx.from.id)) {
    await ctx.reply("Use /start first.");
    return;
  }
  const raw = (ctx.message.text || "")
    .replace(/^\/mission(@\w+)?\s*/i, "")
    .trim();
  if (!raw) {
    // Bare /mission → active mission nominal timeline
    const text = session.formatTimeline(null);
    await ctx.reply(text.length > 3500 ? text.slice(0, 3500) + "\n…" : text);
    return;
  }
  if (raw.toLowerCase().startsWith("use ")) {
    if (!requireAdmin(ctx)) {
      await ctx.reply("Admin only.");
      return;
    }
    const ref = raw.slice(4).trim();
    const r = session.loadMission(ref);
    if (!r.ok) {
      await ctx.reply(r.error);
      return;
    }
    await ctx.reply(`Active mission → ${r.doc.missionName || r.entry.id}`);
    return;
  }
  const text = session.formatTimeline(raw);
  await ctx.reply(text.length > 3500 ? text.slice(0, 3500) + "\n…" : text);
});

bot.command("eta", async (ctx) => {
  const st = session.status();
  await ctx.reply(st.etaText);
});

bot.command("status", async (ctx) => {
  const st = session.status();
  const lines = [
    st.missionName || "TPlus",
    st.tPlusLabel,
    `phase: ${st.phase}`,
    `last: ${st.lastActionId || "—"}`,
  ];
  if (st.statusEtaLine) lines.push(st.statusEtaLine);
  await ctx.reply(lines.join("\n"));
});

// —— admin ops ——

bot.command("ops", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const st = session.status();
  const n = opsActionsForScript(session.scriptDoc?.script || []).length;
  await ctx.reply(
    `Ops — ${st.missionName || "mission"} (${n} buttons · script + hold/go/anomaly)`,
    opsKeyboard(),
  );
});

bot.command("note", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const text = (ctx.message.text || "").replace(/^\/note(@\w+)?\s*/i, "").trim();
  await sendNoteOrBroadcast(ctx, "note", text, null);
});

bot.command("broadcast", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const text = (ctx.message.text || "")
    .replace(/^\/broadcast(@\w+)?\s*/i, "")
    .trim();
  await sendNoteOrBroadcast(ctx, "broadcast", text, null);
});

/** Photo with caption /note … or /broadcast … */
bot.on("photo", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const parsed = parseNoteOrBroadcast(ctx.message.caption || "");
  if (!parsed) {
    await ctx.reply(
      "To send a photo to subscribers, use caption:\n/note your text\nor\n/broadcast your text",
    );
    return;
  }
  const fileId = largestPhotoFileId(ctx.message);
  await sendNoteOrBroadcast(ctx, parsed.kind, parsed.text, fileId);
});

bot.command("hype", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const raw = (ctx.message.text || "").replace(/^\/hype(@\w+)?\s*/i, "").trim();
  const hours = raw ? Number(raw) : 48;
  if (!Number.isFinite(hours) || hours <= 0) {
    await ctx.reply("Usage: /hype <hours>  e.g. /hype 48");
    return;
  }
  const r = await session.fireHype(hours);
  if (!r.ok) {
    await ctx.reply(r.error);
    return;
  }
  const alertText = r.alerts[0]?.text || r.label;
  const { n } = await fanOut(alertText);
  await ctx.reply(`Hype sent to ${n} subscriber(s).`);
});

bot.on("callback_query", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.answerCbQuery("Admin only");
    return;
  }
  const data = ctx.callbackQuery.data || "";
  if (!data.startsWith("ss:")) {
    await ctx.answerCbQuery();
    return;
  }
  const id = data.slice(3);

  if (id === "__status") {
    const st = session.status();
    await ctx.answerCbQuery(`${st.tPlusLabel} · ${st.phase}`.slice(0, 200));
    return;
  }

  const result = await session.fire(id);
  if (!result.ok) {
    await ctx.answerCbQuery(result.error || "error", { show_alert: true });
    return;
  }

  const alertText = result.alerts[0]?.text || `Marked ${id}`;
  let deltaBit = "";
  if (
    result.tPlusSec != null &&
    result.action?.scriptTPlusSec != null &&
    id !== "liftoff"
  ) {
    const delta = result.tPlusSec - result.action.scriptTPlusSec;
    deltaBit = ` · Δ${delta >= 0 ? "+" : ""}${Math.round(delta)}s`;
  }

  const { n } = await fanOut(alertText, {
    excludeChatIds: [ctx.from?.id, ctx.chat?.id],
  });
  await ctx.answerCbQuery(`${alertText}${deltaBit} → ${n}`.slice(0, 200));
});

bot.launch().then(async () => {
  try {
    await bot.telegram.setMyCommands(TPLUS_USER_COMMANDS);
    console.log("Telegram / menu commands set (user-facing)");
  } catch (e) {
    console.warn("setMyCommands failed:", e.message);
  }
  const st = session.status();
  console.log(
    `TPlus bot · mission=${st.missionName} · delivery=${runtime.deliveryMode} · ` +
      `admins=${config.adminIds.join(",") || "(none=all ops)"} · ` +
      `enrollOpen=${config.enrollOpen} · subscribers=${reloadSubscribers()}`,
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
