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
# from cue repo root, with webcast venv or a vision venv
pip install -r apps/tplus/src/webcast/vision/requirements.txt

python apps/tplus/src/webcast/vision/score_frame.py path/to/frame.jpg
python apps/tplus/src/webcast/vision/eval_enrich.py \
  --run-dir /path/to/tplus-webcast/runs/<runId> \
  --action seco
```

## AWS (later)

Upload `runs/<id>/vision/` to S3 and run `score_frame.py` in batch on Graviton/OpenCV 5; pull score JSON for `eval_enrich.py`. Keep OpenCV as the analysis core — not a cloud-only black box.
