# Cue

**Sparse real-time alerts from timed event streams.**

Cue turns a firehose of structured events into a small set of high-severity **moments**, then renders short template messages for log or Telegram delivery. Sources and domains are pluggable; the core is a single pipeline:

**normalize → reduce snapshot → detect moments → gate → render → deliver**

**License:** MIT  
**Author:** [datadr1ven](https://github.com/datadr1ven)

---

## What it is

| Layer | Responsibility |
|--------|----------------|
| **Ingest** | Map external records into a common event shape (`type`, `t`, `payload`) |
| **Domain** | Domain-specific state reduction and moment detection |
| **Gate** | Severity floor, dedupe, cooldowns |
| **Render** | Templates by default (no LLM required) |
| **Deliver** | `log` \| `telegram` \| `none` |

Reference domains in this repository:

| Domain | Primary inputs | Operator path |
|--------|----------------|---------------|
| **`f1`** | OpenF1-shaped MQTT / NDJSON | MQTT worker + offline replay |
| **`starship`** | Manual inject (+ nominal mission script) | CLI keys or Telegram `/ops` |

Downstream apps can brand separately and run one Cue worker instance per domain.

---

## Features

- Domain-pluggable moment pipeline with shared gate and delivery  
- Template rendering; optional LLM hook exists but is off by default  
- Explicit runtime posture (`MQTT_SOURCE`, `DELIVERY_MODE`) — no silent defaults  
- Offline file replay for regression and evaluation  
- Local MQTT publish path for capture-driven integration tests  
- Telegram: open or closed enrollment (`data/users.json`); admin ids for ops  
- Human-in-the-loop inject for domains without a public machine feed  

---

## Requirements

- Node.js 18+  
- Telegram bot token when using Telegram delivery or bots  
- MQTT broker for local worker loops (e.g. Mosquitto)  
- Upstream credentials only when using a live feed that requires them (e.g. OpenF1 for `f1` + `MQTT_SOURCE=live`)  

---

## Install

```bash
git clone https://github.com/datadr1ven/cue.git
cd cue
cp .env.example .env
npm install
```

---

## Usage

### Offline replay (file → stdout)

OpenF1-style NDJSON through the **`f1`** domain:

```bash
npm run replay -- path/to/capture.ndjson
npm run replay -- path/to/capture.ndjson --min-severity 7
npm run replay -- path/to/capture.ndjson --json
```

### MQTT worker (stream → deliver)

Requires `MQTT_SOURCE` and `DELIVERY_MODE`.

| Command | MQTT | Delivery |
|---------|------|----------|
| `npm run worker:local:log` | local broker | log |
| `npm run worker:live:log` | configured live host | log |
| `npm run worker:live` | configured live host | Telegram |

```bash
MQTT_SOURCE=local DELIVERY_MODE=log npm run worker
```

Default domain is `f1` (`ENGINE_DOMAIN`). Lean topic subscriptions are defined in the MQTT worker for that domain.

### Publish NDJSON to a local broker

```bash
# Terminal A: broker
# Terminal B: npm run worker:local:log
# Terminal C:
npm run publish -- path/to/capture.ndjson max
npm run publish -- path/to/capture.ndjson respect 10
```

`max` — as fast as possible · `respect` — wall timing from capture timestamps (optional speed multiplier).

### Telegram enrollment

```bash
npm run bot
```

Allowlisted users: `/start` appends to `data/users.json`. The worker fans out alerts to that list. Enrollment is separate from domain logic.

### Manual inject (Starship / TPlus)

For streams without a public event bus, operators mark moments while watching an external source. Flight timelines live under `missions/` (git). All allowlisted subscribers share one notification stream.

```bash
# Before committing a new flight JSON
npm run validate:missions
npm run validate:missions -- missions/flights/starship-flight-14-script.json
npm run smoke:tplus

# CLI ops
npm run starship:ops
npm run starship:ops -- --mission 12

# Telegram (browse + ops + freeform)
TELEGRAM_TOKEN=… TELEGRAM_ALLOWLIST=your_id DELIVERY_MODE=telegram npm run starship:bot
```

| Command | Role |
|---------|------|
| `/missions` · `/mission <n>` | Archive browse |
| `/mission use <n>` | Active flight (ops + ETA) |
| `/eta` · `/status` | NET countdown · live T+ |
| `/ops` | Milestone buttons |
| `/note <text>` | Freeform alert (all subscribers) |
| `/broadcast <text>` | Announcement |
| photo + caption `/note …` or `/broadcast …` | Same as above, with image (admin) |
| `/hype <hours>` | HITL lead-up template (e.g. 48) |

The Telegram **/** menu lists user commands only (`start`, `help`, `missions`, `mission`, `eta`, `status`). Ops commands stay off the public menu.

Add a flight: create `missions/flights/….json`, add an entry to `missions/index.json`, run `validate:missions` + `smoke:tplus`, commit.

---

## Configuration

See [`.env.example`](./.env.example).

| Variable | Description |
|----------|-------------|
| `MQTT_SOURCE` | `live` \| `local` |
| `DELIVERY_MODE` | `telegram` \| `log` \| `none` |
| `TELEGRAM_TOKEN` | Bot API token |
| `TELEGRAM_ADMIN_IDS` | Ops admins (comma-separated). Alias: `TELEGRAM_ALLOWLIST` |
| `ENROLL_OPEN` | `true` (default): anyone `/start`s. `false`: admin-only enroll |
| `SUBSCRIBER_IDS` | Optional seed subscriber ids (file store) |
| Subscribers | `data/users.json` — delivery targets (not the admin list alone) |
| `OPENF1_USERNAME` / `OPENF1_PASSWORD` | Live OpenF1 MQTT (`f1` + `MQTT_SOURCE=live`) |
| `MQTT_LOCAL_HOST` / `MQTT_LOCAL_PORT` | Local broker (default `localhost:1883`) |
| `ENGINE_DOMAIN` | Domain pack (`f1` \| `starship`, default `f1`) |
| `ENGINE_MIN_SEVERITY` | Minimum severity 1–9 (default `6`) |
| `STARSHIP_MISSION` | Default mission ref (number or id) for TPlus bot |
| `STARSHIP_SCRIPT` | Optional path override for a single mission JSON |
| `USERS_FILE` | Subscriber store path (default `data/users.json`) |

---

## Architecture

```text
┌──────────────────┐     ┌─────────────────┐     ┌──────────┐     ┌──────────┐
│ Source adapter   │     │ Domain pack     │     │ Gate     │     │ Delivery │
│ MQTT · NDJSON ·  │────▶│ snapshot reduce │────▶│ severity │────▶│ log · TG │
│ manual · …       │     │ moment detect   │     │ dedupe   │     │ none     │
└──────────────────┘     └─────────────────┘     └──────────┘     └──────────┘
                                    │
                               templates
```

```text
src/
  engine/
    pipeline.js           Shared orchestrator
    gate.js
    config.js
    domains/
      f1/                 Feed-driven reference domain
      starship/           Manual-inject reference domain
    ingest/               Adapters (e.g. OpenF1 normalize, NDJSON reader)
  missions/               Mission index + load/validate
  mqtt-worker.js
  starship-session.js
  delivery.js
  users.js
  config.js
  runtime.js
bin/                      CLI entrypoints
missions/                 Flight timeline JSON + index.json
examples/                 Legacy copies of sample scripts
gold/                     Evaluation timelines (optional)
```

**Defaults:** no LLM; no per-user preference filtering (global moments → all subscribers).

**Extension points**

- **Source:** emit `{ type, t, payload }` (see existing ingest modules).  
- **Domain:** export `createState`, `reduce`, `detectMoments`, `renderMoment`; register in `pipeline.js`.  

---

## Reference domains (summary)

### `f1`

Feed-oriented session coverage (flags, order changes, pits, stewards, session lifecycle; optional team radio at lower severity). Intended input: OpenF1 MQTT or compatible NDJSON captures.

### `starship`

Operator-oriented flight coverage (window, ascent, booster, ship, entry, anomaly). Intended input: human inject via CLI or Telegram; optional nominal T+ script for labeling and clock hints.

Evaluation notes and capture inventories may live under `gold/` for development; they are not required at runtime.

---

## TPlus on Cloudflare (free tier)

Persistent hosting for the Starship Telegram bot: **webhook Worker + KV**.

See **[docs/tplus-cloudflare.md](./docs/tplus-cloudflare.md)** for deploy, webhook setup, mission updates, and **git-push autodeploy**.

```bash
npm run validate:missions && npm run smoke:tplus
npx wrangler deploy   # manual
```

**Autodeploy:** add GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.  
Workflow [`.github/workflows/deploy-tplus.yml`](./.github/workflows/deploy-tplus.yml) deploys on push to `main` when TPlus-related paths change (not F1-only paths). Use **workflow_dispatch** to deploy manually from the Actions tab.

Local Node polling (`npm run starship:bot`) remains available for development; use one or the other, not both, against the same bot token.

---

## GridWhisper on Cloudflare (enroll + deliver)

F1 product surface (rebuild): **webhook Worker + KV** for subscribe/unsubscribe; race-day MQTT stays on a laptop and fans out via `POST /deliver`.

No per-user prefs in v1 — same sparse moment stream for everyone.

See **[docs/gridwhisper-cloudflare.md](./docs/gridwhisper-cloudflare.md)**.

```bash
npm run smoke:gridwhisper
npx wrangler deploy -c wrangler.gridwhisper.toml
```

| Command | Role |
|---------|------|
| `/start` · `/stop` | Subscribe / unsubscribe |
| `/status` · `/help` | Enrollment check · how it works |
| `POST /deliver` | Trusted race-day inject (Bearer `DELIVER_SECRET`) |

---

## Disclaimer

Cue is an independent project. It is not affiliated with Formula 1 companies, OpenF1, SpaceX, or other upstream data providers. Third-party marks remain the property of their owners. Use of live feeds and media links is subject to upstream terms.

---

## License

[MIT](./LICENSE)
