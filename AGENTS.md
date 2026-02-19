# AGENTS.md — Entry point for all AI agents

**ALWAYS read this file and all linked skills before touching any code.**

## What This Project Is

A self-sustaining paper + live prediction market arbitrage bot targeting Gemini Prediction Markets (launched Dec 2025, thin/illiquid) by exploiting mispricings vs Polymarket (liquid, high-volume) and Kalshi (deep orderbooks).

**The core insight:** Gemini is thin because it's new. Our bot provides liquidity to Gemini while earning the spread vs Poly/Kalshi. **We are a market maker, not just a price taker.**

**Goal:** Run profitably, paper-first, until 500+ trades with Sharpe > 2.0, then go live. Self-sustain until 2047.

---

## Repository Structure

```
kraken-ai-trader/
├── server/
│   ├── prediction-proxy.js    ← MAIN ENTRY POINT (start here)
│   └── rate-limiter.js        ← per-platform request queuing
├── lib/
│   ├── gemini_client.js        ← Gemini execution + HMAC auth (paper/live)
│   ├── gemini_predictions_real.js ← Real Gemini Predictions REST scraper
│   ├── kalshi_client.js        ← Kalshi REST + WebSocket bracket data
│   ├── kalshi_ws.js            ← Kalshi real-time WebSocket subscriber
│   ├── polymarket_client.js    ← Polymarket Gamma REST + CLOB
│   ├── signal_detector.js      ← 6-component scoring + FV + momentum + arb
│   ├── fair_value_engine.js    ← Black-Scholes + Kalshi IV + ensemble FV
│   ├── market_matcher.js       ← Cross-platform market matching
│   ├── odds_api_client.js      ← The Odds API: sportsbook consensus odds (V15)
│   ├── metaculus_client.js     ← Metaculus: calibrated crowd predictions (V15)
│   ├── paper_trading_engine.js ← Kelly sizing + TP/SL/time-decay exits
│   ├── prediction_db.js        ← SQLite schema + queries (WAL, FK enforced)
│   ├── alerts.js               ← Discord webhook alerts
│   └── logger.js               ← Unified logging
├── dashboard/
│   └── index.html              ← Real-time trading dashboard (port 3003)
├── config/
│   ├── bot_config.json         ← Kraken crypto bot config (legacy, unused)
│   └── prediction_params.json  ← Prediction market bot parameters
├── data/
│   ├── prediction_markets.db   ← Main SQLite DB (10s WAL, FK ON)
│   └── matched_markets.json    ← Manual market overrides
├── skills/                     ← Agent knowledge base (READ THESE)
│   ├── gemini_api_skill.md     ← HMAC auth, order placement, ticker API
│   ├── prediction_bot_architecture.md
│   ├── prediction_bot_debugging.md
│   ├── prediction_market_strategies.md
│   ├── BTizzy/                 ← Validation + architecture deep-dives
│   │   ├── prediction-market-architecture.md  ← Platform comparison, strategy types, fee math
│   │   └── statistical-validation.md          ← 5-phase validation, anti-patterns, go-live gates
│   └── community/              ← Curated skills from openclaw/skills
│       ├── websocket.md                  ← Backoff+jitter, heartbeat timing, close codes
│       ├── sqlite.md                     ← WAL, busy_timeout, pragma reference, batch inserts
│       ├── polymarket-fast-markets.md    ← 10% fast-market fee warning, momentum signal formula
│       └── prediction-market-arb-types.md ← 5-type arb taxonomy, per-type min edge, exit rules
├── scripts/                    ← Analysis + backtest tools
├── tests/                      ← Unit + integration tests
└── archive/                    ← Legacy Kraken crypto bot (ignore)
```

---

## Skills (Read Before Any Task)

1. [skills/gemini_api_skill.md](skills/gemini_api_skill.md) — **HMAC auth**, order placement, ticker batch endpoint, maker-or-cancel strategy
2. [skills/prediction_bot_architecture.md](skills/prediction_bot_architecture.md) — Full system architecture, state model, data flow
3. [skills/prediction_bot_debugging.md](skills/prediction_bot_debugging.md) — 10 root causes, emergency procedures, quick status commands
4. [skills/prediction_market_strategies.md](skills/prediction_market_strategies.md) — 5 strategies, fee landscape, platform structures
5. [skills/BTizzy/prediction-market-architecture.md](skills/BTizzy/prediction-market-architecture.md) — Platform comparison (Poly/Kalshi/Gemini), 3 strategy types, fee math, common failure modes, deployment checklist
6. [skills/BTizzy/statistical-validation.md](skills/BTizzy/statistical-validation.md) — 5-phase validation framework, backtesting anti-patterns (incl. artificial convergence), KPI tables, go-live gates (8 checks)
7. [skills/community/websocket.md](skills/community/websocket.md) — Backoff+jitter formula, ping/pong timing (30s/10s), `readyState` machine, close codes, applied notes for KalshiWS
8. [skills/community/sqlite.md](skills/community/sqlite.md) — WAL mode, `busy_timeout`, `foreign_keys` per-connection, 64MB cache pragma, batch insert transactions
9. [skills/community/polymarket-fast-markets.md](skills/community/polymarket-fast-markets.md) — **10% fee on fast/sprint markets** (5× normal), CEX momentum signal formula, USDC.e distinction
10. [skills/community/prediction-market-arb-types.md](skills/community/prediction-market-arb-types.md) — 5-type arb taxonomy with per-type min edge thresholds, exit rules, position limits

