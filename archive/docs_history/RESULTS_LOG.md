# Results Log

## Paper Trading Results

### Session Log

| Date | Trades | Wins | Win Rate | PnL | Balance | Notes |
|------|--------|------|----------|-----|---------|-------|
| *(bot not yet started)* | — | — | — | — | $500.00 | Initial capital |

---

## Performance Tracking

### Daily Targets

| Week | Daily Target | Status |
|------|-------------|--------|
| 1 | Collect data, validate signals | Not started |
| 2 | $50/day (10% daily) | Not started |
| 3 | $200/day (breakeven path to $1k/day) | Not started |
| 4+ | $1,000/day | Not started |

### Key Metrics to Track

- **Win Rate:** Target > 55% (current: N/A)
- **Profit Factor:** Target > 1.5 (current: N/A)
- **Avg Hold Time:** Target 30-90s (current: N/A)
- **Max Drawdown:** Limit < 20% (current: N/A)
- **Sharpe Ratio:** Target > 2.0 (current: N/A)
- **Signals/Hour:** Baseline TBD

---

## Parameter History

Track parameter changes and their impact:

| Date | Change | Before | After | Impact |
|------|--------|--------|-------|--------|
| *(none yet)* | | | | |

---

## Model Training Log

| Date | Trades Used | Test Accuracy | F1-Score | Notes |
|------|------------|---------------|----------|-------|
| *(not trained yet)* | | | | Need 50+ trades |

---

## Observations & Insights

### Market Patterns
- *(Record patterns you notice here)*

### Platform Behavior
- **Polymarket:** *(latency, spread width, volume patterns)*
- **Kalshi:** *(latency, spread width, volume patterns)*
- **Gemini:** *(paper mode — will update when live)*

### Strategy Notes
- *(Record what works/doesn't work)*

---

## How to Update This Log

After each trading session, run:

```bash
# View current positions and recent trades
node scripts/monitor_paper_positions.js

# Run backtest on collected data
node scripts/backtest_prediction_strategy.js --days 1

# Check bot status via API
curl http://localhost:3003/api/performance
curl http://localhost:3003/api/wallet
```

Then update the tables above with the results.
