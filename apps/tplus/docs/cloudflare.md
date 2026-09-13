# TPlus on Cloudflare Workers (free tier)

Event-driven Telegram bot for **sparse launch alerts**:  
**webhook → Worker → sendMessage**, plus laptop `webcast:live` → **`POST /suggest`**.

Subscribers live in **KV**. Mission timelines / streams are resolved on the **laptop** (Launch Library 2); `/suggest` does not need a mission catalog redeploy.

## Why this stack

| Concern | Choice |
|---------|--------|
| Always on (free) | Workers free tier + webhook (no polling process) |
| Subscribers | KV key `users:v1` |
| Free-text from users | KV key `inbox:v1` (admin `/inbox` / `/reply`) |
| Admin inbox pings | KV `inbox:notify:v1` — digest coalesce (~10m quiet window) |
| Schedule / live emit | `POST /suggest` · `mode=test` admins · `mode=ops` all `users:v1` |
| New launches | `webcast:live --ll2-*` on the laptop (no Worker redeploy) |

Not for OpenF1 MQTT (use a small VPS for GridWhisper/F1 if needed).

## Subscribers (`users:v1`)

| Action | Effect |
|--------|--------|
| User `/start` | Upsert into `users:v1` → included in ops fan-out attempts |
| User `/stop` | **Delete** from `users:v1` → no longer attempted |
| Hand-add id to KV | Included in attempt list (no separate “confirmed start” flag) |
| `TELEGRAM_ADMIN_IDS` | Auto-seeded into `users:v1` on fan-out / `/subscribers` |
| `/broadcast` “Sent to N” | **Successful Telegram sends**, not KV size — Telegram rejects users who never opened the bot, blocked it, or have a bad id |

Admin: Telegram **`/subscribers`** (or `/users`) — count + list.  
Laptop: `GET /subscribers` with `Authorization: Bearer $TPLUS_SUGGEST_SECRET`.

## Prerequisites

- Cloudflare account  
- TPlus bot token from BotFather  
- Your numeric Telegram user id (admin)  

## Deploy

```bash
cd cue  # monorepo root
npm install
npm run validate:missions
npm run smoke:tplus

# one-time
npx wrangler login
npx wrangler kv namespace create TPLUS_KV
```

Copy the namespace **id** into `apps/tplus/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "TPLUS_KV"
id = "paste-id-here"
```

```bash
npx wrangler secret put TELEGRAM_TOKEN
# paste bot token

npx wrangler secret put TELEGRAM_ADMIN_IDS
# paste your numeric id (comma-separated if several)

# Ensure apps/tplus/wrangler.toml has a real KV id (not REPLACE_WITH_…)
npm run cf:deploy:tplus
```

If deploy fails with `fileURLToPath` / `path` errors, pull latest Cue — Workers must not import Node-only `registry.js` (use bundled missions).

Note the worker URL, e.g. `https://tplus.<account>.workers.dev`.

### Optional webhook path secret

In `apps/tplus/wrangler.toml` `[vars]`:

```toml
WEBHOOK_SECRET = "long-random-string"
```

Webhook path becomes `/telegram/long-random-string`.

### Point Telegram at the worker

```bash
# without secret
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tplus.<account>.workers.dev/telegram"

# with secret
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://tplus.<account>.workers.dev/telegram/<WEBHOOK_SECRET>"

# verify
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

Stop any local `npm run starship:bot` (polling conflicts with webhook).

## Enrol users

1. Open the bot in Telegram.  
2. `/start` → written to KV (if `ENROLL_OPEN=true`).  
3. Admins use `/ops`, `/note`, `/broadcast`, `/hype`.  
   - **Photo alerts:** send an image with caption `/note …` or `/broadcast …` (re-sent via Telegram `file_id`).  
4. Everyone receives fan-out alerts.  
5. User-facing **/** menu is registered via `setMyCommands` on the first webhook (ops commands stay hidden).

## New mission / launch

**No Worker redeploy.** The laptop loads NET + Official Webcast + timeline from
[Launch Library 2](https://ll.thespacedevs.com/docs/) at `webcast:live` start.
`POST /suggest` is a pure fan-out (formats the alert from the JSON body).

```bash
npm run webcast:live -- --ll2-id <uuid> --mode test
# or: --ll2-search 'O3b mPower' / --ll2-slug falcon-9-…
```

Optional file missions (`--mission <id>`) remain for fixtures/replay. Deploy the
Worker only when **Worker code** changes (enroll, `/suggest` shape, admin cmds).

## Webcast emit → test | ops

Laptop locks mission time (OCR), walks the script, POSTs each milestone to `/suggest`.
**No Approve/Dismiss** — fan-out is immediate:

| `mode` | Audience |
|--------|----------|
| `test` (default) | `TELEGRAM_ADMIN_IDS` only (messages prefixed `🧪 TEST`) |
| `ops` | All keys in KV `users:v1` (see `/start` / `/stop`) |

```bash
npx wrangler secret put TPLUS_SUGGEST_SECRET

