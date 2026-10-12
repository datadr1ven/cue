# Webcast vision scaffold

Offline OpenCV helpers for **frame enrichment** around TPlus milestones.

See [`docs/VISION-ENRICHMENT.md`](../../../docs/VISION-ENRICHMENT.md) for the plan and contest notes.

## Layout

```
vision/
  README.md
  extract_windows.py   # dense frames around milestone emits (yt-dlp -g / ffmpeg)
  label_assist.py      # stratified sample + review.html for gold labels
  pick_best.py         # per-milestone "best alert still" picker (preferred gold)
  batch_score.py       # OpenCV 5 batch scorer (local or Graviton)
  eval_picks.py        # top-k vs human picks.jsonl
  labels.schema.json   # gold JSONL schema
  score_frame.py       # OpenCV baseline scorer (heuristics)
  eval_enrich.py       # rank frames in an emit window
  aws/                 # S3 sync + host batch wrappers (contest AWS slice)
  requirements.txt     # opencv-python-headless>=5
  samples/             # optional tiny fixtures (not full flights)
```

## Quick local try

```bash
# from cue repo root — prefer the webcast venv (has yt-dlp + OpenCV on the desk)
.venv-webcast/bin/pip install -r apps/tplus/src/webcast/vision/requirements.txt

# 1) Pull dense frames around each milestone (±15s @ 2fps by default)
# --download resolves the webcast stream (yt-dlp -g) and ffmpeg-grabs
# only the windows — not the entire multi‑GB VOD.
.venv-webcast/bin/python apps/tplus/src/webcast/vision/extract_windows.py \
  --run-dir /path/to/tplus-webcast/runs/<runId> \
  --download
# or: --video /path/to/vod.mp4
# optional full VOD: --download --full-download
# dry-run plan: add --dry-run
# subset: --actions liftoff,seco

# 2) Score / pick a better still
.venv-webcast/bin/python apps/tplus/src/webcast/vision/score_frame.py \
  /path/to/tplus-webcast/runs/<runId>/vision/frames/seco_0010.jpg
.venv-webcast/bin/python apps/tplus/src/webcast/vision/eval_enrich.py \
  --run-dir /path/to/tplus-webcast/runs/<runId> \
  --action seco

# 3) Labeling pack (stratified stubs + local review gallery)
.venv-webcast/bin/python apps/tplus/src/webcast/vision/label_assist.py \
  --runs-root /path/to/tplus-webcast/runs \
  --per-window 6 \
  --gold-dir /path/to/tplus-webcast/vision-gold
# open vision-gold/index.html (or each run's vision/review.html),
# correct labels, download labels.jsonl → save as runs/<id>/vision/labels.jsonl

# 4) Best still per milestone (product-shaped gold — recommended)
.venv-webcast/bin/python apps/tplus/src/webcast/vision/pick_best.py \
  --run-dir /path/to/tplus-webcast/runs/<runId>
# serve vision/, open pick_best.html, click one winner per action → picks.jsonl
```

### What the labels mean (intuition)

Scene tags were a first cut and are easy to overthink. Prefer **picks.jsonl** (“best alert still”) for enrichment eval.

| Tag | Intuition | When to use |
|-----|-----------|-------------|
| `plume_on` | Bright exhaust / flame is the point of the shot | Liftoff plume, landing burn fire |
| `landing_burn` | Boostback / landing burn look (flame + descent vibe) | Landing windows |
| `pad_or_tower` | Ground / tower / ship deck dominates | Pre-liftoff pad |
| `plume_off` | Airborne but engines dark / coast | SECO coast, stage alone |
| `vehicle_air` | **Catch-all:** stack clearly in flight, no strong plume — easy to abuse; avoid unless nothing else fits | Rare |
| `hud_heavy` | Big telemetry graphic / animation, not a useful photo | Replay cards |
| `low_value` | Black, blur, logo, useless as an alert thumb | Skip |

**Better gold for TPlus:** for each event, pick the one frame you’d put on the bubble — timestamps/best-frame, not a taxonomy essay.

`extract_windows.py` anchors T+0 using `--liftoff-video-sec`, or estimates  
`(liftoff_wall − media_up_wall)` from the run archive (works when the VOD  
starts near webcast go-live).

## AWS batch (contest stub)

See [`aws/README.md`](./aws/README.md). Short version:

```bash
export TPLUS_VISION_BUCKET=tplus-vision-<you>
./apps/tplus/src/webcast/vision/aws/sync_to_s3.sh ~/cue/tplus-webcast/runs/<runId>
# on Graviton (or locally):
./apps/tplus/src/webcast/vision/aws/run_batch_on_host.sh ~/cue/tplus-webcast/runs/<runId>
```

Local smoke (same scorer):

```bash
.venv-webcast/bin/python apps/tplus/src/webcast/vision/batch_score.py \
  --run-dir ~/cue/tplus-webcast/runs/<runId>
```
