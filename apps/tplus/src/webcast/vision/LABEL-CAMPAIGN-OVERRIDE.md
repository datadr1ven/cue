# Labeling campaign: CV as schedule-lag override signal

**Thesis (product):** Timeline + OCR stay *where we look*. Computer vision answers *did the physical thing happen?* — so if the script or clock is ~5–15s late/early, we can still emit (or hold) with evidence: engines went dark, stages parted, burn lit, etc.

**Not the thesis:** Replace the clock with CV.  
**Is the thesis:** CV is a **second channel** that can advance, delay, or footnote an alert when the webcast state disagrees with the plan.

**Priority events (this campaign):** `meco` (engines-out) and `stage_sep`.  
**Flights to start:** Starlink 15-27 (already framed) → Flight 14 where windows exist → one more Falcon if time.

Related: [CONTEST-REPORT.md](./CONTEST-REPORT.md) · [docs/VISION-ENRICHMENT.md](../../../docs/VISION-ENRICHMENT.md)

---

## 1. What we label (two layers)

Keep existing **scene tags** (`plume_on`, …) — they still help still selection.

Add an **event-evidence** layer aimed at override:

| Field | Meaning |
|-------|---------|
| `eventId` | `meco` or `stage_sep` (this campaign) |
| `state` | See vocabulary below |
| `transition` | `true` on the **first** frame in the window where the post-event state is clearly true |
| `confidence` | `high` \| `medium` \| `low` (human) |
| `usableForOverride` | `true` only if you’d trust this frame to argue “event has occurred” in a lag dispute |

### State vocabulary (MECO / engines-out)

| `state` | Intuition |
|---------|-----------|
| `engines_on` | Clear plume / thrust look on the relevant stage |
| `engines_out` | Coast look: plume gone or clearly dying; vehicle still readable |
| `ambiguous` | Can’t tell (angle, cloud, exposure, graphic) |
| `not_visible` | Wrong shot / HUD / black — no vehicle evidence |
| `hud_only` | Telemetry claims MECO but picture doesn’t show engines |

### State vocabulary (stage sep)

| `state` | Intuition |
|---------|-----------|
| `stacked` | Stages still one stack (or inseparable at this angle) |
| `separating` | Gap opening / vapor / relative motion — mid-event |
| `separated` | Two bodies clearly apart |
| `ambiguous` / `not_visible` / `hud_only` | As above |

**Override-positive frames:**  
- MECO: `engines_out` + `usableForOverride`  
- Sep: `separated` (or strong `separating`) + `usableForOverride`

Scene tags can coexist, e.g. `engines_out` + `plume_off` / `vehicle_air`.

---

## 2. Gold file format

New JSONL (one line per labeled frame), e.g.  
`runs/<id>/vision/evidence.jsonl`

```json
{
  "runId": "2026-09-20T01-17-04-falcon-9-block-5-starlink-group-15-27",
  "frame": "vision/frames/meco_0023.jpg",
  "eventId": "meco",
  "tPlusSec": 162.5,
  "state": "engines_out",
  "transition": true,
  "confidence": "high",
  "usableForOverride": true,
  "notes": "plume clearly gone vs 0022; stack still one piece"
}
```

Mark **exactly one** `transition: true` per `(runId, eventId)` when possible — the first honest post-event frame. If the window never shows it, omit transition and note `no_visual_transition` in a tiny sidecar or in notes on the last frame.

Keep `picks.jsonl` for “best alert still” — orthogonal and still useful for UX.

---

## 3. Campaign protocol (what you actually do)

### Phase A — Dense enough windows (if needed)

For `meco` and `stage_sep` only, prefer **±20–30s @ 2–4 fps** (or keep 60 frames but ensure the window brackets the real event, not only the late script time).

If script T+ is suspected late, extract with a **wider pre-roll** so early visual MECO/sep isn’t cropped out.

```bash
# example intent — adjust flags to match extract_windows.py
.venv-webcast/bin/python apps/tplus/src/webcast/vision/extract_windows.py \
  --run-dir "$RUN_DIR" --actions meco,stage_sep --download
```

### Phase B — Timeline pass (per flight, per event)

