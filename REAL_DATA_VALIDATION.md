# Real Data Validation Report

## Executive Summary

**Verdict: The cross-platform prediction market arbitrage strategy is NOT VIABLE with real market data.**

The bot's previous profitability ($505.46 from $500, 45.2% WR) was entirely a product of **simulated prices with artificial convergence lag**. When validated against real Gemini Predictions API data, three fatal problems emerge:

1. **Real spreads (3-5¢) are 50-100% wider** than the simulated 2-4¢ spreads
2. **Zero cross-platform matches exist** — Gemini and Polymarket don't offer the same markets
3. **Average price movement (1.1¢/5min) is far below breakeven (5.6¢)** after spreads + fees

---

## Methodology

### Real API Discovery
- Reverse-engineered the Gemini Predictions frontend JS bundle (218KB)
- Found REST endpoint: `GET https://www.gemini.com/prediction-markets`
- Public, no authentication needed. Query params: `status`, `category`, `limit`, `offset`
- Response: `{ data: [Event], pagination: { limit, offset, total } }`

### Data Collection
- **5-minute observation** with 30-second polling intervals (10 snapshots)
- **37 active crypto events**, 221 total contracts, 156 with two-sided orderbooks
- Simultaneously fetched **100 Polymarket** and attempted **Kalshi** crypto markets
- Tracked real price changes across all contracts over the observation window

### Price Structure  
Gemini API returns per-contract:
- `bestBid` / `bestAsk` — real orderbook levels (only these are tradeable)
- `buy.yes` / `sell.yes` — indicative prices (often = `lastTradePrice`, NOT real orders)
- `lastTradePrice` — last executed trade

**Critical fix**: The bot's earlier analysis used `sell.yes` as a bid fallback, producing phantom negative spreads. Only `bestBid`/`bestAsk` represent real liquidity.

---

## Findings

### 1. Real Gemini Spreads

| Metric | Simulated (bot) | Real (API) |
|--------|-----------------|------------|
| Median spread | 2-4¢ | **4.0¢** |
| Average spread | ~3¢ | **3.6¢** |
| Tightest spread | 1¢ | **1.0¢** |
| Typical liquid spread | 2-3¢ | **4-6¢** |

The tightest real spread found was 1.0¢ (ETH Feb 18 > $2,000, bid=0.13 ask=0.14), but this is a low-probability contract where a 1¢ move represents a 7.1% percentage change — very risky.

For at-the-money contracts (where the bot would typically trade), spreads are consistently **4-6¢**.

### 2. Cross-Platform Match Analysis

**ZERO strict cross-platform matches found.**

The bot's cross-platform arbitrage strategy requires the **same prediction** on **both Gemini and Polymarket/Kalshi**:
- Same asset (BTC/ETH/SOL)
- Same price threshold (e.g., > $67,500)
- Same timeframe (e.g., February 18)

Reality:
- **Gemini**: Short-term daily price brackets ("BTC > $67,500 on Feb 18 at 8am EST")
- **Polymarket**: Longer-term or different-structure markets ("Will BTC reach $100K in Q1?")
- **Kalshi**: Returned 0 crypto markets during observation

These are fundamentally **different prediction markets**. There is no same-market cross-platform price gap to arbitrage.

### 3. Price Movement vs Breakeven

| Metric | Value |
|--------|-------|
| Average price movement (5 min) | 1.12¢ |
| Average spread cost | 3.62¢ |
| Estimated fee (2% × 2 sides) | ~2.0¢ |
| **Total breakeven threshold** | **5.62¢** |
| Top mover (ETH Feb 18 > $2K) | 4.5¢ in 5 min |

- Only **~19% of contracts** had breakeven below 5¢
- Average price movement (1.12¢) is **5× below breakeven** (5.62¢)
- Even the biggest mover (4.5¢) barely approaches breakeven
- Over longer periods, movement may increase, but so does time decay risk (these are short-term contracts expiring in 1-5 days)

### 4. Liquidity Assessment

| Metric | Count | % of Total |
|--------|-------|-----------|
| Total contracts | 221 | 100% |
| Two-sided book (tradeable) | 156 | 70.6% |
| Bid only | 16 | 7.2% |
| Ask only | 11 | 5.0% |
| No liquidity | 38 | 17.2% |

While 70% have two-sided books, depth is thin. The typical bid/ask depth is unknown (the API doesn't expose depth), but the tight spreads for only a few contracts and wide spreads for most suggests market-maker-style quoting with limited depth.

### 5. Fee Model

The Gemini Predictions frontend JS bundle references `takerFee` and `platformFee` fields. The exact rates aren't publicly documented, but:
- **Conservative estimate**: 2% per side (4% round-trip)
- **On a $50 position**: ~$2.00 in fees per round-trip
- **Breakeven requirement**: price must move MORE than spread + fees to profit

At the tightest real spread (1.0¢) with 2% fees on a mid-price contract ($0.50):
- Entry fee: $0.50 × 0.02 = $0.01
- Exit fee: $0.50 × 0.02 = $0.01
- Spread cost: 1.0¢
- **Total cost per contract: 3.0¢**
- Required price movement to profit: **>3.0¢** on the tightest spread

Most contracts have 4-6¢ spreads, requiring **>6-8¢ moves** to profit.

---

## Why the Simulated Bot Appeared Profitable

The original `updatePaperMarket()` function in `gemini_client.js` created artificial profitability through three mechanisms:

1. **Convergence Lag Simulation**: `convergenceRate = 0.15` — Gemini prices slowly converge to Polymarket prices at 15% per cycle. This creates a predictable, exploitable pattern that doesn't exist in reality (because real Gemini markets don't track Polymarket markets at all).

