#!/usr/bin/env bash
# Start/stop GridWhisper live worker + OpenF1 MQTT capture + dual SignalR
# captures (authenticated + no_auth) for a named session.
#
#   OUT_DIR=.../spain-2026 session-ctl.sh start fp1|fp2|fp3|quali|race
#   OUT_DIR=.../spain-2026 session-ctl.sh stop  fp1|fp2|fp3|quali|race
#   OUT_DIR=.../spain-2026 session-ctl.sh status
#
# Authenticated SignalR inherits F1_TOKEN from .env at start time.
# No-auth SignalR clears F1_TOKEN / F1_SUBSCRIPTION_TOKEN for that process only.
#
set -euo pipefail

# Resolve monorepo root from this script (apps/gridwhisper/scripts → ../../..)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_DEFAULT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CUE_ROOT="${CUE_ROOT:-$_DEFAULT_ROOT}"
# Optional sibling checkout for SignalR capture tooling (override on desktop)
SIGNALR_ROOT="${SIGNALR_ROOT:-$CUE_ROOT/../cue-signalr}"
OUT_DIR="${OUT_DIR:-$CUE_ROOT/captures}"
RUN_DIR="${RUN_DIR:-$OUT_DIR/run}"
LOG_DIR="${LOG_DIR:-$OUT_DIR/logs}"
SESSIONS=(fp1 fp2 fp3 quali race)
ROLES=(worker mqtt signalr-auth signalr-noauth)

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
  echo "Usage: OUT_DIR=... $0 start|stop|status [fp1|fp2|fp3|quali|race]" >&2
  exit 2
}

session_kind_for() {
  case "$1" in
    fp1|fp2|fp3) echo practice ;;
    quali) echo qualifying ;;
    race) echo race ;;
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
  if [[ -z "${F1_TOKEN:-}${F1_SUBSCRIPTION_TOKEN:-}" ]]; then
    echo "WARN: no F1_TOKEN in env — signalr-auth will also be no_auth" >&2
  else
    echo "F1_TOKEN present — signalr-auth will use it; signalr-noauth unsets it"
  fi

  echo "=== START $session ($(date -Is)) kind=$kind OUT_DIR=$OUT_DIR ==="
  echo "MQTT            → $mqtt_out"
  echo "SignalR auth    → $sr_auth_out"
  echo "SignalR noauth  → $sr_noauth_out"

  start_one "$session" mqtt \
    "cd '$CUE_ROOT' && MQTT_SOURCE=live npm run capture -- '$mqtt_out'"

  # Authenticated: inherit F1_TOKEN from this shell / .env
  start_one "$session" signalr-auth \
    "cd '$SIGNALR_ROOT' && npm run capture:signalr -- '$sr_auth_out'"

  # Explicit no-auth twin. Must SET empty tokens (not unset): capture-signalr
  # dotenv-loads cue-signalr/.env and would refill F1_TOKEN after env -u.
  # SIGNALR_NO_AUTH=1 is a hard override inside the capture binary.
  start_one "$session" signalr-noauth \
    "cd '$SIGNALR_ROOT' && SIGNALR_NO_AUTH=1 F1_TOKEN= F1_SUBSCRIPTION_TOKEN= npm run capture:signalr -- '$sr_noauth_out'"

  start_one "$session" worker \
    "cd '$CUE_ROOT' && MQTT_SOURCE=live DELIVERY_MODE=http ENGINE_SESSION_KIND=$kind npm run worker:live:http"

  echo "=== START done $session ==="
}

cmd_stop() {
  local session="$1"
  echo "=== STOP $session ($(date -Is)) ==="
  stop_one "$session" worker
  stop_one "$session" mqtt
  stop_one "$session" signalr-auth
  stop_one "$session" signalr-noauth
  echo "=== STOP done $session ==="
}

cmd_status() {
  echo "=== STATUS ($(date -Is)) OUT_DIR=$OUT_DIR ==="
  for session in "${SESSIONS[@]}"; do
    for role in "${ROLES[@]}"; do
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
