# Prediction Market Strategies — Skill Reference

## Fee Landscape (as of Feb 2026)

| Platform | Fee Structure | Effective Round-Trip |
|----------|--------------|---------------------|
| **Gemini Predictions** | 0.05% flat + 0.01% maker | **~0.12%** |
| Kalshi | ~1.2% effective | ~2.4% |
| Polymarket | 0.01% maker / 2% taker | ~4% taker |
| PredictIt | 10% profits + 5% withdrawal | ~15% |

**Gemini is the cheapest by 20x.** This eliminates fees as a barrier — breakeven is essentially just the bid-ask spread.

---

## Platform Market Structures

### Gemini Predictions (Gemini Titan, LLC — CFTC-registered DCM)
- **Type**: Binary "above" contracts — "BTC > $67,500 on Feb 18 at 8am EST"
- **Settlement**: Daily (8am, 12pm EST) and multi-day
- **Assets**: BTC, ETH, SOL  
- **Pricing**: $0.00–$1.00 per contract (probabilistic)
- **API**: `GET https://www.gemini.com/prediction-markets?status=active&category=crypto`
- **Volume**: Low (typically 500–15,000 contracts per event)
- **Liquidity**: Thin — median spread 4¢, tightest ~1¢
- **Edge**: Low volume = inefficient pricing. Cheapest fees = widest profit margins.

### Kalshi (CFTC-registered DCM)
- **Type**: "Between" range brackets — "$67,750 to $67,999.99"
- **Settlement**: Same daily schedule (12pm, 5pm EST)
- **Assets**: BTC, ETH
- **Pricing**: $0.00–$1.00 (cents-based: 0–100)
- **API**: `GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC`
- **Volume**: Higher (5,000–10,000+ per bracket)
- **CRITICAL**: Kalshi brackets can be summed to create **synthetic "above"** contracts matching Gemini's structure

### Mathematical Relationship
```
Gemini: P(BTC > $67,500) = single contract

Kalshi:  P(BTC > $67,500) = P(BTC in [$67,500-$67,750]) 
                          + P(BTC in [$67,750-$68,000])
                          + P(BTC in [$68,000-$68,250])
                          + ... + P(BTC in [$77,750-$78,000])
                          + P(BTC >= $78,000)

If Gemini price ≠ Kalshi synthetic sum → mispricing → EDGE
```

### Polymarket  
- Not useful for cross-platform — different market structures (long-term, non-bracket)
- Only 1 BTC market found ("Will BTC hit $1M before GTA VI?") — not matchable

---

## Strategy 1: Kalshi-Informed Fair Value Trading

### Concept
Use Kalshi's deeper liquidity as a **price oracle** to determine fair value for Gemini contracts. Trade on Gemini when its price deviates from Kalshi-implied fair value.

### How It Works
1. **Fetch Kalshi brackets** for the same event (KXBTC-26FEB1712 = "BTC at 12pm Feb 17")
2. **Sum bracket probabilities** from strike upward to compute P(BTC > X)
3. **Compare** with Gemini's contract price for "BTC > $X"
4. **Trade** when deviation exceeds spread + threshold

### Signal Generation
```
kalshi_fair_value = sum(kalshi_bracket_mids from strike_X upward)
gemini_ask = current Gemini ask price

IF gemini_ask < kalshi_fair_value - threshold:
    BUY on Gemini (underpriced relative to Kalshi consensus)
    
IF gemini_bid > kalshi_fair_value + threshold:
    SELL on Gemini (overpriced relative to Kalshi consensus)
```

### Edge Sizing (observed Feb 17, 2026)
- "BTC > $67,500": Gemini ask=0.59, Kalshi synthetic=0.83 → **24¢ edge**
- "BTC > $68,250": Gemini ask=0.17, Kalshi synthetic=0.27 → **10¢ edge**
- With 0.12% fees, breakeven is <0.1¢ → nearly ALL edge is profit

### Risks
- Strike misalignment: Gemini uses round numbers ($67,500), Kalshi uses $250 increments ($67,500-$67,749.99). Must handle carefully.
- Timing: Different settlement times (Gemini 8am/12pm vs Kalshi 12pm/5pm)
- Kalshi bracket sum can exceed 1.0 due to bid-ask spreads embedded in each bracket
- Use Kalshi **mid-prices** for fair value estimation, not bid or ask sums

---

## Strategy 2: Spot-Price Fair Value (Black-Scholes Analog)

### Concept
Calculate the "correct" probability of "BTC > $67,500 by 12pm EST" using:
- Current BTC spot price (from Kraken/Gemini exchange)
- Historical BTC volatility
- Time to expiry

Then trade Gemini contracts when they deviate from this calculated fair value.

### Formula (Binary Option Pricing)
```
P(S > K at time T) = Φ(d2)

where:
  d2 = [ln(S/K) + (r - σ²/2) × T] / (σ × √T)
  S = current spot price
  K = strike price  
  T = time to expiry (in years)
  σ = annualized volatility (use recent 24h–7d realized vol)
  r = risk-free rate (≈0 for short-term)
  Φ = standard normal CDF
```

### Example
- BTC spot = $67,800
- Strike = $67,500 (Gemini: "BTC > $67,500")
- Time to expiry = 4 hours = 4/8760 years
- σ (24h realized vol) = 45% annualized
- d2 = [ln(67800/67500) + (0 - 0.2025/2) × 0.000457] / (0.45 × 0.0214) = 0.461
- P(BTC > $67,500) = Φ(0.461) = 0.678

If Gemini shows ask=0.59, the contract is **underpriced** by 8.8¢ → BUY.

### Advantages
- No dependency on Kalshi availability
- Works for ALL Gemini contracts, not just ones with Kalshi matches
- Can use Kraken API (already integrated) for spot price
- Volatility can be computed from historical data we already collect

