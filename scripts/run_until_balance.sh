#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3003}"
TARGET_BALANCE="${TARGET_BALANCE:-100}"
SLEEP_SECONDS="${SLEEP_SECONDS:-180}"
LOG_FILE="${LOG_FILE:-logs/run_until_balance.log}"

mkdir -p "$(dirname "$LOG_FILE")"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting run_until_balance target=$TARGET_BALANCE sleep=${SLEEP_SECONDS}s" | tee -a "$LOG_FILE"

# Ensure API is reachable
if ! curl -fsS "$BASE_URL/api/health" >/dev/null; then
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] ERROR: API not reachable at $BASE_URL" | tee -a "$LOG_FILE"
  exit 1
fi

# Keep tight filters in place each run (idempotent)
for kv in \
  entry_threshold:65 \
  min_edge_live:0.08 \
  max_concurrent_positions:1 \
  live_max_concurrent:1 \
  kelly_multiplier:0.10 \
  live_daily_loss_limit:-5 \
  daily_loss_limit:-5
 do
  key="${kv%%:*}"
  val="${kv#*:}"
  curl -fsS -X POST "$BASE_URL/api/parameters/$key" \
    -H 'Content-Type: application/json' \
    -d "{\"value\": $val}" >/dev/null || true
 done

# Start bot if not running
RUNNING=$(curl -fsS "$BASE_URL/api/bot/status" | jq -r '.running')
if [[ "$RUNNING" != "true" ]]; then
  curl -fsS -X POST "$BASE_URL/api/bot/start" >/dev/null || true
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Bot start requested" | tee -a "$LOG_FILE"
fi

while true; do
  TS="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

  STATUS_JSON="$(curl -fsS "$BASE_URL/api/bot/status" || echo '{}')"
  BAL="$(echo "$STATUS_JSON" | jq -r '.wallet.balance // 0')"
  RUNNING="$(echo "$STATUS_JSON" | jq -r '.running // false')"
  OPEN_POS="$(echo "$STATUS_JSON" | jq -r '.open_positions // 0')"
  DAILY_PNL="$(echo "$STATUS_JSON" | jq -r '.daily_pnl.daily_pnl // 0')"

  REC_JSON="$(curl -fsS "$BASE_URL/api/reconcile" || echo '{}')"
  ORPH="$(echo "$REC_JSON" | jq -r '.orphaned | length // 0')"
  PHAN="$(echo "$REC_JSON" | jq -r '.phantom | map(select(.pendingExit != true)) | length // 0')"
  QMIS="$(echo "$REC_JSON" | jq -r '.quantityMismatch | length // 0')"

  echo "[$TS] balance=$BAL running=$RUNNING open_positions=$OPEN_POS daily_pnl=$DAILY_PNL orphaned=$ORPH phantom=$PHAN qty_mismatch=$QMIS" | tee -a "$LOG_FILE"

  # Auto-heal any reconciliation drift
  if [[ "$ORPH" != "0" || "$PHAN" != "0" || "$QMIS" != "0" ]]; then
    echo "[$TS] Drift detected; running /api/reconcile/fix" | tee -a "$LOG_FILE"
    curl -fsS -X POST "$BASE_URL/api/reconcile/fix" | jq -c '.' | tee -a "$LOG_FILE" >/dev/null || true
  fi

  # Restart bot if it stopped unexpectedly before target is reached
  if [[ "$RUNNING" != "true" ]]; then
    echo "[$TS] Bot not running; start requested" | tee -a "$LOG_FILE"
    curl -fsS -X POST "$BASE_URL/api/bot/start" >/dev/null || true
  fi

  # Target hit: stop bot and exit loop
  awk_cmp=$(awk -v b="$BAL" -v t="$TARGET_BALANCE" 'BEGIN { if (b >= t) print 1; else print 0 }')
  if [[ "$awk_cmp" == "1" ]]; then
    echo "[$TS] TARGET HIT: balance=$BAL >= $TARGET_BALANCE. Stopping bot and exiting." | tee -a "$LOG_FILE"
    curl -fsS -X POST "$BASE_URL/api/bot/stop" >/dev/null || true
    exit 0
  fi

  sleep "$SLEEP_SECONDS"
done
