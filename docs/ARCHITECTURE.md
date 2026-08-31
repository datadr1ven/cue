# Cue architecture

## Pipeline

```text
normalize → reduce snapshot → detect moments → gate → render → deliver
```

| Layer | Responsibility |
|--------|----------------|
| **Ingest** | Map external records into `{ type, t, payload }` |
| **Domain** | State reduction + moment detection + templates |
| **Gate** | Severity floor, dedupe, cooldowns |
| **Deliver** | App-specific: log, Telegram, HTTP to CF Worker |

Core implementation: [`packages/cue`](../packages/cue/).

## Monorepo layout

| Path | Role |
|------|------|
| `packages/cue` | Publishable-ish core: engine, domains (`f1`, `starship`), shared Node helpers (`config`, `delivery`, `users`, `telegram-inbox`), `cue-replay` |
| `apps/gridwhisper` | F1 product: MQTT worker, captures, CF enroll + `/deliver` |
| `apps/tplus` | Launch product: missions, webcast OCR/ASR, CF enroll + `/suggest` |

## Adding a domain (without GridWhisper or TPlus)

1. Copy or depend on `packages/cue` only.  
2. Add `packages/cue/src/engine/domains/<name>/` with `createState`, `reduce`, `detectMoments`, `renderMoment`.  
3. Register in `pipeline.js`.  
4. Drive it with NDJSON ingest + `npm run replay`, or your own source adapter that emits Cue events.  

You do **not** need `apps/gridwhisper` or `apps/tplus` to ship a new product.

## Product boundaries

- **Detection packs** for launches (`starship` domain) stay in core so other apps can reuse them.  
- **Mission timeline JSON**, webcast laptop tooling, and Telegram CF surfaces stay in `apps/tplus`.  
- **OpenF1 MQTT** and F1 CF enroll stay in `apps/gridwhisper`.  
- F1 filtering *rationale*: [`apps/gridwhisper/docs/f1/POLICY.md`](../apps/gridwhisper/docs/f1/POLICY.md).
