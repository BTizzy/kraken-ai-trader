# Prediction Market Arbitrage Bot

Paper + live prediction market trading bot targeting Gemini Prediction Markets by exploiting mispricings vs Polymarket and Kalshi.

**Current Version: V18** | **Status: DATA COLLECTION** | **Goal: $100 live test after 100+ paper trades**

## Quick Start

```bash
npm install
node server/prediction-proxy.js        # Paper mode (default)
open http://localhost:3003              # Dashboard
```

## Documentation

**Start here:** [AGENTS.md](AGENTS.md) -- single source of truth for architecture, state model, parameters, running instructions, and version history.

### Skills (reference docs in `skills/`)

| File | What |
|------|------|
| [gemini_api_skill.md](skills/gemini_api_skill.md) | HMAC auth, order placement, ticker API |
| [prediction_market_strategies.md](skills/prediction_market_strategies.md) | 5 strategies, fee landscape, platform structures |
| [backtest_analysis_v18.md](skills/backtest_analysis_v18.md) | Backtest results, parameter sweep, confidence assessment |
| [BTizzy/prediction-market-architecture.md](skills/BTizzy/prediction-market-architecture.md) | Platform comparison, strategy types, fee math |
| [BTizzy/statistical-validation.md](skills/BTizzy/statistical-validation.md) | 5-phase validation, go-live gates |
| [community/websocket.md](skills/community/websocket.md) | Backoff+jitter, heartbeat, close codes |
| [community/sqlite.md](skills/community/sqlite.md) | WAL, busy_timeout, pragma reference |
| [community/polymarket-fast-markets.md](skills/community/polymarket-fast-markets.md) | 10% fast-market fee warning |
| [community/prediction-market-arb-types.md](skills/community/prediction-market-arb-types.md) | 5-type arb taxonomy, min edge thresholds |

### Scripts

| Script | What |
|--------|------|
| `node scripts/backtest_v17.js` | BS fair value backtester (GEMI-* crypto) |
| `node scripts/backtest_crossplatform.js` | Cross-platform arb backtester (sim markets) |
| `node tests/test_fair_value_engine.js` | Fair value engine unit tests |
| `node tests/test_prediction_bot.js` | Paper trading engine tests |

## Key Commands

```bash
curl http://localhost:3003/api/health          # Health check
curl http://localhost:3003/api/bot/status       # Bot status + Sharpe
curl -X POST http://localhost:3003/api/bot/emergency-stop  # Emergency stop
```
