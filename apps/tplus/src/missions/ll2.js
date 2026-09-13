/**
 * Launch Library 2 → TPlus in-memory mission scriptDoc.
 *
 * Official webcasts + timeline only (no unofficial YouTube restreams by default).
 * https://ll.thespacedevs.com/docs/
 */

const LL2_BASE = "https://ll.thespacedevs.com/2.2.0";

/** Free tier: 15 calls/hour/IP — one fetch per webcast start is fine. */
export const LL2_THROTTLE_NOTE =
  "LL2 free tier is 15 req/hour/IP; webcast:live uses one detailed fetch per run.";

/**
 * LL2 timeline abbrev → Cue LAUNCH_ACTIONS id.
 * Unknown abbrevs become null (caller may skip or defer until dumb /suggest).
 */
export const LL2_ABBREV_TO_ACTION = {
  Liftoff: "liftoff",
  "Max-Q": "max_q",
  "Max Q": "max_q",
  MECO: "meco",
  "Stage 2 Separation": "stage_sep",
  "Stage Separation": "stage_sep",
  "SES-1": "ses1",
  "Fairing Separation": "fairing",
  "Entry Burn Startup": "entry_burn",
  "Entry Burn Shutdown": "entry_burn_end",
  "Entry Burn Start": "entry_burn",
  "Entry Burn End": "entry_burn_end",
  "SECO-1": "seco",
  SECO: "seco",
  "Stage 1 Landing Burn": "landing_burn_booster",
  "Landing Burn": "landing_burn_booster",
  "Stage 1 Landing": "booster_landing",
  "SES-2": "ses2",
  "SECO-2": "seco2",
  "SES-3": "relight",
  "SECO-3": "relight",
  // Payload Separation handled specially (first/last only) — see mapTimeline
};

/**
 * Parse LL2 ISO-8601 durations used on timeline.relative_time.
 * Supports: P0D, PT1M12S, PT2M27S, -PT38M, -PT45S, PT1H51S, PT1H57M14S, …
 * @param {string|null|undefined} s
 * @returns {number|null} seconds (negative = T−)
 */
export function parseLl2Duration(s) {
  if (s == null || typeof s !== "string") return null;
  const raw = s.trim();
  if (!raw) return null;
  const neg = raw.startsWith("-");
  const body = neg ? raw.slice(1) : raw;
  if (!body.startsWith("P")) return null;

  // PnDTnHnMnS or PT… or PnD
  const m = body.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i,
  );
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  if (![days, hours, mins, secs].every((n) => Number.isFinite(n))) return null;
  // Bare P / P0D → 0
  const total = Math.round(days * 86400 + hours * 3600 + mins * 60 + secs);
  return neg ? -total : total;
}

/**
 * @param {object} launch LL2 launch object (detailed)
 * @param {{ officialOnly?: boolean }} [opts]
 * @returns {string|null}
 */
