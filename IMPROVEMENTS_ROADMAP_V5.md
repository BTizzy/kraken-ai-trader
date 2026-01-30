# Kraken AI Trader - Improvements Roadmap V5

> **NOTE:** This document provides historical and technical context. For the most current architecture, operational, and strategy information, always check `Must_read_before_any_agent_task.md`.

**Created:** January 20, 2026  
**Version:** 5.0.1  
**Status:** Active Development

---

## ✅ Session Summary (Jan 20, 2026)

This session focused on **critical infrastructure fixes** that were preventing proper data collection and analysis. All major blockers have been resolved.

### 🎯 Key Accomplishments

| Fix | Impact | Status |
|-----|--------|--------|
| Price Persistence | Entry/exit prices now saved to trade_log.json | ✅ Done |
| Duplicate Bot Prevention | Only one bot instance can run at a time | ✅ Done |
| Config Loading Enhanced | Bot now reads TP/SL/trailing params from config | ✅ Done |
| Trailing Stop Tuning | Lowered to 0.5% start, 0.25% trail for faster profits | ✅ Done |
| Backtest Script | Compare strategies instantly on historical data | ✅ Done |
| Fee-Aware Entry | Already implemented - skips trades where profit < fees | ✅ Verified |
| **BUG: Fee Calculation** | **Was using 0.4% instead of 0.8% round-trip** | ✅ **Fixed** |
| **BUG: avg_loss Sign** | **Tracked negative values, broke Kelly** | ✅ **Fixed** |
| **Historical Data Correction** | **Applied missing 0.4% fee to all 1355 trades** | ✅ **Done** |

---

## 🐛 CRITICAL BUG FIXES (Jan 20, 2026 - Session 2)

### Bug #1: Fee Calculation Used Wrong Rate

**Problem:** P&L calculation used 0.4% total fees, but Kraken charges 0.4% PER TRADE (0.8% round-trip).

**Impact:** All P&L was overstated by 0.4% per trade. We thought we were at -$487, but actual was **-$1,867.26**.

**Fix:** `bot/src/main.cpp` line 791
```cpp
// BEFORE (WRONG)
double fees = position_usd * 0.004;  // 0.4% total

// AFTER (CORRECT)  
double fees = position_usd * 0.008;  // 0.8% round-trip (0.4% entry + 0.4% exit)
```

### Bug #2: Fee-Aware Entry Used Wrong Rate

**Problem:** The fee filter checked against 0.4% when it should require 0.8%+ profit to overcome fees.

**Fix:** `bot/src/main.cpp` line 564
```cpp
// BEFORE (WRONG)
const double FEE_RATE = 0.004;  // 0.4%

// AFTER (CORRECT)
const double FEE_RATE = 0.008;  // 0.8% round-trip
```

### Bug #3: avg_loss Tracked Negative Values

**Problem:** `avg_loss` was tracking negative P&L values directly. Since losses are negative, this resulted in negative `avg_loss`, which broke Kelly calculations.

**Fix:** `bot/src/main.cpp` lines 89-90
```cpp
// BEFORE (WRONG)
avg_loss = ((avg_loss * losses) + pnl) / (losses + 1);

// AFTER (CORRECT)
double loss_magnitude = std::abs(pnl);  // Track magnitude, not negative value
avg_loss = ((avg_loss * losses) + loss_magnitude) / (losses + 1);
```

### Bug #4: Kelly Calculation Broken

**Problem:** With negative `avg_loss`, Kelly formula `(win_rate / avg_loss)` produced wrong results.

**Fix:** Automatically fixed by Bug #3 fix.

### Historical Data Correction

Created `scripts/fix_fee_calculation.js` to correct all historical trades:

| Metric | Before Fix | After Fix |
|--------|-----------|-----------|
| Total P&L | -$487.00 | **-$1,867.26** |
| Win Rate | 11% | **8.12%** |
| Profit Factor | 0.187 | **0.035** |
| Trades | 1355 | 1355 |

**Rationale for keeping data:** Even though trades had wrong fee calculations, the patterns themselves are real. The bot now learns from 1355 trades "what NOT to do" - these losing patterns help it avoid similar setups.

---

## 🔧 Technical Details

### 1. Price Persistence Fix

**Problem:** Entry/exit prices were showing as 0 in trade_log.json and dashboard showed "—"

**Root Cause:** C++ bot outputs each line separately via `std::endl`, causing separate Node.js `data` events. The price parsing couldn't match prices to the correct trade.

**Solution:** Added `_pendingEntryPair` and `_pendingExitPair` tracking variables to match price lines to trades across separate events.

```javascript
// server.js - Track pending pairs for multi-line parsing
learningData._pendingExitPair = pair;  // Set on EXIT line
// Later when price line arrives, match to correct trade
if (learningData._pendingExitPair) {
    trade = learningData.recent_trades.find(t => t.pair === learningData._pendingExitPair);
}
```

**Files Modified:** `server.js` lines 740-875

### 2. Duplicate Bot Prevention

**Problem:** "Two bots can never run at the same time - this can negatively affect the data"

**Solution:** 
- Added synchronous `pkill + pgrep` check before spawning new bot
- Added startup cleanup to kill orphaned processes when server starts

```javascript
// server.js - Before starting bot
try {
    execSync('pkill -f kraken_bot', { stdio: 'ignore' });
} catch (e) { /* ignore */ }

// Check no bot is running
const running = execSync('pgrep -f kraken_bot').toString().trim();
if (running) {
    return res.status(409).json({ error: 'Bot already running' });
}
```

**Files Modified:** `server.js` lines 665-700, 1087-1102

### 3. Enhanced Config Loading

