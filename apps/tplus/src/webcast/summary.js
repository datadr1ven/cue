/**
 * Build an end-of-flight summary from a webcast:live run archive:
 * collage of highlight frames + short caption (X-ready) + longer synopsis.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { spawnSync } from "child_process";

/** Preferred order for collage cells (skip missing). */
export const HIGHLIGHT_ACTIONS = [
  "liftoff",
  "max_q",
  "meco",
  "stage_sep",
  "hot_stage",
  "fairing",
  "ses1",
  "landing_burn_booster",
  "booster_landing",
  "entry_burn",
  "entry_burn_end",
  "deploy_start",
  "seco",
];

export const DEFAULT_LANDING_URL = "https://t-plus.pages.dev/";
export const DEFAULT_TELEGRAM_URL =
  "https://t.me/TPlusLaunchBot?start=x";
export const DEFAULT_FEED_URL =
  "https://tplus.scenicminddigital.workers.dev/recent?limit=50";

/**
 * @param {string} runDir
 */
export function loadRunSummaryInputs(runDir) {
  if (!runDir || !existsSync(runDir)) {
    throw new Error(`run dir not found: ${runDir}`);
  }
  const meta = readJson(join(runDir, "meta.json"), {});
  const script = readJson(join(runDir, "script.json"), {});
  const suggestDir = join(runDir, "suggest");
  const framesDir = join(runDir, "frames");

  const suggests = [];
  if (existsSync(suggestDir)) {
    for (const name of readdirSync(suggestDir).filter((n) =>
      n.endsWith(".json"),
    )) {
      const doc = readJson(join(suggestDir, name), null);
      if (!doc) continue;
      const actionId =
        doc.response?.actionId ||
        doc.request?.actionId ||
        name.replace(/\.json$/, "");
      const alertText =
        doc.response?.alertText ||
        (doc.request?.label
          ? String(doc.request.label)
          : null);
      const tPlus =
        doc.request?.scriptTPlusSec != null
          ? Number(doc.request.scriptTPlusSec)
          : null;
      suggests.push({
        actionId: String(actionId),
        alertText: alertText ? String(alertText) : null,
        label: doc.request?.label ? String(doc.request.label) : null,
        tPlus: Number.isFinite(tPlus) ? tPlus : null,
        mode: doc.request?.mode || doc.response?.mode || null,
        path: join(suggestDir, name),
      });
    }
  }
  suggests.sort((a, b) => (a.tPlus ?? 1e12) - (b.tPlus ?? 1e12));

  const frameFiles = existsSync(framesDir)
    ? readdirSync(framesDir).filter((n) => /\.jpe?g$/i.test(n))
    : [];
  /** @type {Map<string, string>} */
  const framesByAction = new Map();
  for (const f of frameFiles) {
    const id = f.replace(/\.jpe?g$/i, "");
    framesByAction.set(id, join(framesDir, f));
  }

  return { runDir, meta, script, suggests, framesByAction, framesDir };
}

/**
 * Pick up to `max` frame paths for the collage.
 * @param {Map<string, string>} framesByAction
 * @param {object[]} suggests
 * @param {number} [max]
 */
export function pickCollageFrames(framesByAction, suggests, max = 9) {
  const picked = [];
  const seen = new Set();
  for (const id of HIGHLIGHT_ACTIONS) {
    if (picked.length >= max) break;
    const path = framesByAction.get(id);
    if (path && existsSync(path)) {
      picked.push({ actionId: id, path });
      seen.add(id);
    }
  }
  // Fill from suggest order if still short
  for (const s of suggests) {
    if (picked.length >= max) break;
    if (seen.has(s.actionId)) continue;
    const path = framesByAction.get(s.actionId);
    if (path && existsSync(path)) {
      picked.push({ actionId: s.actionId, path });
      seen.add(s.actionId);
    }
  }
  // Any remaining frames
  if (picked.length < max) {
    for (const [id, path] of framesByAction) {
      if (picked.length >= max) break;
      if (seen.has(id)) continue;
      if (existsSync(path)) {
        picked.push({ actionId: id, path });
        seen.add(id);
      }
    }
  }
  return picked;
}

