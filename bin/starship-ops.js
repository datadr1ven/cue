#!/usr/bin/env node
/**
 * Starship Flight HITL — watch the webcast, press keys when events happen.
 *
 *   npm run starship:ops
 *   npm run starship:ops -- --script examples/starship-flight-13-script.json
 *
 * Keys: see on-screen help (?). Liftoff (0) starts T+.
 * Telegram: use npm run starship:bot for the same buttons from your phone.
 */

import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import {
  actionByKey,
  formatHelp,
  formatTPlus,
  STARSHIP_ACTIONS,
} from "../src/engine/domains/starship/index.js";
import { createStarshipSession } from "../src/starship-session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultScript = join(
  __dirname,
  "..",
  "examples",
  "starship-flight-13-script.json",
);

function parseArgs(argv) {
  let script = defaultScript;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--script") script = resolve(argv[++i]);
    else if (argv[i].startsWith("--script="))
      script = resolve(argv[i].split("=")[1]);
  }
  return { script };
}

function printAlert(alert, state) {
  const tp =
    state.liftoffWallMs != null
      ? formatTPlus((Date.now() - state.liftoffWallMs) / 1000)
      : "—";
  console.log(`\n⚡ [T+${tp}] ${alert.text}\n`);
}

async function main() {
  const { script } = parseArgs(process.argv);
  const session = createStarshipSession({
    scriptPath: script,
    minSeverity: 1,
    onAlert: async (alert, state) => printAlert(alert, state),
  });

  const mission = session.scriptDoc?.missionName || "Starship";
  console.log(`Cue Starship ops — ${mission}`);
  console.log(`Script: ${script}`);
  console.log(formatHelp());
  console.log("Watch the video; press a key when the event happens.\n");

  if (!process.stdin.isTTY) {
    console.error("Need an interactive TTY for key mode.");
    process.exit(1);
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const onKey = async (str, key) => {
    if (key?.ctrl && key.name === "c") {
      cleanup();
      process.exit(0);
    }
    if (key?.name === "return" || key?.name === "enter") return;

    const ch = str;
    if (ch === "q" || ch === "Q") {
      console.log("Quit.");
      cleanup();
      process.exit(0);
    }
    if (ch === "?" || ch === "/") {
      console.log(formatHelp());
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

    const action = actionByKey(ch);
    if (!action) {
      // ignore unknown (arrows etc.)
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
    if (result.alerts.length === 0) {
      console.log(`  (no alert emitted for ${action.id})`);
    }
    // script delta hint
    if (
      result.tPlusSec != null &&
      action.scriptTPlusSec != null &&
      action.id !== "liftoff"
    ) {
      const delta = result.tPlusSec - action.scriptTPlusSec;
      const sign = delta >= 0 ? "+" : "";
      console.log(
        `  script T+${formatTPlus(action.scriptTPlusSec)}  Δ ${sign}${delta.toFixed(0)}s vs script`,
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

  // keep alive
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
