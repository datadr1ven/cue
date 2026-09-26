#!/usr/bin/env bash
# Start/stop GridWhisper live worker + OpenF1 MQTT capture + SignalR capture
# for a named session.
#
#   OUT_DIR=.../baku-2026 session-ctl.sh start fp1|fp2|fp3|quali|race|sprint
#   ENGINE_SOURCE=signalr|openf1  (default: signalr — worker feed)
#   SIGNALR_AUTH=1                (optional authenticated SignalR capture twin)
#
# Captures (gold): MQTT + SignalR-noauth always.
# Worker alerts: ENGINE_SOURCE=signalr (F1 hub) or openf1 (MQTT).
#
set -euo pipefail

# Resolve monorepo root from this script (apps/gridwhisper/scripts → ../../..)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CUE_ROOT="${CUE_ROOT:-$_DEFAULT_ROOT}"
# Capture:signalr lives in cue (apps/gridwhisper). Override for legacy sibling.
SIGNALR_ROOT="${SIGNALR_ROOT:-$CUE_ROOT}"
OUT_DIR="${OUT_DIR:-$CUE_ROOT/captures}"
RUN_DIR="${RUN_DIR:-$OUT_DIR/run}"
LOG_DIR="${LOG_DIR:-$OUT_DIR/logs}"
ENGINE_SOURCE="${ENGINE_SOURCE:-signalr}"
SESSIONS=(fp1 fp2 fp3 quali race sprint)
# signalr-auth omitted by default — Spain A/B showed auth≈noauth for capture;
# set SIGNALR_AUTH=1 to also run the authenticated twin.
ROLES=(worker mqtt signalr-noauth)
if [[ "${SIGNALR_AUTH:-0}" == "1" ]]; then
  ROLES=(worker mqtt signalr-auth signalr-noauth)
fi

mkdir -p "$OUT_DIR" "$RUN_DIR" "$LOG_DIR"

# Load secrets into this process + children
set -a
# shellcheck disable=SC1091
[[ -f "$CUE_ROOT/.env" ]] && source "$CUE_ROOT/.env"
# shellcheck disable=SC1091
[[ -f "$SIGNALR_ROOT/.env" ]] && source "$SIGNALR_ROOT/.env"
# shellcheck disable=SC1091
[[ -f "$SIGNALR_ROOT/openf1-local/.env" ]] && source "$SIGNALR_ROOT/openf1-local/.env"
set +a

usage() {
  echo "Usage: OUT_DIR=... ENGINE_SOURCE=signalr|openf1 $0 start|stop|status [fp1|fp2|fp3|quali|race|sprint]" >&2
  exit 2
}

session_kind_for() {
  case "$1" in
    fp1|fp2|fp3) echo practice ;;
    quali) echo qualifying ;;
    race|sprint) echo race ;;
    *) echo "unknown session: $1" >&2; exit 2 ;;
  esac
}

pidfile() { echo "$RUN_DIR/$1-$2.pid"; }
logfile() { echo "$LOG_DIR/$1-$2.log"; }

is_running() {
  local pf="$1"
  [[ -f "$pf" ]] || return 1
  local pid
  pid="$(cat "$pf" 2>/dev/null || true)"
  [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null
}

start_one() {
  local session="$1" role="$2" cmd="$3"
  local pf lf
  pf="$(pidfile "$session" "$role")"
  lf="$(logfile "$session" "$role")"

  if is_running "$pf"; then
    echo "[$session/$role] already running pid=$(cat "$pf")"
    return 0
  fi

  echo "[$session/$role] starting → $lf"
  # setsid so cron's shell exit doesn't SIGHUP children; stdout/err to log
  setsid bash -lc "$cmd" >>"$lf" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" >"$pf"
  sleep 0.5
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$session/$role] ok pid=$pid"
  else
    echo "[$session/$role] FAILED to stay up — see $lf" >&2
    rm -f "$pf"
    return 1
  fi
}

stop_one() {
  local session="$1" role="$2"
  local pf pid
  pf="$(pidfile "$session" "$role")"
  if ! is_running "$pf"; then
    echo "[$session/$role] not running"
    rm -f "$pf"
    return 0
  fi
  pid="$(cat "$pf")"
  echo "[$session/$role] stopping pid=$pid"
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$session/$role] force kill"
    kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pf"
  echo "[$session/$role] stopped"
}

