#!/usr/bin/env node
/**
 * Offline smoke for GridWhisper product surface (no Telegram / CF).
 */
import { GRIDWHISPER_USER_COMMANDS } from "../src/gridwhisper-commands.js";

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

const cmds = GRIDWHISPER_USER_COMMANDS.map((c) => c.command);
assert(cmds.includes("start"), "start command");
assert(cmds.includes("help"), "help command");
assert(cmds.includes("status"), "status command");
assert(cmds.includes("stop"), "stop command");
assert(
  GRIDWHISPER_USER_COMMANDS.every((c) => c.description && c.command),
  "each command has description",
);
assert(cmds.length === 4, "exactly 4 user commands (no prefs)");

console.log("OK smoke:gridwhisper");
