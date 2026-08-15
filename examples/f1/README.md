# F1 example captures

Synthetic OpenF1-shaped NDJSON for offline / local-MQTT practice.  
Not full race dumps (those stay out of git — use your own captures for regression).

| File | Purpose | Alerts @ `ENGINE_MIN_SEVERITY=6` |
|------|---------|----------------------------------|
| [`smoke-two-alerts.ndjson`](./smoke-two-alerts.ndjson) | Tiny end-to-end check | **2** (`session.started`, `flag.safety_car`) |

## Replay to stdout (no Telegram)

```bash
npm run replay -- examples/f1/smoke-two-alerts.ndjson
```

## Local MQTT → log

```bash
# Terminal A: mosquitto (or other broker on localhost:1883)
# Terminal B:
npm run worker:local:log
# Terminal C:
npm run publish -- examples/f1/smoke-two-alerts.ndjson
```

## Local MQTT → GridWhisper Telegram (CF `/deliver`)

```bash
# Terminal B:
MQTT_SOURCE=local DELIVERY_MODE=http \
  DELIVER_URL=https://gridwhisper.scenicminddigital.workers.dev/deliver \
  DELIVER_SECRET=… \
  npm run worker

# Terminal C:
npm run publish -- examples/f1/smoke-two-alerts.ndjson
```

Expect **two** Telegram messages if you are subscribed (`/start` on the bot).