---

## State Model (Memorize This)

```
EXTERNAL DATA (read-only)              SIGNAL PIPELINE (2s cycle)
──────────────────────────             ────────────────────────────────
Kraken REST → spotPriceCache           per matched market {poly, kalshi, gemini}:
  BTC/ETH/SOL spot (every 15s)           │
                                         ├─ Strategy 1: CompositeScore (5-component)
Polymarket Gamma REST → priceIndex       │    velocity + spread + consensus + staleness + winRate
  refreshPrices() every 30s              │    → score 0-100, direction = Gemini vs Ref spread
  getCachedPrice() per market/cycle      │
                                         ├─ Strategy 2: FairValue (BS + Kalshi IV + Ensemble)
Kalshi WS → bracketCache (live ticks)    │    → netEdge, kellyFraction, confidence
Kalshi REST → orderbook + brackets       │
  RSA-PSS auth (same as WS)             ├─ Strategy 3: Event-Driven Momentum
  getBestPrices() checks bracketCache    │    spot moves fast, contract hasn't repriced
  first, falls back to REST              │    → direction + contractLag
                                         ├─ Strategy 4: Cross-Platform Synthetic Arb
Gemini Predictions → contracts.Map       │    Gemini YES vs Kalshi bracket implied prob
  fetchMarkets() every 10s               │    → BUY_YES / BUY_NO + edge
  fetchBatchTickers() every 2s           │
  getOrderbookDepth() per market         ↓
                                      Merge: FV > Composite, Momentum boosts, Arb adds
                                         ↓
              ┌──────────────────────────────────────────────┐
              │  PaperTradingEngine.tick(actionable)          │
              │    ├─ canEnterPosition()                      │
              │    │    ├─ max 3 concurrent, max 2/category   │
              │    │    ├─ daily loss limit ($10)              │
              │    │    ├─ 80% initial balance drawdown kill   │
              │    │    └─ no duplicate market                 │
              │    ├─ calculatePositionSize()                  │
              │    │    ├─ Kelly with edge + score              │
              │    │    ├─ max $10, depth cap 10% ask_depth    │
              │    │    ├─ live: min(max_pos, balance×10%)     │
              │    │    └─ kellyFraction from FV if available   │
              │    ├─ enterPosition()                          │
              │    │    ├─ GEMI-* → placeOrder() (live API)    │
              │    │    ├─ gemini_sim_* → executePaperTrade    │
              │    │    ├─ Deep-ITM/OTM guard (spot vs strike) │
              │    │    ├─ NO leverage guard (reject <$0.05)   │
              │    │    ├─ Liquidity gate (2-sided, <15¢ sprd) │
              │    │    ├─ Min edge live (8¢ default)          │
              │    │    ├─ Spread filter (2×spread + 1¢)       │
              │    │    ├─ TP = max(target, entry + 1.5¢)      │
              │    │    └─ SL = mid - 5¢ (from mid, not fill)  │
              │    ├─ monitorPositions()                       │
              │    │    ├─ getPaperMidPrice → stop-loss check   │
              │    │    ├─ getPaperExitPrice → TP check + PnL  │
              │    │    ├─ time-decay stop (final 20% hold)   │
              │    │    ├─ expiry-aware hold (80% of TTX)      │
              │    │    └─ time_exit at max_hold_time (2h+)    │
              │    └─ runLearningCycle() (every 30s)           │
              │         ├─ sliding window: last 50 trades      │
              │         ├─ win>65% → loosen threshold 5%       │
              │         ├─ win<50% → tighten threshold 5%      │
              │         ├─ starvation: 5x tight → reset to 45  │
              │         ├─ live: threshold ∈ [45, 65]          │
              │         └─ live: kelly ≤ 0.20                  │
              └──────────────────────────────────────────────┘
                                         ↓
              SQLite (FK ON, WAL, better-sqlite3)
              WebSocket → Dashboard (port 3003)
              Discord → Alerts (optional)
```

**Execution model (paper):**
- Entry: fill at `market.last + 0.001` (maker-or-cancel with 0.01% fee)
- Exit: fill at `market.last - 0.001` (same model, symmetric)
- Round-trip cost: ~0.2¢ + any convergence overhead
- Direction: `YES` when Gemini is below reference, `NO` when above (edge > 1.5¢)

**Execution model (live):**
- Only `GEMI-*` instrument symbols route to Gemini API; `gemini_sim_*` IDs stay paper
- Entry: `POST /v1/prediction-markets/order` with `orderType: 'limit'`, `timeInForce: 'good-til-cancel'`
- Exit: same endpoint with `side: 'sell'` (NOT YET IMPLEMENTED — exits still use paper simulation)
- Auth: HMAC-SHA384 with seconds-based nonce, `account: 'primary'`
- Order response normalized to match `executePaperTrade` format for engine compatibility

**Data flow summary:**
1. Match cycle finds cross-platform pairs (Gemini ↔ Polymarket ↔ Kalshi)
2. Every 2s: fetch prices from all platforms → feed signal detector
3. Signal detector scores and determines direction → actionable signals
4. Paper trading engine enters/exits positions → SQLite + dashboard

