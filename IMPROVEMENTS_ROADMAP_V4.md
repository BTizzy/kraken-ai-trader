# Kraken AI Trader - Improvements Roadmap V4

**Created:** January 20, 2026  
**Version:** 4.0.0  
**Status:** Active Development

---

## 📊 Week Test Analysis (Jan 13-20)

### Critical Finding: ZERO New Trades

The bot ran for a week but made **0 new trades** due to:

1. **Pattern Edge Filter Too Strict**: Required 5+ trades AND 40% win rate AND has_edge
2. **Two Bots Running**: Duplicate processes (dry-run + server-spawned) caused confusion
3. **No Trade Persistence**: New trades weren't saved to trade_log.json

### Historical Data Summary (1,337 trades)

| Metric | Value | Assessment |
|--------|-------|------------|
| Win Rate | 10.92% | 🔴 Critical - needs 4x improvement |
| Total P&L | -$485.54 | 🔴 Losing money |
| Profit Factor | 0.19 | 🔴 Critical - needs 6x improvement |
| Timeout Exits | 89.1% | 🔴 Most trades timeout without profit |
| Take Profit Exits | 10.9% | 🟡 Too few profitable exits |
| Patterns with Edge | 8/88 | 🟡 Only 9% of patterns profitable |

### Winning Patterns Identified

| Pattern | Win Rate | Profit Factor | Trades |
|---------|----------|---------------|--------|
| BEAMUSD_LONG_2x_2 | 83.3% | 3.57 | 6 |
| AKTUSD_LONG_3x_2 | 62.5% | 1.33 | 8 |
| ANIMEUSD_LONG_0x_2 | 28.6% | 2.03 | 7 |
| BABYUSD_LONG_1x_2 | 29.4% | 1.30 | 17 |

---

## ✅ Fixes Completed This Session

### 1. Multiple Bot Prevention
- Added `pkill -f kraken_bot` to `/api/bot/start` endpoint
- Ensures only one bot instance runs at a time

### 2. Learning Mode Enabled
- Set `learning_mode: true` in config
- Bot now bypasses edge filter to gather pattern data
- Rebuilt C++ bot with latest changes

### 3. Trade Persistence
- Added `persistTrade()` function to server.js
- Completed trades now saved to trade_log.json
- Data survives server restarts

### 4. Config File Path Fix
- Bot now loads config from `../config/bot_config.json`
- Falling back to defaults if not found (needs fix)

---

## 🚀 Phase 1: Critical Fixes (This Week)

### 1.1 Fix Config Loading ⚠️ PRIORITY
**Problem**: Bot shows "No config file found" - path issue from build directory

```cpp
// Current (broken from bot/build/):
std::string config_path = "../config/bot_config.json";

// Should be:
std::string config_path = "../../config/bot_config.json";
```

**Impact**: Bot uses defaults instead of tuned config values

### 1.2 Improve Win Rate via Exit Strategy
**Problem**: 89% of trades exit on timeout, not reaching take profit

**Solutions**:
1. **Trailing Stop Loss**: Lock in partial profits
   ```cpp
   // When price moves 0.5% in our favor, trail at 0.3% behind peak
   if (unrealized_gain > 0.5%) {
       stop_loss = entry_price * (1 + peak_gain - 0.3%);
   }
   ```

2. **Adaptive Take Profit**: Based on volatility
   ```cpp
   double tp_pct = base_tp * (1 + volatility_percentile);
   // Low volatility: tighter TP for faster wins
   // High volatility: wider TP to capture swings
   ```

3. **Time-Based Exit**: Partial close as timeout approaches
   ```cpp
   if (hold_time > max_hold * 0.75 && unrealized > 0) {
       close_50_percent(); // Lock in partial profit
   }
   ```

### 1.3 Shorter Test Cycles
**Problem**: Week-long tests too slow to iterate

**Solution**: Create rapid backtesting mode
- Process historical trades in seconds
- Test strategy changes instantly
- Compare metrics before/after

```javascript
// scripts/backtest.js
function backtest(strategy, trades) {
    return trades.map(t => simulateTrade(t, strategy))
                 .reduce(calculateMetrics);
}
```

