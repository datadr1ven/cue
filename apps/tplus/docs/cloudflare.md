# TPlus on Cloudflare Workers (free tier)

Event-driven Telegram bot for **sparse SpaceX launch alerts**:  
**webhook → Worker → Cue launch domain → sendMessage**.

Subscribers and session state live in **KV**. Mission timelines (Starship, Falcon/Starlink, …) ship in the deploy bundle (git).

## Why this stack

| Concern | Choice |
|---------|--------|
| Always on (free) | Workers free tier + webhook (no polling process) |
| Subscribers | KV key `users:v1` (not local `data/users.json`) |
| Active mission / T+ clock | KV key `session:v1` |
| Free-text from users | KV key `inbox:v1` (admin `/inbox` / `/reply`) |
| Admin inbox pings | KV `inbox:notify:v1` — digest coalesce (~10m quiet window) |
| Schedule / live emit | `POST /suggest` (Bearer `TPLUS_SUGGEST_SECRET`) · `mode=test` admins only · `mode=ops` all subscribers |
| New mission timelines | Commit JSON → `npm run validate:missions` → deploy |

Not for OpenF1 MQTT (use a small VPS for GridWhisper/F1 if needed).

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

## New mission (Starship, Starlink, …)

Same path for every vehicle — data-driven `/ops` from the script:

1. Add `missions/flights/<id>-script.json` (NET + ordered `script[]` milestones).  
2. Register in `missions/index.json` (optional `number` for `/mission use <n>`).  
3. **Import the new JSON in** `src/missions/bundle.js` (Workers cannot read the filesystem).  
4. Use `actionId`s from the `LAUNCH_ACTIONS` catalog (`packages/cue/src/engine/domains/starship/actions.js`). Add a catalog row only if you need a *new* kind of milestone.  
5. `npm run validate:missions && npm run smoke:tplus`  
6. `npm run cf:deploy:tplus`  
7. `/mission use <n|id>` as admin (or set `defaultMissionId`)  

`/ops` shows: always-on `hold` / `go` / `los` / `anomaly` / `success`, then that mission’s script in order.

## Webcast emit → test | ops

Laptop locks mission time (OCR or `--liftoff-file-sec`), walks the script, POSTs each milestone to `/suggest`. **No Approve/Dismiss** — fan-out is immediate:

| `mode` | Audience |
|--------|----------|
| `test` (default) | `TELEGRAM_ADMIN_IDS` only (messages prefixed `🧪 TEST`) |
| `ops` | All subscribers |

```bash
npx wrangler secret put TPLUS_SUGGEST_SECRET

export TPLUS_SUGGEST_URL=https://tplus.scenicminddigital.workers.dev/suggest
export TPLUS_SUGGEST_SECRET=…

# Rehearsal — admins only
npm run webcast:live -- \
  --url 'https://x.com/i/broadcasts/…' \
  --mission starlink-sl-15-23 \
  --mode test

# Launch night — everyone
npm run webcast:live -- --url '…' --mission starlink-sl-15-23 --mode ops
```

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
