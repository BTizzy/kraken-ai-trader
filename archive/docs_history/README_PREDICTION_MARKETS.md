# Prediction Market Trading Bot

## Overview

High-frequency prediction market trading bot that exploits low-volume inefficiencies on Gemini's prediction markets by monitoring price movements on Polymarket and Kalshi, then executing faster than retail investors.

**Strategy:** Price Movement Front-Running — NOT traditional arbitrage. We use Polymarket/Kalshi as leading indicators of where Gemini prices will move, then front-run retail flow.

**Target:** $1,000/day profit within 3 weeks using $500 starting capital in paper trading mode.

## Quick Start

```bash
# Install dependencies
npm install

# Start the prediction market bot (paper trading mode)
npm run prediction

# Or run directly
node server/prediction-proxy.js

# Dashboard available at http://localhost:3003
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Dashboard UI                         │
│              http://localhost:3003                        │
│         (Real-time WebSocket + REST API)                 │
└──────────┬──────────────────────────────────┬────────────┘
           │                                  │
┌──────────▼──────────┐          ┌───────────▼───────────┐
│  Prediction Proxy   │          │   Paper Trading       │
│  (Express + WS)     │          │   Engine              │
│  server/prediction- │          │   lib/paper_trading_   │
│  proxy.js           │          │   engine.js            │
└──────────┬──────────┘          └───────────┬───────────┘
           │                                  │
┌──────────▼──────────────────────────────────▼───────────┐
│                  Signal Detector                         │
│            lib/signal_detector.js                        │
│   (Scoring: velocity + spread + consensus + staleness)   │
└───────┬──────────────┬──────────────┬──────────────────┘
        │              │              │
┌───────▼──────┐ ┌────▼──────┐ ┌────▼──────┐
│  Polymarket  │ │  Kalshi   │ │  Gemini   │
│  Client      │ │  Client   │ │  Client   │
│  (signals)   │ │  (signals)│ │  (exec)   │
└──────────────┘ └───────────┘ └───────────┘
        │              │              │
┌───────▼──────────────▼──────────────▼──────────────────┐
│              Market Matcher                              │
│         lib/market_matcher.js                            │
│   (Fuzzy matching + manual overrides)                    │
└────────────────────────┬───────────────────────────────┘
                         │
┌────────────────────────▼───────────────────────────────┐
│              SQLite Database                             │
│         data/prediction_markets.db                       │
│   (markets, prices, trades, signals, wallet, params)     │
└────────────────────────────────────────────────────────┘
```

## Key Components

| File | Purpose |
|------|---------|
| `server/prediction-proxy.js` | Main server: API proxy, trading loop, WebSocket |
| `lib/prediction_db.js` | SQLite schema and data access layer |
| `lib/polymarket_client.js` | Polymarket Gamma/CLOB API client |
| `lib/kalshi_client.js` | Kalshi REST API client |
| `lib/gemini_client.js` | Gemini API + paper trading simulation |
| `lib/market_matcher.js` | Cross-platform market matching |
| `lib/signal_detector.js` | Opportunity scoring (0-100) |
| `lib/paper_trading_engine.js` | Entry/exit logic, Kelly sizing, learning |
| `server/rate-limiter.js` | Per-platform request rate limiting |
| `dashboard/index.html` | Dashboard UI |
| `config/prediction_params.json` | Tunable parameters |
| `data/matched_markets.json` | Manual market match overrides |

## Signal Scoring (0-100 points)

| Component | Max Points | What It Measures |
|-----------|-----------|-----------------|
| Price Velocity | 20 | Magnitude of price move on Poly/Kalshi (≥3¢ in 10s) |
| Spread Differential | 20 | Gemini spread vs Poly/Kalshi average |
| Cross-Platform Consensus | 25 | Both platforms agree on direction |
| Gemini Staleness | 15 | Time since last Gemini trade |
| Category Win Rate | 20 | Historical win rate for market category |

**Minimum score to trade:** 60 (adaptive)

## Risk Management

| Rule | Value |
|------|-------|
| Max concurrent positions | 5 |
| Max per category | 2 |
| Max position size | $100 (20% of bankroll) |
| Capital at risk limit | 50% |
| Stop loss | 3¢ from entry |
| Take profit | Reference price - 1¢ buffer |
| Max hold time | 10 minutes |
| Daily loss limit | -$50 |
| Drawdown kill switch | -20% from peak |
| Simulated slippage | 0.5¢ per trade |

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/markets` | GET | All matched markets with prices |
| `/api/signals` | GET | Current opportunity signals |
| `/api/trades/open` | GET | Open positions |
| `/api/trades/recent` | GET | Recent closed trades |
| `/api/wallet` | GET | Paper wallet status |
| `/api/performance` | GET | Full performance summary |
| `/api/daily-pnl` | GET | Today's P&L |
| `/api/parameters` | GET | Bot parameters |
| `/api/parameters/:key` | POST | Update a parameter |
| `/api/bot/start` | POST | Start the bot |
| `/api/bot/stop` | POST | Stop the bot |
| `/api/bot/status` | GET | Full bot status |
| `/api/markets/rematch` | POST | Force market re-match |
| `/ws` | WebSocket | Real-time updates |

## Adaptive Learning

Every 30 seconds, the bot evaluates recent performance:

- **Win rate > 65% & avg PnL > $2:** Lower entry threshold, increase Kelly multiplier
- **Win rate < 50%:** Raise entry threshold, tighten stop losses
- Parameters bounded by min/max values to prevent runaway optimization

## Paper Trading Simulation

Paper mode faithfully simulates real execution:
- Fill at Gemini ask (buying YES) or bid (buying NO)
- 0.5¢ slippage penalty on every trade
- Extra slippage if position > 50% of orderbook depth
- 100-500ms simulated network latency
- Wider spreads on Gemini (22-27¢) vs competitors (4-6¢)

## Development Phases

- [x] **Phase 1:** Data infrastructure (API clients, DB schema, market matching)
- [x] **Phase 2:** Signal generation (opportunity scoring, velocity detection)
- [x] **Phase 3:** Paper trading bot (entry/exit logic, wallet simulation)
- [ ] **Phase 4:** Optimization (parameter tuning, ML model, backtesting)
- [ ] **Phase 5:** Scale to target ($1,000/day)
