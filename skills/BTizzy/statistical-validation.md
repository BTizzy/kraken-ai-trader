# Statistical Validation for Trading Strategies

## Overview
How to validate prediction market trading strategies using real data, avoid backtesting illusions, and distinguish signal from noise. Based on Feb 2026 kraken-ai-trader validation.

## Core Problem

**Most trading strategies fail not because they're badly coded, but because they have no edge.**

Your Feb 17, 2026 validation:
- Simulated: +$14.20 profit, 45.2% win rate
- Reality: Strategy NOT viable (spreads too wide, no market matches)

This validation was SUCCESS — knowing what doesn't work is as valuable as finding what does.

---

## Validation Framework

### Phase 1: Hypothesis Definition

**Define EXACTLY what you're testing:**

❌ Bad: "Can I make money on prediction markets?"
✅ Good: "Can I profit from Polymarket-Kalshi price discrepancies where NO + YES < $0.97?"

**Specify:**
- Entry conditions (what triggers a trade?)
- Exit conditions (when do you close?)
- Position sizing (how much per trade?)
- Success criteria (what win rate/profit = viable?)

**Example from your repo:**
```javascript
// BEFORE validation
const hypothesis = {
  strategy: "Gemini price-lag arbitrage",
  entry: "Polymarket moves ≥3¢ in <10s",
  target_profit: "$50/day with $500 capital",
  assumptions: [
    "Gemini lags Polymarket by 3-15s",
    "Gemini spreads are 2-4¢",
    "Markets match across platforms"
  ]
};
```

---

### Phase 2: Data Collection (Observation Mode)

**CRITICAL: Do NOT trade during this phase**

Collect for 12–48 hours:
```javascript
const observationLog = {
  timestamp: Date.now(),
  polymarket_price: { bid: 0.52, ask: 0.54 },
  kalshi_price:     { bid: 0.51, ask: 0.55 },
  gemini_price:     { bid: 0.48, ask: 0.54 }, // REAL data, not simulated!

  // Track what WOULD have happened
  signal_generated: true,
  opportunity_score: 65,
  would_have_entered: true,

  // Track outcome 60s later
  gemini_price_60s_later: 0.49,
  signal_correct: false // Didn't converge as expected
};
```

**Metrics to Track:**
- Opportunity frequency (signals per hour)
- Signal accuracy (% where prediction was correct)
- Price movements (did prices move as expected?)
- Execution feasibility (opportunities last >5s?)

**Your Feb 17 Results:**
- Gemini spreads: 4–6¢ (REAL) vs 2–3¢ (simulated) = 2× worse
- Market matches: 0 (Gemini has different events entirely)
- Price movement: 1.1¢/5min vs 5.6¢ needed = 5× too small

---

### Phase 3: Fee-Adjusted Modeling

**CRITICAL: Model fees BEFORE calculating profitability**

```javascript
function calculateBreakeven(strategy) {
  const fees = {
    polymarket_taker: 0.02,   // 2%
    kalshi:           0.012,  // 1.2%
    gemini:           0.0005, // 0.05%
    slippage:         0.005   // 0.5¢ avg
  };

  // For arbitrage (both platforms)
  const totalCost = fees.polymarket_taker + fees.kalshi + fees.slippage;

  console.log(`Need >${(totalCost * 100).toFixed(2)}% price differential to break even`);
  // Result: "Need >3.7% price differential to break even"
}
```

**Example Calculation:**
```
Signal: Poly NO $0.56 + Kalshi YES $0.42 = $0.98 total

Gross profit: $1.00 - $0.98 = $0.02 (2% return)

Fees:
  Polymarket: $0.56 × 2%   = $0.0112
  Kalshi:     $0.42 × 1.2% = $0.0050
  Slippage:                  ~$0.0050
Total:                        $0.0212

Net result: $0.02 - $0.0212 = -$0.0012 (LOSING TRADE!)
```

**Key Insight:** 2% gross profit → NEGATIVE after fees

---

### Phase 4: Paper Trading (Real Prices)

**Use REAL price feeds, simulate REALISTIC fills**

