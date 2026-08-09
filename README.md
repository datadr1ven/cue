# Cue

**Real-time alerts from live event streams — high signal, low volume.**

Cue ingests structured event data, maintains a compact situation snapshot, detects discrete **moments** (safety car, lead change, pit under VSC, chequered flag, …), and emits short template-rendered alerts. An F1 domain (OpenF1 MQTT / NDJSON) ships in-tree. The pipeline is domain-pluggable.

**License:** MIT  
**Author:** [datadr1ven](https://github.com/datadr1ven)

---

## Features

- **Moment pipeline** — normalize → reduce state → detect → gate (severity / dedupe) → render  
- **Template output by default** — no LLM required  
- **OpenF1 adapter** — live MQTT and offline NDJSON captures  
- **Lean subscriptions** — race control, position, pit, stints, drivers, weather, team radio (not location / car_data / lap firehose)  
- **Delivery modes** — Telegram, log, or none  
- **Local replay** — file → stdout, or file → MQTT broker → worker  
- **Minimal Telegram bot** — allowlisted `/start` enrollment to a JSON subscriber file  

---

## Requirements

- Node.js 18+  
- For live OpenF1 MQTT: OpenF1 credentials  
- For Telegram delivery: a bot token  
- For local MQTT loops: a broker (e.g. Mosquitto) on `localhost:1883`  

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

### Offline replay (no broker, no Telegram)

```bash
npm run replay -- path/to/session.ndjson
npm run replay -- path/to/session.ndjson --min-severity 7
npm run replay -- path/to/session.ndjson --radios
npm run replay -- path/to/session.ndjson --json
```

### Worker (MQTT → alerts)

`MQTT_SOURCE` and `DELIVERY_MODE` are required (no silent defaults).

| Command | MQTT | Delivery |
|---------|------|----------|
| `npm run worker:local:log` | local broker | log |
| `npm run worker:live:log` | OpenF1 live | log |
| `npm run worker:live` | OpenF1 live | Telegram |

```bash
MQTT_SOURCE=local DELIVERY_MODE=log npm run worker
```

### Publish NDJSON to a local broker

```bash
# Terminal A: mosquitto
# Terminal B: worker:local:log
# Terminal C:
npm run publish -- path/to/session.ndjson max
npm run publish -- path/to/session.ndjson respect 10
```

`max` publishes as fast as possible; `respect` preserves capture timing (optional speed multiplier).

### Telegram bot (enrollment)

```bash
npm run bot
```

Allowlisted users run `/start` to write into `data/users.json`. The worker reads that file for fan-out. The bot does not process race data.

---

## Configuration

See [`.env.example`](./.env.example).

| Variable | Description |
|----------|-------------|
| `MQTT_SOURCE` | `live` \| `local` |
| `DELIVERY_MODE` | `telegram` \| `log` \| `none` |
| `TELEGRAM_TOKEN` | Bot API token |
| `TELEGRAM_ALLOWLIST` | Comma-separated numeric chat ids (delivery + `/start`) |
| `SUBSCRIBER_IDS` | Optional seed subscriber ids |
| `OPENF1_USERNAME` / `OPENF1_PASSWORD` | Required when `MQTT_SOURCE=live` |
| `MQTT_LOCAL_HOST` / `MQTT_LOCAL_PORT` | Local broker (default `localhost:1883`) |
| `ENGINE_DOMAIN` | Domain pack (default `f1`) |
| `ENGINE_MIN_SEVERITY` | Minimum moment severity 1–9 (default `6`; `5` includes team radio) |
| `USERS_FILE` | Subscriber JSON path (default `data/users.json`) |

---

## Architecture

```text
┌─────────────┐     ┌──────────────┐     ┌─────────┐     ┌────────┐
│  NDJSON /   │     │   Domain     │     │  Gate   │     │Deliver │
│  MQTT / …   │────▶│  reduce +    │────▶│ severity│────▶│ TG/log │
│  normalize  │     │  detect      │     │ dedupe  │     │        │
└─────────────┘     └──────────────┘     └─────────┘     └────────┘
                           │
                      templates
```

```text
src/
  engine/                 Core pipeline
    pipeline.js
    gate.js
    config.js
    domains/f1/           F1 snapshot, detectors, templates, roster
    ingest/               OpenF1 normalize + NDJSON reader
  mqtt-worker.js          Live MQTT bridge
  delivery.js
  users.js
  config.js
  runtime.js
bin/
  replay.js
  worker.js
  bot.js
  publish-ndjson.js
gold/                     Reference timelines for evaluation
```

**Pipeline defaults:** LLM off; preference filtering off. All subscribers receive the same global moments.

**Extensibility:** additional source adapters implement the same normalized event shape; additional domains export `createState` / `reduce` / `detectMoments` / `renderMoment`.

---

## F1 domain (summary)

| Moment types (examples) | Severity (typical) |
|-------------------------|-------------------|
| Safety car / VSC / red flag | 9 |
| Leader change, chequered | 9 |
| Time penalties | 8 |
| Session start/finish, investigations | 7 |
| Pits (top of field higher), big position swings | 5–7 |
| Team radio (with position / track context + URL) | 5 |

Captures used for development live under sibling project artifacts (not vendored here). Gold sketches in `gold/` list high-value beats from public race reports.

---

## Project layout notes

Cue is the open **engine and thin operators** (worker, replay, bot). Downstream products may brand separately (e.g. a consumer F1 bot) while depending on or embedding this repository.

---

## Disclaimer

Cue is an independent project and is not affiliated with Formula 1 companies or OpenF1. Formula 1® and related marks are trademarks of their respective owners. Live data and media links are subject to upstream terms of use.

---

## License

[MIT](./LICENSE)