---

## Key Numbers

| Parameter | Value | Why |
|-----------|-------|-----|
| Scan interval | 2s | Balances freshness vs rate limits |
| Entry threshold | 55 (adaptive, live floor=45) | Score 0-100; adaptive learning with live guardrails |
| Min edge (paper) | 3¢ | After fees, must be positive |
| Min edge (live) | 8¢ | Higher bar for real money trades |
| Kelly multiplier | 0.15 (live ceiling=0.20) | Conservative fractional Kelly |
| Max position | $10 | 10% of $100 live budget per trade |
| Max concurrent | 3 | Concentration risk with small budget |
| Stop loss | 10¢ | V18: backtest showed 10c = 5c performance, prevents noise exits |
| Max hold | 14400s (4h, expiry-aware) | V18: hold to 80% of TTX; longer = better convergence |
| Daily loss limit | $10 | Protects $100 live budget |
| Max capital at risk | 20% | Max total exposure |
| Drawdown kill | 20% | Auto-stop the bot |
| Gemini fee | 0.01% maker / 0.05% taker | Use maker-or-cancel always |
| Spread filter | 2× spread + 1¢ | Round-trip cost + profit margin |
| Liquidity gate | Two-sided book, spread < $0.15 | Ensures exit liquidity (live only) |

---

## Running the Bot

```bash
# Start (paper mode default)
node server/prediction-proxy.js

# Start in live mode (requires GEMINI_API_KEY + GEMINI_API_SECRET)
GEMINI_MODE=live node server/prediction-proxy.js

# Start in sandbox mode (requires SANDBOX_GEMINI_API_KEY + SANDBOX_GEMINI_API_SECRET)
# NOTE: Sandbox has no prediction market symbols — only useful for spot auth testing
GEMINI_MODE=sandbox node server/prediction-proxy.js

# Dashboard
open http://localhost:3003

# Health check
curl http://localhost:3003/api/health

# Bot status (includes mode, Sharpe, circuit breaker)
curl http://localhost:3003/api/bot/status

# Emergency stop (closes all positions)
curl -X POST http://localhost:3003/api/bot/emergency-stop

# Close single position
curl -X POST http://localhost:3003/api/bot/close-position/123

# Run tests
node tests/test_fair_value_engine.js
node tests/test_prediction_bot.js

# Force market rematch
curl -X POST http://localhost:3003/api/markets/rematch
```

---

## .env Required Variables

```
GEMINI_MODE=paper              # 'paper' | 'live' | 'sandbox'
GEMINI_API_KEY=                # For live trading (HMAC auth)
GEMINI_API_SECRET=             # For HMAC signing
SANDBOX_GEMINI_API_KEY=        # For sandbox mode (api.sandbox.gemini.com)
SANDBOX_GEMINI_API_SECRET=     # Sandbox HMAC signing
KALSHI_API_KEY=                # Kalshi member ID (for WS + REST auth)
KALSHI_PRIVATE_KEY_PATH=       # Path to RSA private key PEM (for RSA-PSS signing)
DISCORD_WEBHOOK_URL=           # For alerts (optional)
PREDICTION_PORT=3003           # Dashboard/API port (default 3003)
```

---

## Agent Rules (from Must_read_before_any_agent_task.md)

1. Read this file AND all linked skills before any task
2. Review conversation history — more important than old READMEs
3. Visualize the full state model before responding
4. Add new skill `.md` files in `skills/` when you discover useful knowledge
5. Before responding, reflect on what could have gone better and what a future agent should know

---

## Current Version: V18

**Status: DATA COLLECTION — Preparing for $100 Live Test**

**V18: Backtest-Validated Parameter Optimization**

**What we did:** Built comprehensive backtester (`scripts/backtest_v17.js`) using 573K real price snapshots across 97 GEMI-* crypto contracts and 32 simulated markets. Ran 40+ parameter sweep configurations (edge thresholds, stop loss, hold times, volatility, settlement strategies).

**Key findings:**
1. **BS fair value on crypto binaries is profitable** — 3 trades in 19h, 100% WR, $3.94-$6.01 PnL depending on config. All NO direction on ETH $2000 contracts. The model correctly identified that ETH was unlikely to reach $2,000 (a ~7% OTM strike).
2. **Hold-to-settlement is the biggest single improvement** — PnL jumps 44% ($3.94→$5.67) by holding to 80% of time-to-expiry instead of fixed 2h max.
3. **Wider stop loss (10c) matches narrow (5c) performance** — Prediction markets are noisy; tight stops cause premature exits.
4. **Cross-platform arb on sim markets shows ZERO edge** — Gemini sim prices track Polymarket within 1-2c (less than the 3.6c spread). Paper trading wins on sim markets are from simulation noise, not real arbitrage.
5. **Default 50% vol works best** — Higher vol (80%) generates garbage signals (-$24.65 PnL). Implied vol from lattice is too noisy.

**NOT CONFIDENT for live deployment yet.** Need 100+ trades (14+ days of paper data) for statistical significance. Current evidence is directional (correct signal type) but insufficient for go-live.

