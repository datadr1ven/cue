# Weak indicators & sensors (TPlus)

How TPlus should *notice* launch moments — today and next — without becoming a second webcast UI.

**Audience:** operators and eager collaborators.  
**Fan brief:** https://t-plus.pages.dev/sensors (high-level) · alert rules: [EVENT-RULES.md](./EVENT-RULES.md).  
**Code today:** `apps/tplus/src/webcast/` (OCR, ASR, listen, live).

---

## Idea

A launch alert should not depend on a single brittle detector.

**Schedule + OCR clock** stays the spine (when does the mission say this beat is due; what does the on-screen T+ say).  
Everything else is a **weak indicator**: evidence that can corroborate, contradict, or fill gaps — never a raw firehose into Telegram.

Think of a short chain of sensors looking at the same stream:

| Sensor | Role today | Direction |
|--------|------------|-----------|
| LL2 / mission script | Expected milestones + labels | Keep; improve mappings |
| OCR clock | Hold-aware T+ lock | Primary time base |
| ASR phrases | Weak corroboration / footnotes | Keep gated by script |
| HUD / scroller heuristics | Light on-screen text cues | Tighten or replace |
| **Video classification** | Scene / vehicle / pad / plume / landing | Add as weak votes |
| **Audio classification** | Crowd roar, callouts, engine character (not full ASR) | Add as weak votes |
| Future (telemetry mirrors, chat, etc.) | Extra votes | Only if they stay weak + attributable |

Fusion goal: **several weak yeses near a scripted beat** → confident emit; lone flashes → log only.

---

## Design principles

1. **Sensors emit evidence, not alerts.**  
   Shape roughly: `{ actionId?, tPlusSec?, wallMs, confidence, sensorId, notes?, artifacts? }`. The desk / fusion layer decides fan-out.

2. **Script still gates public noise.**  
   Same rule as today’s ASR: hearing “Max-Q” without a Max-Q row on the mission script should not spam subscribers. Sensors can still *suggest* for HITL / test mode.

3. **Clock ownership stays narrow.**  
   Prefer one authoritative clock (OCR + liftoff mark). Other sensors propose *what* happened, not competing T+0s, unless they explicitly offer a clock correction with low privilege.

4. **Fail soft.**  
   Missing model weights, GPU, or stream audio must not kill OCR emit. Sensors are optional processes or plugins.

5. **Attribution.**  
   Alerts may footnote “heard in audio” / “vision agree” — never pretend official telemetry.

6. **No Cue branding on product Pages**; contributor docs can live in-repo and be linked plainly.

---

## Collaborator path (sketch — not a frozen API)

We want people who care about launch AV to plug in **sensors**, not fork the whole fan-out stack.

### Likely contribution shapes

1. **Phrase / pattern packs** — ASR or HUD lexicons mapped to `LAUNCH_ACTIONS` ids (lowest friction; already close to `src/webcast/phrases`).
2. **Offline evaluators** — given a saved webcast + run archive, score precision/recall for a milestone (helps prove a sensor before live).
3. **Stream sensors** — long-running workers that read the same video/audio the desk uses and emit NDJSON evidence lines on stdout or a local socket.
4. **Model cards** — small ONNX/TFLite (or similar) classifiers with a one-page card: input (audio mel / frame crop), labels, latency budget, license.

### What we need before “send a PR”

- Stable **evidence record** schema (versioned).
- A **sensor registry** (id, modality, how to run, resource needs).
- Fusion policy documented per mode (`test` vs `ops`): thresholds, cooldowns, script gate.
- Clear **non-goals**: sensors must not ship provider credentials, scrape private feeds, or post directly to Telegram/CF.

Until that lands, open an issue or discussion with: modality, target `actionId`s, sample clips, and how you’d run it next to `webcast:live`.

---

## Near-term roadmap (honest)

| Step | Status |
|------|--------|
| OCR clock + script emit | Done (ops path) |
| ASR as weak footnote / gated assist | Done (v0) |
| Document fan rules + this sensor vision | In progress |
| Evidence schema + local NDJSON bus | TODO |
| First vision or audio-class sensor behind the bus | TODO |
| Public contributor guide with a real plugin example | TODO (after schema) |

---

## Related

- Webcast consumer overview: [`../src/webcast/README.md`](../src/webcast/README.md)
- Action catalog: `packages/cue/src/engine/domains/starship/actions.js`
- LL2 import: `apps/tplus/src/missions/ll2.js`
