# TPlus Vision Enrichment — Technical Report

**OpenCV AI Competition 2026 (powered by AWS)**  
**Project:** TPlus webcast vision enrichment  
**Stack:** OpenCV 5.0.0 · Amazon S3 · Amazon EC2 · Python 3.11  
**Report date:** 2026-10-26  
**Code:** `apps/tplus/src/webcast/vision/` in the Cue / TPlus monorepo  

---

## 1. Problem

Launch webcasts are long, noisy, and full of graphics. TPlus already watches those streams, reads the mission clock with OCR, and fires milestone alerts (liftoff, Max-Q, MECO, SECO, landing burn, …) to people who cannot sit through the whole broadcast.

The weak link is the **still image** attached to each alert. Emit-time grabs are often:

- black or underexposed,
- washed-out fireball blowouts,
- HUD / replay cards with no useful photo of the vehicle.

**Problem statement:** given frames around a milestone, answer a binary question — **does this image show event X?** — so TPlus can **withhold stills that do not depict the event** (HUD cards, black frames, wrong phase). Timeline + OCR still decide *when* to alert; vision decides *whether a still is allowed to post*.

## 2. Users and intended impact

| Who | What they get |
|-----|----------------|
| Friends / operators following a launch on Telegram / web | Alerts with a still worth glancing at |
| TPlus maintainers | Offline gold + eval so enrichment can improve without guessing |
| Contest judges / CV practitioners | A small, reproducible OpenCV 5 + AWS batch path on real webcast data |

Impact is deliberately narrow and product-shaped: **do not attach an image when the frame does not show the named milestone**. Alerts can still fire as text. This is a precision-first gate (`shows_event`), not autonomous launch detection.

## 3. Architecture

```
Webcast / X replay
        │
        ▼
 extract_windows.py          yt-dlp -g + ffmpeg  (±window @ N fps)
        │                    → runs/<id>/vision/frames/*.jpg
        ▼
 Human gold (optional)
   pick_best.py / review UI  → picks.jsonl  (preferred)
   label_assist.py           → labels.jsonl (scene tags)
        │
        ├──────────────────────┐
        ▼                      ▼
 score_frame.py           Amazon S3
 (OpenCV 5 heuristics)    s3://…/tplus-vision/runs/<id>/vision/
        ▲                      │
        │                      ▼
 batch_score.py  ◄──── EC2 host (same code as laptop)
        │
        ▼
 scores.jsonl + scores.summary.json
        │
        ▼
 eval_picks.py               top-k vs human picks
```

**Design rules:**

1. **Same scorer everywhere** — `batch_score.py` / `score_frame.py` on laptop or EC2; AWS is storage + batch host, not a cloud-only black box.
2. **Windows, not full VOD** — stream URL via `yt-dlp -g`, ffmpeg only the milestone neighborhoods (keeps packs small enough for Free Tier S3).
3. **Product-shaped gold** — `picks.jsonl` (“best still for this alert”) over scene taxonomy essays.
4. **Vision is soft** — OCR + event rules remain primary for emit timing.

## 4. OpenCV 5 implementation

Dependency: `opencv-python-headless>=5,<6` (verified **5.0.0** on the contest EC2 run).

`score_frame.py` is an explicit **heuristic baseline** (replaceable by a DNN later). Per frame it:

1. Loads BGR, downscales to width 320 for speed.
2. Builds HSV / gray / Canny features.
3. Estimates:
   - warm / plume fractions (strict + loose ranges),
   - center-crop warm (alert composition),
   - lower-half warm (landing-burn bias),
   - Laplacian sharpness,
   - mid-contrast “structure sweet spot” (coast / readable vehicle),
   - upper-band edge density (HUD / tickers),
   - low-value (dark, flat, blowout).
4. Emits a soft **primary label** among  
   `plume_on | plume_off | pad_or_tower | vehicle_air | landing_burn | hud_heavy | low_value`.
5. Emits an **enrichment `rank` ∈ [0,1]** used to pick alert stills:

   - Rewards sweet-spot plume (not full-frame fireball), sharpness, mid contrast, light label prior.
   - Adds a **coast term** (`structure_sweet * coast`) so low-plume / SECO frames can still win as readable stills.
   - Penalizes HUD-heavy and low-value frames.

