# F1 example captures

Synthetic OpenF1-shaped NDJSON for offline / local-MQTT practice.  
Not full race dumps (those stay out of git — use your own captures for regression).

| File | Purpose | Alerts @ `ENGINE_MIN_SEVERITY=6` |
|------|---------|----------------------------------|
| [`smoke-two-alerts.ndjson`](./smoke-two-alerts.ndjson) | Tiny end-to-end check | **2** (`session.started`, `flag.safety_car`) |

## Replay to stdout (no Telegram)

```bash
npm run replay -- packages/cue/examples/f1/smoke-two-alerts.ndjson
# or: cd packages/cue && npm run replay -- examples/f1/smoke-two-alerts.ndjson
```

### Full qualifying capture (sparse quali mode)

Captures are **not** in this repo. Useful local trees:

| Location | Examples |
|----------|----------|
| `~/testdata/` | `aus-qual.ndjson`, `cn-qual.ndjson`, `jp-day-2.ndjson`, `cn-fp1-and-sprintqual.ndjson` |
| GridWhisper `latest-artifacts/` | `hungary-qual.ndjson`, `aus-qual.ndjson` |

Force quali kind so Q1 is not treated like a race:

```bash
ENGINE_SESSION_KIND=qualifying npm run replay -- \
  ~/testdata/cn-qual.ndjson

# Clean-ish sessions land ~20–35 alerts: segment starts, session bests, cuts, pole, red/stewards
# Combined days (fp3+qual) a bit higher. Not 100+ position thrash lines.
```

| File (testdata) | ~alerts @ sev 6 + forced quali | Notes |
|-----------------|----------------------------------|--------|
| `cn-qual.ndjson` | ~22 | Clean single quali — good first dual-watch |
| `jp-day-2.ndjson` | ~30 | Practice+qual day; still sparse |
| `aus-qual.ndjson` | ~33 | Red flags → extra segment_start |
| `cn-fp1-and-sprintqual.ndjson` | ~35 | FP1 + sprint quali |
| `aus-fp3-qual.ndjson` | ~49 | FP3+qual mashed; more reds/segments |

### Session kinds (`ENGINE_SESSION_KIND`)

| Kind | Volume | What you get |
|------|--------|----------------|
| `practice` (alias `fp`) | **Very low** | Start / resume, red/VSC, finished recap (fastest · compounds · most stops) |
| `qualifying` (`quali`) | Medium | Q1–Q3 starts, fastest laps, cuts (who’s **out**), pole |
| `sprint_qualifying` (`shootout`, `sq`) | Medium | Same as quali with **SQ1–SQ3** + sprint pole |
| `sprint` | Race-like | Leader changes, pits, SC, finish |
| `race` | Race-like | Same as today for the GP |
| *(unset)* | Auto | Heuristics; **force `practice` for FP** — auto is imperfect mid-session |

```bash
ENGINE_SESSION_KIND=practice npm run replay -- ~/testdata/aus-fp3.ndjson
# ~7 alerts vs ~90 if mis-tagged as race

ENGINE_SESSION_KIND=sprint_qualifying npm run replay -- ~/testdata/cn-fp1-and-sprintqual.ndjson
```

Race / full quali captures: leave unset or set explicitly (`race` / `qualifying`).

## Local MQTT → log

```bash
# Terminal A: mosquitto (or other broker on localhost:1883)
# Terminal B:
npm run worker:local:log
# Terminal C:
npm run publish -- packages/cue/examples/f1/smoke-two-alerts.ndjson
```

## Local MQTT → GridWhisper Telegram (CF `/deliver`)

```bash
# Terminal B:
MQTT_SOURCE=local DELIVERY_MODE=http \
  DELIVER_URL=https://gridwhisper.scenicminddigital.workers.dev/deliver \
  DELIVER_SECRET=… \
  npm run worker

# Terminal C:
npm run publish -- packages/cue/examples/f1/smoke-two-alerts.ndjson
```

Expect **two** Telegram messages if you are subscribed (`/start` on the bot).