### Risks
- Assumes log-normal distribution (crypto has fat tails)
- Volatility estimation is imprecise for very short timeframes
- Jump risk: sudden large moves can invalidate continuous model
- Solution: Use a volatility premium (inflate σ by 10-20%)

---

## Strategy 3: Market Making on Gemini

### Concept
Place limit orders on BOTH sides of Gemini's orderbook, earning the bid-ask spread. Low volume = we can BE the market maker.

### How It Works
1. Determine fair value (using Strategy 1 or 2)
2. Place a BID at `fair_value - half_spread`
3. Place an ASK at `fair_value + half_spread`
4. When both sides fill, profit = spread - fees

### Example
- Fair value for "BTC > $67,500" = 0.65
- Place bid at 0.62, ask at 0.68
- If both fill: profit = (0.68 - 0.62) - fees = 6¢ - 0.08¢ = **5.92¢ per contract**

### Advantages
- Earns spread on EVERY fill (not just when market moves in our direction)
- Gemini's 0.01% maker fee means almost zero cost for limit orders
- Low competition (thin liquidity = few market makers)

### Risks
- Adverse selection: getting filled only on the wrong side
- Inventory risk: accumulating one-sided positions
- Requires limit order API access (need to verify Gemini supports this)
- Solution: Delta-hedge inventory using the Gemini/Kraken spot market

---

## Strategy 4: Event-Driven Momentum

### Concept
Monitor real-time BTC/ETH spot price changes. When spot moves significantly, prediction market contracts should reprice but may LAG on low-volume Gemini.

### How It Works
1. Monitor BTC spot via WebSocket (already have Kraken WS)
2. When BTC moves >$100 in <5 min, check if Gemini contracts have repriced
3. If stale: buy contracts that SHOULD have increased, sell those that SHOULD have decreased

### Example
- BTC was $67,500, moves to $67,800 in 2 minutes
- "BTC > $67,500" should be worth ~0.70 now (was 0.55)
- If Gemini still shows ask=0.59, buy immediately
- Expected profit: ~11¢ per contract when price catches up

### Advantages
- Leverages existing Kraken WebSocket infrastructure
- Low volume = slower repricing = bigger window to act
- Can quantify expected contract price change per $1 of BTC movement (delta)

### Delta Estimation
```
contract_delta = dP/dS ≈ φ(d2) / (S × σ × √T)

For BTC > $67,500 at S=$67,800, σ=45%, T=4h:
  delta ≈ 0.00047 per $1 of BTC movement
  → $100 BTC move → 4.7¢ contract price change
  → $500 BTC move → 23.5¢ contract price change
```

---

## Strategy 5: Cross-Platform Synthetic Arbitrage

### Concept
True arbitrage: buy an equivalent position on one platform, sell on another, locking in riskless profit. Uses the Kalshi-to-Gemini synthetic relationship.

### How It Works
1. **BUY YES on Gemini** "BTC > $67,500" at ask=0.59
2. **SELL equivalent on Kalshi**: Short all brackets from $67,500 upward
   - This creates a synthetic NO position equivalent to "BTC ≤ $67,500"
3. Total cost: Gemini ask (0.59) + Kalshi bracket costs
4. If sum < 1.00: **locked profit = 1.00 - total cost**

### Challenges
- Must short multiple Kalshi brackets simultaneously (execution risk)
- Kalshi bracket liquidity may not support full position size
- Settlement time differences create residual risk
- Requires accounts on BOTH platforms

### Feasibility
Medium. Requires Kalshi API integration with trading capability. The price gaps observed (10-24¢) are large enough to be highly profitable, but execution complexity is high.

---

## Recommended Implementation Priority

### Phase 1: Spot-Price Fair Value (Strategy 2) — IMPLEMENT FIRST
- **Why**: Zero external dependencies, uses existing Kraken API
- **Expected edge**: 5-15¢ per trade on mispriced contracts
- **Required**: Volatility calculator, Black-Scholes pricing, signal threshold tuning
- **Development time**: Medium

### Phase 2: Kalshi-Informed Fair Value (Strategy 1) — IMPLEMENT SECOND  
- **Why**: Kalshi data is free, public API, provides market-consensus fair value
- **Expected edge**: 10-24¢ per trade based on observed data
- **Required**: Kalshi API client, bracket-to-above converter, cross-platform matcher
- **Development time**: Medium

### Phase 3: Event-Driven Momentum (Strategy 4) — IMPLEMENT THIRD
- **Why**: Leverages real-time spot data + low Gemini liquidity for timing edge
- **Expected edge**: 5-25¢ per trade when spot moves significantly
- **Required**: Spot price momentum detector, contract delta calculator
- **Development time**: Low (extends existing infrastructure)

### Phase 4: Market Making (Strategy 3) — REQUIRES API VERIFICATION
- **Why**: Consistent income from spread capture
- **Blocker**: Need to confirm Gemini supports limit orders via API for predictions
- **Development time**: High

---

## Key Numbers for Trading Parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Gemini fee per side | 0.06% (0.05% flat + 0.01% maker) | User research |
| Round-trip fee cost | ~0.12% | Calculated |
| On $50 position | $0.06 fees | Trivial |
| Kalshi fee | ~1.2% effective | 2025 revenue data |
| Median Gemini spread | 4.0¢ | Live observation |
| Tightest Gemini spread | 1.0¢ | Live observation |
| BTC 24h realized vol | ~45% annualized | Typical |
| Contract delta (ATM) | ~0.0005/$ | Calculated |
| Min edge threshold | >3¢ (spread) | Conservative |

---

*Created: February 17, 2026*  
*Data sources: Live Gemini & Kalshi APIs, observed market data*