```javascript
class RealisticPaperTrading {
  async executeTrade(opportunity) {
    // Re-fetch prices at execution moment (opportunity may have expired)
    const current = await this.getCurrentPrices(opportunity.market);

    // Check if still profitable after re-fetch
    const stillValid = this.validateOpportunity(current);
    if (!stillValid) {
      return { success: false, reason: 'opportunity_expired' };
    }

    // Simulate realistic execution scenarios
    const scenarios = {
      both_fill:     0.65,  // 65% of time both sides fill
      only_one_fill: 0.20,  // 20% partial fill — creates directional risk
      neither_fills: 0.15   // 15% opportunity gone before execution
    };

    const outcome = this.sampleOutcome(scenarios);

    if (outcome === 'only_one_fill') {
      // Immediately hedge the open leg to prevent directional exposure
      await this.hedgeOpenLeg(opportunity);
      return { success: false, reason: 'partial_fill_hedged' };
    }

    return { success: outcome === 'both_fill', reason: outcome };
  }
}
```

**Paper Trading Checklist:**
- [ ] Price feeds are live API data (not simulated/cached)
- [ ] Fees deducted on every trade (both entry and exit)
- [ ] Slippage modeled (0.5% minimum, scale with size)
- [ ] Partial fills simulated (one side may not execute)
- [ ] Opportunities re-validated at execution time
- [ ] Min 100 trades before drawing conclusions

---

### Phase 5: Statistical Significance Testing

**Don't trust small samples**

```javascript
function isStrategySignificant(trades) {
  const n = trades.length;
  if (n < 30) return { significant: false, reason: 'need_30_minimum' };

  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = wins / n;

  // Null hypothesis: win rate = 50% (random)
  // One-tailed binomial test (is win rate significantly > 50%?)
  const se = Math.sqrt(0.5 * 0.5 / n); // Standard error under null
  const z = (winRate - 0.5) / se;

  // z > 1.645 = significant at 95% confidence
  const significant = z > 1.645;

  const avgPnl = trades.reduce((s, t) => s + t.pnl, 0) / n;

  return {
    significant,
    z_score:   z.toFixed(2),
    win_rate:  winRate.toFixed(3),
    avg_pnl:   avgPnl.toFixed(4),
    viable:    significant && avgPnl > 0,
    trades_needed: Math.ceil(Math.pow(1.645 / Math.max(0.001, winRate - 0.5), 2) * 0.25)
  };
}
```

**Sample Size Guide:**

| Win Rate | Trades for 95% Confidence |
|----------|--------------------------|
| 55% | 271 trades |
| 60% | 68 trades |
| 65% | 30 trades |
| 70% | 17 trades |

**Rule:** Never go live with <100 paper trades. Sharpe >2.0 + 100+ trades is your go-live gate.

---

## Backtesting Anti-Patterns

### Anti-Pattern 1: Look-Ahead Bias
```javascript
// ❌ WRONG — uses future price to determine entry
function badBacktest(prices) {
  for (let i = 0; i < prices.length; i++) {
    if (prices[i + 5] > prices[i] * 1.02) { // Using future price!
      recordEntry(prices[i]);
    }
  }
}

// ✅ CORRECT — entry decision uses only data available at that moment
function goodBacktest(prices) {
  for (let i = 20; i < prices.length; i++) {
    const signal = calculateSignal(prices.slice(0, i)); // Only past data
    if (signal.actionable) recordEntry(prices[i]);
  }
}
```

### Anti-Pattern 2: Survivorship Bias
```
Problem: Only backtesting markets that existed long enough to resolve
Solution: Include ALL markets, even those suspended or cancelled
Impact:   Cancelled markets often come from tail-risk events = large losses
```

### Anti-Pattern 3: Overfitting Parameters
```javascript
// ❌ WRONG — optimizing parameters on the SAME data you test on
function badOptimization(allData) {
  for (const threshold of [30, 40, 50, 60, 70]) {
    const result = backtest(allData, { entry_threshold: threshold });
    if (result.sharpe > best.sharpe) best = result; // Cherry-picking!
  }
}

// ✅ CORRECT — walk-forward validation
function goodOptimization(allData) {
  const trainData = allData.slice(0, 0.7 * allData.length); // 70% train
  const testData  = allData.slice(0.7 * allData.length);    // 30% test

  const params = optimizeOn(trainData);
  return backtest(testData, params); // Never seen before → true OOS performance
}
```