/**
 * Grid layout cols/rows for N cells (prefer wide grids).
 * @param {number} n
 */
export function gridLayout(n) {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  if (n <= 9) return { cols: 3, rows: 3 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

/**
 * Build ffmpeg xstack collage.
 * @param {{ path: string, actionId: string }[]} frames
 * @param {string} outPath
 * @param {{ cellW?: number, cellH?: number, ffmpeg?: string }} [opts]
 */
export function buildCollage(frames, outPath, opts = {}) {
  if (!frames.length) throw new Error("no frames for collage");
  const cellW = opts.cellW ?? 480;
  const cellH = opts.cellH ?? 270;
  const ffmpeg = opts.ffmpeg || process.env.FFMPEG || "ffmpeg";
  const n = frames.length;
  const { cols, rows } = gridLayout(n);

  const args = ["-y"];
  for (const f of frames) {
    args.push("-i", f.path);
  }

  const parts = [];
  for (let i = 0; i < n; i++) {
    parts.push(
      `[${i}:v]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v${i}]`,
    );
  }
  const layout = [];
  for (let i = 0; i < n; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col === 0 ? "0" : Array.from({ length: col }, (_, k) => `w${k}`).join("+");
    const y = row === 0 ? "0" : Array.from({ length: row }, (_, k) => `h${k * cols}`).join("+");
    // xstack layout: use w0/h0 references — simpler fixed offsets
    layout.push(`${col * cellW}_${row * cellH}`);
  }
  const inputs = Array.from({ length: n }, (_, i) => `[v${i}]`).join("");
  parts.push(
    `${inputs}xstack=inputs=${n}:layout=${layout.join("|")}[out]`,
  );

  args.push("-filter_complex", parts.join(";"), "-map", "[out]", "-q:v", "3", outPath);

  const r = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `ffmpeg collage failed (status ${r.status}): ${(r.stderr || r.stdout || "").slice(-800)}`,
    );
  }
  if (!existsSync(outPath)) throw new Error("collage not written");
  return { outPath, cols, rows, count: n, args };
}

/**
 * @param {ReturnType<typeof loadRunSummaryInputs>} inputs
 * @param {{ landingUrl?: string, telegramUrl?: string }} [urls]
 */
export function buildCaptions(inputs, urls = {}) {
  const landingUrl = urls.landingUrl || DEFAULT_LANDING_URL;
  const telegramUrl = urls.telegramUrl || DEFAULT_TELEGRAM_URL;
  const mission =
    inputs.meta.missionName ||
    inputs.script.missionName ||
    inputs.meta.missionId ||
    "Launch";
  const vehicle = inputs.script.vehicle || null;
  const n = inputs.suggests.length;
  const first = inputs.suggests[0];
  const last = inputs.suggests[inputs.suggests.length - 1];
  const firstLabel = shortLabel(first);
  const lastLabel = shortLabel(last);

  const vehicleBit = vehicle ? ` · ${shortVehicle(vehicle)}` : "";
  const arc =
    firstLabel && lastLabel && firstLabel !== lastLabel
      ? `${firstLabel} → ${lastLabel}`
      : firstLabel || "flight";

  // Keep under ~280 with room for one URL (X charges more for posts with links)
  let caption =
    `${mission}${vehicleBit}\n` +
    `${n} alert${n === 1 ? "" : "s"} · ${arc}\n\n` +
    `${landingUrl}`;

  if (caption.length > 260) {
    caption =
      `${mission}\n` +
      `${n} alerts · ${arc}\n\n` +
      `${landingUrl}`;
  }

  const lines = inputs.suggests
    .map((s) => s.alertText || `${s.actionId}${s.tPlus != null ? ` T+${formatT(s.tPlus)}` : ""}`)
    .filter(Boolean);

  const synopsis =
    `${mission}${vehicleBit}\n` +
    (inputs.script.site ? `Site: ${inputs.script.site}\n` : "") +
    `Mode: ${inputs.meta.mode || "—"}\n` +
    `Alerts: ${n}\n\n` +
    lines.map((l) => `• ${l}`).join("\n") +
    `\n\nLanding: ${landingUrl}\n` +
    `Telegram: ${telegramUrl}\n`;

  return { caption, synopsis, mission, vehicle, alertCount: n };
}

