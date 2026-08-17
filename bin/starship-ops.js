#!/usr/bin/env node
/**
 * TPlus HITL CLI — watch webcast, press keys for active mission.
 *
 *   npm run starship:ops
 *   npm run starship:ops -- --mission 12
 *   npm run starship:ops -- --mission starlink-sl-17-50
 *   npm run starship:ops -- --script path/to/file.json
 *
 * Keys: ? help (mission-scoped) · 0 liftoff · n note · q quit
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import {
  actionByKey,
  formatHelp,
  formatTPlus,
} from "../src/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session-node.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  /** @type {{ script?: string, mission?: string }} */
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--script") out.script = resolve(argv[++i]);
    else if (argv[i].startsWith("--script="))
      out.script = resolve(argv[i].split("=")[1]);
    else if (argv[i] === "--mission") out.mission = argv[++i];
    else if (argv[i].startsWith("--mission="))
      out.mission = argv[i].split("=")[1];
  }
  return out;
}

function printAlert(alert) {
  console.log(`\n⚡ ${alert.text}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const session = createStarshipSession({
    scriptPath: args.script,
    missionRef: args.script ? undefined : args.mission || "default",
    minSeverity: 1,
    onAlert: async (alert) => printAlert(alert),
  });

  const st0 = session.status();
  console.log(`TPlus ops — ${st0.missionName || "mission"}`);
  if (st0.path) console.log(`Script: ${st0.path}`);
  console.log(st0.etaText);
  // Mission-scoped keys (same set as Telegram /ops)
  console.log(formatHelp(session.scriptDoc?.script || []));
  console.log("Watch the video; press a key when the event happens.\n");

  if (!process.stdin.isTTY) {
    console.error("Need an interactive TTY for key mode.");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let noteMode = false;
  let noteBuf = "";

  const onKey = async (str, key) => {
    if (key?.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }

    if (noteMode) {
      if (key?.name === "return" || key?.name === "enter") {
        noteMode = false;
        process.stdin.setRawMode(true);
        const text = noteBuf.trim();
        noteBuf = "";
        console.log();
        if (text) {
          const r = await session.fireNote(text);
          if (!r.ok) console.log(`  error: ${r.error}`);
        }
        return;
      }
      if (key?.name === "backspace") {
        noteBuf = noteBuf.slice(0, -1);
        return;
      }
      if (str && str >= " ") {
        noteBuf += str;
        process.stdout.write(str);
      }
      return;
    }

    if (key?.name === "return" || key?.name === "enter") return;

    const ch = str;
    if (ch === "q" || ch === "Q") {
      console.log("Quit.");
      cleanup();
      process.exit(0);
    }
    if (ch === "?" || ch === "/") {
      console.log(formatHelp(session.scriptDoc?.script || []));
      return;
    }
    if (ch === "t" || ch === "T") {
      const st = session.status();
      console.log(`  ${st.tPlusLabel}  phase=${st.phase}`);
      return;
    }
    if (ch === "p" || ch === "P") {
      const st = session.status();
      console.log(`  phase=${st.phase} last=${st.lastActionId || "—"}`);
      return;
    }
    if (ch === "m" || ch === "M") {
      console.log(session.formatMissionList());
      return;
    }
    if (ch === "e" || ch === "E") {
      // 'e' is also entry action — only use E for eta if we conflict
    }
    if (ch === "n" || ch === "N") {
      noteMode = true;
      noteBuf = "";
      process.stdin.setRawMode(false);
      process.stdout.write("note> ");
      return;
    }

    const action = actionByKey(ch);
    if (!action) {
      if (ch && ch.length === 1 && /[a-zA-Z0-9]/.test(ch)) {
        console.log(`  (unknown key '${ch}' — press ? for help)`);
      }
      return;
    }

    const result = await session.fire(action.id);
    if (!result.ok) {
      console.log(`  error: ${result.error}`);
      return;
    }
    if (
      result.tPlusSec != null &&
      result.action?.scriptTPlusSec != null &&
      action.id !== "liftoff"
    ) {
      const delta = result.tPlusSec - result.action.scriptTPlusSec;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `  script T+${formatTPlus(result.action.scriptTPlusSec)}  Δ ${sign}${delta.toFixed(0)}s vs script`,
      );
    }
  };

  function cleanup() {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }

  process.stdin.on("keypress", (str, key) => {
    onKey(str, key).catch((e) => console.error(e));
  });

  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