export TPLUS_SUGGEST_URL=https://tplus.scenicminddigital.workers.dev/suggest
export TPLUS_SUGGEST_SECRET=…

# Rehearsal — admins only (LL2 Official Webcast when --url omitted)
npm run webcast:live -- --ll2-search 'O3b mPower' --mode test

# Launch night
npm run webcast:live -- --ll2-id ad358a4d-c541-409b-9366-9c2f2da4aeb9 --mode ops
```

`/suggest` body (Bearer `TPLUS_SUGGEST_SECRET`):  
`{ actionId, label, scriptTPlusSec, missionName, mode, artifacts? }` or `{ text, mode }`.

## Migrate existing `data/users.json`

One-shot (Node, with wrangler):

```bash
# export subscribers from local file, then put into KV via dashboard
# or:
npx wrangler kv key put --binding=TPLUS_KV users:v1 --path=data/users.json
```

(Use remote flag / correct wrangler KV syntax for your CLI version.)

## Local Node bot (still available)

```bash
DELIVERY_MODE=telegram TELEGRAM_ADMIN_IDS=… npm run starship:bot
```

Uses `data/users.json` on disk. Prefer **either** local polling **or** CF webhook, not both.

## Deploy on git push (GitHub Actions)

Workflow: [`.github/workflows/deploy-tplus.yml`](../.github/workflows/deploy-tplus.yml).

### Path filters (so F1-only work does not redeploy TPlus)

Deploy runs when these change (or via **Actions → Deploy TPlus → Run workflow**).  
Bias: **over-deploy rather than miss a needed redeploy**, but pure F1/GridWhisper paths stay out.

Typical triggers:
- `worker/tplus/**`, `apps/tplus/wrangler.toml`, `src/tplus-commands.js`
- Shared Cue core used by the session pipeline (`pipeline`, `gate`, `types`)
- `apps/tplus/**`, `packages/cue` starship domain + shared telegram-inbox
- `package.json`, `package-lock.json`, the workflow file itself

**Not** triggered by pure F1 work (`packages/cue` f1 domain, `apps/gridwhisper/**`).  
Also **not** by `packages/cue/src/engine/config.js` alone — use **workflow_dispatch** if you change engine defaults TPlus should pick up.

### One-time GitHub secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|--------|--------|
| `CLOUDFLARE_API_TOKEN` | [Create token](https://dash.cloudflare.com/profile/api-tokens) — template **Edit Cloudflare Workers** (or custom: Account → Workers Scripts → Edit, Account → Account Settings → Read) |
| `CLOUDFLARE_ACCOUNT_ID` | Hex **Account ID** from the Cloudflare dashboard sidebar (not your email) |

### One-time Worker secrets (Cloudflare, not GitHub)

Still required for the bot to run (CI only deploys code):

```bash
npx wrangler secret put TELEGRAM_TOKEN
npx wrangler secret put TELEGRAM_ADMIN_IDS
```

Or Dashboard → Workers → `tplus` → Settings → Variables and Secrets.

### After secrets are set

1. Push to `main` (with a path that matches the filters), **or**  
2. **Actions → Deploy TPlus → Run workflow** (works even if only README changed).

Check the run is green; `getWebhookInfo` should still point at the worker URL.

## Free-tier notes

- Sparse traffic (signups + launch day) fits Workers request limits.  
- KV is enough; no Durable Objects required for single-admin T+.  
- Keep alerts low frequency except during flights.
