# Kraken AI Trader - Improvement Roadmap V6

> **NOTE:** This document provides historical and technical context. For the most current architecture, operational, and strategy information, always check `Must_read_before_any_agent_task.md`.

**Created**: January 20, 2026
**Status**: Bot running with regime filter, waiting for VOLATILE conditions

---

## 📊 Current System Status

### ✅ What's Working
| Component | Status | Details |
|-----------|--------|---------|
| C++ Bot | ✅ Running | PID active, scanning 704 pairs |
| Node.js Server | ✅ Running | Dashboard accessible |
| Regime Filter | ✅ Active | Only VOLATILE regime allowed |
| Blacklist | ✅ Loaded | 5 pairs blocked (BONKUSD, ADAUSD, ABUSD, BOBUSD, ALGOUSD) |
| Technical Indicators | ✅ Calculated | RSI, MACD, Bollinger Bands, ATR |
| SQLite Database | ✅ Available | 1406 historical trades migrated |
| Trade Log (JSON) | ✅ Recording | C++ bot writes to trade_log.json |

### ⚠️ Gaps to Address
| Issue | Impact | Priority |
|-------|--------|----------|
| SQLite not auto-synced | New trades go to JSON, not SQLite | High |
| No live trade notifications | Can't monitor remotely | Medium |
| Dashboard shows stale status | bot_status.json not updating | Medium |
| No backtest framework | Can't validate strategies offline | Medium |

---

## 📈 Key Insights from Data Analysis

```
Historical Performance (1406 trades):
- Overall Win Rate: 7.8%
- Total P&L: -$1,945.85

By Exit Reason:
- Take Profit: 75.3% WR, +$62 ← WINNERS!
- Timeout: 0% WR, -$2,002 ← THE PROBLEM

By Market Regime:
- VOLATILE: 70.2% WR, +$17 ← TRADE THIS
- RANGING: 0% WR, -$1,498 ← BLOCKED
- TRENDING: 0% WR, -$448 ← BLOCKED
```

**The Strategy**: Only trade VOLATILE regime → expect 70%+ win rate

---

## 🚀 Phase 1: Immediate Fixes (This Week)

### 1.1 Auto-Sync JSON → SQLite
**Why**: Enable SQL queries on live data for pattern analysis
```javascript
// Create scripts/sync_to_sqlite.js
// Run on interval (every 5 minutes) or on-demand
// Insert new trades from trade_log.json into SQLite
```

### 1.2 Fix bot_status.json Updates
**Why**: Dashboard shows stale data
- Bot needs to write status file to project root, not just build/
- Or server needs to read from bot/build/bot_status.json

### 1.3 Add Trade Notifications
**Why**: Monitor bot without watching dashboard
- Webhook to Discord/Slack on trade entry/exit
- Alert when PnL drops below threshold

---

## 🔧 Phase 2: Learning Engine Improvements (Week 2)

### 2.1 Regime Detection Enhancement
Current: Simple volatility-based detection
**Improve**:
- Use RSI divergence to detect regime changes
- Add volume profile analysis
- Detect regime transitions (QUIET→VOLATILE)

### 2.2 Dynamic Parameter Tuning
**Why**: Optimal settings vary by regime
```cpp
// Per-regime config
VOLATILE: TP=2.0%, SL=0.8%, hold_max=600s
TRENDING: TP=3.0%, SL=1.0%, hold_max=900s (if enabled)
```

### 2.3 Pattern Persistence
**Why**: Patterns reset on bot restart
- Save learned patterns to JSON/SQLite
- Load patterns on startup
- Track pattern performance over time

---

## 📊 Phase 3: Analytics Dashboard (Week 3)

### 3.1 Real-Time Metrics
- Live P&L chart
- Win rate rolling average
- Regime distribution pie chart
- Active trades with entry prices

### 3.2 Trade Analysis View
- Filter by pair/regime/exit_reason
- P&L breakdown by time period
- Pattern performance leaderboard

### 3.3 Backtest Panel
- Select date range
- Test strategy parameters
- Compare against actual results

---

## 🧠 Phase 4: Advanced ML (Month 2)

### 4.1 Entry Signal Enhancement
- Train classifier on winning vs losing trades
- Features: RSI, MACD, BB position, volume ratio, regime
- Output: confidence score for trade entry

### 4.2 Exit Optimization
- Predict optimal hold time per trade
- Dynamic TP/SL based on volatility forecast
- Trailing stop optimization

### 4.3 Pair Selection Model
- Rank pairs by expected edge
- Auto-adjust position sizes by confidence
- Time-based pair rotation

---

## 📋 Immediate TODO List

- [ ] Create `scripts/sync_to_sqlite.js` - sync JSON trades to SQLite
- [ ] Add cron/interval to run sync automatically
- [ ] Fix bot_status.json path for dashboard
- [ ] Add Discord webhook for trade notifications
- [ ] Verify regime filter working (wait for VOLATILE and observe)
- [ ] Create daily P&L summary report script
- [ ] Backtest regime filter on historical data

---

## 🎯 Success Metrics

| Metric | Current | Target (30 days) |
|--------|---------|------------------|
| Win Rate | 7.8% | 50%+ |
| P&L | -$1,946 | +$0 (break even) |
| Timeout Exits | 89% | <30% |
| TP/SL Exits | 11% | >70% |
| Avg Winning Trade | +$1.96 | +$3.00 |
| Avg Losing Trade | -$1.68 | -$1.00 |

---

## 📝 Notes

### Why Regime Filter Should Work
The historical data clearly shows:
1. **70% of VOLATILE trades hit TP** - price moves enough to capture profit
2. **0% of RANGING trades hit TP** - price chops around, fees eat everything
3. By filtering to VOLATILE only, we skip the 89% of losing trades

### Risk
- VOLATILE conditions may be rare (hours between opportunities)
- Bot may go long periods without trading
- Need patience to validate strategy

### Monitoring Plan
1. Check SQLite daily for new trades
2. Expect 1-5 trades per day initially
3. Look for 50%+ win rate on filtered trades
4. If win rate < 40% after 20 trades, reassess regime detection
