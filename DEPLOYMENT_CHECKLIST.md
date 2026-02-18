# Deployment Checklist — Prediction Market Bot

## Pre-Flight

- [ ] **All tests pass**: `node tests/test_fair_value_engine.js && node tests/test_prediction_bot.js` → 86/86
- [ ] **Smoke test**: `node -e "require('./server/prediction-proxy')"` loads without errors
- [ ] **Monte-Carlo sim**: `node scripts/monte_carlo_liquidity_sim.js` → strategy is +EV
- [ ] **Git state clean**: All changes committed and pushed

## Environment Setup

```bash
# Node.js v20+ required (using v24.11.1)
node --version

# Install dependencies
npm install

# Verify SQLite working
node -e "const b = require('better-sqlite3'); console.log('SQLite OK');"
```

## Configuration

### 1. API Keys (`config/api_keys.json`)
```json
{
  "gemini": {
    "api_key": "YOUR_GEMINI_API_KEY",
    "api_secret": "YOUR_GEMINI_API_SECRET"
  }
}
```
> **Note**: Polymarket and Kalshi use public APIs — no keys needed for price data.

### 2. Bot Parameters (`config/bot_config.json`)
```json
{
  "mode": "paper",
  "initial_balance": 500,
  "prediction_port": 3003,
  "fee_per_side": 0.0006,
  "min_edge": 0.03,
  "high_confidence_edge": 0.08,
  "kelly_fraction": 0.25,
  "max_position_size": 100,
  "drawdown_limit": 0.20
}
```

## Starting the Bot

### Paper Trading (Recommended First)
```bash
# Start prediction market bot on port 3003
node server/prediction-proxy.js

# Or use start.sh if configured
./start.sh
```

### Monitor via Dashboard
```
http://localhost:3003          # Dashboard UI
http://localhost:3003/api/health   # Health check
http://localhost:3003/api/wallet   # Balance/PnL
http://localhost:3003/api/bot/status  # Full status
http://localhost:3003/api/fair-value  # Spot prices + FV engine
```

### Background Mode
```bash
# Run as background process
nohup node server/prediction-proxy.js > logs/prediction_bot.log 2>&1 &
echo $! > bot_pid.txt

# Check logs
tail -f logs/prediction_bot.log

# Stop
kill $(cat bot_pid.txt)
```

## Health Monitoring

### Key Metrics to Watch
| Metric | Good | Bad | Action |
|--------|------|-----|--------|
| `circuit_breaker.open` | `false` | `true` | Check API connectivity |
| `consecutive_errors` | 0-2 | 5+ | Circuit opens automatically |
| `wallet.total_pnl` | Positive | Negative >$20 | Review signals |
| `wallet.max_drawdown_pct` | <10% | >20% | Kill-switch triggers |
| `open_positions` | 0-5 | 10+ | Reduce position sizing |
| `spot_prices` | All 3 assets | Missing | Check Kraken API |

### Health Check Script
```bash
curl -s http://localhost:3003/api/health | jq '{
  status, bot_running,
  errors: .circuit_breaker.consecutive_errors,
  circuit: .circuit_breaker.open
}'

curl -s http://localhost:3003/api/wallet | jq '{
  balance, total_pnl, total_trades, winning_trades, losing_trades
}'
```

## Scaling: Paper → Live

### Phase 1: Paper Validation (Current)
- Run for **7+ days** with paper trading
- Target: >55% trial profitability, Sharpe >1.5, drawdown <15%
- Review `GET /api/performance` daily

### Phase 2: Small Live ($50)
- Switch `gemini_client.js` from paper to real mode
- Set `max_position_size: 10` (smallest possible)
- Monitor for 3+ days before scaling

### Phase 3: Full Live ($500)
- Increase position limits gradually
- Enable drawdown kill-switch at 20%
- Set up external monitoring (cron health checks)

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| "Circuit breaker OPEN" | 5+ API failures | Check internet, wait 30s |
| "DRAWDOWN KILL-SWITCH" | >20% loss from peak | Review strategy, restart manually |
| "0 matched markets" | API fetch failed | Check Polymarket/Kalshi endpoints |
| "FK constraint failed" | Manual overrides reference missing markets | Non-critical, ignore |
| No fair-value signals | No crypto contracts matched | Normal — FV only works for BTC/ETH/SOL bracket markets |
| Spot price fetch errors | Kraken rate limit | Automatic retry in 15s |

## Key Files

| File | Purpose |
|------|---------|
| `server/prediction-proxy.js` | Main orchestrator (port 3003) |
| `lib/fair_value_engine.js` | BS + Kalshi ensemble pricing |
| `lib/signal_detector.js` | Dual strategy signal scoring |
| `lib/paper_trading_engine.js` | Position management + Kelly sizing |
| `lib/gemini_client.js` | Gemini API wrapper (paper + real modes) |
| `lib/kalshi_client.js` | Kalshi API + synthetic probability |
| `lib/polymarket_client.js` | Polymarket Gamma API client |
| `lib/market_matcher.js` | Cross-platform market matching |
| `lib/prediction_db.js` | SQLite database layer |
| `scripts/monte_carlo_liquidity_sim.js` | Monte-Carlo validation |
