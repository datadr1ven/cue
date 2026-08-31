# Cue

**Sparse real-time alerts from timed event streams.**

Cue turns a firehose of structured events into a small set of high-severity **moments**, then renders short template messages for log or Telegram delivery.

```text
normalize → reduce snapshot → detect moments → gate → render → deliver
```

**License:** MIT · **Author:** [datadr1ven](https://github.com/datadr1ven)

This repository is an **npm workspaces** monorepo:

| Package / app | Path | What it is |
|---------------|------|------------|
| **cue** (core) | [`packages/cue`](./packages/cue/) | Pipeline, gate, domains (`f1`, `starship`), offline replay |
| **GridWhisper** | [`apps/gridwhisper`](./apps/gridwhisper/) | F1 product — OpenF1 MQTT + CF enroll/`/deliver` |
| **TPlus** | [`apps/tplus`](./apps/tplus/) | Launch product — missions, webcast:live, CF enroll/`/suggest` |

Architecture notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Build a variant without GridWhisper or TPlus

```bash
git clone https://github.com/datadr1ven/cue.git
cd cue && npm install
cd packages/cue
npm run replay -- examples/f1/smoke-two-alerts.ndjson
```

Use only `packages/cue`: add a domain pack, wire your own source + delivery. See [`packages/cue/README.md`](./packages/cue/README.md). You can ignore `apps/*` entirely.

---

## Install (full monorepo)

```bash
git clone https://github.com/datadr1ven/cue.git
cd cue
cp .env.example .env
npm install
```

Root scripts delegate into workspaces (`npm run replay`, `npm run worker:live:http`, `npm run webcast:live`, …).

---

## GridWhisper (F1)

MQTT (laptop) → Cue `f1` domain → log / Telegram / `POST` Cloudflare `/deliver`.

```bash
npm run replay -- packages/cue/examples/f1/smoke-two-alerts.ndjson
npm run worker:local:log
npm run smoke:gridwhisper
npm run cf:deploy:gridwhisper
```

- App docs: [`apps/gridwhisper/README.md`](./apps/gridwhisper/README.md)  
- CF: [`apps/gridwhisper/docs/cloudflare.md`](./apps/gridwhisper/docs/cloudflare.md)  
- Filtering policy (why alerts exist): [`apps/gridwhisper/docs/f1/POLICY.md`](./apps/gridwhisper/docs/f1/POLICY.md)

User Telegram commands: `/start` · `/stop` · `/status` · `/help` (+ admin `/note` · `/broadcast` · `/inbox` · `/reply`).

---

## TPlus (launches)

Mission timelines in git → Cue `starship` domain → Telegram. Live path: laptop **`webcast:live`** (OCR clock + optional ASR) posts milestones to CF **`/suggest`**.

| Mode | Audience |
|------|----------|
| `--mode test` (default) | Admins only (`🧪 TEST`) |
| `--mode ops` | All subscribers |

```bash
npm run validate:missions
npm run smoke:tplus
npm run webcast:live -- --url 'https://x.com/i/broadcasts/…' --mission starlink-sl-15-23 --mode test
npm run cf:deploy:tplus
```

- App docs: [`apps/tplus/README.md`](./apps/tplus/README.md)  
- CF: [`apps/tplus/docs/cloudflare.md`](./apps/tplus/docs/cloudflare.md)  
- Webcast: [`apps/tplus/src/webcast/README.md`](./apps/tplus/src/webcast/README.md)

User Telegram commands (GW parity): `/start` · `/stop` · `/help` · `/status` · `/missions` · `/mission` · `/eta`.  
Ops inject via webcast/`/suggest` (no public `/ops` menu).

---

## Configuration

See [`.env.example`](./.env.example). Important variables:

| Variable | Description |
|----------|-------------|
| `MQTT_SOURCE` | `live` \| `local` (GridWhisper worker) |
| `DELIVERY_MODE` | `telegram` \| `log` \| `http` \| `none` |
| `TELEGRAM_TOKEN` / `TELEGRAM_ADMIN_IDS` | Bot + admins |
| `OPENF1_USERNAME` / `OPENF1_PASSWORD` | Live OpenF1 MQTT |
| `ENGINE_MIN_SEVERITY` | Gate floor (default `6`) |
| `DELIVER_URL` / `DELIVER_SECRET` | GridWhisper CF `/deliver` |
| `TPLUS_SUGGEST_URL` / `TPLUS_SUGGEST_SECRET` | TPlus CF `/suggest` |

---

## Disclaimer

Cue is an independent project. It is not affiliated with Formula 1 companies, OpenF1, SpaceX, or other upstream data providers.

## License

[MIT](./LICENSE)
