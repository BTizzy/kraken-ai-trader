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
│   ├── signal_detector.js      ← 5-component scoring + FV + momentum + arb
│   ├── fair_value_engine.js    ← Black-Scholes + Kalshi IV + ensemble FV
│   ├── market_matcher.js       ← Cross-platform market matching
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
│   └── prediction_market_strategies.md
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

---

## State Model (Memorize This)

```
EXTERNAL DATA (read-only)          SIGNAL PIPELINE (2s cycle)
─────────────────────────          ───────────────────────────────────────
Kraken REST → spotPriceCache        Strategy 1: CompositeScore
Polymarket  → priceIndex            Strategy 2: FairValue BS + Kalshi IV
Kalshi WS   → bracketCache          Strategy 3: Event-Driven Momentum
Gemini REAL → contracts.Map         Strategy 4: Cross-Platform Synthetic Arb
              + OrderbookDepth                   ↓
                                    PaperTradingEngine.tick()
                                      ├── canEnterPosition (Kelly + depth cap)
                                      └── monitorPositions
                                            └── time-decay stop (final 20%)
                                               ↓
                                    SQLite (FK ON, WAL)
                                    WebSocket → Dashboard
                                    Discord → Alerts
```

---

## Key Numbers

| Parameter | Value | Why |
|-----------|-------|-----|
| Scan interval | 2s | Balances freshness vs rate limits |
| Entry threshold | 45 (adaptive) | Score 0-100; adaptive learning tightens/loosens |
| Min edge | 3¢ | After fees, must be positive |
| Kelly multiplier | 0.25 | Fractional Kelly for safety |
| Max position | $100 | Thin Gemini books, don't move market |
| Max concurrent | 5 | Capital concentration risk |
| Stop loss | 3¢ | Tight — we have high turnover strategy |
| Max hold | 600s | Force exit before contract decay |
| Drawdown kill | 20% | Auto-stop the bot |
| Gemini fee | 0.01% maker / 0.05% taker | Use maker-or-cancel always |

---

## Running the Bot

```bash
# Start (paper mode default)
node server/prediction-proxy.js

# Dashboard
open http://localhost:3003

# Health check
curl http://localhost:3003/api/health

# Run tests
node tests/test_fair_value_engine.js
node tests/test_prediction_bot.js

# Force market rematch
curl -X POST http://localhost:3003/api/markets/rematch
```

---

## .env Required Variables

```
KALSHI_API_KEY=         # For Kalshi auth (public endpoints work without)
GEMINI_API_KEY=         # For live trading (leave blank for paper)
GEMINI_API_SECRET=      # For HMAC signing (leave blank for paper)
DISCORD_WEBHOOK_URL=    # For alerts (optional but recommended)
```

---

## Agent Rules (from Must_read_before_any_agent_task.md)

1. Read this file AND all linked skills before any task
2. Review conversation history — more important than old READMEs
3. Visualize the full state model before responding
4. Add new skill `.md` files in `skills/` when you discover useful knowledge
5. Before responding, reflect on what could have gone better and what a future agent should know

---

## Current Version: V10

**Merged in V10:**
- `lib/alerts.js`: Discord webhook alerts for arb events (≥3¢) + daily P&L summary
- `lib/kalshi_ws.js`: Real-time Kalshi WebSocket (ticker_v2, auto-reconnect, bracket subscriptions)
- `lib/gemini_client.js`: HMAC-SHA384 `_signedPost()` + `placeOrder()` (paper-guarded), `cancelOrder()`, `getOpenOrders()`
- `lib/gemini_predictions_real.js`: `fetchBatchTickers(category)` — lightweight 5s price-only updates
- `lib/paper_trading_engine.js`: Depth-based Kelly cap (max 10% of real `ask_depth`), `time_decay_stop` ML feedback
- `lib/prediction_db.js`: `getWinRateByExitReason()` — breakdown by exit reason for learning cycle
- `server/prediction-proxy.js`: Alerts + KalshiWS wired; arb detection → Discord; Kalshi brackets auto-subscribed after match cycle; `/api/signals` exposes `arbEvents` + `momentumAlerts`
- `dashboard/index.html` + `prediction_charts.js`: Arb Events + Momentum Alerts panels, polled every 5s

**V11 candidates:**
- Live mode E2E test harness (test HMAC auth against Gemini sandbox/testnet if available)
- Kalshi WS bracket ticker → `kalshiClient.getBracketsByEvent()` cache integration (currently feeds `bracketCache` directly)
- Walk-forward backtest on paper trade log once 500+ trades accumulated
- Gemini order book WebSocket (if Gemini opens WS for prediction markets)
- Auto-flip to live mode when paper Sharpe > 2.0 and 500+ trades (DEPLOYMENT CHECKLIST)
