# GridWhisper on Cloudflare Workers (enroll + deliver)

**Always-on:** Telegram webhook → Worker → KV subscribers.  
**Race day:** laptop MQTT + Cue F1 pipeline → `POST /deliver` → Worker fans out via Telegram.

No user prefs in v1 — everyone gets the same sparse moments.

## Architecture

```
Telegram users
    │  /start /stop /help /status
    ▼
CF Worker (gridwhisper) ── KV users:v1
    ▲
    │  POST /deliver  (Bearer DELIVER_SECRET)
    │
Laptop (quali / race)
  MQTT OpenF1 → Cue f1 pipeline → HTTP deliver
```

TPlus stays a separate worker (`wrangler.toml` / `tplus`).

## Autodeploy (GitHub Actions)

Workflow [`.github/workflows/deploy-gridwhisper.yml`](../.github/workflows/deploy-gridwhisper.yml) deploys on push to `main` when the **Worker surface** changes:

- `worker/gridwhisper/**`
- `wrangler.gridwhisper.toml`
- `src/gridwhisper-commands.js`
- `package.json` / lockfile / the workflow itself

Uses the same GitHub secrets as TPlus: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

**Not** redeployed by this workflow: F1 engine / moments (`src/engine/**`). Those run on your laptop via MQTT → `POST /deliver`. Pull + restart the local worker for those.

Manual deploy anytime: **Actions → Deploy GridWhisper → Run workflow**, or:

```bash
npx wrangler deploy -c wrangler.gridwhisper.toml
```

## Prerequisites

- Cloudflare account  
- **Existing GridWhisper** bot token (BotFather)  
- Long random string for `DELIVER_SECRET`  

## Deploy

```bash
cd cue
npm install

# one-time KV
npx wrangler kv namespace create GRIDWHISPER_KV -c wrangler.gridwhisper.toml
```

Paste the namespace **id** into `wrangler.gridwhisper.toml`:

```toml
[[kv_namespaces]]
binding = "GRIDWHISPER_KV"
id = "paste-id-here"
```

```bash
npx wrangler secret put TELEGRAM_TOKEN -c wrangler.gridwhisper.toml
# paste GridWhisper bot token

npx wrangler secret put DELIVER_SECRET -c wrangler.gridwhisper.toml
# paste a long random string (keep for race-day .env)

# optional (future ops)
# npx wrangler secret put TELEGRAM_ADMIN_IDS -c wrangler.gridwhisper.toml

npx wrangler deploy -c wrangler.gridwhisper.toml
```

Note the URL, e.g. `https://gridwhisper.<account>.workers.dev`.

### Optional webhook path secret

In `wrangler.gridwhisper.toml` `[vars]`:

```toml
WEBHOOK_SECRET = "long-random-string"
```

Webhook path becomes `/telegram/long-random-string`.

### Point Telegram at the worker

**Stop any old Vercel / Node webhook or polling** for this bot token first.

```bash
# without path secret
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://gridwhisper.<account>.workers.dev/telegram"

# with path secret
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://gridwhisper.<account>.workers.dev/telegram/<WEBHOOK_SECRET>"

curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

### Commands menu

`setMyCommands` runs on the first webhook after deploy (`start`, `help`, `status`, `stop`).  
Reopen the chat if Telegram still shows an old list.

## Enrol users

1. Open the GridWhisper bot in Telegram.  
2. `/start` → written to KV (`ENROLL_OPEN=true`).  
3. `/status` · `/stop` as needed.  

Friends re-subscribe after the old Redis wipe — no migration.

## Race-day deliver (manual test)

```bash
export DELIVER_SECRET='…'   # same as wrangler secret
export GW_URL='https://gridwhisper.<account>.workers.dev'

curl -s -X POST "$GW_URL/deliver" \
  -H "Authorization: Bearer $DELIVER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"text":"GridWhisper test · sparse alert pipeline ok"}'
# → {"ok":true,"delivered":N,"total":N}
```

Chunk 2 wires the MQTT worker to this endpoint automatically.

## Race day (laptop MQTT → Worker)

Subscribers stay in KV. Your laptop never needs the user list.

```bash
cd cue
# .env or export:
#   OPENF1_USERNAME=…
#   OPENF1_PASSWORD=…
#   DELIVER_URL=https://gridwhisper.scenicminddigital.workers.dev/deliver
#   DELIVER_SECRET=…   # same as wrangler secret

npm run worker:live:http
```

Or:

```bash
MQTT_SOURCE=live DELIVERY_MODE=http \
  DELIVER_URL=https://gridwhisper.scenicminddigital.workers.dev/deliver \
  DELIVER_SECRET=… \
  npm run worker
```

Offline practice (local broker + tiny fixture → **2** Telegram messages):

```bash
# Terminal A: mosquitto (localhost:1883)
# Terminal B:
MQTT_SOURCE=local DELIVERY_MODE=http \
  DELIVER_URL=https://gridwhisper.scenicminddigital.workers.dev/deliver \
  DELIVER_SECRET=… \
  npm run worker
# Terminal C:
npm run publish -- examples/f1/smoke-two-alerts.ndjson
```

Fixture details: [`examples/f1/README.md`](../examples/f1/README.md).  
Each moment → one `POST /deliver` → Worker fans out to all KV subscribers.

Stdout-only check (no MQTT / Telegram):

```bash
npm run replay -- examples/f1/smoke-two-alerts.ndjson
```

## Vs old GridWhisper (Vercel)

| Old | New |
|-----|-----|
| Vercel webhook + Redis prefs | CF Worker + KV enroll only |
| Per-user interests / verbosity | One feed for everyone |
| Worker + bot on Vercel | Bot on CF; MQTT on laptop |

## Smoke (offline)

```bash
npm run smoke:gridwhisper
```