**Changes:**
1. **Backtester** (`scripts/backtest_v17.js`): Full simulation engine — loads GEMI price histories, reconstructs spot from contract lattice interpolation, computes BS fair values, applies all V17 entry guards, tracks PnL with realistic fills (entry at ask, exit at bid). 40+ parameter sweep configurations.
2. **Cross-Platform Backtester** (`scripts/backtest_crossplatform.js`): Tests Gemini-vs-Polymarket arbitrage on 32 simulated markets. Confirms zero edge after spread costs.
3. **Parameter Updates** (`lib/prediction_db.js`): V18 migration widens stop_loss from 5c→10c, increases max_hold_time from 2h→4h, adds `hold_to_settlement` flag (default: ON).
4. **Analysis Document** (`skills/backtest_analysis_v18.md`): Comprehensive backtest results, parameter sweep table, confidence assessment, go-live gates checklist.

**V18 Parameter Changes:**

| Parameter | V17 | V18 | Backtest Evidence |
|-----------|-----|-----|-------------------|
| stop_loss_width | 0.05 | **0.10** | 10c SL = 5c SL performance (100% WR both) |
| max_hold_time | 7200 (2h) | **14400 (4h)** | Longer holds capture settlement convergence |
| hold_to_settlement | (new) | **1 (ON)** | +44% PnL improvement on same trades |

---

## Previous Version: V17

**Merged in V17: $100 Live Trading Safety & Signal Quality Overhaul**

**Problem:** Live trading lost money because (1) position sizes were too large ($100/trade on $200 balance), (2) spread costs exceeded edge on most trades, (3) learning cycle drifted parameters to dangerous extremes, (4) stale Kalshi data from wrong settlement dates created phantom 30c+ edges, (5) bot would short near-certain outcomes (e.g., BTC > $67K when BTC at $67K).

**Changes:**
1. **DB Cleanup & Parameter Reset** (`lib/prediction_db.js`): V17 migration reclassifies 4 phantom `gemini_sim_*` live trades as paper. Resets all parameters to conservative values. Adds `min_edge_live` parameter (default 0.08).

2. **Position Sizing** (`lib/paper_trading_engine.js`): Live mode uses real Gemini balance via `getAvailableBalance()` with 30s cache. Per-trade cap = `min(max_position_size, realBalance × 0.10)`. Minimum $1 per trade (was $5).

3. **NO Trade Leverage Guard** (`lib/paper_trading_engine.js`): Rejects NO trades with entry price < $0.05 (prevents 20x+ leverage). Clamps PnL to `[-position_size, position_size × 10]`.

4. **Deep-ITM/OTM Guard** (`lib/paper_trading_engine.js`): For GEMI-* crypto contracts, parses strike from market ID. Rejects NO when spot > strike × 1.20, rejects YES when spot < strike × 0.80. Spot price enriched onto signal objects in `prediction-proxy.js`.

5. **Hard Liquidity Gate** (`lib/paper_trading_engine.js`): Live trades require two-sided orderbook and spread < $0.15. Minimum edge for live = 8c (configurable via `min_edge_live` parameter).

6. **Round-Trip Spread Edge Filter** (`lib/paper_trading_engine.js`, `lib/fair_value_engine.js`): Entry requires `edge > max(stop_loss, geminiSpread × 2 + 0.01)`. Fair value engine subtracts estimated spread from netEdge.

7. **Expiry-Aware Hold Times** (`lib/paper_trading_engine.js`): Parses settlement date from GEMI instrument symbol. Sets `maxHold = max(params.max_hold_time, timeToExpiry × 0.80)`. High-edge trades get 4h minimum hold.

8. **Learning Cycle Guardrails** (`lib/paper_trading_engine.js`): Live mode clamps `entry_threshold ∈ [45, 65]` and `kelly_multiplier ≤ 0.20`. Prevents parameter drift to aggressive values.

9. **Ensemble Sanity Check** (`lib/fair_value_engine.js`): Spot-price reality gate for crypto — if moneyness > 1.30, requires P(above) > 0.45 from each model or zeroes weight. Model disagreement check: if max-min > 0.40, downweights outliers 90%. Prevents stale Kalshi data from corrupting fair value.

10. **Kalshi Date Matching** (`lib/market_matcher.js`): `matchCryptoContracts()` now parses settlement dates from both Gemini instrument symbols (GEMI-BTC**2602240800**) and Kalshi event tickers (KXBTC-**26FEB19**16). Rejects matches with >48h date difference. Reduces confidence for 12-48h gaps. Deduplicates to keep best-confidence match per Gemini contract.

11. **Position Reconciliation** (`lib/paper_trading_engine.js`, `server/prediction-proxy.js`): New `reconcilePositions()` method compares DB vs Gemini exchange positions. Detects orphaned and phantom positions. Wired into hourly cleanup cycle. `/api/reconcile` endpoint added.

12. **Real Gemini Balance** (`lib/gemini_client.js`): `getAvailableBalance()` with 30s TTL cache. Queries actual USD balance before live trades instead of using paper wallet.