cmd_start() {
  local session="$1"
  local kind mqtt_out sr_auth_out sr_noauth_out
  kind="$(session_kind_for "$session")"
  mqtt_out="$OUT_DIR/${session}.ndjson"
  sr_auth_out="$OUT_DIR/${session}-signalr-auth.ndjson"
  sr_noauth_out="$OUT_DIR/${session}-signalr-noauth.ndjson"

  if [[ -z "${OPENF1_USERNAME:-}" || -z "${OPENF1_PASSWORD:-}" ]]; then
    echo "ERROR: OPENF1_USERNAME/PASSWORD missing (cue/.env)" >&2
    exit 1
  fi
  if [[ -z "${DELIVER_URL:-}" || -z "${DELIVER_SECRET:-}" ]]; then
    echo "ERROR: DELIVER_URL/SECRET missing — worker:live:http will fail" >&2
    exit 1
  fi
  echo "=== START $session ($(date -Is)) kind=$kind OUT_DIR=$OUT_DIR ENGINE_SOURCE=$ENGINE_SOURCE ==="
  echo "MQTT capture    → $mqtt_out"
  echo "SignalR noauth  → $sr_noauth_out"
  if [[ "${SIGNALR_AUTH:-0}" == "1" ]]; then
    echo "SignalR auth    → $sr_auth_out (SIGNALR_AUTH=1)"
  fi
  echo "Worker feed     → $ENGINE_SOURCE"

  start_one "$session" mqtt \
    "cd '$CUE_ROOT' && MQTT_SOURCE=live npm run capture -- '$mqtt_out'"

  # No-auth SignalR capture twin (gold). SIGNALR_NO_AUTH=1 hard-overrides .env tokens.
  start_one "$session" signalr-noauth \
    "cd '$SIGNALR_ROOT' && SIGNALR_NO_AUTH=1 F1_TOKEN= F1_SUBSCRIPTION_TOKEN= npm run capture:signalr -- '$sr_noauth_out'"

  if [[ "${SIGNALR_AUTH:-0}" == "1" ]]; then
    start_one "$session" signalr-auth \
      "cd '$SIGNALR_ROOT' && npm run capture:signalr -- '$sr_auth_out'"
  fi

  if [[ "$ENGINE_SOURCE" == "signalr" ]]; then
    start_one "$session" worker \
      "cd '$CUE_ROOT' && ENGINE_SOURCE=signalr DELIVERY_MODE=http ENGINE_SESSION_KIND=$kind npm run worker:live:signalr:http"
  else
    start_one "$session" worker \
      "cd '$CUE_ROOT' && ENGINE_SOURCE=openf1 MQTT_SOURCE=live DELIVERY_MODE=http ENGINE_SESSION_KIND=$kind npm run worker:live:http"
  fi

  echo "=== START done $session ==="
}

cmd_stop() {
  local session="$1"
  echo "=== STOP $session ($(date -Is)) ==="
  stop_one "$session" worker
  stop_one "$session" mqtt
  stop_one "$session" signalr-noauth
  stop_one "$session" signalr-auth
  echo "=== STOP done $session ==="
}

cmd_status() {
  echo "=== STATUS ($(date -Is)) OUT_DIR=$OUT_DIR ==="
  # Always list auth slot too (may be leftover from older starts)
  local status_roles=(worker mqtt signalr-noauth signalr-auth)
  for session in "${SESSIONS[@]}"; do
    for role in "${status_roles[@]}"; do
      local pf
      pf="$(pidfile "$session" "$role")"
      if is_running "$pf"; then
        echo "  $session/$role RUNNING pid=$(cat "$pf")"
      else
        echo "  $session/$role stopped"
      fi
    done
  done
}

main() {
  local action="${1:-}" session="${2:-}"
  case "$action" in
    start)
      [[ -n "$session" ]] || usage
      cmd_start "$session"
      ;;
    stop)
      [[ -n "$session" ]] || usage
      cmd_stop "$session"
      ;;
    status)
      cmd_status
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