`batch_score.py` walks `vision/frames/`, calls `_score`, writes JSONL + a summary that records **OpenCV version, host, machine arch, ms/frame**.

Supporting tools:

| Script | Role |
|--------|------|
| `extract_windows.py` | Dense frames around milestone emits |
| `pick_best.py` | Human “best still” gallery → `picks.jsonl` |
| `label_assist.py` | Stratified scene-label review |
| `eval_picks.py` | Top-1 / top-3 / top-10 vs gold picks |
| `aws/sync_to_s3.sh` | Upload/download vision packs |
| `aws/run_batch_on_host.sh` | Thin wrapper around `batch_score.py` |

## 5. AWS deployment

### Services used

| Service | Role |
|---------|------|
| **Amazon S3** | Durable store for frames, gold picks, and score artifacts |
| **Amazon EC2** | Batch OpenCV host (`t3.micro`, Amazon Linux 2023, `us-east-2`) |
| **AWS CLI + EC2 Instance Connect** | Operator path from a desktop bastion (no long-lived instance SSH key required for the contest run) |

### Object layout

```
s3://tplus-vision-scenicmind/tplus-vision/
  runs/<runId>/vision/
    frames/*.jpg
    picks.jsonl              # human gold (optional)
    scores.jsonl             # batch output
    scores.summary.json      # opencv / host / timing
```

### Contest batch (executed 2026-10-12)

1. Uploaded Starlink Group 15-27 and Starship Flight 14 vision packs to S3.
2. Launched **`t3.micro`** in **`us-east-2`** (Free Tier–eligible path available under the account’s managed org constraints; Graviton `t4g.*` remained blocked by org SCP during this build — see Limitations).
3. Installed Python 3.11 + `opencv-python-headless==5.0.0`.
4. Synced code + frames to the instance; ran `batch_score.py` for both runs.
5. Wrote scores back to S3 and local run archives.
6. **Terminated** the instance immediately after (no idle spend).

### Measured EC2 batch results

| Run | Frames | Scored | Failed | OpenCV | Elapsed | ms/frame | Arch |
|-----|--------|--------|--------|--------|---------|----------|------|
| Falcon 9 Starlink Group 15-27 | 420 | 420 | 0 | 5.0.0 | 3.93 s | 9.4 | x86_64 |
| Starship Flight 14 | 420 | 420 | 0 | 5.0.0 | 4.39 s | 10.5 | x86_64 |

Summaries include `host`, `platform`, `machine`, and `opencv` so a judge can verify the cloud path without trusting a screenshot.

**Reproducibility (operator):**

```bash
export TPLUS_VISION_BUCKET=tplus-vision-scenicmind
export AWS_REGION=us-east-2
./apps/tplus/src/webcast/vision/aws/sync_to_s3.sh "$RUN_DIR"
# on EC2 with the same vision/ tree:
python batch_score.py --run-dir "$RUN_DIR"
aws s3 cp "$RUN_DIR/vision/scores.jsonl" \
  "s3://$TPLUS_VISION_BUCKET/tplus-vision/runs/$RUN/vision/"
aws s3 cp "$RUN_DIR/vision/scores.summary.json" \
  "s3://$TPLUS_VISION_BUCKET/tplus-vision/runs/$RUN/vision/"
```

## 6. Evaluation

### Gold

Human **best-still** picks (skip event if no honest frame):

| Flight | Picks |
|--------|-------|
| Starlink Group 15-27 | 7 (liftoff, max_q, meco, seco, stage_sep, landing_burn_booster, booster_landing) |
| Starship Flight 14 | 5 (liftoff, max_q, meco, seco, booster_landing); skipped landing_burn_booster & stage_sep (no usable still) |

### Metric

`eval_picks.py`: for each gold pick, rank all frames in that action window by enrichment `rank`; report whether the human pick is in top-1 / top-3 / top-10.

### Results (after sweet-spot + coast rank tuning)

| Flight | n | top1Rate | top3Rate | top10Rate |
|--------|---|----------|----------|-----------|
| Starlink 15-27 | 7 | 0.00 | 0.14 | 0.29 |
| Flight 14 | 5 | 0.00 | 0.20 | 0.20 |