**V17 Key Lessons:**
- **Stale cross-platform data creates phantom edges**: A Feb 19 Kalshi event matched to a Feb 24 Gemini contract shows P(BTC>67.5K)=6% when the real probability is ~50%. The 44c "edge" is entirely from using the wrong date's data.
- **Ensemble weights amplify bad data**: With crypto weights at 70% Kalshi / 30% BS, a garbage Kalshi input dominates even when Black-Scholes has the correct answer.
- **Position sizing relative to budget matters more than edge quality**: $100/trade on $200 balance means 2 bad trades wipe you out regardless of edge accuracy.
- **Paper and live performance diverge dramatically**: Paper fills at synthetic mid-price with instant execution. Real Gemini fills cross bid/ask spreads on thin books. Paper win rate was 72-89%, live was 0-36%.
- **Prediction markets reward patience**: Short hold times (10 min) catch noise, not signal. Contracts converge toward fair value near expiry — hold up to 80% of time-to-expiry.

---

## Previous Version: V16

**Merged in V16:**
- **Reference sources wired into signal pipeline**: OddsAPI and Metaculus probabilities are now looked up per-market during every 2-second price update cycle and fed into both the composite scoring and fair value ensemble. Previously these were fetched/cached but never consumed by signals.
- `server/prediction-proxy.js`: Per-market lookups of `metaculusClient.getProbability()` and `oddsClient.findMatchingOdds()` in `updatePrices()`. Results passed via `marketStates` to signal detector. New **Strategy 5: Multi-source ensemble FV for non-crypto markets** — computes ensemble fair value from Polymarket + Kalshi + Metaculus + OddsAPI for politics/sports/finance/tech/culture markets and generates actionable signals when Gemini deviates by > 3c. Bot status endpoint now includes `odds_api` and `metaculus` stats. Periodic logging shows reference source counts.
- `lib/signal_detector.js`: `determineDirection()` now accepts `additionalRefs` parameter — enhances reference price with Metaculus + OddsAPI probabilities for more accurate direction determination. `processMarkets()` extracts additional refs from state and computes enhanced reference price. `generateFairValueSignals()` accepts `extrasLookup` callback for per-contract reference data.
- `lib/fair_value_engine.js`: `generateSignal()` now accepts `extras` parameter and passes to `ensembleFairValue()`. `analyzeAll()` accepts `extrasLookup` callback that provides per-contract polymarket/metaculus/oddsApi/category data. `ensembleFairValue()` uses category-specific weights only when category is explicitly provided (falls back to instance `modelWeights` otherwise, fixing test regression).
- `lib/fair_value_engine.js`: `getActionableSignals()` passes through `extrasLookup`.

**V16 Data Flow (reference sources):**
```
Match cycle (every 5 min):
  oddsClient.getConsensusOdds() → matchedOdds cache (40+ sportsbooks)
  metaculusClient.getActiveQuestions() → questions cache (50 questions)

Price update cycle (every 2s):
  per matched market:
    metaculusClient.getProbability(title) → metaculusProb (in-memory lookup)
    oddsClient.findMatchingOdds(title) → oddsApiProb (in-memory lookup)
    → marketState { ...polymarket, kalshi, metaculus, oddsApi }

  Strategy 1 (Composite): uses enhanced referencePrice (poly+kalshi+metaculus+oddsApi average)
  Strategy 2 (BS+Kalshi FV): now receives extras { polymarket, oddsApi, metaculus, category }
  Strategy 5 (Multi-source FV): for non-crypto — ensembleFairValue with category weights
```

**V16 Key Lessons:**
- **Data fetched but not consumed is zero value**: V15 added OddsAPI and Metaculus but only cached the data during the match cycle. It was never looked up per-market during the 2s price cycle, so it had zero impact on trading decisions. V16 wires it through.
- **Category-aware ensemble weights transform signal quality for non-crypto**: Politics markets now weight Polymarket 45% + Kalshi 30% + Metaculus 25% instead of ignoring all non-BS/Kalshi sources. Sports markets use OddsAPI 40% + Polymarket 35% + Kalshi 25%.
- **Non-crypto markets need their own FV strategy**: Strategy 2 (Black-Scholes) only applies to crypto (requires spot/strike/expiry). Strategy 5 fills this gap by computing ensemble FV from available reference sources for politics/sports/finance markets.
- **ensembleFairValue default behavior matters**: Defaulting to 'crypto' category weights when no category was specified broke existing tests expecting instance-level modelWeights. Fix: use category weights only when explicitly provided.

**V19 candidates:**
- Accumulate 100+ paper trades with V18 params → re-run backtest for go-live confidence
- Wire real orderbook depth (replace hard-coded `ask_depth: 500` with `getOrderbookDepth()` API results)
- Warm-up period on startup (observe for N cycles before placing live trades)
- Add live order status polling (check if fill/cancel occurred between cycles)
- Pre-expiry forced exit (sell 30 min before settlement to avoid binary outcome risk)
- Implement market making mode (post both sides, capture spread)
- Walk-forward validation once 500+ paper trades accumulated

---

## Previous Version: V15

