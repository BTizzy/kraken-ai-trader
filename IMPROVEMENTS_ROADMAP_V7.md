# Kraken AI Trader - Improvement Roadmap V7

> **NOTE:** This document provides historical and technical context. For the most current architecture, operational, and strategy information, always check `Must_read_before_any_agent_task.md`.

**Created**: January 20, 2026
**Updated**: January 22, 2026
**Status**: SQLite is single source of truth, regime filter active, learning operational, MARKET ANALYSIS COMPLETE - realistic targets applied

---

## 📊 Current System Status

### ✅ What's Working
| Component | Status | Details |
|-----------|--------|---------|
| C++ Bot | ✅ Running | SQLite direct writes, regime filtering |
| Node.js Server | ✅ Running | Dashboard accessible at localhost:8000 |
| SQLite Database | ✅ **SINGLE SOURCE OF TRUTH** | 1406 trades, all indicators stored |
| Regime Filter | ✅ Active | **VOLATILE only** - RANGING/TRENDING blocked |
| Technical Indicators | ✅ Calculated | RSI, MACD, Bollinger Bands, ATR, Volume |
| Learning Engine | ✅ Recording | Saves to SQLite immediately on each trade |
| Dashboard Start Button | ✅ **REMOVED** | Prevents accidental bot spawning |

### 🔧 Recent Fixes (This Session)
| Fix | Impact |
|-----|--------|
| SQLite as ONLY data store | No JSON fallback, data integrity ensured |
| Regime threshold lowered | 8% → 4% for VOLATILE detection |
| JSON save calls removed | No more trade_log.json writes from C++ |
| Dashboard start button removed | Prevents server crashes from rogue spawns |
| Bot/start endpoint disabled | Returns 403 - must use terminal |
| **VOLATILE TP/SL Fixed** | **Reverted to fixed 1.5% TP / 0.6% SL for all VOLATILE regime** - eliminates timeouts causing losing streak |
| **MARKET ANALYSIS COMPLETE** | **Root cause: 1.5% TP impossible in 3min - markets barely move!** |
| **REALISTIC TARGETS APPLIED** | **TP: 0.5%, SL: 0.3%, Hold: 15min - matches actual market movement** |

---

## 📈 Data Analysis (1406 trades)

```
Historical Performance:
- Overall Win Rate: 7.8% (110 wins / 1406 trades)
- Total P&L: -$1,945.85

By Exit Reason:
- Take Profit: 75.3% WR, +$62 ← WINNERS!
- Stop Loss: ~30% WR, -$450
- Timeout: 0% WR, -$2,002 ← THE PROBLEM

By Market Regime (historical):
- VOLATILE (regime=2): 70.2% WR, +$17 ← TRADE THIS
- RANGING (regime=0): 0% WR, -$1,498 ← NOW BLOCKED
- TRENDING (regime=1): 0% WR, -$448 ← NOW BLOCKED
```

---

## 🎯 Learning Engine Configuration

### Current Parameters
```cpp
// Learning thresholds
MIN_TRADES_FOR_ANALYSIS = 25;      // Patterns analyzed after 25 trades
CONFIDENCE_THRESHOLD = 0.6;         // 60% confidence needed
MIN_WIN_RATE_FOR_TRADE = 0.45;     // Pattern must have >45% WR to trade
OUTLIER_THRESHOLD = 2.5;            // 2.5 std devs for outlier detection

// Trading parameters
take_profit_pct = 1.5%;            // Target profit
stop_loss_pct = 0.6%;              // Max loss
min_hold_seconds = 180;            // 3 minutes min
max_hold_seconds = 1800;           // 30 minutes max

// Regime filter
regime_filter_enabled = true;
allow_volatile_regime = true;      // ONLY regime allowed
allow_trending_regime = false;     // Blocked - loses money
allow_ranging_regime = false;      // Blocked - loses $1498
allow_quiet_regime = false;        // Blocked
```

### Learning Goals
1. **Pattern Recognition**: Identify which (pair + volatility + RSI + MACD + regime) combos win
2. **Entry Optimization**: Learn optimal entry conditions per pattern
3. **Exit Optimization**: Adjust TP/SL based on pattern historical performance
4. **Position Sizing**: Kelly criterion based on pattern confidence
5. **Pair Selection**: Auto-blacklist consistently losing pairs

