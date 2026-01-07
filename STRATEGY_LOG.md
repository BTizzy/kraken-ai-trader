# Scalper Strategy Evolution Log

This document tracks all strategy iterations, test results, and learnings to prevent regression.

---

## 📊 Test Results Summary

| Test # | Date | Win Rate | P&L | Strategy | Key Changes |
|--------|------|----------|-----|----------|-------------|
| 1 | 2026-01-07 | 40% | -$0.81 | Mixed momentum/reversion | Initial baseline, SHORT trades killing performance |
| 2 | 2026-01-07 | 24% | -$1.58 | Mean reversion only | Eliminated SHORT, but fallback trades still losing |
| 3 | 2026-01-07 | **68%** | **+$2.14** | Strict mean reversion | ✅ **BEST RUN** - β≥0.05, oversold, LONG only |
| 4 | 2026-01-07 | 52% | +$1.42 | Mean reversion + position sizing | Relaxed criteria slightly, BIO fast_stops hurt |
| 5 | 2026-01-07 | 24% | -$5.10 | Strict oversold + bounce confirmation | Too many fast_stops (52%), trailing stop issues |
| 6 | 2026-01-07 | 44% | -$6.31 | Deep oversold + wide stop (-2x) | MEGA disaster (-$4.20), wide stops = bigger losses |
| 7 | 2026-01-07 | 40% | -$3.93 | Hybrid momentum + reversion | Still struggling, @174 big loss, BABY fast_stops |
| 8 | 2026-01-07 | **8%** | **-$15.93** | Aggressive sizing ($150-250) | ❌ **WORST RUN** - Bigger positions = bigger losses |
| 9 | 2026-01-07 | 48% | -$0.36 | Test #3 config (validation) | BABY 7 fast_stops in row killed it (-$1.59). Adding cooldowns |
| 10 | 2026-01-07 | 44% | +$0.14 | + Symbol cooldowns | No BABY spam! But @248 flash crash -$1.41. FOGO +$2.68 |

---

## 📈 Data-Driven Improvement (after Test #10)

**Analysis of Test #10 data:**
- Winners (11 trades): avg β = 0.29
- Losers (14 trades): avg β = 0.09
- All trades with β < 0.10 lost money

**Change for Test #11:** Raised betaThreshold from 0.05 → **0.10**

This would have filtered out 6 losing trades (-$3.14) while keeping all winners.

---

## 🏆 Best Performing Configuration (Test #3)

**Win Rate: 68% | P&L: +$2.14**

### Entry Criteria
- β (volatility) ≥ 0.05
- isOversold = true (price < -0.05% from 20-tick mean)
- momentum ≥ 0 (non-negative)
- **LONG only** (no SHORT trades)

### Exit Criteria
- Profit target: 1x costs ($0.12)
- Stop loss: -1x costs (-$0.12)
- Quick profit: Any gain after 5s
- Reversion complete: Price returns to mean

### Position Sizing
- $100 baseline

### What Worked
- FOGO, @184, @267, LIT all profitable
- Fast exits on profit (<1s hold times on winners)
- High beta symbols (>0.2) were best performers

---

## ❌ What Didn't Work (Lessons Learned)

### Test #2: Fallback Trades Kill Performance
- "Found 0 STRONG opportunities" → fell back to momentum_simple
- Fallback trades had 0% win rate
- **Lesson:** Better to skip trade than take weak signal

### Test #5-6: Wide Stops Make Losses Worse
- Changed from -1x to -2x costs stop loss
- MEGA lost -$1.85 in one trade (was -$0.18 with tight stop)
- **Lesson:** Tight stops protect capital even if more losers

### Test #6: Mean Reversion in Downtrends = Disaster
- MEGA was in strong downtrend, kept catching falling knives
- 4 trades, all losses totaling -$4.20
- **Lesson:** Don't reversion trade in strong trends

### Test #7: Hybrid Strategy Still Struggling
- @174: -$1.81 fast_stop, but also +$1.15 timeout (same symbol, different outcomes)
- BABY: 3 consecutive fast_stops (-$0.92 total)
- FOGO: Mixed results, some big wins (+$1.06) but also big losses (-$1.36)
- **Lesson:** Momentum criteria (trend>0.6) may be too loose

---

## 🔧 Current Strategy Configuration (Test #7)

### Entry Paths (Hybrid)

**Path 1: MOMENTUM BREAKOUT**
```javascript
hasMomentumBreakout = 
  β ≥ 0.06 &&
  momentum > 0.05% &&  // Strong upward move
  trendStrength > 0.6   // Clear direction
```

**Path 2: MEAN REVERSION**
```javascript
hasMeanReversionSetup = 
  isOversold &&           // Below -0.10% from mean
  β ≥ 0.08 &&            // Higher vol requirement
  momentum > 0 &&         // Turning positive
  trendStrength < 0.5     // NOT in strong trend
```

### Exit Criteria
- Trailing stop: 50% of peak when profit > 2x costs
- Profit target: 1.5x costs
- Stop loss: -1.5x costs
- Quick profit: >0.2x costs after 5s

### Position Sizing
- β ≥ 0.15 → $150
- β ≥ 0.10 → $125
- β < 0.10 → $100

---

## 📈 Key Metrics to Watch

1. **Fast Stop Rate** - Should be <30% of trades
2. **Average Win Size** - Should be >$0.20
3. **Average Loss Size** - Should be <$0.30
4. **Win Rate** - Target >55%
5. **Profit Factor** - Total wins / Total losses > 1.2

---

## 🎯 Next Improvements to Try

1. **Return to Test #3 settings** - Best performer, don't over-engineer
2. **Add trend strength filter** - Skip symbols with trendStrength > 0.7 (too trendy)
3. **Reduce momentum threshold** - 0.05% may be too high, try 0.02%
4. **Minimum price filter** - Avoid ultra-low price symbols (more volatile)
5. **Time-of-day analysis** - Are certain hours more profitable?

---

## 📝 Symbol Performance Notes

### Consistently Good
- **@267** - High beta, quick profits
- **FOGO** - Works well in ranging markets
- **@184** - Many small wins

### Problematic
- **MEGA** - Extreme volatility, large losses when wrong
- **BIO** - Repeated fast_stops in Test #3-4
- **@243** - 4 consecutive fast_stops in one test
- **BABY** - 3 fast_stops in Test #7

### Variable
- **@174** - Both best (+$1.15) and worst (-$1.81) in same test

---

*Last Updated: 2026-01-07 21:46 UTC*
