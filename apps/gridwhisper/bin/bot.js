#!/usr/bin/env node
/**
 * Telegram enrollment bot.
 * Allowlisted users: /start writes data/users.json for the worker.
 */

import { Telegraf } from "telegraf";
import { config, requireTelegramToken } from "cue/config.js";
import { enrollUser, isAllowed, loadSubscribers } from "cue/users.js";

requireTelegramToken();

const bot = new Telegraf(config.telegramToken);
loadSubscribers();

bot.command("start", async (ctx) => {
  const id = ctx.from.id;
  if (!isAllowed(id)) {
    await ctx.reply("This bot is private.");
    return;
  }
  enrollUser(id, {
    username: ctx.from.username || null,
    first_name: ctx.from.first_name || null,
  });
  await ctx.reply(
    "Subscribed to Cue alerts.\n" +
      "A worker process must be running to deliver live session alerts.\n\n" +
      "/status — enrollment\n/help — commands",
  );
});

bot.command("status", async (ctx) => {
  const n = loadSubscribers().size;
  const ok = isAllowed(ctx.from.id);
  await ctx.reply(
    `Allowlisted: ${ok ? "yes" : "no"}\nSubscribers: ${n}`,
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Cue — sparse live session alerts.\n" +
      "/start — subscribe (allowlist required)\n" +
      "/status — enrollment\n" +
      "/help — this message",
  );
});

bot.launch().then(() => {
  console.log("Cue bot polling");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
