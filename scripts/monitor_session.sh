#!/bin/bash
# 2-hour monitoring script - checks bot health every 15 minutes
# Writes structured output for analysis

LOG="/tmp/claude/-workspaces-kraken-ai-trader/monitoring.log"
echo "=== MONITORING SESSION STARTED $(date -u) ===" > "$LOG"
echo "" >> "$LOG"

for i in $(seq 1 8); do
    echo "--- CHECK $i/8 at $(date -u) ---" >> "$LOG"

    # Health check
    HEALTH=$(curl -s http://localhost:3003/api/health 2>/dev/null)
    if [ -z "$HEALTH" ]; then
        echo "  [ERROR] Server not responding!" >> "$LOG"
        echo "" >> "$LOG"
        sleep 900
        continue
    fi

    # Bot status
    STATUS=$(curl -s http://localhost:3003/api/bot/status 2>/dev/null)

    BALANCE=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"wallet\"][\"balance\"]:.2f}')" 2>/dev/null)
    PNL=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"wallet\"][\"total_pnl\"]:.2f}')" 2>/dev/null)
    WINS=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['wallet']['winning_trades'])" 2>/dev/null)
    LOSSES=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['wallet']['losing_trades'])" 2>/dev/null)
    TOTAL=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['wallet']['total_trades'])" 2>/dev/null)
    CYCLE=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cycle_count', 0))" 2>/dev/null)
    OPEN=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('open_positions', 0))" 2>/dev/null)
    SHARPE=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d.get(\"sharpe\", 0):.2f}')" 2>/dev/null)
    KALSHI_AUTH=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('kalshi',{}).get('authenticated', False))" 2>/dev/null)
    KALSHI_WS=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('kalshi_ws',{}).get('connected', False))" 2>/dev/null)

    echo "  Balance: \$$BALANCE | PnL: \$$PNL | Trades: $TOTAL (W:$WINS L:$LOSSES) | Sharpe: $SHARPE" >> "$LOG"
    echo "  Cycle: $CYCLE | Open: $OPEN | Kalshi REST: $KALSHI_AUTH | Kalshi WS: $KALSHI_WS" >> "$LOG"

    # Get circuit breaker state
    CB_OPEN=$(echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('circuit_breaker',{}).get('open', False))" 2>/dev/null)
    ERRORS=$(echo "$HEALTH" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('circuit_breaker',{}).get('total_errors', 0))" 2>/dev/null)
    echo "  Circuit breaker: open=$CB_OPEN errors=$ERRORS" >> "$LOG"

    # Count recent trades from DB
    RECENT_TRADES=$(curl -s http://localhost:3003/api/trades/recent 2>/dev/null | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    trades=d.get('trades',[])
    recent=[t for t in trades if t.get('is_open')==0]
    if recent:
        last=recent[0]
        print(f'  Last trade: {last.get(\"direction\")} {last.get(\"market_title\",\"\")[:40]} PnL=\${last.get(\"pnl\",0):+.2f} ({last.get(\"exit_reason\")})')
    else:
        print('  No recent closed trades')
except:
    print('  (trade data unavailable)')
" 2>/dev/null)
    echo "$RECENT_TRADES" >> "$LOG"
    echo "" >> "$LOG"

    # Wait 15 minutes before next check
    if [ $i -lt 8 ]; then
        sleep 900
    fi
done

echo "=== MONITORING SESSION ENDED $(date -u) ===" >> "$LOG"