export function pickOfficialWebcastUrl(launch, opts = {}) {
  const officialOnly = opts.officialOnly !== false;
  const vids = launch?.vidURLs || launch?.vid_urls || [];
  if (!Array.isArray(vids) || !vids.length) return null;

  const official = vids.filter((v) => {
    const name = v?.type?.name || v?.type || "";
    return String(name).toLowerCase() === "official webcast";
  });
  const pool = officialOnly ? official : official.length ? official : vids;
  if (!pool.length) return null;

  // Lower type.id ≈ higher priority when present; else keep API order within pool
  const sorted = [...pool].sort((a, b) => {
    const ia = Number(a?.type?.id ?? a?.priority ?? 99);
    const ib = Number(b?.type?.id ?? b?.priority ?? 99);
    return ia - ib;
  });
  const url = sorted[0]?.url;
  return url ? String(url).trim() : null;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * @param {object} launch
 * @param {{ officialOnly?: boolean, requireWebcast?: boolean, includeUnmapped?: boolean }} [opts]
 * @returns {{ scriptDoc: object, warnings: string[], unmapped: string[] }}
 */
export function launchToScriptDoc(launch, opts = {}) {
  const officialOnly = opts.officialOnly !== false;
  const requireWebcast = opts.requireWebcast !== false;
  const includeUnmapped = Boolean(opts.includeUnmapped);
  const warnings = [];
  const unmapped = [];

  if (!launch || typeof launch !== "object") {
    throw new Error("LL2 launch object required");
  }

  const webcastUrl = pickOfficialWebcastUrl(launch, { officialOnly });
  if (!webcastUrl) {
    const msg = officialOnly
      ? "No Official Webcast in LL2 vidURLs"
      : "No webcast URL in LL2 vidURLs";
    if (requireWebcast) throw new Error(msg);
    warnings.push(msg);
  }

  const missionName =
    launch.mission?.name ||
    String(launch.name || "")
      .split("|")
      .slice(1)
      .join("|")
      .trim() ||
    launch.name ||
    "Launch";

  const missionId =
    slugify(launch.slug) ||
    slugify(missionName) ||
    slugify(launch.id) ||
    "ll2-launch";

  const vehicle =
    launch.rocket?.configuration?.full_name ||
    launch.rocket?.configuration?.name ||
    null;
  const pad = launch.pad;
  const site = pad
    ? [pad.name, pad.location?.name].filter(Boolean).join(", ")
    : null;
  const lsp = launch.launch_service_provider?.name || null;
  const payloadParts = [
    launch.mission?.name,
    launch.mission?.type,
    launch.mission?.orbit?.name || launch.mission?.orbit?.abbrev,
  ].filter(Boolean);

  const { countdown, script, skipped } = mapTimeline(launch.timeline || [], {
    includeUnmapped,
    unmapped,
  });
  warnings.push(...skipped);

  const net = launch.net || launch.window_start || null;
  const scriptDoc = {
    missionId,
    missionName: String(missionName).trim(),
    vehicle,
    site,
    landing: null,
    payload: payloadParts.join(" · ") || null,
    lsp,
    source: launch.url || `${LL2_BASE}/launch/${launch.id}/`,
    ll2LaunchId: launch.id || null,
    ll2Slug: launch.slug || null,
    webcastUrl: webcastUrl || null,
    notes: [
      "Imported from Launch Library 2 at webcast start.",
      LL2_THROTTLE_NOTE,
      officialOnly ? "Official Webcast only." : null,
      `LSP: ${lsp || "—"}.`,
    ]
      .filter(Boolean)
      .join(" "),
    launchApproxUtc: net,
    windowOpenUtc: launch.window_start || net,
    windowCloseUtc: launch.window_end || null,
    countdown,
    script,
  };

  if (!script.some((r) => r.actionId === "liftoff")) {
    warnings.push("LL2 timeline has no Liftoff row — inserting tPlusSec=0 liftoff");
    script.unshift({
      tPlusSec: 0,
      actionId: "liftoff",
      label: "Liftoff",
    });
  }

  return { scriptDoc, warnings, unmapped };
}

/**
 * @param {object[]} timeline
 * @param {{ includeUnmapped?: boolean, unmapped?: string[] }} opts
 */
function mapTimeline(timeline, opts = {}) {
  const unmapped = opts.unmapped || [];
  const skipped = [];
  const countdown = [];
  /** @type {{ tPlusSec: number, actionId: string, label: string }[]} */
  const script = [];

  const payloadRows = [];
  for (const row of timeline) {
    const abbrev = row?.type?.abbrev || row?.type?.description || "";
    const label = abbrev || row?.type?.description || "Event";
    const sec = parseLl2Duration(row?.relative_time);
    if (sec == null) {
      skipped.push(`skip timeline row (bad relative_time): ${label}`);
      continue;
    }

    if (String(abbrev).toLowerCase().includes("payload separation") ||
        String(abbrev) === "Payload Separation") {
      payloadRows.push({ sec, label: label || "Payload Separation" });
      continue;
    }

    // Countdown (T−)
    if (sec < 0) {
      countdown.push({ tMinusSec: -sec, label });
      continue;
    }

    const actionId = LL2_ABBREV_TO_ACTION[abbrev] || null;
    if (!actionId) {
      unmapped.push(abbrev || label);
      if (opts.includeUnmapped) {
        // Not fireable on current Worker — omit until dumb /suggest
        skipped.push(`unmapped abbrev omitted: ${abbrev || label}`);
      } else {
        skipped.push(`unmapped abbrev omitted: ${abbrev || label}`);
      }
      continue;
    }

    script.push({ tPlusSec: sec, actionId, label });
  }

  // Payload Separation: first → deploy_start, last (if distinct) → deploy_done
  if (payloadRows.length) {
    payloadRows.sort((a, b) => a.sec - b.sec);
    const first = payloadRows[0];
    script.push({
      tPlusSec: first.sec,
      actionId: "deploy_start",
      label: first.label,
    });
    if (payloadRows.length > 1) {
      const last = payloadRows[payloadRows.length - 1];
      script.push({
        tPlusSec: last.sec,
        actionId: "deploy_done",
        label: last.label,
      });
      if (payloadRows.length > 2) {
        skipped.push(
          `omitted ${payloadRows.length - 2} intermediate Payload Separation row(s)`,
        );
      }
    }
  }

  countdown.sort((a, b) => b.tMinusSec - a.tMinusSec);
  script.sort((a, b) => a.tPlusSec - b.tPlusSec);

  // Dedupe identical actionId keeping earliest T+ (fire() is one-shot per id)
  const seen = new Set();
  const deduped = [];
  for (const row of script) {
    if (seen.has(row.actionId)) {
      skipped.push(
        `dedupe actionId ${row.actionId} @ T+${row.tPlusSec}s (keep first)`,
      );
      continue;
    }
    seen.add(row.actionId);
    deduped.push(row);
  }

  return { countdown, script: deduped, skipped };
}

/**
 * @param {string} pathAndQuery e.g. "/launch/uuid/" or "/launch/upcoming/?search=…"
 * @param {{ token?: string|null, fetchImpl?: typeof fetch }} [opts]
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {string} pathAndQuery e.g. "/launch/uuid/" or "/launch/upcoming/?search=…"
 * @param {{ token?: string|null, fetchImpl?: typeof fetch, maxRetries?: number }} [opts]
 */
export async function ll2Fetch(pathAndQuery, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const url = pathAndQuery.startsWith("http")
    ? pathAndQuery
    : `${LL2_BASE}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
  const headers = { Accept: "application/json" };
  const token = opts.token || process.env.LL2_TOKEN || null;
  if (token) headers.Authorization = `Token ${token}`;

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetchImpl(url, { headers });
    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    lastErr = new Error(`LL2 ${res.status}: ${text.slice(0, 200)}`);

    if (res.status !== 429 || attempt === maxRetries) break;

    // "Expected available in 473 seconds." or Retry-After header
    const retryHeader = Number(res.headers.get("Retry-After") || 0);
    const m = text.match(/available in\s+(\d+)\s+seconds/i);
    let waitSec = retryHeader || (m ? Number(m[1]) : 60);
    // Cap so a hung throttle doesn't block forever; cron has ~30m lead
    waitSec = Math.min(Math.max(waitSec, 5), 600);
    await sleep(waitSec * 1000);
  }
  throw lastErr;
}

/**
 * @param {{ id?: string, slug?: string, search?: string, token?: string|null, officialOnly?: boolean, requireWebcast?: boolean }} opts
 */
export async function resolveLl2Launch(opts) {
  const { id, slug, search } = opts;
  const n = [id, slug, search].filter(Boolean).length;
  if (n !== 1) {
    throw new Error("Provide exactly one of ll2 id, slug, or search");
  }

  let launch;
  if (id) {
    launch = await ll2Fetch(`/launch/${encodeURIComponent(id)}/`, opts);
  } else if (slug) {
    const data = await ll2Fetch(
      `/launch/upcoming/?mode=detailed&limit=20&search=${encodeURIComponent(slug)}`,
      opts,
    );
    launch =
      (data.results || []).find((r) => r.slug === slug) ||
      (data.results || [])[0];
    if (!launch) throw new Error(`LL2 slug not found in upcoming: ${slug}`);
  } else {
    const data = await ll2Fetch(
      `/launch/upcoming/?mode=detailed&limit=5&search=${encodeURIComponent(search)}`,
      opts,
    );
    launch = (data.results || [])[0];
    if (!launch) throw new Error(`LL2 search returned no launches: ${search}`);
  }

  // list mode may omit timeline — refetch detailed by id
  if (!launch.timeline && launch.id) {
    launch = await ll2Fetch(`/launch/${encodeURIComponent(launch.id)}/`, opts);
  }

  return launch;
}

/**
 * @param {{ id?: string, slug?: string, search?: string, token?: string|null, officialOnly?: boolean, requireWebcast?: boolean }} opts
 */
export async function loadScriptDocFromLl2(opts) {
  const launch = await resolveLl2Launch(opts);
  const built = launchToScriptDoc(launch, opts);
  return { ...built, launch };
}

export { LL2_BASE };