**Merged in V15:**
- **Category Expansion**: Bot now fetches ALL 8 Gemini Prediction categories (crypto, sports, politics, elections, culture, tech, finance, other) instead of just crypto. This was the single biggest fix — 7/8 categories were being ignored while having much better cross-platform matching potential with Polymarket/Kalshi.
- `lib/gemini_client.js`: `refreshRealData()` loops over all configured categories for both `fetchMarkets()` and `fetchBatchTickers()` (was hardcoded to 'crypto' only).
- `lib/paper_trading_engine.js`: **Live exit orders** — `monitorPositions()` now routes live trade exits through `POST /v1/prediction-markets/order` with `side: 'sell'` instead of skipping them. Retries failed exits on next cycle. **Spread-aware entry** — rejects trades where edge < max(stopLoss, geminiSpread * 1.2). **Balance check** — rejects live orders if wallet < $7. **Rate limiting** — max 3 live orders per cycle. **Portfolio risk** — max 3 positions per category, max 2 in same direction per category. **Learning window** increased from 20 to 50 trades.
- `lib/signal_detector.js`: **6-component scoring** (was 5). Added Liquidity Score (15 pts): two-sided book (5pts), tight spread <5c (5pts), adequate depth >$100 (5pts). Redistributed from velocity (20→15), spread (20→15), win_rate (20→15).
- `lib/fair_value_engine.js`: **Category-specific ensemble weights** — crypto uses 30% BS + 70% Kalshi; politics uses 45% Polymarket + 30% Kalshi + 25% Metaculus; sports uses 40% OddsAPI + 35% Polymarket + 25% Kalshi. `ensembleFairValue()` accepts `extras: { polymarket, oddsApi, metaculus, category }`.
- `lib/odds_api_client.js`: NEW — The Odds API client. Fetches real-time odds from 40+ sportsbooks, converts American/decimal odds to implied probabilities, provides consensus reference prices for sports prediction markets. Free tier: 500 requests/month.
- `lib/metaculus_client.js`: NEW — Metaculus API client. Fetches calibrated community predictions for politics, economics, science, tech events. Free API, no auth needed. Question matching via keyword overlap.
- `lib/kalshi_client.js`: `computeSyntheticAbove()` now filters illiquid brackets (spread > 0.50 or volume = 0) before summing, and clamps results to [0, 1]. This prevents garbage synthetic probabilities from thinly-traded brackets.
- `server/prediction-proxy.js`: Requires and instantiates OddsApiClient + MetaculusClient. Fetches reference data (sports odds, Metaculus questions) during match cycle (every 5 min). All 7 non-crypto Gemini categories passed to GeminiClient.
- `tests/test_prediction_bot.js`: `monitorPositions` test updated to async. Entry test edge widened to pass spread-aware threshold.

**V15 .env additions:**
```
ODDS_API_KEY=               # Optional: The Odds API key for sports reference prices (free tier: 500 req/mo)
```

**V15 Key Lessons:**
- **Category blindness was the root cause of poor matching**: Gemini has 8 categories but code only fetched 'crypto'. Political/economic events have standardized titles that fuzzy-match well across platforms with deep Poly/Kalshi liquidity.
- **Spread-aware entry prevents underwater trades**: Actual Gemini spreads are 4-6c. With 3c min edge, most entries were immediately unprofitable. Edge must exceed the actual spread.
- **Sportsbook odds are the deepest reference pool**: For sports prediction markets, 40+ sportsbooks provide consensus probabilities far more liquid than any prediction platform.
- **Metaculus calibration is free alpha**: Community predictions have excellent track records on political/economic/science events. Even though Metaculus is not a trading venue, the probability estimates are a strong fair value signal.
- **Illiquid Kalshi brackets corrupt syntheticprobabilities**: Brackets with 0 volume or 50c+ spreads were being summed, producing probabilities >1.0. Filtering before summing is essential.
- **Live exits require real API calls**: V14 blocked paper exits for live trades but didn't implement real exits. V15 routes live exits through `placeOrder({side: 'sell'})` with retry on failure.
- **Portfolio correlation risk**: 5 concurrent BTC positions all going YES is functionally one huge bet. Category + direction limits prevent correlated concentration.

---

## Previous Version: V14

**Merged in V14:**
- `lib/gemini_client.js`: **Live trading via Prediction Markets API** — `placeOrder()` routes to `POST /v1/prediction-markets/order` (NOT `/v1/order/new`). Added `cancelOrder()`, `getOpenOrders()`, `getPositions()`, `getOrderHistory()`, `getBalances()`. HMAC-SHA384 nonce fixed to seconds-based with strict increment tracking. `account: 'primary'` required on all private endpoints. Sandbox mode: `api.sandbox.gemini.com` with separate `SANDBOX_GEMINI_API_KEY`/`SANDBOX_GEMINI_API_SECRET`.
- `lib/paper_trading_engine.js`: `enterPosition()` and `tick()` made async. Live order routing: `GEMI-*` instruments → `placeOrder()` (real API), `gemini_sim_*` → `executePaperTrade()` (paper). Trade mode recorded as `'live'` or `'paper'` in DB. Paper exit `monitorPositions()` skips live trades (mode='live'). Live entry safety guards: minimum score 45, reject NO > $0.85, reject edge < 1¢, reject if Gemini bid/ask undefined. Mode detection: only `GEMI-*` instruments get `mode='live'`, all `gemini_sim_*` trades are `mode='paper'` even when bot is in live mode.
- `lib/market_matcher.js`: Added `matchCryptoContracts()` — structural matching of GEMI-* crypto contracts to Kalshi KXBTC/KXETH/KXSOL bracket series by asset + strike price. Parses `HI66500` → $66,500, matches to nearest Kalshi strike via `findSyntheticPrice()`. Synthetic probabilities clamped to [0, 1].
- `server/prediction-proxy.js`: `GEMINI_MODE` env var (`paper`|`live`|`sandbox`). `tradingEngine.tick()` awaited. Crypto match metadata preserved in `cryptoMatchMeta` Map (not stored in DB). Kalshi price fetch handles crypto matches via synthetic probabilities. Startup validation checks mode-specific env vars. Mode + Sharpe displayed in bot status.
- `tests/test_prediction_bot.js`: Async test framework — `test()` detects promises and queues them. `Promise.all()` at end. `enterPosition` test uses `async/await`.

