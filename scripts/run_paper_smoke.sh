#!/usr/bin/env bash
# Run the bot in paper mode for a configurable duration and capture logs
set -euo pipefail
DURATION=${1:-600} # seconds, default 10 minutes
LOGDIR="$(pwd)/logs"
mkdir -p "$LOGDIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOGFILE="$LOGDIR/paper_smoke_${TIMESTAMP}.log"

echo "Starting paper-mode smoke test for ${DURATION}s, logging to ${LOGFILE}"
PRICE_HISTORY_DB="$(pwd)/data/price_history.db" TRADES_DB="$(pwd)/data/trades.db" \
  /Users/ryanbartell/polymarket-ai-trader/kraken-ai-trader-1/bot/build/kraken_bot --paper --verbose --scan-interval 10 > "$LOGFILE" 2>&1 &
BOT_PID=$!

trap "echo 'Stopping bot...'; kill $BOT_PID 2>/dev/null || true; echo 'Stopped'; exit" INT TERM

sleep "$DURATION"

echo "Time elapsed; killing bot (pid=$BOT_PID)"
kill $BOT_PID 2>/dev/null || true
sleep 1
if ps -p $BOT_PID >/dev/null 2>&1; then
  echo "Bot did not exit; sending SIGKILL"
  kill -9 $BOT_PID 2>/dev/null || true
fi

echo "Smoke test complete. Logs: $LOGFILE"
exit 0