/**
 * Write summary artifacts into runDir/summary/
 * @param {string} runDir
 * @param {{ maxFrames?: number, landingUrl?: string, telegramUrl?: string, ffmpeg?: string }} [opts]
 */
export function writeRunSummary(runDir, opts = {}) {
  const inputs = loadRunSummaryInputs(runDir);
  const frames = pickCollageFrames(
    inputs.framesByAction,
    inputs.suggests,
    opts.maxFrames ?? 9,
  );
  if (!frames.length) {
    throw new Error(`no frames in ${join(runDir, "frames")}`);
  }

  const outDir = join(runDir, "summary");
  mkdirSync(outDir, { recursive: true });
  const collagePath = join(outDir, "collage.jpg");
  const collage = buildCollage(frames, collagePath, {
    ffmpeg: opts.ffmpeg,
  });
  const { caption, synopsis, mission, vehicle, alertCount } = buildCaptions(
    inputs,
    {
      landingUrl: opts.landingUrl,
      telegramUrl: opts.telegramUrl,
    },
  );

  writeFileSync(join(outDir, "caption.txt"), caption + "\n");
  writeFileSync(join(outDir, "synopsis.txt"), synopsis);
  const intentUrl = xComposeIntentUrl(caption);
  writeFileSync(join(outDir, "intent-url.txt"), intentUrl + "\n");
  const postHtmlPath = writePostHtml(outDir, {
    caption,
    intentUrl,
    mission,
    collageFile: "collage.jpg",
  });
  const manifest = {
    runId: inputs.meta.runId || basename(runDir),
    mission,
    vehicle,
    alertCount,
    frameActionIds: frames.map((f) => f.actionId),
    collage: "collage.jpg",
    captionFile: "caption.txt",
    synopsisFile: "synopsis.txt",
    intentUrlFile: "intent-url.txt",
    postHtml: "post.html",
    intentUrl,
    landingUrl: opts.landingUrl || DEFAULT_LANDING_URL,
    telegramUrl: opts.telegramUrl || DEFAULT_TELEGRAM_URL,
    collageLayout: { cols: collage.cols, rows: collage.rows },
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return {
    outDir,
    collagePath,
    caption,
    synopsis,
    intentUrl,
    postHtmlPath,
    manifest,
    frames,
  };
}

/** Prefill text in X’s compose UI (browser or app). Images still need a manual attach. */
export function xComposeIntentUrl(caption) {
  const text = String(caption || "").slice(0, 280);
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}

/**
 * Local review page: collage + Open draft on X.
 * @param {string} outDir
 * @param {{ caption: string, intentUrl: string, mission?: string, collageFile?: string|null }} opts
 */
export function writePostHtml(outDir, opts) {
  const collageFile = opts.collageFile || null;
  const mission = opts.mission || "Launch";
  const caption = String(opts.caption || "");
  const intentUrl = opts.intentUrl || xComposeIntentUrl(caption);
  const imgBlock = collageFile
    ? `<img id="collage" src="${escapeAttr(collageFile)}" alt="Flight collage" />
  <div class="row">
    <button class="cta secondary" type="button" id="copyImage">Copy collage</button>
  </div>`
    : `<p class="lead">No stills in the public feed for this flight — text-only draft.</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TPlus → X · ${escapeHtml(mission)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #0b0b14; color: #e8e8ff;
      max-width: 720px; margin-inline: auto; padding: 1.25rem; line-height: 1.45; }
    h1 { font-size: 1.35rem; margin: 0 0 0.5rem; }
    .lead { color: #9a9ab8; margin: 0 0 1.25rem; }
    .cta { display: inline-block; background: #1d9bf0; color: #fff; font-weight: 700;
      text-decoration: none; padding: 0.85rem 1.25rem; border-radius: 999px; margin: 0 0.5rem 0.5rem 0; border: 0; cursor: pointer; }
    .cta.secondary { background: transparent; border: 1px solid #3a3a52; color: #c8c8e0; }
    .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 1rem 0 1.5rem; }
    img { width: 100%; border-radius: 12px; background: #000; display: block; }
    pre { white-space: pre-wrap; background: #141422; border: 1px solid #2a2a3e;
      border-radius: 12px; padding: 1rem; font-size: 0.95rem; }
    .hint { color: #9a9ab8; font-size: 0.9rem; margin-top: 1rem; }
    kbd { background: #22223a; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>${escapeHtml(mission)} — ready to post</h1>
  <p class="lead">Text is prefilled on X.${collageFile ? " Attach the collage (drag from this page, or paste if it’s on your clipboard)." : ""}</p>
  <div class="row">
    <a class="cta" id="openX" href="${escapeAttr(intentUrl)}" target="_blank" rel="noopener">Open draft on X</a>
    <button class="cta secondary" type="button" id="copyCaption">Copy caption</button>
  </div>
  ${imgBlock}
  <h2 style="font-size:1rem;margin:1.25rem 0 0.5rem">Caption</h2>
  <pre id="caption">${escapeHtml(caption)}</pre>
  <p class="hint">
    Click <strong>Open draft on X</strong>, glance the text, attach the collage if you have one, then Post.
  </p>
  <script>
    const caption = document.getElementById("caption").innerText;
    document.getElementById("copyCaption").onclick = async () => {
      try {
        await navigator.clipboard.writeText(caption);
        document.getElementById("copyCaption").textContent = "Copied";
      } catch (e) {
        alert("Could not copy caption — select the text manually.");
      }
    };
    const img = document.getElementById("collage");
    const copyImg = document.getElementById("copyImage");
    if (img && copyImg) {
      copyImg.onclick = async () => {
        try {
          const res = await fetch(img.src);
          const blob = await res.blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/jpeg"]: blob })]);
          copyImg.textContent = "Collage copied";
        } catch (e) {
          alert("Clipboard image copy blocked — drag the image into X instead.");
        }
      };
    }
  </script>
</body>
</html>
`;
  const path = join(outDir, "post.html");
  writeFileSync(path, html);
  return path;
}

/**
 * @param {string} [feedUrl]
 * @returns {Promise<object[]>}
 */
export async function fetchFeedItems(feedUrl = DEFAULT_FEED_URL) {
  const res = await fetch(feedUrl, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`feed HTTP ${res.status}: ${feedUrl}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return items;
}

/**
 * Pick one mission's items (default: most recent missionName in the feed).
 * @param {object[]} items
 * @param {string|null} [missionFilter]
 */
export function selectMissionFeedItems(items, missionFilter = null) {
  if (!items.length) return [];
  if (missionFilter) {
    const want = String(missionFilter).toLowerCase();
    const filtered = items.filter(
      (i) =>
        String(i.missionName || "").toLowerCase() === want ||
        String(i.text || "").toLowerCase().includes(want),
    );
    return filtered.length ? filtered : items;
  }
  // Newest item defines the active mission; take all items sharing that name
  const newest = items[items.length - 1];
  const name = newest?.missionName || null;
  if (!name) return items;
  return items.filter((i) => i.missionName === name);
}

/**
 * Build summary from the public Worker feed (laptop / Termux / anywhere with network).
 * @param {string} outParent  e.g. tplus-webcast/summaries
 * @param {{
 *   feedUrl?: string,
 *   mission?: string|null,
 *   maxFrames?: number,
 *   landingUrl?: string,
 *   telegramUrl?: string,
 *   ffmpeg?: string,
 * }} [opts]
 */
export async function writeFeedSummary(outParent, opts = {}) {
  const items = await fetchFeedItems(opts.feedUrl || DEFAULT_FEED_URL);
  const missionItems = selectMissionFeedItems(items, opts.mission || null);
  if (!missionItems.length) {
    throw new Error("public feed is empty — nothing to summarize");
  }

  const mission =
    missionItems.find((i) => i.missionName)?.missionName ||
    "Launch";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safe = String(mission)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 40);
  const outDir = join(outParent, `${stamp}-${safe}`);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(join(outDir, "frames"), { recursive: true });

  /** @type {{ actionId: string, path: string }[]} */
  const frames = [];
  const maxFrames = opts.maxFrames ?? 9;
  const ordered = [...missionItems].sort((a, b) => {
    const ai = HIGHLIGHT_ACTIONS.indexOf(a.actionId || "");
    const bi = HIGHLIGHT_ACTIONS.indexOf(b.actionId || "");
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const it of ordered) {
    if (frames.length >= maxFrames) break;
    const url = it.imageUrl;
    if (!url || !/^https:\/\//i.test(String(url))) continue;
    const actionId = String(it.actionId || `img${frames.length}`).replace(
      /[^a-zA-Z0-9._-]+/g,
      "_",
    );
    const dest = join(outDir, "frames", `${actionId}.jpg`);
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength < 100) continue;
      writeFileSync(dest, buf);
      frames.push({ actionId, path: dest });
    } catch {
      /* skip bad image */
    }
  }

  const suggests = missionItems.map((it) => ({
    actionId: it.actionId || "update",
    alertText: it.text || null,
    label: it.actionId ? String(it.actionId).replace(/_/g, " ") : null,
    tPlus: null,
  }));
  const inputs = {
    meta: { missionName: mission, mode: "ops", runId: `feed-${safe}` },
    script: { missionName: mission, vehicle: null, site: null },
    suggests,
  };
  const { caption, synopsis, vehicle, alertCount } = buildCaptions(inputs, {
    landingUrl: opts.landingUrl,
    telegramUrl: opts.telegramUrl,
  });

  let collagePath = null;
  let collageMeta = null;
  if (frames.length) {
    collagePath = join(outDir, "collage.jpg");
    collageMeta = buildCollage(frames, collagePath, { ffmpeg: opts.ffmpeg });
  }

  writeFileSync(join(outDir, "caption.txt"), caption + "\n");
  writeFileSync(join(outDir, "synopsis.txt"), synopsis);
  const intentUrl = xComposeIntentUrl(caption);
  writeFileSync(join(outDir, "intent-url.txt"), intentUrl + "\n");
  const postHtmlPath = writePostHtml(outDir, {
    caption,
    intentUrl,
    mission,
    collageFile: collagePath ? "collage.jpg" : null,
  });
  const manifest = {
    source: "feed",
    feedUrl: opts.feedUrl || DEFAULT_FEED_URL,
    mission,
    vehicle,
    alertCount,
    frameActionIds: frames.map((f) => f.actionId),
    collage: collagePath ? "collage.jpg" : null,
    captionFile: "caption.txt",
    synopsisFile: "synopsis.txt",
    intentUrlFile: "intent-url.txt",
    postHtml: "post.html",
    intentUrl,
    landingUrl: opts.landingUrl || DEFAULT_LANDING_URL,
    telegramUrl: opts.telegramUrl || DEFAULT_TELEGRAM_URL,
    collageLayout: collageMeta
      ? { cols: collageMeta.cols, rows: collageMeta.rows }
      : null,
    createdAt: new Date().toISOString(),
    note: frames.length
      ? null
      : "No imageUrl on feed items — caption only. Stills appear after ops /suggest with photos.",
  };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return {
    outDir,
    collagePath,
    caption,
    synopsis,
    intentUrl,
    postHtmlPath,
    manifest,
    frames,
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function shortLabel(s) {
  if (!s) return null;
  if (s.label) return String(s.label);
  if (s.actionId) return String(s.actionId).replace(/_/g, " ");
  return null;
}

function shortVehicle(v) {
  return String(v)
    .replace(/Block\s*\d+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function formatT(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
