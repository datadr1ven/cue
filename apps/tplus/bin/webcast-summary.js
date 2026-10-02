#!/usr/bin/env node
/**
 * End-of-flight summary → X draft (manual).
 *
 * From a local run archive (desktop):
 *   npm run webcast:summary -- --latest --open
 *
 * From anywhere (laptop / Termux) via the public feed:
 *   npm run webcast:summary -- --from-feed --open
 *   npm run webcast:summary -- --from-feed --mission Crew-13 --open
 */

import { config as loadEnv } from "dotenv";
import { existsSync, readdirSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  DEFAULT_FEED_URL,
  writeFeedSummary,
  writeRunSummary,
} from "../src/webcast/summary.js";
import { openManualXDraft } from "../src/webcast/open-draft.js";
import { postSummaryToX, xPostConfig } from "../src/webcast/x-post.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CUE_ROOT = resolve(__dirname, "../../..");
loadEnv({ path: join(CUE_ROOT, ".env") });

function parseArgs(argv) {
  const out = {
    run: null,
    latest: false,
    fromFeed: false,
    feedUrl: process.env.TPLUS_FEED_URL || DEFAULT_FEED_URL,
    mission: null,
    runsParent: join(CUE_ROOT, "tplus-webcast/runs"),
    outParent: join(CUE_ROOT, "tplus-webcast/summaries"),
    post: false,
    open: false,
    maxFrames: 9,
    landingUrl: process.env.TPLUS_LANDING_URL || undefined,
    telegramUrl: process.env.TPLUS_TELEGRAM_URL || undefined,
    help: false,
  };
  const a = argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const next = () => a[++i];
    if (x === "--help" || x === "-h") out.help = true;
    else if (x === "--run") out.run = next();
    else if (x === "--latest") out.latest = true;
    else if (x === "--from-feed") out.fromFeed = true;
    else if (x === "--feed-url") out.feedUrl = next();
    else if (x === "--mission") out.mission = next();
    else if (x === "--runs-parent") out.runsParent = next();
    else if (x === "--out") out.outParent = next();
    else if (x === "--post") out.post = true;
    else if (x === "--open") out.open = true;
    else if (x === "--max-frames") out.maxFrames = Number(next()) || 9;
    else if (x === "--landing-url") out.landingUrl = next();
    else if (x === "--telegram-url") out.telegramUrl = next();
    else if (!x.startsWith("-") && !out.run) out.run = x;
  }
  return out;
}

function findLatestRun(parent) {
  if (!existsSync(parent)) throw new Error(`runs parent missing: ${parent}`);
  const dirs = readdirSync(parent)
    .map((name) => join(parent, name))
    .filter((p) => {
      try {
        return statSync(p).isDirectory() && existsSync(join(p, "meta.json"));
      } catch {
        return false;
      }
    })
    .sort();
  if (!dirs.length) throw new Error(`no runs under ${parent}`);
  return dirs[dirs.length - 1];
}

function usage() {
  console.log(`Usage:
  # Anywhere with network (recommended for laptop / Termux):
  npm run webcast:summary -- --from-feed --open
  npm run webcast:summary -- --from-feed --mission Crew-13 --open

  # Local run archive (desktop that saved frames):
  npm run webcast:summary -- --latest --open
  npm run webcast:summary -- --run <runDir> --open

Options:
  --from-feed         Build from public GET /recent (no run folder needed)
  --feed-url URL      Default: ${DEFAULT_FEED_URL}
  --mission NAME      Filter feed to a mission (default: newest in feed)
  --out DIR           Where --from-feed writes (default: tplus-webcast/summaries)
  --run DIR           Path to a tplus-webcast/runs/<id> directory
  --latest            Use newest local run under --runs-parent
  --max-frames N      Collage cells (default 9)
  --open              Open review page + X compose (text prefilled)
  --post              Live X API post (needs TPLUS_X_ENABLED=1 + keys)
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    process.exit(0);
  }

  let result;
  if (args.fromFeed) {
    console.log(`summary from-feed ${args.feedUrl}`);
    result = await writeFeedSummary(resolve(args.outParent), {
      feedUrl: args.feedUrl,
      mission: args.mission,
      maxFrames: args.maxFrames,
      landingUrl: args.landingUrl,
      telegramUrl: args.telegramUrl,
    });
  } else {
    let runDir = null;
    if (args.run) {
      const candidates = [
        resolve(args.run),
        resolve(CUE_ROOT, args.run),
        resolve(process.cwd(), args.run),
      ];
      runDir = candidates.find((p) => existsSync(p)) || candidates[0];
    }
    if (args.latest || !runDir) {
      if (!runDir || !existsSync(runDir)) {
        runDir = findLatestRun(resolve(args.runsParent));
      }
    }
    if (!runDir || !existsSync(runDir)) {
      usage();
      console.error(
        `run dir not found. Use --from-feed if you're not on the desktop.`,
      );
      process.exit(1);
    }
    console.log(`summary run=${runDir}`);
    result = writeRunSummary(runDir, {
      maxFrames: args.maxFrames,
      landingUrl: args.landingUrl,
      telegramUrl: args.telegramUrl,
    });
  }

  console.log(`out      ${result.outDir}`);
  if (result.collagePath) console.log(`collage  ${result.collagePath}`);
  else console.log(`collage  (none — feed had no stills)`);
  console.log(`review   ${result.postHtmlPath}`);
  if (result.frames?.length) {
    console.log(`frames   ${result.frames.map((f) => f.actionId).join(", ")}`);
  }
  if (result.manifest?.note) console.log(`note     ${result.manifest.note}`);
  console.log("--- caption ---");
  console.log(result.caption);
  console.log("---");

  if (args.open) {
    const opened = openManualXDraft({
      caption: result.caption,
      intentUrl: result.intentUrl,
      collagePath: result.collagePath,
      postHtmlPath: result.postHtmlPath,
    });
    console.log(`open-draft: ${opened.steps.join(" · ")}`);
    if (opened.termux) {
      if (opened.gallery?.ok) {
        console.log(
          `Camera roll: ${opened.gallery.dest}${opened.gallery.scanned ? " (media-scanned)" : " (scan skipped — check Gallery)"}`,
        );
      }
      console.log(
        "Termux: review page → “Open draft on X”, then attach the collage from Photos/Gallery.",
      );
    } else {
      console.log(
        "Glance the draft on X, attach collage if present, then Post.",
      );
    }
  }

  if (args.post) {
    if (!result.collagePath) {
      console.warn("WARNING: --post skipped (no collage to upload)");
    } else {
      const cfg = xPostConfig();
      if (!cfg.enabled) {
        console.warn(
          "WARNING: --post ignored until TPLUS_X_ENABLED=1 (see docs/x-posting.md)",
        );
      }
      const x = await postSummaryToX({
        caption: result.caption,
        collagePath: result.collagePath,
        dryRun: !cfg.enabled,
      });
      if (x.dryRun) {
        console.log(
          `x-post dry-run (credentials ${x.configReady ? "present" : "missing: " + (x.missing || []).join(", ")})`,
        );
      } else {
        console.log(`x-post ok tweetId=${x.tweetId} mediaId=${x.mediaId}`);
      }
    }
  } else if (!args.open) {
    console.log("Tip: add --open to prefill an X draft in the browser.");
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