**V14 Gemini Prediction Markets API Reference:**
```
Base URL: https://api.gemini.com (prod), https://api.sandbox.gemini.com (sandbox — no prediction symbols)

Instrument symbols: GEMI-BTC2602190200-HI66250 (NOT btcusd-pred-*)

POST /v1/prediction-markets/order          — Place limit order
  Fields: symbol, orderType ("limit"), side, quantity, price, outcome ("yes"/"no"), timeInForce
  Returns: { orderId, status, avgExecutionPrice, filledQuantity, remainingQuantity }

POST /v1/prediction-markets/order/cancel   — Cancel order
  Fields: orderId
  Returns: { result: "ok" }

POST /v1/prediction-markets/orders/active  — List open orders
  Returns: { orders: [...] }

POST /v1/prediction-markets/orders/history — Filled/cancelled history
  Returns: { orders: [...] }

POST /v1/prediction-markets/positions      — Current positions
  Returns: { positions: [...] }

Auth (all private endpoints):
  payload = base64(JSON({ request, nonce, account: 'primary', ...fields }))
  signature = HMAC-SHA384(payload, API_SECRET)
  Headers: X-GEMINI-APIKEY, X-GEMINI-PAYLOAD, X-GEMINI-SIGNATURE
  Nonce: seconds since epoch (NOT milliseconds), must be within ±30s of server time
```

**V14 Key Lessons:**
- **Prediction markets use separate API endpoints** — `/v1/prediction-markets/*`, NOT `/v1/order/new`. Standard exchange endpoints reject `GEMI-*` symbols with `InvalidSymbol`.
- **Nonce must be in seconds** — `Date.now()` returns ms, Gemini expects seconds. Use `Math.floor(Date.now() / 1000)`.
- **Nonce must be strictly increasing** — Track `_lastNonce` and increment when multiple requests in same second.
- **`account: 'primary'`** — Required in all signed POST payloads or you get auth failures.
- **Sandbox has no prediction symbols** — Cannot test prediction orders on sandbox.
- **Market ID routing** — Only `GEMI-*` IDs are real instruments. `gemini_sim_*` MUST stay paper.
- **Paper exits on live trades cause phantom profit** — monitorPositions() must skip `mode='live'` trades. A live order at $0.99 NO followed by a paper exit at $0.01 generated a phantom $489 profit that corrupted the wallet. Fixed by checking `trade.mode === 'live'` in monitorPositions().
- **NO direction entry at $0.99 is catastrophic** — For deep-ITM contracts, `1 - bestBid` ≈ $0.99. Safety guards: reject NO > $0.85, reject edge < 1¢, require score ≥ 45, require Gemini bid/ask defined.
- **Kalshi synthetic probabilities can exceed 1.0** — `computeSyntheticAbove()` sums bracket mid prices from thinly-traded brackets. Must clamp to [0, 1].
- **Crypto markets need structural matching** — Gemini "BTC > $66,500" has no Polymarket equivalent. Must match by asset + strike to Kalshi KXBTC brackets using `computeSyntheticAbove()`. Title-based fuzzy matching doesn't work.
- **InsufficientFunds cascade** — With only $5.99 real balance and 30+ crypto signals, the bot sends dozens of orders that all fail. Need minimum live balance check.
- **Live exits not yet implemented** — Entry orders go to the real API, but exits still use paper simulation (which are now blocked for live trades). V15 must add real sell orders.

**V14 Findings — Crypto Signal Quality:**
- 153+ GEMI-* ↔ Kalshi pairs are now matched per cycle (BTC, ETH, SOL, XRP, ZEC)
- Many signals have `Gemini=undefined` because the contract has no bestAsk (one-sided book). These are filtered out by the "Gemini bid/ask undefined" guard.
- Kalshi synthetic bid sums for deep-ITM contracts often sum > 1.0 → clamped to 1.0
- Real tradeable opportunities are rare: most GEMI-* crypto contracts have wide spreads (0.10-0.40) making arb entry expensive
- Paper trading on simulated markets continues to work well (17W/0L) alongside live crypto matching

**V14 .env additions:**
```
GEMINI_MODE=live               # NEW: controls paper/live/sandbox mode
SANDBOX_GEMINI_API_KEY=        # NEW: sandbox auth
SANDBOX_GEMINI_API_SECRET=     # NEW: sandbox auth
```

**V15 candidates:**
- Implement live exit orders (sell via `/v1/prediction-markets/order`) for `mode='live'` positions
- Add minimum live USD balance check before sending orders ($5 minimum)
- Improve Kalshi synthetic accuracy: filter out illiquid brackets (spread > 0.5 or volume = 0) before summing
- Use Gemini `buy.no`/`sell.no` prices directly instead of computing `1 - bestBid` for NO entries
- Rate-limit live order attempts (max 3 per cycle, avoid InsufficientFunds spam)
- Walk-forward backtest on paper trade log once 500+ trades accumulated
- Auto-flip to live mode when paper Sharpe > 2.0 and 500+ trades

