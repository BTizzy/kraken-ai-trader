# Prediction Market Bot Architecture

## Overview
How to design, build, and deploy profitable prediction market trading bots. Covers arbitrage vs market making strategies, execution patterns, and real-world constraints from Feb 2026 validation.

## Core Concepts

### Market Structure
Prediction markets are binary outcome contracts where YES + NO = $1.00 (always).

**Key Properties:**
- Zero-sum: Every dollar won = dollar lost by counterparty
- Bounded outcomes: Prices between $0.01 - $0.99
- Time-limited: Contracts resolve at specific event
- Fee-dependent: 0.01% - 2% fees drastically impact profitability

### Platform Comparison (Feb 2026)

| Platform | Volume | Fees | Liquidity | API Access |
|----------|--------|------|-----------|------------|
| Polymarket | $3.74B/mo | 0.01% maker, 2% taker | High | CLOB API (free) |
| Kalshi | $5.8B/mo | ~1.2% effective | High | Free tier (60 req/min) |
| Gemini Predictions | <$100M/mo | 0.05% + 0.01% maker | Low | Public API |

---

## Strategy Types

### 1. Statistical Arbitrage (Risk-Free)

**Principle:** Exploit price-sum violations across platforms

**Example:**
```
Polymarket NO ask: $0.56
Kalshi YES ask:    $0.42
Total cost:        $0.98
Guaranteed payout: $1.00
Gross profit:      $0.02 (2.04%)

Fees:
  Polymarket taker: 2% × $0.56  = $0.0112
  Kalshi:           1.2% × $0.42 = $0.0050
Total fees:         $0.0162

Net profit: $0.0038 (0.39% return)
```

**Requirements:**
- EXACT market matching (same event, same resolution source)
- Simultaneous execution (both sides must fill)
- Partial fill handling (hedge if only one side executes)
- Low latency (<500ms total execution time)

**Profitability Factors:**
- Opportunity frequency: Need 20+ per day for $50/day target
- Success rate: >65% both sides filling
- Net profit after fees: >$0.50 per trade minimum

**Proven Results:** $40M extracted Apr 2024–Apr 2025, top 3 wallets: $4.2M profit

---

### 2. Market Making (Capital Intensive)

**Principle:** Provide liquidity, profit from bid-ask spread

**Strategy:**
```javascript
// Adapted Stoikov model for binary outcomes
function calculateQuotes(fairValue, inventory, spread) {
  const baseSpread = 0.02; // 2¢ spread

  // Skew quotes based on inventory
  const inventorySkew = inventory * 0.005; // 0.5¢ per $100 inventory

  const bid = fairValue - baseSpread/2 - inventorySkew;
  const ask = fairValue + baseSpread/2 - inventorySkew;

  return { bid, ask };
}
```

**Example:**
```
Fair Value: $0.50 (50% probability)
Base Spread: 2¢
Inventory: +$500 long

Bid: $0.49 - $0.0025 = $0.4875
Ask: $0.51 - $0.0025 = $0.5075

On fill: Earn 2.5¢ per contract ($0.5075 - $0.4875)
```

**Requirements:**
- Fair value pricing model (polls, news, other platforms)
- Inventory management (avoid getting stuck directionally)
- Real-time orderbook monitoring
- Risk controls (max inventory, max drawdown)

**Proven Results:** One bot made $181K across 1M trades (2025)

---

### 3. Price Lag Exploitation (FAILED — Learn From This)

**Original Hypothesis:** Gemini prices lag Polymarket by 3–15 seconds

**Validation Results (Feb 17, 2026):**
- ❌ Real Gemini spreads: 4–6¢ (vs 2–3¢ simulated)
- ❌ Zero cross-platform matches (different market types)
- ❌ Price movements: 1.1¢/5min (vs 5.6¢ breakeven)

**Key Lesson:** Validate with REAL data before building infrastructure

---

## Architecture Patterns

### Modular Design
```
/lib
  polymarket_client.js      # API wrapper
  kalshi_client.js          # API wrapper
  gemini_client.js          # API wrapper (real or simulated)
  market_matcher.js         # Cross-platform matching
  signal_detector.js        # Opportunity scoring
  paper_trading_engine.js   # Execution simulation

/server
  prediction-proxy.js       # API aggregator
  rate-limiter.js           # Request throttling

/data
  trades.db                 # SQLite (single source of truth)
  market_cache.json         # In-memory price cache

/config
  prediction_params.json    # Tunable parameters
```