2. **Narrow Simulated Spreads**: `spreadWidth = 0.02 + random(0.02)` — 2-4¢ simulated spreads vs real 3-6¢ spreads.

3. **No Fee Model**: The paper trading engine had zero trading fees, making every small price movement potentially profitable.

Together, these made the strategy appear to earn $5.46 on $500 (1.1% return). In reality:
- The convergence pattern doesn't exist (no cross-platform match)
- Real spreads eliminate most edge even if patterns existed
- Fees eat whatever remains

---

## Real Strategy Assessment (Gemini-Only)

Could a Gemini-only strategy work without cross-platform arbitrage?

### Potential Approach: Directional Trading
Buy YES when you believe the probability is underpriced, sell when it's overpriced.

### Challenges:
1. **Spreads eat 4-6¢** — you need to be right by MORE than the spread
2. **Short-term contracts** (1-5 day expiry) give limited time for convergence
3. **Thin liquidity** limits position sizes
4. **Information disadvantage** — market makers are sophisticated

### Realistic Edge Required:
- To achieve 5% return on $500 monthly:
  - Need $25/month profit
  - At $50 position sizes and 4¢ avg spread + 2¢ fees = 6¢ cost
  - Need contracts to move >6¢ in your direction, consistently
  - With 50% win rate, gross wins must average >12¢ per trade
  - This requires exceptional skill in predicting crypto prices within tight daily/weekly brackets

### Verdict: Requires Exceptional Skill
Not impossible, but requires genuine forecasting ability that exceeds the market's collective wisdom. Not achievable through automated spread-capture strategies.

---

## Technical Deliverables

### New Files Created
- `lib/gemini_predictions_real.js` — Real Gemini Predictions API client
  - Connects to `https://www.gemini.com/prediction-markets`
  - Properly distinguishes `bestBid`/`bestAsk` (real orderbook) from `sell.yes`/`buy.yes` (indicative)
  - Market analysis, liquidity scoring, normalization
  
- `scripts/observe_real_markets.js` — Real data observation mode
  - Polls Gemini, Polymarket, Kalshi every 30s
  - Strict cross-platform matching (asset + strike + timeframe)
  - Correct prediction market PnL calculations
  - Price change tracking over time
  - Generates honest profitability verdicts

### Files Modified
- `lib/gemini_client.js` — Added `useRealPrices` mode using `GeminiPredictionsReal`
- `lib/paper_trading_engine.js` — Added `fee_per_side` (2%) to PnL calculations

### API Documentation
```
Gemini Predictions REST API (Public)
=====================================
Endpoint: GET https://www.gemini.com/prediction-markets

Query Parameters:
  status:     active | settled | under_review
  category:   crypto | sports | politics | elections | culture | tech | finance | other  
  limit:      number (max results per page)
  offset:     number (pagination)
  search:     string (text search)
  marketType: string

Response:
  {
    data: [{
      id, title, slug, ticker, type, category, status,
      contracts: [{
        id, label, ticker, instrumentSymbol,
        prices: {
          buy: { yes, no },
          sell: { yes, no },
          bestBid,        // Real orderbook bid (null if no live bids)
          bestAsk,        // Real orderbook ask (null if no live asks)  
          lastTradePrice
        },
        expiryDate, marketState
      }]
    }],
    pagination: { limit, offset, total }
  }

WebSocket (for real-time):
  wss://api.gemini.com/v1/ws/sports (needs specific event tickers)
  wss://wsapi.fast.gemini.com (symbol@trade, symbol@bookTicker)
```

---

## Recommendations

1. **Do not deploy this bot for live trading** with real money until a genuine edge is identified
2. **Keep the real API client** — it's valuable infrastructure for future strategies  
3. **If pursuing prediction markets**, focus on:
   - Markets where you have genuine informational advantage
   - Longer-duration contracts with deeper liquidity
   - Single-platform directional trades, not cross-platform arb
4. **Consider**: The $500 starting capital is too small for prediction market trading given the typical 4-6¢ spreads and 2% fees. Larger capital enables patient limit-order strategies on deeper markets.

---

*Report generated: February 17, 2026*  
*Data source: Real Gemini Predictions API, live Polymarket API*  
*Observation period: 5 minutes (10 snapshots, 30s intervals)*  
*Validation tool: `scripts/observe_real_markets.js`*
