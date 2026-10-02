/**
 * Public read-only recent-alerts ring for CF Workers (KV-backed).
 * Written on ops deliver/suggest; served via GET /recent for Pages /live.
 */

export const FEED_KV_KEY = "feed:v1";
/** Keep the newest N alerts (FIFO drop). */
export const FEED_MAX = 50;
/** Max alert text stored. */
export const FEED_TEXT_MAX = 2000;
/** Default items returned by GET /recent. */
export const FEED_SHOW = 20;

/**
 * @param {object} [data]
 * @returns {{ updatedAt: string|null, items: object[] }}
 */
export function normalizeFeed(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  return {
    updatedAt: data?.updatedAt != null ? String(data.updatedAt) : null,
    items,
  };
}

/**
 * @param {{
 *   text?: string,
 *   source?: string,
 *   actionId?: string|null,
 *   missionName?: string|null,
 *   imageUrl?: string|null,
 * }} fields
 */
export function feedEntry(fields = {}) {
  const text = String(fields.text || "").trim().slice(0, FEED_TEXT_MAX);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    t: new Date().toISOString(),
    text,
    source: fields.source || "unknown",
  };
  if (fields.actionId) entry.actionId = String(fields.actionId);
  if (fields.missionName) entry.missionName = String(fields.missionName);
  if (fields.imageUrl) entry.imageUrl = String(fields.imageUrl).slice(0, 500);
  return entry;
}

/** KV key prefix for rehosted feed images (TPlus Worker). */
export const FEED_IMG_KV_PREFIX = "feed-img:v1:";
/** Soft cap for a single rehosted JPEG in KV. */
export const FEED_IMG_MAX_BYTES = 2_500_000;

/**
 * @param {object} [feed]
 * @param {object} entry
 * @param {number} [max]
 */
export function appendFeed(feed, entry, max = FEED_MAX) {
  const prev = normalizeFeed(feed);
  const items = [...prev.items, entry].slice(-max);
  return {
    updatedAt: entry.t || new Date().toISOString(),
    items,
  };
}

/**
 * Resolve Access-Control-Allow-Origin for public feed.
 * FEED_CORS_ORIGINS: "*" (default) or comma-separated origins.
 * @param {{ FEED_CORS_ORIGINS?: string }} env
 * @param {Request} request
 */
export function feedCorsOrigin(env, request) {
  const raw = env?.FEED_CORS_ORIGINS != null ? String(env.FEED_CORS_ORIGINS) : "*";
  const allowed = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allowed.length || allowed.includes("*")) return "*";
  const origin = request.headers.get("Origin") || "";
  if (origin && allowed.includes(origin)) return origin;
  // No Origin (curl) or unmatched — still return first allowlisted for simple GETs
  return allowed[0];
}

/**
 * @param {string} allowOrigin
 * @returns {Record<string, string>}
 */
export function feedCorsHeaders(allowOrigin) {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