**Reading:** the baseline is **demoable and honest, not production-ready**. Liftoff / plume-on windows are closer; coast and landing windows still lose to competing bright or busy frames. The AWS path is proven; the CV quality is the open workstream.

### What improved during the build

Early rank maximized raw plume and chased fireballs. Tuning toward:

- center warm **sweet spot**,
- mid-contrast coast term,
- HUD / blowout penalties,

moved Starlink top-3 from 0/7 → 1/7 on the same gold. Further gains likely need either (a) more gold + supervised ranking, or (b) a small OpenCV DNN / embedding re-ranker — still runnable with the same S3 ↔ EC2 loop.


## 6b. Shows-event gold (post / don’t-post)

Label question: **Does this image show [named event X]?** → `yes` | `no` | `unsure`.

Gold: `shows_event.jsonl` (per run + `tplus-webcast/vision-gold/shows_event.jsonl`). Human best-still picks are `yes`; HUD / low-value / early-window / wrong-phase frames are `no`. See [`LABEL-CAMPAIGN-SHOWS-EVENT.md`](./LABEL-CAMPAIGN-SHOWS-EVENT.md) and [`DEVPOST-SUBMISSION.md`](./DEVPOST-SUBMISSION.md).

**Product rule:** if the scorer does not confidently say `yes` for that `eventId`, TPlus attaches **no image**. Optimize **precision on yes**.

## 7. Limitations

1. **Heuristic scorer** — no trained model yet; labels and ranks are feature recipes.
2. **Low top-k rates** — enrichment is not ready to gate alerts.
3. **Graviton path deferred** — account sits in AWS’s managed “new experience” org; SCPs blocked `t4g` / some `RunInstances` shapes. Contest compute used **`t3.micro` x86_64** instead. Same OpenCV code; COOL / Arm award not claimed.
4. **Webcast rights** — frames are derived from public launch webcasts / replays for personal alert tooling and contest evaluation; redistribution of raw frame packs should follow source license / ToS.
5. **Single-region, short-lived EC2** — intentional for cost; not a multi-AZ service.
6. **t3.micro memory** — fine for 320px heuristics (~87 MB RSS); larger models will need a bigger instance class.

## 8. Responsible use

- Vision **does not** decide whether a launch alert fires in v0; schedule + OCR clock do.
- Gold labeling skips events with no clear still rather than forcing a pick.
- Instances are **terminated** after batch; S3 holds only contest/run packs.
- No biometric surveillance, no continuous public camera network — domain is **public spaceflight webcast stills** for sparse human alerts.
- Do not overclaim: report rates as measured; treat ranks as ranking features, not calibrated probabilities.

## 9. What we would ship next

1. Grow gold to ~5 flights; add pairwise prefs where top-k is ambiguous.
2. Keep OpenCV 5 as the decode / feature front-end; add a tiny learned re-ranker trained only on picks.
3. When org policy allows, re-run the **identical** `batch_score.py` on **Graviton** and attach Arm timing to the summary (COOL narrative without rewriting the app).
4. Wire top-ranked still into TPlus feed / Telegram as optional enrichment once top-3 clears a chosen bar on held-out gold.

## 10. Submission checklist (Devpost)

| Requirement | Status |
|-------------|--------|
| Substantive OpenCV 5 image analysis | Yes — `score_frame.py` / `batch_score.py` on real frames |
| Meaningful AWS component | Yes — S3 packs + EC2 batch + scores back to S3 |
| Technical report | This document |
| Code archive / repo for judges | Cue `apps/tplus/src/webcast/vision/` (+ run summaries) |
| Demo video | TBD before 2026-10-26 |
| COOL / Graviton special award | Not claimed (x86 EC2 this round) |
| Agentic Vision special award | Not claimed (no agent loop yet) |

---

### One-line summary

**TPlus Vision Enrichment** uses **OpenCV 5** to decide whether a webcast frame **shows a named milestone** so alerts don’t post misleading stills — with **Amazon S3** packs and **Amazon EC2** batch scoring (OpenCV 5.0.0), same code path locally and in the cloud.