---

## 📈 Phase 2: Win Rate Improvement (Next 2 Weeks)

### 2.1 Pattern-Based Entry Selection
Only trade patterns with proven edge:

```cpp
// Minimum criteria for edge:
// - 10+ historical trades
// - Win rate > 35% (vs 10.9% baseline)
// - Profit factor > 1.0
bool hasEdge = trades >= 10 && winRate > 0.35 && profitFactor > 1.0;
```

### 2.2 Multi-Timeframe Confirmation
Don't trade against the trend:

```cpp
struct TimeframeSignals {
    double tf_5m;   // Entry timing
    double tf_1h;   // Trend direction
    double tf_4h;   // Overall bias
    
    bool shouldTrade() {
        // All timeframes must agree on direction
        return sign(tf_5m) == sign(tf_1h) && sign(tf_1h) == sign(tf_4h);
    }
};
```

### 2.3 Volume/Liquidity Filter
Skip low-volume pairs:

```cpp
// Filter out pairs with < $100k daily volume
if (pair.volume_24h < 100000) {
    skip("Low volume - slippage risk");
}
```

### 2.4 Fee-Aware Entry
Only enter if expected profit > fees:

```cpp
double expected_move = volatility * confidence;
double round_trip_fees = 2 * taker_fee; // 0.8% for Kraken
if (expected_move < round_trip_fees * 1.5) {
    skip("Expected profit doesn't cover fees");
}
```

---

## 🔧 Phase 3: Infrastructure (Month 2)

### 3.1 SQLite Database
Replace JSON files for better querying:

```sql
CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    pair TEXT,
    direction TEXT,
    entry_price REAL,
    exit_price REAL,
    pnl REAL,
    exit_reason TEXT,
    timestamp INTEGER,
    pattern_key TEXT
);

CREATE INDEX idx_pattern ON trades(pattern_key);
CREATE INDEX idx_timestamp ON trades(timestamp);
```

### 3.2 WebSocket Price Feed
Real-time prices instead of polling:

```javascript
const ws = new WebSocket('wss://ws.kraken.com');
ws.send(JSON.stringify({
    event: 'subscribe',
    pair: ['XBT/USD', 'ETH/USD'],
    subscription: { name: 'ticker' }
}));
```

### 3.3 Automated Testing Pipeline
```yaml
# .github/workflows/test.yml
on: [push]
jobs:
  test:
    steps:
      - run: npm test
      - run: node scripts/backtest.js --quick
```

---

## 📊 Success Metrics

### Short Term (1 Week)
| Metric | Current | Target |
|--------|---------|--------|
| New Trades/Day | 0 | 10+ |
| Trade Persistence | ❌ | ✅ |
| Config Loading | ❌ | ✅ |

### Medium Term (1 Month)
| Metric | Current | Target |
|--------|---------|--------|
| Win Rate | 10.9% | 30%+ |
| Profit Factor | 0.19 | 1.0+ |
| Timeout Exits | 89% | 50% |

### Long Term (3 Months)
| Metric | Current | Target |
|--------|---------|--------|
| Win Rate | 10.9% | 45%+ |
| Profit Factor | 0.19 | 1.5+ |
| Daily P&L | -$3.63 | +$10+ |

---

## 🎯 Immediate Next Steps

1. ✅ ~~Enable learning mode~~ - Done
2. ✅ ~~Implement trade persistence~~ - Done
3. ✅ ~~Fix multiple bot prevention~~ - Done
4. ⬜ Fix config file path (../../config/bot_config.json)
5. ⬜ Let bot run for 24 hours to gather data
6. ⬜ Analyze new trades and pattern performance
7. ⬜ Implement trailing stop loss
8. ⬜ Create backtest script for faster iteration

---

## 📝 Files Modified This Session

| File | Changes |
|------|---------|
| `server.js` | Added persistTrade(), pkill in bot/start |
| `bot/src/main.cpp` | learning_mode support, config loading |
| `config/bot_config.json` | learning_mode: true, edge filter settings |

---

*Previous: IMPROVEMENTS_ROADMAP_V3.md*