1. Open frames for `meco_*` in order (review gallery or file viewer).
2. Scrub until plume dies / stages part.
3. Label:
   - pre-event states (`engines_on` / `stacked`) on a few anchors,
   - **one** transition frame,
   - a few clear post-event frames (`engines_out` / `separated`),
   - mark junk as `not_visible` / `hud_only` (these teach “don’t override on graphics”).
4. Repeat for `stage_sep_*`.
5. Write `evidence.jsonl`.

**Time box:** ~20–30 min per event per flight once the UI is familiar.  
**Target volume:** 2 flights × 2 events × (~8–15 labeled frames) ≈ **40–60 evidence rows**, plus existing picks.

### Phase C — Lag stress labels (the compelling bit)

For each transition frame, record (in `notes` or fields):

| Extra field | How to fill |
|-------------|-------------|
| `scriptTPlusSec` | Scripted/OCR emit time for that action |
| `visualTPlusSec` | `tPlusSec` of the transition frame |
| `lagSec` | `scriptTPlusSec - visualTPlusSec` (positive ⇒ script/OCR late) |

Even **3–5 documented lag examples** (“visual MECO 8s before our emit”) make the demo narrative concrete.

### Phase D — Negative / trap set

Intentionally label:

- Bright HUD “MECO” cards with no vehicle → `hud_only`, `usableForOverride: false`
- Exposure blowouts that look like “engines out” but are just white → `ambiguous`
- Staging camera cuts that aren’t sep → `ambiguous` / `not_visible`

Override systems fail by **false positives**; the campaign must include traps.

---

## 4. What we measure (eval that matches the thesis)

Move beyond “is the pretty still in top-3?”

| Metric | Definition |
|--------|------------|
| **Transition hit** | Predicted first `engines_out` / `separated` within ±N frames of human transition |
| **Lead time** | `scriptTPlusSec - visualTPlusSec` when visual is early (how much lag we could absorb) |
| **Override precision** | Of frames model marks usableForOverride-positive, fraction that humans agree |
| **False override rate** | Model says event happened on `hud_only` / `not_visible` / pre-event frames |
| **Still quality** (secondary) | Existing `eval_picks` top-k |

v0 detector can stay OpenCV heuristics: **plume fraction drop** across the MECO window; **blob-split / dual bright bodies** for sep — scored as a time series, not a single-frame beauty rank.

---

## 5. Demo story (after this campaign)

Replace soft-enrichment close with:

1. Show script/OCR emit at T+X.  
2. Scrub frames: visual engines-out at T+X−8s.  
3. “CV marks `engines_out` here; we’d advance or footnote the alert.”  
4. Show a HUD trap we correctly refuse.  
5. Same batch still runs on EC2/S3 (cloud proof unchanged).

That’s more compelling than top-3 rates alone — and stays honest if precision isn’t perfect yet.

---

## 6. Schema / tool deltas (small)

1. Extend or sibling-schema: `evidence.schema.json` (states above).  
2. Review UI: either extend `label_assist` / `review.html` with event-state buttons, or a minimal `evidence_label.html` that only shows `meco_*` / `stage_sep_*` strips + keyboard: `O` engines_on, `X` engines_out, `T` mark transition, `H` hud_only, `N` not_visible.  
3. `eval_evidence.py`: transition hit + lag table + false override on traps.  
4. Update CONTEST-REPORT §1–2 thesis once we have ≥1 flight fully evidence-labeled.

Don’t block labeling on the perfect UI — a spreadsheet or JSONL-from-review is fine for flight one.

---

## 7. Execution checklist

- [ ] Confirm Starlink `meco` / `stage_sep` windows bracket the real visual events (widen if needed)
- [ ] Label Starlink MECO evidence strip + lagSec vs script
- [ ] Label Starlink stage_sep evidence strip + lagSec
- [ ] Add ≥5 trap frames (HUD / ambiguous)
- [ ] Repeat on Flight 14 (or next Falcon) for MECO; sep if footage supports it
- [ ] Snapshot 2–3 lag examples for the demo video
- [ ] (Optional) Heuristic time-series detector + `eval_evidence.py`
- [ ] Retarget demo shot list §2 and §7 to override narrative

---

## 8. What we are not doing in this campaign

- Full agentic autonomy / firing without human-visible evidence  
- Claiming CV beats OCR on liftoff TOD in general  
- Relabeling every scene tag on every flight before override gold exists  
- Waiting on Graviton / advanced org features
