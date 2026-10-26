# Devpost paste pack — TPlus Vision Enrichment

**Contest:** OpenCV AI Competition 2026 (AWS) — https://opencv26.devpost.com/  
**Your job:** create/open the project, paste these fields, upload the zip (+ optional video), hit Submit. (~10–15 min)

Deadline: **2026-10-26 11:59pm Pacific**.

---

## Project name

TPlus Vision Enrichment

## Tagline

Don’t post the still if it doesn’t show the launch event — OpenCV 5 + AWS for TPlus alerts.

## Built with

OpenCV 5, Python, Amazon S3, Amazon EC2, ffmpeg, yt-dlp, Cloudflare Workers (TPlus)

---

## Short description

TPlus already alerts friends on launch milestones using the webcast clock (OCR) and mission timeline. The painful failure mode is attaching a still that does **not** show the event — black frames, HUD cards, wrong phase, fireball mush.

We treat still selection as a binary vision question: **“Does this image show [liftoff / MECO / stage sep / …]?”** OpenCV 5 scores frames in milestone windows; if the answer isn’t a confident yes, the alert stays text-only. Frames and scores sync through **Amazon S3**; the same `batch_score.py` ran on **EC2** with OpenCV **5.0.0** (420 frames in ~4s per flight), then the instance was terminated.

---

## Full description

### Problem

Launch webcasts are long and full of graphics. Sparse alerts need a trustworthy thumbnail. A wrong still is worse than no still.

### Approach

1. Extract short ffmpeg windows around each milestone (not the full VOD).
2. Label frames with a single question: does this show event X? (yes/no).
3. Score with OpenCV 5 heuristics (HSV plume, sharpness, mid-contrast, HUD penalties) — same code locally and on EC2.
4. Gate: only attach a still when the model says yes for that event. Timeline + OCR remain authoritative for *when* to alert.

### AWS

- **S3** bucket `tplus-vision-scenicmind` (us-east-2) for frames / picks / scores
- **EC2** `t3.micro` batch host, OpenCV 5.0.0, terminate-after
- Summaries record `opencv`, `host`, `machine`, timing for reproducibility

### Evaluation (honest)

### Shows-event gate (baseline heuristic)

On 96 yes/no labels (2 flights), OpenCV rank threshold:

| tau | precision(yes) | recall(yes) |
|-----|----------------|-------------|
| 0.50 | 0.50 | 0.38 |
| 0.80 | **1.00** | 0.15 |

Product chooses high tau: **never post a false still** even if many alerts stay text-only.


Human best-still gold and shows-event yes/no sets on Falcon 9 Starlink and Starship Flight 14. Ranking top-k is still weak (~14–20% top-3); the product bet is **precision on “shows event”** — refuse bad posts first. We’re not claiming solved detection.

### What’s in the submission zip

`vision/` — extract helpers, label campaigns, `score_frame.py`, `batch_score.py`, AWS sync helpers, `CONTEST-REPORT.md`, sample `shows_event.jsonl` and EC2 `scores.summary.json` (no full webcast frame dumps).

### Responsible use

Public webcast stills for personal sparse alerts; vision does not fire alerts alone in v0; instances terminated after batch; no biometric / city-camera surveillance.

---

## Submit checklist (you — the 1%)

- [ ] Log into https://opencv26.devpost.com/ and create/open the project
- [ ] Paste name, tagline, short + full description from this file
- [ ] Upload `tplus-vision-opencv-submission.zip`
- [ ] Optional: upload a short demo video if you have one
- [ ] Confirm OpenCV 5 + AWS are mentioned
- [ ] **Submit** before 2026-10-26 11:59pm PT
