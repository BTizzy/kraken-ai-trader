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
| 11 | 2026-01-07 | **72%** | **+$3.35** | Data-Driven Mean Reversion v4.0 | ✅ **BEST RUN** - β≥0.10, symbol cooldowns, FOGO/@267 dominate |
| 12 | 2026-01-07 | 56% | +$3.07 | Data-Driven Mean Reversion v5.0 | β≥0.20, beta-scaling positions, wider exits (1.5x) - **REGRESSION** |
| 13 | 2026-01-07 | **72%** | **-$1.27** | Data-Driven Mean Reversion v6.0 | ⚠️ **POSITION SIZING ISSUE** - β≥0.10, 1.0x exits, conservative sizing, but high-beta losses persist |
| 14 | 2026-01-08 | **96%** | **+$4.13** | Data-Driven Mean Reversion v7.0 | ✅ **BETA FILTERING WORKED** - β≥0.10, β≤0.5, 1.0x exits, no catastrophic losses |

---

## 📈 Data-Driven Improvement (after Test #11)

**Analysis of Test #11 data (72% WR, +$3.35):**
- **Symbol Performance:**
  - FOGO: 76.2% WR, +$2.55 (21 trades) - **dominant performer**
  - @267: 100% WR, +$0.99 (1 trade) - excellent but limited data
  - PEOPLE: 50% WR, -$0.13 (2 trades)
  - kPEPE: 0% WR, -$0.04 (1 trade)

- **Beta Range Performance:**
  - β≥0.30: 100% WR, +$0.31 avg P&L (6 trades)
  - β≥0.20-0.25: 83.3% WR, +$0.13 avg P&L
  - β≥0.15-0.20: 57.1% WR, -$0.00 avg P&L
  - β≥0.10-0.15: 50% WR, +$0.20 avg P&L
  - β<0.15: Lower performance

- **Exit Reason Performance:**
  - profit_target: 100% WR, +$0.34 avg P&L
  - quick_profit: 100% WR, +$0.10 avg P&L
  - reversion_complete: 66.7% WR, +$0.04 avg P&L
  - fast_stop: 0% WR, -$0.18 avg P&L - **all losses**

**Changes for Test #12:**
1. **Beta threshold:** 0.10 → **0.20** (focus on higher-quality trades)
2. **Symbol whitelist:** Only trade FOGO and @267 (top performers)
3. **Position sizing:** Beta-scaled (β≥0.30: $150, β≥0.25: $125, β<0.20: $75)
4. **Exit adjustments:** Profit targets +50% (1.0x→1.5x, 3.0x→4.0x), stop loss +50% (1.0x→1.5x)

---

## 📉 Test #12 Regression Analysis

**Test #12 Results (56% WR, +$3.07):**
- **Symbol Performance:**
  - FOGO: 80% WR, +$1.31 (10 trades) - still strong
  - @267: 43% WR, +$0.94 (7 trades) - declined
  - ZEN: 50% WR, +$0.79 (2 trades)
  - @228: 33% WR, +$0.70 (3 trades)
  - @184: 33% WR, -$0.67 (3 trades)

- **Beta Range Performance:**
  - 0.20-0.30: 57% WR, -$0.06 avg P&L (7 trades)
  - 0.30-0.50: 75% WR, +$0.23 avg P&L (8 trades)
  - 1.0+: 40% WR, +$0.16 avg P&L (10 trades)

- **Exit Reason Performance:**
  - profit_target: 100% WR, +$0.99 avg P&L (5 trades)
  - fast_stop: 0% WR, -$0.46 avg P&L (7 trades) - **all losses**
  - reversion_complete: 20% WR, -$0.01 avg P&L (5 trades)
  - quick_profit: 100% WR, +$0.18 avg P&L (8 trades)

**Root Cause Analysis:**
1. **Beta threshold too high (0.20+):** Eliminated many opportunities, winners had lower beta (1.85 avg) than losers (3.22 avg)
2. **Wider exits hurt performance:** fast_stop exits still 0% win rate despite wider stops, reversion_complete only 20% wins
3. **Winners vs Losers:** Winners had shorter hold times (7.1s vs 17.1s), suggesting strategy works better with faster exits

**Changes for Test #13:**
1. **Beta threshold:** 0.20 → **0.10** (revert to proven setting)
2. **Exit multiples:** 1.5x → **1.0x** (revert to proven setting)
3. **Keep:** Symbol cooldowns, beta-scaling position sizing

---

## 📈 Test #13 Position Sizing Analysis

**Test #13 Results (72% WR, -$1.27):**
- **Symbol Performance:**
  - FOGO: 77.3% WR, +$2.15 (22 trades) - **dominant performer**
  - @248: 50% WR, +$0.29 (4 trades)
  - @204: 0% WR, -$4.13 (1 trade) - **catastrophic loss**
  - @184: 50% WR, -$0.04 (2 trades)

- **Beta Range Performance:**
  - 0.10-0.25: 75% WR, +$0.15 avg P&L (4 trades)
  - 0.25-0.35: 83.3% WR, +$0.20 avg P&L (6 trades)
  - 0.35-0.50: 100% WR, +$0.29 avg P&L (5 trades)
  - 0.50+: 25% WR, -$0.78 avg P&L (4 trades) - **problem range**

- **Exit Reason Performance:**
  - profit_target: 100% WR, +$0.26 avg P&L (17 trades)
  - fast_stop: 0% WR, -$0.82 avg P&L (7 trades) - **all losses**
  - quick_profit: 100% WR, +$0.21 avg P&L (1 trade)

**Root Cause Analysis:**
1. **High beta symbols still risky:** Even with $75 positions, β>0.5 symbols cause catastrophic losses (@204 -$4.13)
2. **Position sizing insufficient:** Conservative sizing helped but didn't eliminate high-volatility risks
3. **fast_stop still 0% wins:** All 7 fast_stops are losses, suggesting exit logic issues on volatile symbols

**Changes for Test #14:**
1. **Beta filtering:** Skip symbols with β > **0.5** entirely (eliminate catastrophic losses)
2. **Keep:** β≥0.10 threshold, 1.0x exits, symbol cooldowns, conservative position sizing

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

## 🔧 Current Strategy Configuration (Test #14)

**Data-Driven Mean Reversion v7.0**

### Entry Criteria

### Exit Criteria

### Position Sizing (Conservative Beta-Scaled)

### What Changed from Test #13


## 📈 Key Metrics to Watch


1. **Test #13:** Revert to proven settings (β≥0.10, 1.0x exits) to recover from Test #12 regression
4. **Reduce momentum threshold** - 0.05% may be too high, try 0.02%
5. **Minimum price filter** - Avoid ultra-low price symbols (more volatile)

## 📝 Symbol Performance Notes

### Consistently Good
- **@267** - High beta, quick profits
### Problematic
- **MEGA** - Extreme volatility, large losses when wrong
- **BIO** - Repeated fast_stops in Test #3-4
- **@243** - 4 consecutive fast_stops in one test
- **BABY** - 3 fast_stops in Test #7

### Variable
- **@174** - Both best (+$1.15) and worst (-$1.81) in same test

---

*Last Updated: 2026-01-07 23:45 UTC*
