#!/usr/bin/env bash
# Start a paper bot with aggressive overrides and monitor P&L
set -euo pipefail
CANDIDATE_JSON=${1:-}
DURATION=${2:-86400} # seconds, default 24h
LOGDIR=$(pwd)/logs
mkdir -p "$LOGDIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOGFILE="$LOGDIR/aggressive_paper_${TIMESTAMP}.log"

if [ -z "$CANDIDATE_JSON" ]; then
  echo "Usage: $0 <candidate-json> [duration_seconds]"
  echo "Candidate JSON keys: tp, sl, trail_start, trail_stop, min_volatility, min_confidence, kelly_fraction"
  exit 2
fi

# Read candidate params
TP=$(jq -r '.tp' <<< "$CANDIDATE_JSON")
SL=$(jq -r '.sl' <<< "$CANDIDATE_JSON")
TRAIL=$(jq -r '.trail_start' <<< "$CANDIDATE_JSON")
TRSTOP=$(jq -r '.trail_stop' <<< "$CANDIDATE_JSON")
MIN_VOL=$(jq -r '.min_volatility' <<< "$CANDIDATE_JSON")
MIN_CONF=$(jq -r '.min_confidence' <<< "$CANDIDATE_JSON")
KELLY=$(jq -r '.kelly_fraction' <<< "$CANDIDATE_JSON")
TP_MULT=$(jq -r '.tp_multiplier // empty' <<< "$CANDIDATE_JSON" )
SL_MULT=$(jq -r '.sl_multiplier // empty' <<< "$CANDIDATE_JSON" )

echo "Starting aggressive paper run with TP=$TP SL=$SL TRAIL=$TRAIL TRSTOP=$TRSTOP MIN_VOL=$MIN_VOL MIN_CONF=$MIN_CONF KELLY=$KELLY"

export PRICE_HISTORY_DB=$(pwd)/data/price_history.db
export TRADES_DB=$(pwd)/data/trades.db
export KELLY_FRACTION_OVERRIDE=$KELLY
export PAPER_MIN_CONFIDENCE=$MIN_CONF
export MIN_VOLATILITY_PCT=$MIN_VOL
export USE_AUTHORITATIVE_PRICES=1
export AUTO_DIRECTION=1
# Allow leverage override (default 3x for aggressive runs)
export LEVERAGE_OVERRIDE=${LEVERAGE_OVERRIDE:-3}
if [ -n "$TP_MULT" ]; then export TP_MULTIPLIER_OVERRIDE=$TP_MULT; fi
if [ -n "$SL_MULT" ]; then export SL_MULTIPLIER_OVERRIDE=$SL_MULT; fi

/Users/ryanbartell/polymarket-ai-trader/kraken-ai-trader-1/bot/build/kraken_bot --paper --verbose --scan-interval 10 > "$LOGFILE" 2>&1 &
# PID of the started bot
BOT_PID=$!
# attach TP/SL multipliers if provided
if [ -n "$TP_MULT" ]; then export TP_MULTIPLIER_OVERRIDE=$TP_MULT; fi
if [ -n "$SL_MULT" ]; then export SL_MULTIPLIER_OVERRIDE=$SL_MULT; fi

# Start monitor in background (allow override via env MONITOR_STOP_LOSS / MONITOR_PROFIT_TARGET)
MON_STOP=${MONITOR_STOP_LOSS:--200}
MON_PROF=${MONITOR_PROFIT_TARGET:-500}
node scripts/monitor_trade_pnl.js --db=./data/trades.db --pid=$BOT_PID --stop-loss=${MON_STOP} --profit-target=${MON_PROF} --poll=15 &
MON_PID=$!

echo "Bot pid=$BOT_PID monitor pid=$MON_PID log=$LOGFILE"

# Wait for duration or until bot exits
SECONDS=0
while [ $SECONDS -lt $DURATION ]; do
  if ! kill -0 $BOT_PID 2>/dev/null; then
    echo "Bot exited early"
    break
  fi
  sleep 5
done

# On finish, attempt to gracefully stop
if kill -0 $BOT_PID 2>/dev/null; then
  echo "Time elapsed; sending SIGTERM to bot (pid=$BOT_PID)"
  kill $BOT_PID || true
  sleep 2
  if kill -0 $BOT_PID 2>/dev/null; then
    echo "Bot did not exit; SIGKILL"
    kill -9 $BOT_PID || true
  fi
fi

# Kill monitor
if kill -0 $MON_PID 2>/dev/null; then
  kill $MON_PID || true
fi

echo "Run complete. Logs: $LOGFILE"
exit 0
