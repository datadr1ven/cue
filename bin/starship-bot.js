#!/usr/bin/env node
/**
 * TPlus — Telegram surface for Starship (Cue domain).
 *
 * Allowlisted users: full product (browse, eta, receive alerts).
 * Same allowlist: admin ops (buttons, note, broadcast, hype, mission use).
 *
 *   TELEGRAM_TOKEN=… TELEGRAM_ALLOWLIST=your_id npm run starship:bot
 *   DELIVERY_MODE=log|telegram|none  (default telegram if unset when token present)
 *
 * Commands: /start /help /missions /mission /eta /status
 * Admin:    /ops /note /broadcast /hype /mission use N
 */

import { Telegraf, Markup } from "telegraf";
import { config, requireTelegramToken } from "../src/config.js";
import { isAllowed, loadSubscribers, enrollUser } from "../src/users.js";
import { deliver } from "../src/delivery.js";
import { STARSHIP_ACTIONS, formatTPlus } from "../src/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session.js";
import { listMissions } from "../src/missions/registry.js";

requireTelegramToken();

const deliveryMode =
  process.env.DELIVERY_MODE ||
  (config.telegramToken ? "telegram" : "log");

const runtime = {
  deliveryMode,
  telegramAllowlist: config.telegramAllowlist,
};

const bot = new Telegraf(config.telegramToken);
let subscribers = loadSubscribers();

const initialRef = process.env.STARSHIP_SCRIPT
  ? undefined
  : process.env.STARSHIP_MISSION || "default";

const session = createStarshipSession({
  missionRef: process.env.STARSHIP_SCRIPT ? undefined : initialRef,
  scriptPath: process.env.STARSHIP_SCRIPT || undefined,
  minSeverity: 1,
});

function reloadSubscribers() {
  subscribers = loadSubscribers();
  return subscribers.size;
}

function requireUser(ctx) {
  return isAllowed(ctx.from?.id);
}

/**
 * Fan-out to all subscribers (including operator).
 * @param {string} text
 * @param {number} [exceptId] - deprecated; we send to everyone including ops
 */
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

// —— public-ish (allowlist) ——

bot.command("start", async (ctx) => {
  if (!requireUser(ctx)) {
    await ctx.reply("TPlus is private (allowlist only).");
    return;
  }
  enrollUser(ctx.from.id, {
    username: ctx.from.username || null,
    first_name: ctx.from.first_name || null,
  });
  reloadSubscribers();
  const st = session.status();
  await ctx.reply(
    `Subscribed to TPlus.\n` +
      `Active: ${st.missionName || "—"}\n\n` +
      `/missions — archive\n` +
      `/mission <n> — timeline\n` +
      `/eta — time until NET\n` +
      `/status — flight clock\n` +
      `/help — commands\n\n` +
      `Ops: /ops /note /broadcast /hype /mission use <n>`,
  );
});

bot.command("help", async (ctx) => {
  if (!requireUser(ctx)) return;
  await ctx.reply(
    `TPlus — sparse Starship flight alerts (Cue)\n\n` +
      `Everyone (allowlist)\n` +
      `/missions — list flights\n` +
      `/mission <n|id> — browse nominal T+\n` +
      `/eta — countdown to NET\n` +
      `/status — live T+ if liftoff marked\n\n` +
      `Ops\n` +
      `/ops — milestone buttons\n` +
      `/note <text> — freeform alert (all subscribers)\n` +
      `/broadcast <text> — announcement\n` +
      `/hype <hours> — e.g. /hype 48\n` +
      `/mission use <n> — set active flight for ops/eta\n\n` +
      `Unofficial; not affiliated with SpaceX.`,
  );
});

bot.command("missions", async (ctx) => {
  if (!requireUser(ctx)) return;
  const list = session.formatMissionList();
  await ctx.reply(`Missions (* = default)\n${list}\n\n/mission <n> to browse`);
});

bot.command("mission", async (ctx) => {
  if (!requireUser(ctx)) return;
  const raw = (ctx.message.text || "").replace(/^\/mission(@\w+)?\s*/i, "").trim();
  if (!raw) {
    const st = session.status();
    await ctx.reply(
      `Active: ${st.missionName || "—"}\n` +
        `Use /mission <n> to browse or /mission use <n> to switch ops.`,
    );
    return;
  }
  if (raw.toLowerCase().startsWith("use ")) {
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
  // Telegram message limit ~4096
  if (text.length > 3500) {
    await ctx.reply(text.slice(0, 3500) + "\n…");
  } else {
    await ctx.reply(text);
  }
});

bot.command("eta", async (ctx) => {
  if (!requireUser(ctx)) return;
  const st = session.status();
  await ctx.reply(
    `${st.missionName || "Mission"}\n${st.etaText}`,
  );
});

bot.command("status", async (ctx) => {
  if (!requireUser(ctx)) return;
  const st = session.status();
  await ctx.reply(
    `${st.missionName || "Starship"}\n` +
      `${st.tPlusLabel}\n` +
      `phase: ${st.phase}\n` +
      `last: ${st.lastActionId || "—"}\n` +
      `${st.etaText}`,
  );
});

// —— ops ——

bot.command("ops", async (ctx) => {
  if (!requireUser(ctx)) {
    await ctx.reply("Not allowlisted.");
    return;
  }
  const st = session.status();
  await ctx.reply(`Ops — ${st.missionName || "Starship"}`, opsKeyboard());
});

bot.command("note", async (ctx) => {
  if (!requireUser(ctx)) return;
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
  await fanOut(alertText);
  if (runtime.deliveryMode === "none") {
    await ctx.reply(`(delivery none) ${alertText}`);
  } else if (runtime.deliveryMode === "telegram") {
    // operator is a subscriber if enrolled; confirm
    await ctx.reply(`Sent (${reloadSubscribers()} subscribers).`);
  }
});

bot.command("broadcast", async (ctx) => {
  if (!requireUser(ctx)) return;
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
  await fanOut(alertText);
  if (runtime.deliveryMode !== "telegram") {
    await ctx.reply(alertText);
  } else {
    await ctx.reply(`Broadcast sent.`);
  }
});

bot.command("hype", async (ctx) => {
  if (!requireUser(ctx)) return;
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
  await fanOut(alertText);
  if (runtime.deliveryMode !== "telegram") {
    await ctx.reply(alertText);
  } else {
    await ctx.reply(`Hype sent (${hours}h template).`);
  }
});

bot.on("callback_query", async (ctx) => {
  if (!requireUser(ctx)) {
    await ctx.answerCbQuery("Not allowed");
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
  await fanOut(alertText);
  // Always show ops feedback with delta
  await ctx.reply(`${alertText}${extra}`);
});

bot.launch().then(() => {
  const st = session.status();
  console.log(
    `TPlus bot · mission=${st.missionName} · delivery=${runtime.deliveryMode} · allowlist=${config.telegramAllowlist.join(",") || "(empty)"} · subscribers=${reloadSubscribers()}`,
  );
  console.log(
    "Commands: /start /help /missions /mission /eta /status /ops /note /broadcast /hype",
  );
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
