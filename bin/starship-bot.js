#!/usr/bin/env node
/**
 * TPlus — Telegram surface for Starship (Cue domain).
 *
 * Subscribers: /start (ENROLL_OPEN=true by default) → data/users.json → alerts
 * Admins: TELEGRAM_ADMIN_IDS or TELEGRAM_ALLOWLIST → /ops /note /broadcast /hype /mission use
 *
 *   TELEGRAM_TOKEN=… TELEGRAM_ADMIN_IDS=you DELIVERY_MODE=telegram npm run starship:bot
 */

import { Telegraf, Markup } from "telegraf";
import { config, requireTelegramToken } from "../src/config.js";
import {
  isAdmin,
  canEnroll,
  loadSubscribers,
  enrollUser,
} from "../src/users.js";
import { deliver } from "../src/delivery.js";
import {
  STARSHIP_ACTIONS,
  formatTPlus,
} from "../src/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session.js";

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

/** Fan-out to every subscriber in users.json */
async function fanOut(text) {
  reloadSubscribers();
  const users = [...subscribers.values()];
  if (users.length === 0) {
    console.log(`[no-subscribers] ${text.replace(/\n/g, " | ")}`);
    return { n: 0 };
  }
  let n = 0;
  for (const user of users) {
    const r = await deliver(bot, runtime, user.user_id, text);
    if (r.ok) n += 1;
  }
  if (runtime.deliveryMode === "log") {
    console.log(`[deliver:log] → ${n} users: ${text.replace(/\n/g, " | ")}`);
  }
  return { n };
}

function opsKeyboard() {
  const rows = [];
  let row = [];
  for (const a of STARSHIP_ACTIONS) {
    row.push(
      Markup.button.callback(`${a.key}:${a.label}`.slice(0, 64), `ss:${a.id}`),
    );
    if (row.length === 2) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  rows.push([Markup.button.callback("T+ / status", "ss:__status")]);
  return Markup.inlineKeyboard(rows);
}

function userHelp() {
  return (
    `TPlus — sparse Starship flight alerts\n\n` +
    `/missions — list flights\n` +
    `/mission <n> — browse nominal T+\n` +
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
    `/ops — milestone buttons\n` +
    `/note <text> — freeform alert\n` +
    `/broadcast <text> — announcement\n` +
    `/hype <hours> — e.g. /hype 48\n` +
    `/mission use <n> — set active flight`
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
  // browse: any enrolled user, or anyone if open
  if (!canEnroll(ctx.from.id) && !isAdmin(ctx.from.id)) {
    await ctx.reply("Use /start first.");
    return;
  }
  const list = session.formatMissionList();
  await ctx.reply(`Missions (* = default)\n${list}\n\n/mission <n> to browse`);
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
    const st = session.status();
    await ctx.reply(
      `Active: ${st.missionName || "—"}\n` +
        `/mission <n> to browse` +
        (isAdmin(ctx.from.id) ? ` · /mission use <n> to switch ops` : ""),
    );
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
  await ctx.reply(`${st.missionName || "Mission"}\n${st.etaText}`);
});

bot.command("status", async (ctx) => {
  const st = session.status();
  await ctx.reply(
    `${st.missionName || "Starship"}\n` +
      `${st.tPlusLabel}\n` +
      `phase: ${st.phase}\n` +
      `last: ${st.lastActionId || "—"}\n` +
      `${st.etaText}`,
  );
});

// —— admin ops ——

bot.command("ops", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const st = session.status();
  await ctx.reply(`Ops — ${st.missionName || "Starship"}`, opsKeyboard());
});

bot.command("note", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const text = (ctx.message.text || "").replace(/^\/note(@\w+)?\s*/i, "").trim();
  if (!text) {
    await ctx.reply("Usage: /note <text>");
    return;
  }
  const r = await session.fireNote(text);
  if (!r.ok) {
    await ctx.reply(r.error);
    return;
  }
  const alertText = r.alerts[0]?.text || text;
  const { n } = await fanOut(alertText);
  await ctx.reply(`Sent to ${n} subscriber(s).`);
});

bot.command("broadcast", async (ctx) => {
  if (!requireAdmin(ctx)) {
    await ctx.reply("Admin only.");
    return;
  }
  const text = (ctx.message.text || "")
    .replace(/^\/broadcast(@\w+)?\s*/i, "")
    .trim();
  if (!text) {
    await ctx.reply("Usage: /broadcast <text>");
    return;
  }
  const r = await session.fireBroadcast(text);
  if (!r.ok) {
    await ctx.reply(r.error);
    return;
  }
  const alertText = r.alerts[0]?.text || text;
  const { n } = await fanOut(alertText);
  await ctx.reply(`Broadcast to ${n} subscriber(s).`);
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
    await ctx.answerCbQuery(st.tPlusLabel);
    await ctx.reply(`${st.tPlusLabel} · phase ${st.phase}`);
    return;
  }

  const result = await session.fire(id);
  if (!result.ok) {
    await ctx.answerCbQuery(result.error || "error");
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

  await ctx.answerCbQuery("ok");
  const { n } = await fanOut(alertText);
  await ctx.reply(`${alertText}${extra}\n→ ${n} subscriber(s)`);
});

bot.launch().then(() => {
  const st = session.status();
  console.log(
    `TPlus bot · mission=${st.missionName} · delivery=${runtime.deliveryMode} · ` +
      `admins=${config.adminIds.join(",") || "(none=all ops)"} · ` +
      `enrollOpen=${config.enrollOpen} · subscribers=${reloadSubscribers()}`,
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
