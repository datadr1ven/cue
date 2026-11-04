#!/usr/bin/env bash
# Daily (or on-demand) cleanup of the TPlus public Pages feed.
#
# Uses OpenCV heuristics to strip/drop black / HUD / wrong-phase stills, then
# by default drops text-only items so the page stays image-forward.
# Telegram is untouched — this only edits KV feed:v1.
# Requires wrangler login + .venv-webcast OpenCV.
#
#   ./apps/tplus/scripts/feed-cleanup.sh           # apply
#   ./apps/tplus/scripts/feed-cleanup.sh --dry-run
#   npm run webcast:feed-cleanup -w tplus
#   npm run webcast:feed-cleanup -w tplus -- --dry-run
#
set -euo pipefail

DRY_RUN=0
KEEP_TEXT_ONLY=0
EXTRA_ARGS=()
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY_RUN=1 ;;
    --keep-text-only) KEEP_TEXT_ONLY=1; EXTRA_ARGS+=(--keep-text-only) ;;
    --help|-h)
      sed -n '2,14p' "$0"
      exit 0
      ;;
  esac
done

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
REPO_ROOT=$(cd "$APP_ROOT/../.." && pwd)
cd "$APP_ROOT"

# Prefer Node 22+ for wrangler (CF Workers tooling); fall back to PATH.
if [[ -z "${NODE_BIN:-}" ]]; then
  for candidate in \
    "$HOME/.local/node-v22.23.4/bin" \
    "$HOME/.local/node-v22.22.1/bin" \
    "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | grep '^v22' | sort -V | tail -1)/bin"; do
    if [[ -x "${candidate}/node" ]]; then
      export PATH="${candidate}:$PATH"
      break
    fi
  done
fi

PY="${REPO_ROOT}/.venv-webcast/bin/python"
if [[ ! -x "$PY" ]]; then
  PY=python3
fi
CLEAN_PY="$APP_ROOT/src/webcast/vision/feed_cleanup.py"
NS_ID="${TPLUS_KV_NAMESPACE_ID:-3971fe561fdd4514836238747293ac8e}"
LOG_DIR="${TPLUS_FEED_CLEANUP_LOG_DIR:-$REPO_ROOT/tplus-webcast/logs}"
mkdir -p "$LOG_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d /tmp/tplus-feed-cleanup-XXXXXX)
trap 'rm -rf "$WORK"' EXIT

echo "[feed-cleanup] $STAMP dry_run=$DRY_RUN work=$WORK node=$(command -v node) $(node -v 2>/dev/null || echo none)"

# Prefer KV export (source of truth for Pages); fall back to public /recent
if npx wrangler kv key get "feed:v1" --namespace-id "$NS_ID" --remote \
  >"$WORK/feed-raw.txt" 2>"$WORK/wrangler-get.err"; then
  # Strip any wrangler noise; keep JSON object
  python3 - "$WORK/feed-raw.txt" "$WORK/feed.json" <<'PY'
import sys
from pathlib import Path
raw = Path(sys.argv[1]).read_text()
start, end = raw.find("{"), raw.rfind("}")
if start < 0 or end <= start:
    raise SystemExit("no JSON in wrangler kv get output")
Path(sys.argv[2]).write_text(raw[start : end + 1])
PY
else
  echo "[feed-cleanup] wrangler get failed; using public /recent" >&2
  cat "$WORK/wrangler-get.err" >&2 || true
  FEED_URL="${TPLUS_FEED_URL:-https://tplus.scenicminddigital.workers.dev/recent?limit=50}"
  curl -fsS "$FEED_URL" -o "$WORK/recent.json"
  python3 - "$WORK/recent.json" "$WORK/feed.json" <<'PY'
import json, sys
from pathlib import Path
d = json.loads(Path(sys.argv[1]).read_text())
Path(sys.argv[2]).write_text(
    json.dumps({"updatedAt": d.get("updatedAt"), "items": d.get("items") or []})
)
PY
fi

REPORT="$LOG_DIR/feed-cleanup-$STAMP.jsonl"
OUT="$WORK/feed-clean.json"
ARGS=(--feed "$WORK/feed.json" --out "$OUT" --report "$REPORT" --work-dir "$WORK/imgs" "${EXTRA_ARGS[@]}")
if [[ "$DRY_RUN" -eq 1 ]]; then
  ARGS+=(--dry-run)
fi

"$PY" "$CLEAN_PY" "${ARGS[@]}" | tee "$LOG_DIR/feed-cleanup-$STAMP.summary.json"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[feed-cleanup] dry-run only; KV unchanged"
  exit 0
fi

CHANGED=$(python3 -c "import json;d=json.load(open('$LOG_DIR/feed-cleanup-$STAMP.summary.json')); print(d.get('changed', d.get('stripped',0)))")
if [[ "${CHANGED:-0}" -eq 0 ]]; then
  echo "[feed-cleanup] nothing to change"
  exit 0
fi

npx wrangler kv key put "feed:v1" --namespace-id "$NS_ID" --remote --path "$OUT"
echo "[feed-cleanup] wrote feed:v1 (changed=$CHANGED)"
echo "[feed-cleanup] report $REPORT"
