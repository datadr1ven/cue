#!/usr/bin/env bash
# Run OpenCV batch scoring on the current host (laptop or Graviton).
# Optionally push scores back to S3 when TPLUS_VISION_BUCKET is set.
set -euo pipefail

RUN_DIR=${1:?usage: run_batch_on_host.sh <run-dir>}
RUN_DIR=$(cd "$RUN_DIR" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
VISION=$(cd "$HERE/.." && pwd)
PY=${PYTHON:-python3}

# Prefer repo .venv-webcast when present
ROOT=$VISION
while [[ "$ROOT" != / ]]; do
  if [[ -x "$ROOT/.venv-webcast/bin/python" ]]; then
    PY="$ROOT/.venv-webcast/bin/python"
    break
  fi
  ROOT=$(dirname "$ROOT")
done
if [[ -n "${VIRTUAL_ENV:-}" && "$PY" == "python3" ]]; then
  PY="$VIRTUAL_ENV/bin/python"
fi

echo "python=$PY"
"$PY" -c "import cv2; print('opencv', cv2.__version__)"
"$PY" "$VISION/batch_score.py" --run-dir "$RUN_DIR"

if [[ -n "${TPLUS_VISION_BUCKET:-}" ]]; then
  BUCKET=$TPLUS_VISION_BUCKET
  PREFIX=${TPLUS_VISION_PREFIX:-tplus-vision}
  REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}
  RUN_ID=$(basename "$RUN_DIR")
  DEST="s3://${BUCKET}/${PREFIX}/runs/${RUN_ID}/vision/"
  echo "→ upload scores to $DEST"
  aws s3 cp "$RUN_DIR/vision/scores.jsonl" "${DEST}scores.jsonl" --region "$REGION"
  aws s3 cp "$RUN_DIR/vision/scores.summary.json" "${DEST}scores.summary.json" --region "$REGION"
fi

echo "scores: $RUN_DIR/vision/scores.jsonl"
