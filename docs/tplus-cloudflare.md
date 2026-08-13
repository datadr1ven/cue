# TPlus on Cloudflare Workers (free tier)

Event-driven Telegram bot: **webhook → Worker → Cue starship domain → sendMessage**.  
Subscribers and session state live in **KV**. Flight timelines ship in the deploy bundle (git).

## Why this stack

| Concern | Choice |
|---------|--------|
| Always on (free) | Workers free tier + webhook (no polling process) |
| Subscribers | KV key `users:v1` (not local `data/users.json`) |
| Active mission / T+ clock | KV key `session:v1` |
| New flight timelines | Commit JSON → `npm run validate:missions` → deploy |

Not for OpenF1 MQTT (use a small VPS for GridWhisper/F1 if needed).

## Prerequisites

- Cloudflare account  
- TPlus bot token from BotFather  
- Your numeric Telegram user id (admin)  

## Deploy

```bash
cd cue
npm install
npm run validate:missions
npm run smoke:tplus

# one-time
npx wrangler login
npx wrangler kv namespace create TPLUS_KV
```

Copy the namespace **id** into `wrangler.toml`:

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

# Ensure wrangler.toml has a real KV id (not REPLACE_WITH_…)
npx wrangler deploy
```

If deploy fails with `fileURLToPath` / `path` errors, pull latest Cue — Workers must not import Node-only `registry.js` (use bundled missions).

Note the worker URL, e.g. `https://tplus.<account>.workers.dev`.

### Optional webhook path secret

In `wrangler.toml` `[vars]`:

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
4. Everyone receives fan-out alerts.

## New flight (e.g. 14)

1. Add `missions/flights/starship-flight-14-script.json`.  
2. Register in `missions/index.json`.  
3. **Import the new JSON in** `src/missions/bundle.js` (Workers cannot read the filesystem).  
4. `npm run validate:missions && npm run smoke:tplus`  
5. `npx wrangler deploy`  
6. `/mission use 14` as admin  

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

Deploy runs only when these change (or via **Actions → Deploy TPlus → Run workflow**):

- `worker/tplus/**`, `wrangler.toml`
- Shared engine pieces used by TPlus (`pipeline`, `gate`, `config`, `types`)
- `src/engine/domains/starship/**`, `src/missions/**`, `src/starship-session.js`
- `missions/**`, `package.json`, `package-lock.json`, the workflow file itself

Edits under `src/engine/domains/f1/**` alone do **not** trigger this workflow.

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