### Anti-Pattern 4: Artificial Price Convergence
```javascript
// ❌ What the original bot was doing (V1–V8)
// Simulating Gemini prices that converge toward Polymarket at a fixed rate
updatePaperMarket(marketId, refPrice) {
  const current = this.paperMarkets.get(marketId);
  const convergenceRate = 0.15;
  // This creates FAKE lag that generates FAKE alpha
  const newPrice = current + (refPrice - current) * convergenceRate;
  this.paperMarkets.set(marketId, newPrice); // Paper profits = simulation artifact
}

// ✅ Correct: use real Gemini API prices (V9+ fix)
async getMarketState(marketId) {
  const realPrices = this.realClient.getBestPrices(marketId);
  return realPrices ? { ...realPrices, isReal: true } : this.paperSimulate(marketId);
}
```

**This was the V9 fix.** Switching to real prices revealed the price-lag strategy had no edge.

---

## Metrics Reference

### Primary KPIs

| Metric | Formula | Target | Red Flag |
|--------|---------|--------|----------|
| Win Rate | wins / total | >55% | <50% |
| Profit Factor | sum(wins) / sum(losses) | >1.5 | <1.1 |
| Sharpe Ratio | avg_pnl / std_pnl × √252 | >2.0 | >10 (probably fake) |
| Max Drawdown | peak_to_trough / peak | <20% | >30% |
| Avg P&L / trade | total_pnl / n | >$1.00 | <$0.50 |
| Break-Even WR | fees / (fees + avg_win) | — | if >actual WR = losing |

### Secondary KPIs

| Metric | Formula | Why It Matters |
|--------|---------|----------------|
| Opportunity Frequency | signals/hour | Too low = can't reach income target |
| Fill Rate | fills / signals | Low = strategy works only in theory |
| Fee Drag | total_fees / total_pnl | >50% = fees destroying you |
| Hold Time | avg seconds in position | Very short = latency-sensitive |
| Exit Reason Distribution | % by type | Heavy `time_exit` = signals aren't working |

### Current Paper Stats (Feb 2026)
```
Starting balance:  $500
P&L after ~10min:  +$8.45 (+1.69%)
Exit reasons:      take_profit (good), time_exit (neutral), time_decay_stop (good)
Fee model (V11+):  0.01% maker-or-cancel (corrected from 0.06%)
```

---

## Interpreting Suspicious Results

### Sharpe Ratio >10
```
Bot V8 paper Sharpe was 17.38 → This is a red flag.
Real hedge funds achieve 1–3. HFT firms achieve 3–6.
Sharpe >10 almost always means:
  1. Simulation artifact (artificial convergence)
  2. Overfitted parameters on in-sample data
  3. Look-ahead bias
  4. Fees or slippage not modeled
```

### Win Rate Exactly 50%
```
Suggests strategy is random (no edge).
But check: are you profitable anyway?
High avg_win vs low avg_loss = Kelly-positive even at 50% WR.
```

### Win Rate >70% with Small Sample
```
Need significance test before trusting it.
70% win rate on 20 trades could easily be 50% in reality.
Wait for 30+ trades (95% confidence) or 100+ (reliable estimate).
```

---

## Go-Live Decision Framework

```
Paper Performance Gates (all must pass before live):

1. Sample size:        ≥100 closed trades
2. Win rate:           >55% after all fees
3. Profit factor:      >1.3
4. Max drawdown:       <20% during paper run
5. Sharpe ratio:       >1.5 and <10 (realistic range)
6. Avg P&L / trade:    >$0.50
7. Opportunity freq:   >5 actionable signals/day
8. Price feeds:        REAL prices (isReal: true in gemini state)

If ALL pass → Start live with 10% of intended capital for 2 weeks
If any fail → Investigate that metric; do not proceed
```

---

## Version History
- v1.0.0 (2026-02-18): Initial version based on Feb 2026 kraken-ai-trader validation
