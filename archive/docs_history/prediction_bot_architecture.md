# Prediction Market Bot — Architecture & Operations Skill

## System Overview

The bot exploits price divergences between **Polymarket** (leader) and **Gemini** (lagger) prediction markets by:
1. Monitoring Polymarket for price movements (via Gamma API bulk pricing)
2. Detecting lagged/stale pricing on Gemini paper markets
3. Entering positions on Gemini when a cross-platform edge exists
4. Exiting when Gemini price converges to Polymarket reference

**Stack**: Node.js v24 · Express · WebSocket · better-sqlite3 · Paper trading simulation

---

## Component Map

```
server/prediction-proxy.js     ← Main server (port 3003), REST API, trading loop
lib/polymarket_client.js       ← Polymarket Gamma API + CLOB API client
lib/kalshi_client.js           ← Kalshi REST API client
lib/gemini_client.js           ← Gemini paper trading simulator
lib/market_matcher.js          ← Cross-platform fuzzy matching (Levenshtein + Jaccard)
lib/signal_detector.js         ← 5-component opportunity scoring
lib/paper_trading_engine.js    ← Trade entry/exit, Kelly sizing, adaptive learning
lib/prediction_db.js           ← SQLite schema (8 tables), data access
lib/logger.js                  ← Structured logging with component tags
config/prediction_params.json  ← Nested JSON config (trading, entry, position_sizing, etc.)
scripts/stress_test_prediction.js ← 24h accelerated simulation
```

---

## Data Flow (Each Cycle, ~2s)

```
1. Polymarket Gamma API → refreshPrices() → priceIndex Map (every 30s)
   ├── getCachedPrice() for instant lookups
   └── Micro-noise (±3 mills) between refreshes for realistic fluctuation

2. Market Matcher → createSimulatedGeminiMarkets()
   ├── Filters: 0.10 ≤ price ≤ 0.90, liquidity ≥ 1000
   ├── Passes polymarket_yes_token_id / polymarket_no_token_id through DB
   └── Caps simulated volume: min(20000, poly.volume × 0.001)

3. Gemini Client → updatePaperMarket(marketId, referencePrice)
   ├── Exponential convergence: 15% per tick toward reference
   ├── Persistent lagged price (the core edge)
   ├── Spread: 2-4¢ (configurable via opts.spreadWidth)
   └── Simulated trade intervals: 60-300s between trades

4. Signal Detector → processMarkets(marketStates) → scored signals
   ├── 5 components: velocity(20), spread(20), consensus(25), staleness(15), category(20)
   ├── Min score: 45  |  Velocity threshold: 0.01  |  Staleness: 120s
   └── Direction: weighted velocity > 0.002→YES, < -0.002→NO, fallback price level

5. Trading Engine → tick(actionableSignals)
   ├── monitorPositions() — check TP/SL/time exits for open positions
   │   ├── Stop loss: mid-price based (NOT execution price) to avoid spread-triggered exits
   │   └── Take profit: execution price based (conservative — must be realizable)
   ├── enterPosition() — Kelly sizing with edge-based + score-based fallback
   │   ├── Take profit: max(targetPrice, fill + 1.5¢) to guarantee profitable exits
   │   └── Stop loss: entryMid - 3¢ (mid-price, not fill)
   └── runLearningCycle() — adaptive parameter adjustment
```

---

## Critical Parameters (config/prediction_params.json)

| Parameter | Value | Notes |
|-----------|-------|-------|
| entry_threshold | 45 | Signal score minimum (tuned down from 60) |
| stop_loss_width | 0.03 | 3¢ from entry mid-price |
| take_profit_buffer | 0.01 | Buffer below reference (clamped to ≥ fill+1.5¢) |
| kelly_multiplier | 0.25 | Fractional Kelly (conservative) |
| max_concurrent_positions | 5 | Risk limit |
| max_hold_time | 600 | 10 min time exit |
| daily_loss_limit | -50 | Kill switch |
| slippage_penalty | 0.005 | 0.5¢ simulated slippage |

---

## Database Schema (SQLite)

| Table | Purpose |
|-------|---------|
| `matched_markets` | Cross-platform market pairs (incl. token IDs) |
| `prediction_trades` | All paper trades (open + closed) |
| `signals` | Signal history for learning |
| `market_prices` | Price snapshots |
| `paper_wallet` | Balance tracking |
| `trading_parameters` | Adaptive parameters |
| `performance_snapshots` | Hourly performance |
| `category_performance` | Win rates by category |

---

## API Endpoints (port 3003)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/prediction/status` | GET | Bot status, wallet, open trades |
| `/api/prediction/start` | POST | Start trading loop |
| `/api/prediction/stop` | POST | Stop trading loop |
| `/api/prediction/markets` | GET | Matched markets list |
| `/api/prediction/trades` | GET | Trade history |
| `/api/prediction/signals` | GET | Recent signals |
| `/api/prediction/parameters` | GET/POST | View/update params |
| `/health` | GET | Health check |

WebSocket at `ws://localhost:3003` pushes real-time updates.

---

## Key Design Decisions

1. **Gamma API over CLOB**: Direct CLOB orderbook calls return 403/404 for most markets. Gamma API provides bulk pricing reliably.

2. **Mid-price stop loss**: Stop losses track market mid-price, not execution price. This prevents the spread cost (2-4¢) from immediately triggering the 3¢ stop loss upon entry.

3. **Take profit floor**: `takeProfitPrice ≥ fill_price + 1.5¢` ensures that "take profit" exits always produce positive execution PnL.

4. **Score-based fallback sizing**: When no edge is detected from the price gap (referencePrice - entryPrice ≤ 0), position sizing falls back to a score-based calculation instead of returning 0.

5. **Convergence lag is the edge**: The Gemini paper simulation uses exponential convergence (configurable %, default 15%) toward the reference price, creating a persistent lag that represents the real-world inefficiency.