**Problem:** Bot only loaded `learning_mode` from config, not risk management parameters

**Solution:** Extended config parser to read TP/SL/trailing parameters

```cpp
// main.cpp - Now loads these from config
config.take_profit_pct = find_double("take_profit_pct");
config.stop_loss_pct = find_double("stop_loss_pct");
config.trailing_start_pct = find_double("trailing_start_pct");
config.trailing_stop_pct = find_double("trailing_stop_pct");
```

**Files Modified:** `bot/src/main.cpp` lines 916-940

### 4. Aggressive Trailing Stop

**Problem:** 89% of trades exit on timeout without capturing available profit

**Solution:** Made trailing stop more aggressive to lock in profits earlier

| Parameter | Before | After | Rationale |
|-----------|--------|-------|-----------|
| `trailing_start_pct` | 0.8% | 0.5% | Activate earlier when profitable |
| `trailing_stop_pct` | 0.3% | 0.25% | Tighter trail to capture more |

**Files Modified:** `config/bot_config.json`

### 5. Backtest Script

**Problem:** Week-long tests too slow to iterate on strategy changes

**Solution:** Created `scripts/backtest.js` to simulate strategies on historical data

```bash
# Usage
node scripts/backtest.js                    # Run with default strategy
node scripts/backtest.js --tp=2.0 --sl=0.8  # Test different TP/SL
node scripts/backtest.js --compare          # Compare multiple strategies
```

**Features:**
- Loads all 1348 historical trades
- Simulates different TP/SL/trailing combinations
- Shows win rate, profit factor, P&L improvement
- Comparison mode tests 6 strategies at once

**Files Created:** `scripts/backtest.js`

### 6. Fee-Aware Entry (Verified)

**Already Implemented:** Bot checks that expected profit exceeds fees before entering

```cpp
// main.cpp lines 555-576
const double FEE_RATE = 0.004;  // 0.4%
const double MIN_PROFIT_BUFFER = 0.001;  // 0.1% buffer

// Skip if TP < fees + buffer
if (tp_pct < min_required_tp) {
    skip("TP too low for fees");
}

// Skip if expected profit < fees
double expected_profit = (tp_pct * win_rate) - (sl_pct * loss_rate);
if (expected_profit < expected_fees_pct) {
    skip("Expected profit doesn't cover fees");
}
```

---

## 📊 Current Bot Status

### Configuration (from config/bot_config.json)
```json
{
  "learning_mode": true,
  "take_profit_pct": 1.5,
  "stop_loss_pct": 0.6,
  "trailing_start_pct": 0.5,
  "trailing_stop_pct": 0.25,
  "edge_filter_min_trades": 10,
  "edge_filter_min_winrate": 0.35
}
```

### Trade Log Stats
- **Total Trades:** 1348
- **Total P&L:** -$486.90
- **Win Rate:** 10.9%
- **Trades with Price Data:** ~6 (rest from before fix)

### Winning Patterns (from learning engine)
| Pattern | Win Rate | Profit Factor | Trades |
|---------|----------|---------------|--------|
| BEAMUSD_LONG_2x | 83.3% | 3.57 | 6 |
| AKTUSD_LONG_3x | 62.5% | 1.33 | 8 |
| ANIMEUSD_LONG_0x | 28.6% | 2.03 | 7 |
| BABYUSD_LONG_1x | 29.4% | 1.30 | 17 |

---

## 🎯 Next Steps

### Immediate (Next 24 Hours)
1. ✅ Let bot run to collect trades with proper price data
2. ✅ Monitor trailing stop effectiveness with new 0.5% threshold
3. ⬜ Run backtest once we have 50+ trades with price data

### Short Term (This Week)
1. ⬜ Analyze trades with price data to see actual price movements
2. ⬜ Tune TP/SL based on observed price action
3. ⬜ Test if tighter trailing captures more profit

### Medium Term (Next 2 Weeks)
1. ⬜ Implement multi-timeframe confirmation
2. ⬜ Add volume/liquidity filter
3. ⬜ Target 30% win rate (up from 10.9%)

---

## 📁 Files Modified This Session

| File | Changes |
|------|---------|
| `server.js` | Price persistence with _pendingExitPair, duplicate bot prevention |
| `bot/src/main.cpp` | Enhanced config loading for TP/SL/trailing params |
| `config/bot_config.json` | Aggressive trailing: 0.5% start, 0.25% trail |
| `scripts/backtest.js` | **NEW** - Strategy backtesting tool |
| `tests/test_dashboard_api.js` | Updated tests for active trades |

---

## 📈 Metrics to Track

### Data Quality
- [x] Trades persist to trade_log.json
- [x] Entry/exit prices captured (not 0)
- [x] P&L calculated correctly
- [ ] 50+ trades with price data

### Strategy Performance
- [ ] Trailing stop exits increase from 0%
- [ ] Timeout exits decrease from 89%
- [ ] Win rate improves from 10.9%
- [ ] Profit factor improves from 0.19

### Infrastructure
- [x] Single bot instance guaranteed
- [x] Config changes apply without rebuild
- [x] Backtest runs in < 1 second

---

## 🧪 Testing

All 25 tests pass:
```
✅ Trade Calculations        8P 0F 0W
✅ Trade Log Validation      10P 0F 1W  
✅ Dashboard API             7P 0F 0W
```

---

## Git Commits This Session

1. `716c672` - Fix price persistence and duplicate bot prevention
   - Added _pendingEntryPair and _pendingExitPair tracking
   - Entry and exit prices now persist correctly
   - Synchronous pkill + pgrep check before bot start
   - Startup cleanup for orphaned processes

---

*Previous: IMPROVEMENTS_ROADMAP_V4.md*
