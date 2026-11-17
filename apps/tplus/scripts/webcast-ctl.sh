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

# Resolve monorepo root from this script (apps/tplus/scripts → ../../..)
# so cron works on any machine/user — never hardcode /home/<user>.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CUE_ROOT="${CUE_ROOT:-$_DEFAULT_ROOT}"
OUT_DIR="${OUT_DIR:-$CUE_ROOT/tplus-webcast}"
RUN_DIR="${RUN_DIR:-$OUT_DIR/run}"
LOG_DIR="${LOG_DIR:-$OUT_DIR/logs}"
MODE="${WEBCAST_MODE:-ops}" # ops | test

# Stable LL2 UUIDs for scheduled launches (prefer --ll2-id over search).
declare -A LL2_IDS=(
  [o3b-mpower-f]=ad358a4d-c541-409b-9366-9c2f2da4aeb9
  [vega-c-sentinel-3c-flex]=8effc13a-c658-4d2e-9f15-8dba4d7fe2dd
  [ussf-259]=17c71937-dd80-406f-bb47-0c9ee9a24276
  [starlink-sl-15-27]=d1471f9d-e9d0-4146-8e97-90863e48bfc8
)

mkdir -p "$OUT_DIR" "$RUN_DIR" "$LOG_DIR"

usage() {
  echo "Usage: $0 start|stop|status [alias|--ll2-id UUID|--mission id] [--phase ascent|return|all]" >&2
  echo "  aliases: ${!LL2_IDS[*]}" >&2
  echo "  --phase ascent  ascent desk only (cron default for launch day)" >&2
  echo "  --phase return  next-day deorbit/catch desk (run key …-return)" >&2
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

# Resolve start args → run_key + webcast:live argv fragment.
# Accepts: start --ll2-id UUID [--phase ascent|return|all]
#          start --mission id [--phase …]
#          start <alias> [--phase …]
resolve_start() {
  RUN_KEY=""
  LIVE_ARGS=()
  PHASE="all"
  local positional=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ll2-id)
        local id="${2:-}"
        [[ -n "$id" ]] || usage
        RUN_KEY="ll2-${id:0:8}"
        LIVE_ARGS+=(--ll2-id "$id")
        shift 2
        ;;
      --mission)
        local mid="${2:-}"
        [[ -n "$mid" ]] || usage
        RUN_KEY="$mid"
        LIVE_ARGS+=(--mission "$mid")
        shift 2
        ;;
      --phase)
        PHASE="${2:-all}"
        shift 2
        ;;
      --help|-h) usage ;;
      *)
        positional+=("$1")
        shift
        ;;
    esac
  done

  if [[ -z "$RUN_KEY" && ${#positional[@]} -gt 0 ]]; then
    local a="${positional[0]}"
    if [[ -n "${LL2_IDS[$a]:-}" ]]; then
      RUN_KEY="$a"
      LIVE_ARGS=(--ll2-id "${LL2_IDS[$a]}")
      if [[ -f "$CUE_ROOT/apps/tplus/missions/flights/${a}-script.json" ]]; then
        LIVE_ARGS+=(--mission "$a")
      fi
    elif [[ -f "$CUE_ROOT/apps/tplus/missions/flights/${a}-script.json" ]]; then
      RUN_KEY="$a"
      LIVE_ARGS=(--mission "$a")
    else
      echo "ERROR: unknown start target: $a" >&2
      usage
    fi
  fi

  if [[ -z "$RUN_KEY" ]]; then
    usage
  fi

  case "$PHASE" in
    ascent|return|all) ;;
    *)
      echo "ERROR: --phase must be ascent|return|all (got $PHASE)" >&2
      exit 2
      ;;
  esac
  LIVE_ARGS+=(--phase "$PHASE")
  if [[ "$PHASE" == "return" ]]; then
    RUN_KEY="${RUN_KEY}-return"
  fi
}

# Pre-start LL2 gate: refresh crontab on slip/cancel; only spawn when "go".
# Exit 0 from check = go; 75 = slip; 76 = cancel (see schedule-from-ll2.js).
check_start_ll2() {
  local id="$1"
  local ec
  set +e
  (cd "$CUE_ROOT" && node apps/tplus/bin/schedule-from-ll2.js --check-start "$id")
  ec=$?
  set -e
  return "$ec"
}

apply_schedule() {
  echo "[$RUN_KEY] refreshing schedule (LL2 → crontab)…"
  if ! (cd "$CUE_ROOT" && node apps/tplus/bin/schedule-from-ll2.js --apply-crontab); then
    echo "[$RUN_KEY] WARN: --apply-crontab failed" >&2
    return 1
  fi
  # Make the new start/stop lines obvious in cron.log (Owlright: slip with no
  # visible reschedule left us thinking the gate just aborted).
  if [[ -n "${1:-}" ]]; then
    echo "[$RUN_KEY] crontab lines for $1 after refresh:"
    crontab -l 2>/dev/null | grep -F "$1" || \
      echo "[$RUN_KEY] (no crontab lines for $1 — not in horizon?)"
  fi
  return 0
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

  # If starting by LL2 id, recheck NET/window before parking on a stale cron.
  local ll2_id=""
  local i=0
  for ((i = 0; i < ${#LIVE_ARGS[@]}; i++)); do
    if [[ "${LIVE_ARGS[$i]}" == "--ll2-id" ]]; then
      ll2_id="${LIVE_ARGS[$((i + 1))]:-}"
      break
    fi
  done
  # Return desk is hours/days after NET; slip/window gates do not apply.
  if [[ -n "$ll2_id" && "${PHASE:-all}" != "return" ]]; then
    local ec=0
    set +e
    check_start_ll2 "$ll2_id"
    ec=$?
    set -e
    if [[ "$ec" -eq 75 ]]; then
      echo "[$RUN_KEY] check-start SLIP (ec=75) — not spawning; rewriting crontab for new NET"
      apply_schedule "$ll2_id" || true
      echo "=== START deferred $RUN_KEY (await new cron start) ==="
      return 0
    fi
    if [[ "$ec" -eq 76 ]]; then
      echo "[$RUN_KEY] check-start CANCEL (ec=76) — not spawning; refreshing schedule"
      apply_schedule "$ll2_id" || true
      echo "=== START cancelled $RUN_KEY ==="
      return 0
    fi
    if [[ "$ec" -ne 0 ]]; then
      echo "[$RUN_KEY] check-start failed ec=$ec — refusing start" >&2
      return 1
    fi
  elif [[ "${PHASE:-}" == "return" ]]; then
    echo "[$RUN_KEY] phase=return — skipping NET/window check-start"
  fi

  # Quote-safe: rebuild command string
  local args_q=""
  local x
  for x in "${LIVE_ARGS[@]}"; do
    args_q+=" $(printf '%q' "$x")"
  done
  # --save-run archives under tplus-webcast/runs/ (meta, script, events, suggests)
  setsid bash -lc "cd '$CUE_ROOT' && npm run webcast:live --$args_q --mode '$MODE' --save-run" \
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
  # Optional: build collage + caption from newest run (dry-run X unless ENABLED + --post)
  if [[ "${TPLUS_SUMMARY_ON_STOP:-0}" == "1" ]]; then
    # --open prefills an X draft in the browser when a display is available
    local open_flag=()
    if [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
      open_flag=(--open)
    fi
    echo "[$mission] webcast:summary --latest ${open_flag[*]}"
    (
      cd "$CUE_ROOT" && npm run webcast:summary -w tplus -- --latest "${open_flag[@]}"
    ) || echo "[$mission] summary failed (non-fatal)"
  fi
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
