# GridWhisper

F1 sparse alerts built on **Cue**.

- **Race day (laptop):** OpenF1 MQTT → Cue `f1` pipeline → log / Telegram / `POST /deliver`  
- **Always-on (Cloudflare):** enroll (`/start`/`/stop`) + fan-out from `/deliver`

## Quick commands (from monorepo root)

```bash
npm run replay -- packages/cue/examples/f1/smoke-two-alerts.ndjson
npm run worker:live:http
npm run smoke:gridwhisper
npm run cf:deploy:gridwhisper
```

Or from this package:

```bash
npm run worker:local:log
npm run smoke
npm run cf:deploy
```

## Docs

- [Cloudflare enroll + deliver](./docs/cloudflare.md)  
- [F1 moment policy](./docs/f1/POLICY.md) — why filters exist  
- [Capture inventory](./docs/f1/CAPTURES.md) — external NDJSON pointers  

## Layout

```text
apps/gridwhisper/
  bin/          worker, capture, download, publish, bot, smokes
  src/          mqtt-worker, topics, commands
  worker/       CF Worker entry
  docs/
  wrangler.toml
```

Core engine: `packages/cue` (dependency `cue`).
