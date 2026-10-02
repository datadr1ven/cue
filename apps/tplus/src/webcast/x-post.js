/**
 * Optional X (Twitter) post for a TPlus end-of-flight summary.
 *
 * Dry-run by default. Live post requires pay-per-use API credits + OAuth user
 * tokens with write access (see apps/tplus/docs/x-posting.md).
 *
 * Env (when posting for real):
 *   TPLUS_X_API_KEY
 *   TPLUS_X_API_SECRET
 *   TPLUS_X_ACCESS_TOKEN
 *   TPLUS_X_ACCESS_SECRET
 * Optional:
 *   TPLUS_X_ENABLED=1   — allow live posts (still needs --post on CLI)
 */

import { createHmac, randomBytes } from "crypto";
import { readFileSync } from "fs";
import { basename } from "path";

/**
 * @returns {{ ready: boolean, missing: string[], enabled: boolean }}
 */
export function xPostConfig() {
  const keys = [
    "TPLUS_X_API_KEY",
    "TPLUS_X_API_SECRET",
    "TPLUS_X_ACCESS_TOKEN",
    "TPLUS_X_ACCESS_SECRET",
  ];
  const missing = keys.filter((k) => !process.env[k]);
  return {
    ready: missing.length === 0,
    missing,
    enabled: process.env.TPLUS_X_ENABLED === "1" || process.env.TPLUS_X_ENABLED === "true",
  };
}

/**
 * @param {{ caption: string, collagePath: string, dryRun?: boolean }} opts
 */
export async function postSummaryToX(opts) {
  const { caption, collagePath } = opts;
  const dryRun = opts.dryRun !== false;
  const cfg = xPostConfig();

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      caption,
      collagePath,
      note: "dry-run — no X API call",
      configReady: cfg.ready,
      missing: cfg.missing,
    };
  }

  if (!cfg.enabled) {
    throw new Error(
      "Live X post blocked: set TPLUS_X_ENABLED=1 and pass --post (see docs/x-posting.md)",
    );
  }
  if (!cfg.ready) {
    throw new Error(
      `Missing X credentials: ${cfg.missing.join(", ")} (see docs/x-posting.md)`,
    );
  }

  const mediaId = await uploadImageOAuth1({
    path: collagePath,
    apiKey: process.env.TPLUS_X_API_KEY,
    apiSecret: process.env.TPLUS_X_API_SECRET,
    accessToken: process.env.TPLUS_X_ACCESS_TOKEN,
    accessSecret: process.env.TPLUS_X_ACCESS_SECRET,
  });

  const tweet = await createTweetOAuth1({
    text: caption,
    mediaIds: [mediaId],
    apiKey: process.env.TPLUS_X_API_KEY,
    apiSecret: process.env.TPLUS_X_API_SECRET,
    accessToken: process.env.TPLUS_X_ACCESS_TOKEN,
    accessSecret: process.env.TPLUS_X_ACCESS_SECRET,
  });

  return {
    ok: true,
    dryRun: false,
    mediaId,
    tweetId: tweet?.data?.id || null,
    tweet,
  };
}

/**
 * Simple media upload (v1.1) for images ≤5MB — still widely used with OAuth 1.0a.
 * Chunked v2 can replace this later if needed.
 */
async function uploadImageOAuth1({
  path,
  apiKey,
  apiSecret,
  accessToken,
  accessSecret,
}) {
  const buf = readFileSync(path);
  if (buf.byteLength > 5_000_000) {
    throw new Error(
      `collage too large for simple upload (${buf.byteLength} bytes; max 5MB)`,
    );
  }
  const url = "https://upload.twitter.com/1.1/media/upload.json";
  const oauth = oauth1Header({
    method: "POST",
    url,
    apiKey,
    apiSecret,
    accessToken,
    accessSecret,
  });

  const form = new FormData();
  form.append("media", new Blob([buf], { type: "image/jpeg" }), basename(path));

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: oauth },
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.media_id_string) {
    throw new Error(
      `X media upload failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`,
    );
  }
  return json.media_id_string;
}

async function createTweetOAuth1({
  text,
  mediaIds,
  apiKey,
  apiSecret,
  accessToken,
  accessSecret,
}) {
  const url = "https://api.twitter.com/2/tweets";
  const body = {
    text: String(text).slice(0, 280),
    media: { media_ids: mediaIds.map(String) },
  };
  const oauth = oauth1Header({
    method: "POST",
    url,
    apiKey,
    apiSecret,
    accessToken,
    accessSecret,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: oauth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `X create tweet failed HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}`,
    );
  }
  return json;
}

function oauth1Header({
  method,
  url,
  apiKey,
  apiSecret,
  accessToken,
  accessSecret,
  extraParams = {},
}) {
  const oauth = {
    oauth_consumer_key: apiKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: accessToken,
    oauth_version: "1.0",
  };
  const params = { ...oauth, ...extraParams };
  const paramStr = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramStr)].join("&");
  const signingKey = `${enc(apiSecret)}&${enc(accessSecret)}`;
  const signature = createHmac("sha1", signingKey).update(base).digest("base64");
  oauth.oauth_signature = signature;
  const header =
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(", ");
  return header;
}

function enc(s) {
  return encodeURIComponent(String(s)).replace(/[!*()']/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

