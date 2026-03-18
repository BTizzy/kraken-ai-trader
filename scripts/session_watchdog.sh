#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p logs
WDLOG="logs/session_watchdog_$(date +%Y%m%d_%H%M%S).log"
echo "watchdog_log=$WDLOG"

while true; do
  TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if ! curl -sf http://localhost:3003/api/health >/dev/null; then
    echo "[$TS] health_check=down action=restart_server" >> "$WDLOG"
    pkill -f "node server/prediction-proxy.js" 2>/dev/null || true
    nohup node server/prediction-proxy.js >> "$WDLOG" 2>&1 &
    sleep 8

    if curl -sf http://localhost:3003/api/health >/dev/null; then
      echo "[$TS] restart_result=ok" >> "$WDLOG"
    else
      echo "[$TS] restart_result=failed" >> "$WDLOG"
    fi
  else
    BOT_RUNNING="$(curl -s http://localhost:3003/api/health | jq -r '.bot_running')"
    echo "[$TS] health_check=ok bot_running=$BOT_RUNNING" >> "$WDLOG"
  fi

  sleep 15
done