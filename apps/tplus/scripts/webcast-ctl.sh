#!/usr/bin/env bash
# Start/stop TPlus webcast:live (LL2-primary; file --mission still works).
#
#   webcast-ctl.sh start o3b-mpower-f|ussf-259|starlink-sl-15-27
#   webcast-ctl.sh start --ll2-id <uuid>
#   webcast-ctl.sh stop  <run-key>
#   webcast-ctl.sh status
#
# Cron uses --mode ops via WEBCAST_MODE. Logs → $OUT_DIR/logs/
#
set -euo pipefail

CUE_ROOT="${CUE_ROOT:-/home/datadr1ven/cue}"
OUT_DIR="${OUT_DIR:-$CUE_ROOT/tplus-webcast}"
RUN_DIR="${RUN_DIR:-$OUT_DIR/run}"
LOG_DIR="${LOG_DIR:-$OUT_DIR/logs}"
MODE="${WEBCAST_MODE:-ops}" # ops | test

# Stable LL2 UUIDs for scheduled launches (prefer --ll2-id over search).
declare -A LL2_IDS=(
  [o3b-mpower-f]=ad358a4d-c541-409b-9366-9c2f2da4aeb9
  [ussf-259]=17c71937-dd80-406f-bb47-0c9ee9a24276
  [starlink-sl-15-27]=d1471f9d-e9d0-4146-8e97-90863e48bfc8
)

mkdir -p "$OUT_DIR" "$RUN_DIR" "$LOG_DIR"

usage() {
  echo "Usage: $0 start|stop|status [alias|--ll2-id UUID|--mission id]" >&2
  echo "  aliases: ${!LL2_IDS[*]}" >&2
  exit 2
}

pidfile() { echo "$RUN_DIR/$1.pid"; }
logfile() { echo "$LOG_DIR/$1.log"; }

is_running() {
  local pf="$1"
  [[ -f "$pf" ]] || return 1
  local pid
  pid="$(cat "$pf" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

# Resolve start args → run_key + webcast:live argv fragment
resolve_start() {
  local a="${1:-}"
  RUN_KEY=""
  LIVE_ARGS=()

  if [[ -z "$a" ]]; then
    usage
  fi
  if [[ "$a" == "--ll2-id" ]]; then
    local id="${2:-}"
    [[ -n "$id" ]] || usage
    RUN_KEY="ll2-${id:0:8}"
    LIVE_ARGS=(--ll2-id "$id")
    return 0
  fi
  if [[ "$a" == "--mission" ]]; then
    local mid="${2:-}"
    [[ -n "$mid" ]] || usage
    RUN_KEY="$mid"
    LIVE_ARGS=(--mission "$mid")
    return 0
  fi
  if [[ -n "${LL2_IDS[$a]:-}" ]]; then
    RUN_KEY="$a"
    # --mission alias keeps CF bundle loadMission working until dumb /suggest
    LIVE_ARGS=(--ll2-id "${LL2_IDS[$a]}" --mission "$a")
    return 0
  fi
  if [[ -f "$CUE_ROOT/apps/tplus/missions/flights/${a}-script.json" ]]; then
    RUN_KEY="$a"
    LIVE_ARGS=(--mission "$a")
    return 0
  fi
  echo "ERROR: unknown start target: $a" >&2
  usage
}

cmd_start() {
  resolve_start "$@"
  local pf lf
  pf="$(pidfile "$RUN_KEY")"
  lf="$(logfile "$RUN_KEY")"

  if is_running "$pf"; then
    echo "[$RUN_KEY] already running pid=$(cat "$pf")"
    return 0
  fi

  echo "=== START webcast $RUN_KEY ($(date -Is)) mode=$MODE args=${LIVE_ARGS[*]} ==="
  echo "log → $lf"
  # Quote-safe: rebuild command string
  local args_q=""
  local x
  for x in "${LIVE_ARGS[@]}"; do
    args_q+=" $(printf '%q' "$x")"
  done
  setsid bash -lc "cd '$CUE_ROOT' && npm run webcast:live --$args_q --mode '$MODE'" \
    >>"$lf" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" >"$pf"
  sleep 1.5
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$RUN_KEY] ok pid=$pid"
  else
    echo "[$RUN_KEY] FAILED to stay up — see $lf" >&2
    rm -f "$pf"
    return 1
  fi
  echo "=== START done $RUN_KEY ==="
}

cmd_stop() {
  local mission="${1:-}"
  [[ -n "$mission" ]] || usage
  local pf pid
  pf="$(pidfile "$mission")"
  echo "=== STOP webcast $mission ($(date -Is)) ==="
  if ! is_running "$pf"; then
    echo "[$mission] not running"
    rm -f "$pf"
    return 0
  fi
  pid="$(cat "$pf")"
  echo "[$mission] stopping pid=$pid"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$mission] force kill"
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pf"
  echo "[$mission] stopped"
  echo "=== STOP done $mission ==="
}

cmd_status() {
  echo "=== STATUS ($(date -Is)) OUT_DIR=$OUT_DIR mode=$MODE ==="
  local found=0
  local pf
  for pf in "$RUN_DIR"/*.pid; do
    [[ -e "$pf" ]] || continue
    found=1
    local mission pid
    mission="$(basename "$pf" .pid)"
    if is_running "$pf"; then
      pid="$(cat "$pf")"
      echo "  $mission RUNNING pid=$pid log=$(logfile "$mission")"
    else
      echo "  $mission stopped (stale pidfile)"
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    echo "  (no pidfiles)"
  fi
}

main() {
  local action="${1:-}"
  shift || true
  case "$action" in
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    status) cmd_status ;;
    *) usage ;;
  esac
}

main "$@"
