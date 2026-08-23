# Local OpenF1 → Cue (race-day experiment)

Run OpenF1’s SignalR ingest on your machine and publish `v1/*` to a local Mosquitto broker. Point Cue at that broker instead of `mqtt.openf1.org`.

```
F1 livetiming (SignalR)
        │
        ▼
OpenF1 ingest-realtime   (subscribes via get_topics(), incl. PitStop*)
        │
        ├─► MongoDB
        └─► MQTT  v1/race_control, v1/position, v1/pit, …
                    │
                    ▼
              Cue worker (MQTT_SOURCE=local)
```

## One-time setup

```bash
cd openf1-local
./clone-openf1.sh
cp .env.example .env
# edit .env — set F1_TOKEN=… (F1TV subscription JWT)
```

Default MQTT user/password is **`openf1` / `openf1`** (same as upstream OpenF1 compose). Change both `mqtt-config/mosquitto.passwd` and `.env` if you expose the broker.

## Start the stack

```bash
# Infra + API
docker compose up -d --build mongo mqtt api

# Live ingest (logs in foreground recommended the first time)
docker compose up --build ingest-realtime
```

Check:

```bash
# API up?
curl -s 'http://localhost:8000/v1/sessions?limit=1' | head

# MQTT traffic (optional)
docker compose exec mqtt mosquitto_sub -h localhost -u openf1 -P openf1 -t 'v1/#' -v
```

Optional season backfill (slow, not needed for a live Cue test):

```bash
docker compose --profile backfill up ingest-historical
```

## Point Cue at local MQTT

From the **Cue repo root** (with this stack’s broker on `:1883`):

```bash
MQTT_SOURCE=local \
  MQTT_LOCAL_HOST=localhost \
  MQTT_LOCAL_PORT=1883 \
  MQTT_LOCAL_USERNAME=openf1 \
  MQTT_LOCAL_PASSWORD=openf1 \
  DELIVERY_MODE=log \
  ENGINE_SESSION_KIND=race \
  npm run worker
```

For Telegram/HTTP like race day, swap `DELIVERY_MODE` / deliver URL as usual — keep **`ALERT_TAG`** set (e.g. `LOCAL`) so you don’t confuse it with the paid feed.

**Safety net:** leave a second worker on `MQTT_SOURCE=live` (paid OpenF1) in another terminal/chat while you evaluate.

## Session timing tips

- Start **`ingest-realtime` ≥15–60 min before** the session (OpenF1’s own guidance: ~1h before races, ~15 min before practice/quali).
- `F1_TOKEN` must be set in `.env` for auth; without it ingest still runs but streams may be thin.
- Tokens expire — refresh before the weekend (`python -m fastf1 auth …` or your browser grab).

## Tear down

```bash
docker compose down          # keep mongo volume
docker compose down -v       # wipe DB + mqtt state
```

## What this does *not* do

- Replace Cue’s detectors / Telegram delivery
- Give you OpenF1’s hosted HA — you own reconnects and race-day ops
- Automatically sync historical gold; use Cue `npm run download -- <session_key>` or the `backfill` profile

## Files

| Path | Role |
|------|------|
| `docker-compose.yml` | mongo, mosquitto, api, ingest-realtime |
| `mqtt-config/` | Mosquitto listener + passwd |
| `openf1/` | Clone of [br-g/openf1](https://github.com/br-g/openf1) (gitignored build context) |
| `.env` | `F1_TOKEN` + MQTT creds (not committed) |