### Data Flow
```
1. API Clients       → Real-time prices (WebSocket preferred)
2. Market Matcher    → Identify same events across platforms
3. Signal Detector   → Calculate opportunity scores
4. Trading Engine    → Execute trades (paper or live)
5. Database          → Log every trade for learning
6. Learning Engine   → Adjust parameters based on results
```

### Critical Components

**Market Matching (Hardest Part):**
```javascript
// Manual verification required — no fuzzy matching!
const marketMappings = {
  "trump_2024_election": {
    polymarket_token_id: "21742633...",
    kalshi_ticker: "USPREZ24-TRUMP",
    match_confidence: 1.0, // Manual verification = 100%
    last_verified: "2026-02-17"
  }
};
```

**Fee Calculation (Make or Break):**
```javascript
function calculateNetPnL(entry, exit, size, platform) {
  const grossPnL = (exit - entry) * size;

  const fees = {
    polymarket: size * entry * 0.02,   // 2% taker
    kalshi:     size * entry * 0.012,  // 1.2% effective
    gemini:     size * entry * 0.0005  // 0.05%
  };

  const slippage = size > 100 ? 0.01 : 0.005; // Size-dependent

  return grossPnL - fees[platform] - (size * slippage);
}
```

---

## Performance Metrics

### Must Track
- **Win Rate (after fees):** >55% required for viability
- **Profit Factor:** Wins/Losses ratio, target >1.5
- **Sharpe Ratio:** Risk-adjusted returns, target >2.0
- **Max Drawdown:** Must stay <20%
- **Opportunity Frequency:** Signals per day
- **Success Rate:** % of trades where both sides fill

### Red Flags
- Win rate <50% = strategy has no edge
- Profit factor <1.1 = fees eating all profits
- Sharpe >10 = likely simulation artifact (17.38 was suspiciously high)
- Avg P&L <$1 = not worth execution complexity

---

## Common Failure Modes

### 1. Simulated Profits
- **Problem:** Bot creates artificial price lag
- **Detection:** Code like `laggedPrice = ref * convergenceRate`
- **Solution:** Validate with REAL API data

### 2. Fee Ignorance
- **Problem:** 2–3% gross becomes 0.5% net after fees
- **Detection:** Paper profits disappear in live trading
- **Solution:** Model fees FIRST, before strategy

### 3. Backtesting Illusions
- **Problem:** Different price feeds for backtest vs live
- **Detection:** Gamma API (backtest) vs CLOB API (live) mismatch
- **Solution:** Use SAME data source for both

### 4. Partial Fills
- **Problem:** One side executes, other doesn't = directional risk
- **Detection:** Losing money on "risk-free" arbitrage
- **Solution:** Hedge immediately if partial fill occurs

---

## Deployment Checklist

**Before Going Live:**
- [ ] Validate strategy with 48+ hours real data observation
- [ ] Calculate fees for EVERY trade (gross vs net P&L)
- [ ] Test partial fill handling (what if only one side executes?)
- [ ] Implement kill switches (max loss, error rate, drawdown)
- [ ] Paper trade for 100+ trades with REAL prices
- [ ] Achieve >55% win rate AFTER fees
- [ ] Document failure modes (what makes strategy stop working?)

**Infrastructure:**
- [ ] WebSocket connections for real-time prices
- [ ] Rate limiting (respect API limits)
- [ ] Error handling (retry logic, exponential backoff)
- [ ] Logging (every trade, every signal, every error)
- [ ] Monitoring (uptime, P&L, position tracking)

**Capital Requirements:**
- Statistical Arb: $500–1k minimum (can scale quickly)
- Market Making: $5–10k recommended (need inventory buffer)
- High-Frequency: $10k+ (need capital for simultaneous positions)

---

## Best Practices

1. **Start with Observation:** Collect data for 24h BEFORE trading
2. **Model Fees First:** Know your breakeven point
3. **Validate Assumptions:** Test on real markets, not simulations
4. **Handle Edge Cases:** Partial fills, API errors, market suspensions
5. **Learn from Losses:** 45% win rate taught you fees matter
6. **Document Everything:** Future you will thank present you

---

## Resources
- Polymarket CLOB API: https://docs.polymarket.com/
- Kalshi API: https://trading-api.kalshi.com/trade-api/v2/
- Gemini Predictions: https://docs.gemini.com/prediction-markets/
- Research: "$40M extracted from Polymarket arbitrage (2024–2025)"

---

## Version History
- v1.0.0 (2026-02-18): Initial version based on Feb 2026 validation