### What's Being Learned
Each trade records to SQLite:
- Pair, direction, entry/exit prices
- Technical indicators at entry (RSI, MACD, BB, ATR)
- Market regime (0=RANGING, 1=TRENDING, 2=VOLATILE, 3=QUIET)
- Volatility, spread, volume conditions
- P&L, exit reason, hold time

---

## 📋 SQLite Schema

```sql
CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    pair TEXT NOT NULL,
    direction TEXT DEFAULT 'LONG',
    entry_price REAL,
    exit_price REAL,
    position_size REAL,
    leverage INTEGER DEFAULT 1,
    pnl REAL,
    gross_pnl REAL,
    fees_paid REAL,
    exit_reason TEXT,
    timestamp INTEGER,
    timeframe_seconds INTEGER,
    volatility_pct REAL,
    bid_ask_spread REAL,
    rsi REAL,
    macd_histogram REAL,
    macd_signal REAL,
    bb_position REAL,
    volume_ratio REAL,
    momentum_score REAL,
    atr_pct REAL,
    market_regime INTEGER,
    trend_direction REAL,
    max_profit REAL,
    max_loss REAL,
    UNIQUE(pair, timestamp)
);
```

---

## 🚀 Next Steps

### Immediate (Validated)
- [x] SQLite as single source of truth
- [x] Regime filter blocking RANGING/TRENDING
- [x] Dashboard start button removed
- [x] Bot/start API endpoint disabled
- [x] **High-Frequency Price Collection**: 360x data improvement (1,800+ points/hour vs 5) with real-time technical analysis
- [ ] Monitor new trades for regime=2 (VOLATILE) only
- [ ] Verify 50%+ win rate on filtered trades

### Phase 2: Enhanced Learning
- [ ] Add indicator correlation analysis (which combos predict wins)
- [ ] Dynamic TP/SL based on pattern history
- [ ] Trailing stop optimization per volatility level
- [ ] Time-of-day analysis (best trading hours)

### Phase 3: Production Readiness
- [ ] Add Discord webhook for trade notifications
- [ ] Daily P&L report generation
- [ ] Backtest framework validation
- [ ] Live trading mode (non-paper)

---

## 🎯 Success Metrics

| Metric | Before | Target (30 days) |
|--------|--------|------------------|
| Win Rate | 7.8% | 50%+ |
| P&L | -$1,946 | +$0 (break even) |
| Timeout Exits | 89% | <30% |
| TP/SL Exits | 11% | >70% |
| Regime Distribution | Mixed | 100% VOLATILE |

---

## 📝 Operations Guide

### Starting the Bot
```bash
# 1. Start the server first
cd /Users/ryanbartell/polymarket-ai-trader/kraken-ai-trader-1
node server.js &

# 2. Then start the bot (MUST be from build directory)
cd bot/build
./kraken_bot

# Or with logging:
nohup ./kraken_bot > /tmp/kraken_bot.log 2>&1 &
```

### Checking Status
```bash
# Check if running
ps aux | grep -E "kraken_bot|node.*server"

# Check SQLite trades
sqlite3 data/trades.db "SELECT COUNT(*), SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), printf('%.2f', SUM(pnl)) FROM trades;"

# Check recent trades
sqlite3 data/trades.db "SELECT pair, printf('%.2f', pnl), exit_reason, market_regime FROM trades ORDER BY timestamp DESC LIMIT 5;"

# Check bot log
tail -f /tmp/kraken_bot.log
```

### Stopping the Bot
```bash
pkill -f kraken_bot
```

---

## 📊 Monitoring Checklist

Daily checks:
1. ☐ Bot process running (`ps aux | grep kraken_bot`)
2. ☐ Server process running (`ps aux | grep "node server"`)
3. ☐ New trades in SQLite with regime=2 (VOLATILE)
4. ☐ Win rate on new trades >40%
5. ☐ No trades with regime=0 (RANGING) or regime=1 (TRENDING)

If win rate drops below 30% after 20+ trades, investigate:
- Are TP/SL targets correct for current volatility?
- Is regime detection threshold (4%) appropriate?
- Are blacklisted pairs being traded anyway?