---

## Previous Version: V13

**Merged in V13:**
- `lib/kalshi_client.js`: **RSA-PSS auth for REST** — replaced broken `Bearer` token header with proper RSA-PSS SHA256 signing (same scheme as KalshiWS). Loads private key from `KALSHI_PRIVATE_KEY_PATH` or `KALSHI_PRIVATE_KEY` env var. Signed message = `timestamp_ms + METHOD + /trade-api/v2/path` (query string stripped, per Kalshi Python SDK). `getBestPrices()` now checks `bracketCache` (WS live ticks, < 30s old) first, falls back to REST orderbook.
- `lib/kalshi_ws.js`: WS hostname: `wss://api.elections.kalshi.com/trade-api/ws/v2`.
- `lib/signal_detector.js`: Direction logic rewritten — PRIMARY signal is Gemini-vs-reference spread (arb direction), not price level. Old fallback `refPrice < 0.45 → NO` removed (caused 100% loss rate). Edge threshold: 1.5¢. Default `feePerSide` corrected `0.0006` → `0.0001`.
- `lib/fair_value_engine.js`: Default `feePerSide` corrected `0.0006` → `0.0001`.
- `lib/gemini_client.js`: Execution model changed from market-taker (ask + slippage) to maker-or-cancel (mid + 0.1¢ fee). `executePaperTrade` and `getPaperExitPrice` both use `market.last` as fill base. Round-trip cost: ~0.2¢ (was ~5¢). HTTP 429 retry with exponential backoff (max 3 retries, was infinite recursion). `updatePaperMarket` spread persisted across cycles (was re-randomized each call, causing phantom signals).
- `lib/paper_trading_engine.js`: Adaptive learning uses sliding window (`getRecentTradeStats(20)`) instead of daily PnL. Cap lowered 90→65, tightening slowed 10%→5%, starvation detection after 5 consecutive tightenings resets to 45. Min profit target: 1.5¢.
- `lib/prediction_db.js`: Added `getRecentTradeStats(n)` — last-N trades sliding window for adaptive learning.
- `server/prediction-proxy.js`: `signalDetector.loadParameters()` called after each `tradingEngine.tick()` to sync adaptive threshold. Cross-platform arb direction normalized: `BUY_GEMINI_YES`/`SYNTHETIC_ARB` → `YES`, `SELL_GEMINI_YES` → `NO` (paper trading engine expects YES/NO).
- `AGENTS.md`: Complete state model rewrite with execution details.

**V13 Key Lessons:**
- **Direction logic**: The arb direction is `Gemini vs reference (Poly/Kalshi) spread`. When Gemini < reference → YES (buy underpriced). When Gemini > reference → NO (sell overpriced). NEVER use absolute price level for direction.
- **Execution model**: Maker-or-cancel fills at mid, not at ask/bid. Paper model must match this or systematic losses result.
- **Adaptive threshold starvation**: If threshold tightens to 65 and max score is ~50, no trades enter and the window never refreshes. Need starvation detection + auto-reset.
- **Kalshi REST auth**: Was broken since V1. Now uses same RSA-PSS scheme as KalshiWS. Hostname: `api.elections.kalshi.com` (NOT `trading-api.kalshi.com` — that returns 401 + redirect). Signed message: `timestamp_ms + METHOD + full_path` (full path includes `/trade-api/v2` prefix, query string EXCLUDED per official Kalshi Python SDK).
- **bracketCache**: KalshiWS live ticks were being collected but never consumed. Now `getBestPrices()` in `kalshi_client.js` checks bracketCache first.
- **Arb direction mapping**: `detectCrossPlatformArb` returns `BUY_GEMINI_YES`/`SELL_GEMINI_YES`/`SYNTHETIC_ARB` but PaperTradingEngine requires `YES`/`NO`. Must normalize before injecting into actionable signals.
- **HTTP 429**: Gemini `_fetch` and `_signedPost` had unbounded recursion on 429. Fixed with retry counter + exponential backoff (3s, 6s, 12s, then throw).
- **feePerSide defaults**: Both `signal_detector.js` and `fair_value_engine.js` defaulted to `0.0006` (6× too high). Fixed to `0.0001` to match maker-or-cancel fee model.

**V13 .env** (no changes from V12)

---

## Previous Version: V11

**Merged in V11:**
- `server/prediction-proxy.js`: Added `require('dotenv').config()` at top — env vars from `.env` were silently ignored before
- `lib/kalshi_client.js`: Added `this.bracketCache = new Map()` to constructor — WS tick data was being discarded
- `lib/paper_trading_engine.js`: Fee calibration `0.0006` → `0.0001` (0.01% maker-or-cancel rate, 6× more accurate)
- `lib/kalshi_ws.js`: API key guard (skip connect if no key) + removed `this.emit('error')` that crashed Node with no listener
- `.env.example`: Added root-level template for all prediction bot env vars
- `skills/BTizzy/prediction-market-architecture.md`: Architecture deep-dive (platform fees, strategy types, failure modes)
- `skills/BTizzy/statistical-validation.md`: 5-phase validation framework, anti-patterns, go-live gates