#!/usr/bin/env node
/**
 * Starship HITL via Telegram (allowlisted "master" accounts).
 *
 *   TELEGRAM_TOKEN=… TELEGRAM_ALLOWLIST=your_id npm run starship:bot
 *
 * /ops — keyboard of script buttons
 * Tap a button when you see the event in the webcast
 * Alerts echo back to you (and optional DELIVERY to subscribers)
 *
 * Yes: the bot master account is a valid ops console while video plays on another screen.
 */

import { Telegraf, Markup } from "telegraf";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { config, requireTelegramToken } from "../src/config.js";
import { isAllowed, loadSubscribers } from "../src/users.js";
import { deliver } from "../src/delivery.js";
import { getRuntime } from "../src/runtime.js";
import {
  STARSHIP_ACTIONS,
  formatTPlus,
} from "../src/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultScript = join(
  __dirname,
  "..",
  "examples",
  "starship-flight-13-script.json",
);

requireTelegramToken();

const scriptPath = process.env.STARSHIP_SCRIPT
  ? resolve(process.env.STARSHIP_SCRIPT)
  : defaultScript;

/** optional fan-out to all subscribers when DELIVERY_MODE set */
let runtime = null;
try {
  runtime = getRuntime();
} catch {
  runtime = {
    deliveryMode: process.env.DELIVERY_MODE || "none",
    telegramAllowlist: config.telegramAllowlist,
  };
}

const bot = new Telegraf(config.telegramToken);
const subscribers = loadSubscribers();

const session = createStarshipSession({
  scriptPath,
  minSeverity: 1,
  onAlert: async (alert, state) => {
    // always handled by fire() caller for the operator; fan-out below
  },
});

function opsKeyboard() {
  // Telegram inline: 2 buttons per row
  const rows = [];
  let row = [];
  for (const a of STARSHIP_ACTIONS) {
    row.push(
      Markup.button.callback(
        `${a.key}:${a.label}`.slice(0, 64),
        `ss:${a.id}`,
      ),
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

function requireMaster(ctx) {
  const id = ctx.from?.id;
  if (!isAllowed(id)) {
    return false;
  }
  return true;
}

bot.command("start", async (ctx) => {
  if (!requireMaster(ctx)) {
    await ctx.reply("Private bot.");
    return;
  }
  await ctx.reply(
    "Cue Starship ops.\n/ops — open buttons\n/status — T+ and phase\nWatch the webcast; tap when events happen.",
  );
});

bot.command("ops", async (ctx) => {
  if (!requireMaster(ctx)) {
    await ctx.reply("Not allowlisted.");
    return;
  }
  const name = session.scriptDoc?.missionName || "Starship";
  await ctx.reply(`Ops console — ${name}`, opsKeyboard());
});

bot.command("status", async (ctx) => {
  if (!requireMaster(ctx)) return;
  const st = session.status();
  await ctx.reply(
    `${st.missionName || "Starship"}\n${st.tPlusLabel}\nphase: ${st.phase}\nlast: ${st.lastActionId || "—"}`,
  );
});

bot.on("callback_query", async (ctx) => {
  if (!requireMaster(ctx)) {
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
    result.action.scriptTPlusSec != null &&
    id !== "liftoff"
  ) {
    const delta = result.tPlusSec - result.action.scriptTPlusSec;
    extra = `\n(script T+${formatTPlus(result.action.scriptTPlusSec)}, Δ ${delta >= 0 ? "+" : ""}${Math.round(delta)}s)`;
  }

  await ctx.answerCbQuery("ok");
  await ctx.reply(`${alertText}${extra}`);

  // Fan-out to subscribers if delivery is log/telegram
  if (runtime.deliveryMode === "log" || runtime.deliveryMode === "telegram") {
    for (const user of subscribers.values()) {
      if (user.user_id === ctx.from.id) continue;
      await deliver(bot, runtime, user.user_id, alertText);
    }
    if (runtime.deliveryMode === "log") {
      console.log(`[deliver:log] ${alertText}`);
    }
  }
});

bot.launch().then(() => {
  console.log(
    `Starship ops bot — script=${scriptPath} allowlist=${config.telegramAllowlist.join(",") || "(empty — all blocked for ops)"}`,
  );
  console.log("Commands: /ops /status");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
