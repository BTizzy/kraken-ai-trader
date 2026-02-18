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

## Current Version: V12

**Merged in V12:**
- `lib/kalshi_ws.js`: **Complete rewrite** — RSA-PSS SHA256 signing (Kalshi requires `KALSHI-ACCESS-KEY` + `KALSHI-ACCESS-TIMESTAMP` + `KALSHI-ACCESS-SIGNATURE` headers, NOT Bearer tokens). Loads private key from PEM file (`KALSHI_PRIVATE_KEY_PATH`) or inline env var (`KALSHI_PRIVATE_KEY`). WS URL corrected to `wss://api.elections.kalshi.com/trade-api/ws/v2`. Fixed `stopped` flag bug: `connect()` now resets `this.stopped = false` so bot stop→start cycle reconnects properly.
- `server/prediction-proxy.js`: Gemini polling sped up (`realFetchInterval` 15s→10s, `tickerFetchInterval` 5s→2s, `cacheTTL` 3s→2s, `realCacheTTL` 10s→2s, `realApiInterval` 2s→1s). Added `recordApiResult()` calls for Kraken (in `fetchSpotPrices`), Kalshi (in market loop), and Gemini (after `getMarketState`) so all 4 API health dots work. Added `ws_clients: wss.clients.size` to `/api/health` response. Added `emergencyExitAll`, `validateStartup`, mode+Sharpe API endpoints.
- `dashboard/index.html`: V12 dashboard HTML — API health dots (Polymarket/Kalshi/Kraken/Gemini), mode badge (PAPER/LIVE), emergency kill switch button, Sharpe ratio metric, 8-column metrics row.
- `dashboard/prediction_charts.js`: WSS protocol auto-detection (`wss://` when page is HTTPS, `ws://` when HTTP) to fix Mixed Content blocking on GitHub Codespaces. Added try/catch fallback for WS construction. Added `ws_clients` display in health panel.
- `dashboard/styles_prediction.css`: All V12 styles — emergency button pulse animation, mode badge, API health dots, health panel, close position button, circuit breaker, trade reason badges. `metrics-row` grid expanded from 6→8 columns.
- `lib/gemini_client.js`: Updated comments to reflect new polling intervals.
- `.gitignore`: Added `*.pem` and `*private_key*` to protect RSA key files from accidental commit.

**V12 Key Lessons:**
- **Kalshi auth**: Bearer tokens don't work. Must RSA-PSS sign `timestamp + 'GET' + '/trade-api/ws/v2'` and send 3 headers. Private key must be a full PKCS#8 PEM file (1679 bytes), NOT truncated.
- **WSS on HTTPS**: Always detect protocol: `window.location.protocol === 'https:' ? 'wss:' : 'ws:'` — hardcoded `ws://` is blocked by browsers when page is served over HTTPS.
- **KalshiWS lifecycle**: `disconnect()` sets `stopped = true`. Always reset it at the start of `connect()` or bot restart won't reconnect.
- **API health dots**: `recordApiResult(source, success)` must be called after every platform fetch, not just Polymarket.

**V12 .env additions:**
```
KALSHI_PRIVATE_KEY_PATH=./kalshi_private_key.pem   # Path to RSA private key PEM file
# OR
KALSHI_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

**V13 candidates:**
- Live mode E2E test harness (test HMAC auth against Gemini sandbox/testnet if available)
- Walk-forward backtest on paper trade log once 500+ trades accumulated
- Gemini order book WebSocket (if Gemini opens WS for prediction markets)
- Auto-flip to live mode when paper Sharpe > 2.0 and 500+ trades
- Telegram alerts (replacing Discord)

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