# Labeling campaign: “Does this frame show event X?”

**Product pain:** TPlus should not attach a still to a milestone alert when the image does not actually show that event (black frame, HUD card, wrong camera, fireball mush, prior/next phase).

**Label shape (yes — use this):** for each `(frame, eventId)` ask a binary question:

> Does this image show **[named event X]**?

Answer: **`yes` | `no` | `unsure`** (use `unsure` sparingly; prefer `no` if you would not post it).

That is clearer than scene taxonomy and maps 1:1 to a ship gate:  
`post_still = model_says_yes && confidence ≥ τ` (else omit image / use text-only alert).

Related: [CONTEST-REPORT.md](./CONTEST-REPORT.md) · [LABEL-CAMPAIGN-OVERRIDE.md](./LABEL-CAMPAIGN-OVERRIDE.md) (lag/override is a *later* campaign; this one is the submission spine).

---

## 1. Events to label first

Start with events where a bad still hurts most and the visual is teachable:

| Priority | `eventId` | “Yes” means (one line) |
|----------|-----------|-------------------------|
| 1 | `liftoff` | Vehicle leaving the pad / clear liftoff plume from ground view |
| 1 | `meco` | Engines cut / coast look on the relevant stage (not just a graphic) |
| 1 | `stage_sep` | Stages clearly parting or just parted |
| 2 | `landing_burn_booster` / `booster_landing` | Landing burn or landing visible |
| 2 | `seco` | Upper-stage cutoff / coast readable (harder — label fewer) |
| 3 | `max_q` | Only if the frame clearly reads as Max-Q era flight; skip if always ambiguous |

Skip an event for a flight if the window never has an honest “yes” (same rule as picks gold).

---

## 2. What to sample (per flight × event)

From `vision/frames/{eventId}_*.jpg` (already ~60/window):

| Bucket | How many | How to pick |
|--------|----------|-------------|
| **Positives** | 3–8 | Frames you would actually post (include your `picks.jsonl` winner as yes) |
| **Easy negatives** | 5–10 | Black, logo, pure HUD, replay card, wrong pad shot |
| **Hard negatives** | 5–10 | Plume-ish but wrong phase; blowout; vehicle too small; sep-looking vapor that isn’t |
| **Boundary** | 2–4 | “Almost” — if you hesitate to post → **`no`** |

**Target v0:** 2 flights × 4 events × ~15–25 labels ≈ **120–200 yes/no rows**. Enough for a contest baseline + a simple OpenCV/heuristic or tiny classifier threshold.

---

## 3. JSONL schema

`runs/<id>/vision/shows_event.jsonl` — one line per judgment:

```json
{
  "runId": "2026-09-20T01-17-04-falcon-9-block-5-starlink-group-15-27",
  "frame": "vision/frames/meco_0023.jpg",
  "eventId": "meco",
  "showsEvent": "yes",
  "tPlusSec": 162.5,
  "notes": "plume clearly gone; stack intact"
}
```

Rules:
- `showsEvent` ∈ `yes` | `no` | `unsure`
- Question is always about **`eventId`**, not “is this a nice photo”
- A great-looking coast frame is **`no`** for `liftoff`
- HUD that *says* MECO with no vehicle is **`no`**

Optional later fields (not required for v0): `confidence`, `lagSec`, `usableForOverride`.

---

## 4. Labeling session (30–45 min)

1. Open one flight’s frames for one `eventId` (gallery or file strip).
2. Keyboard mental model: **Y** / **N** / **U** (even if you’re writing JSONL by hand or a tiny HTML helper).
3. First pass: mark obvious yes + easy no.
4. Second pass: only hard cases; when unsure whether you’d post it → **`no`**.
5. Append JSONL; don’t rewrite taxonomy mid-flight.

Do Starlink `liftoff` + `meco` + `stage_sep` first; then Flight 14 same set.

---

## 5. Train / evaluate (minimum)

**Metric that matches the pain:**

| Metric | Meaning |
|--------|---------|
| **Precision @ yes** | Of frames we’d post, fraction that are true yes (false posts hurt users) |
| **Recall @ yes** | Of true yes frames, fraction we’d post (missing a still is OK; text alert still fires) |
| **Gate accuracy** | Prefer high precision; tune threshold to **minimize false posts** |

v0 scorer can stay OpenCV heuristics + threshold, or a tiny binary head later — same labels either way.

```text
eval_shows_event.py  # predicted showsEvent vs gold; report P/R for yes
```

Product rule for TPlus:

```text
if score(frame, eventId) < τ:  attach no image (or fallback stock)
else:                          attach frame
```

OCR/timeline still decide *when* to alert; this campaign only decides *whether the still is allowed*.

---

## 6. Contest narrative (one sentence)

> We label webcast frames with a single question — “Does this show liftoff / MECO / stage sep?” — so TPlus can withhold images that don’t depict the milestone, using OpenCV 5 features scored on AWS (S3 + EC2) against that gold.

---

## 7. Checklist

- [ ] Starlink: liftoff / meco / stage_sep yes-no sets
- [ ] Flight 14: same (skip event if no honest yes)
- [ ] Include existing `picks.jsonl` winners as `yes`
- [ ] ≥20 hard negatives (HUD / wrong phase)
- [ ] Note τ chosen for precision over recall
- [ ] (Optional) 20-screen GIF: bad still blocked vs good still posted
