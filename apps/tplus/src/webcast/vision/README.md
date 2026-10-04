# Webcast vision scaffold

Offline OpenCV helpers for **frame enrichment** around TPlus milestones.

See [`docs/VISION-ENRICHMENT.md`](../../../docs/VISION-ENRICHMENT.md) for the plan and contest notes.

## Layout

```
vision/
  README.md
  labels.schema.json   # gold JSONL schema
  score_frame.py       # OpenCV baseline scorer (heuristics)
  eval_enrich.py       # rank frames in an emit window
  requirements.txt     # opencv-python-headless, …
  samples/             # optional tiny fixtures (not full flights)
```

## Quick local try

```bash
# from cue repo root — prefer the webcast venv (has yt-dlp + OpenCV on the desk)
.venv-webcast/bin/pip install -r apps/tplus/src/webcast/vision/requirements.txt

# 1) Pull dense frames around each milestone (±15s @ 2fps by default)
.venv-webcast/bin/python apps/tplus/src/webcast/vision/extract_windows.py \
  --run-dir /path/to/tplus-webcast/runs/<runId> \
  --download
# or: --video /path/to/vod.mp4
# dry-run plan: add --dry-run
# subset: --actions liftoff,seco

# 2) Score / pick a better still
.venv-webcast/bin/python apps/tplus/src/webcast/vision/score_frame.py \
  /path/to/tplus-webcast/runs/<runId>/vision/frames/seco_0010.jpg
.venv-webcast/bin/python apps/tplus/src/webcast/vision/eval_enrich.py \
  --run-dir /path/to/tplus-webcast/runs/<runId> \
  --action seco
```

`extract_windows.py` anchors T+0 using `--liftoff-video-sec`, or estimates  
`(liftoff_wall − media_up_wall)` from the run archive (works when the VOD  
starts near webcast go-live).

## AWS (later)

Upload `runs/<id>/vision/` to S3 and run `score_frame.py` in batch on Graviton/OpenCV 5; pull score JSON for `eval_enrich.py`. Keep OpenCV as the analysis core — not a cloud-only black box.
