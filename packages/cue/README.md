# cue (core)

Sparse real-time alerts from timed event streams.

```text
normalize → reduce → detect → gate → render → deliver
```

This package is the **engine**. GridWhisper and TPlus are optional apps in the same monorepo; you can build a different product using only this package.

## Install (from monorepo)

```bash
# from repo root
npm install
cd packages/cue
npm run replay -- examples/f1/smoke-two-alerts.ndjson
```

You do **not** need to run or configure `apps/gridwhisper` or `apps/tplus`.

## Domains included

| Domain | Inputs | Notes |
|--------|--------|-------|
| `f1` | OpenF1-shaped MQTT / NDJSON | Reference feed-driven pack |
| `starship` | Manual / scripted inject | Reference operator-driven pack |

## Extension sketch

```js
import { createPipeline } from "cue/engine/pipeline.js";
import { readNdjsonEvents } from "cue/engine/ingest/ndjson.js";

const pipeline = createPipeline({
  domain: "f1",
  minSeverity: 6,
  useLlm: false,
  usePrefs: false,
});

for await (const ev of readNdjsonEvents("capture.ndjson")) {
  const { alerts } = pipeline.push(ev);
  for (const a of alerts) console.log(a.text);
}
```

New domain: implement `createState` / `reduce` / `detectMoments` / `renderMoment`, register in `src/engine/pipeline.js`. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md).

## Shared helpers

Also exported for apps (Node / Workers as applicable):

- `cue/log.js` — wall-clock ops logs  
- `cue/config.js` · `cue/users.js` · `cue/delivery.js` — local Telegram/file helpers  
- `cue/telegram-inbox.js` — KV-friendly inbox digest helpers  

## License

MIT
