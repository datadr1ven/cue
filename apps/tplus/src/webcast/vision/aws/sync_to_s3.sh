#!/usr/bin/env bash
# Upload a run's vision/ pack to s3://$TPLUS_VISION_BUCKET/tplus-vision/runs/<id>/
set -euo pipefail

RUN_DIR=${1:?usage: sync_to_s3.sh <run-dir>}
RUN_DIR=$(cd "$RUN_DIR" && pwd)
RUN_ID=$(basename "$RUN_DIR")
BUCKET=${TPLUS_VISION_BUCKET:?set TPLUS_VISION_BUCKET}
PREFIX=${TPLUS_VISION_PREFIX:-tplus-vision}
REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-2}}

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found" >&2
  exit 1
fi
if [[ ! -d "$RUN_DIR/vision/frames" ]]; then
  echo "missing $RUN_DIR/vision/frames" >&2
  exit 1
fi

DEST="s3://${BUCKET}/${PREFIX}/runs/${RUN_ID}/vision/"
echo "→ sync $RUN_DIR/vision/ → $DEST"
aws s3 sync "$RUN_DIR/vision/" "$DEST" \
  --region "$REGION" \
  --exclude '*' \
  --include 'frames/*' \
  --include 'picks.jsonl' \
  --include 'labels.jsonl' \
  --include 'manifest.json' \
  --include 'scores.jsonl' \
  --include 'scores.summary.json'
echo "done $DEST"
