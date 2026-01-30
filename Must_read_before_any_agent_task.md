# MUST READ BEFORE ANY AGENT TASK

## Overview

**IMPORTANT:** This is a production trading bot, not a game. Some older documentation and files may reference a "game" or prediction market, but the current focus is a robust, data-driven cryptocurrency trading bot for Kraken. Please disregard or update any outdated/game-related references you encounter. The goal is extreme profitability.

This document provides a high-level summary of the kraken-ai-trader system, its architecture, and the evolution of its profitability strategies. All agents and contributors must review this before making changes or proposing improvements.


## System State Model (Trading Bot)


### Components
- **C++ Bot (`kraken_bot`)**: Core trading logic, regime detection, trade execution, and data logging. Runs in paper or live mode.
- **Node.js Server (`server/kraken-proxy.js`)**: API proxy for the bot, handles communication with exchanges and external services.
- **High-Frequency Price Collector (`lib/price_data_collector.js`)**: Real-time price data collection every 2 seconds, storing in SQLite with rolling buffers for technical analysis.
- **UI (HTML/JS/CSS)**: Provides dashboards and monitoring for bot status, trade logs, and analytics.
- **SQLite Databases**: 
  - `data/trades.db`: All trade records, technical indicators, and performance metrics. Single source of truth.
  - `data/price_history.db`: High-frequency price data (1,800+ data points/hour vs 5 before) for real-time technical analysis.
- **Config & Scripts**: JSON and JS files for configuration, backtesting, enrichment, and migration.


### Data Flow
1. **High-Frequency Price Collection**: Price collector fetches real-time ticker data every 2 seconds from Kraken API, stores in SQLite with rolling buffers.
2. **Market Data** is fetched by the bot via REST API (`/api/prices/`) for technical analysis with 360x more data points than previous OHLC candles.
3. **Bot** processes high-frequency data, calculates technical indicators (RSI, MACD, SMA, EMA, ATR, Bollinger Bands), classifies regime (RANGING, TRENDING, VOLATILE, QUIET), and decides on trades.
4. **Trades** are executed (paper/live) and logged directly to SQLite. JSON files (including `bot_status.json`) are no longer used for trading or as a source of truth.
5. **Server** exposes API endpoints for UI, price data, and external tools.
6. **UI** displays live and historical analytics, trade logs, and bot health.
7. **Learning Engine** runs continuous adaptation every 30 seconds, analyzing trade patterns and evolving strategies based on performance data.


### Connectors & Interactions
- **Bot ↔ Server**: REST/WebSocket API for trade execution, status, and data sync.
- **Server ↔ Exchange**: Handles authentication, rate limits, and error handling.
- **UI ↔ Server**: Fetches analytics, trade logs, and bot status for user display.


### Profitability Evolution
- **Initial**: Fixed TP/SL, static regime thresholds, basic momentum/trend filters.
- **V1**: Added regime detection, blocked RANGING/TRENDING, focused on VOLATILE.
- **V2**: Dynamic TP/SL scaling with volatility, volatility ceiling, learning mode for data gathering.
- **Current**: Ongoing improvements to regime thresholds, volatility scoring, and trade selection based on historical win rates.


### Key Insights
- **VOLATILE regime (2.5-4% vol)** historically had 100% win rate with fixed 1.5% TP.
- **Higher volatility (4-7%)** led to more timeouts and lower win rates.
- **Dynamic scaling** is being tuned to avoid "death zones" and maximize profitable trades.
- **High-Frequency Data**: 360x improvement (1,800+ data points/hour vs 5) enables much more responsive technical analysis and trading decisions.


## Roadmaps, Strategy, and Key Files for Agents

### Roadmap Files (Most Relevant)
- `IMPROVEMENTS_ROADMAP.md` and `IMPROVEMENTS_ROADMAP_V2-V7.md`: These contain the full history of improvements, bug fixes, and open issues. **Always check the latest version (highest V#) for the most current priorities and system state.**
- `STRATEGY_LOG.md`: Tracks all strategy iterations, test results, and learnings. Use this to avoid regression and understand what has/hasn't worked.
- `KRAKEN_CPP_BOT_SUMMARY.md`: Technical summary of the C++ bot, learning engine, and architecture. Read this for a deep dive into the bot's design and learning cycle.
- `bot/BUILD_AND_DEPLOY.md`: Step-by-step build, deployment, and learning cycle guide for the C++ bot.
- `README.md`: General project overview, but **note**: some sections are outdated or game-oriented. Focus on the C++ bot, the learning engine and trading logic.
- `CONTRIBUTING.md`: Contribution guidelines. Some sections may reference the old "game" concept—please update as needed.
- `DEPLOYMENT.md`: Deployment instructions for web UI and server. Some info may be web-game specific.

### Outdated or Game-Related Files
- Some files and documentation (especially older README sections and web UI code) may reference a "game" or prediction market. These are legacy and should be ignored or updated for the current trading bot focus.

### Agent Guidance
- **Always check the latest roadmap and strategy log before proposing changes.**
- If you find conflicting or outdated information, prioritize the most recent roadmap and C++ bot documentation.
- When in doubt, ask for clarification or propose updates to documentation.

---

---
#### Operational Reminders for Agents

**Common issues and best practices:**

- **Always start the Node.js server (`server/kraken-proxy.js`) before running or testing the C++ bot.** The bot relies on the server for API access and will not function correctly if the server is down.
- **Always start the Node.js server (`server/kraken-proxy.js`) before running or testing the C++ bot.** The bot relies on the server for API access and will not function correctly if the server is down.
  - Operational note: Do not kill the running server process during monitoring runs. If you must restart, perform a graceful restart and verify routes with `GET /__routes__` and `GET /api/collector/status2` before starting monitoring. Add logs and route checks if you see unexpected 404s.
- **Before testing or debugging, check if the `kraken_bot` process is running.** Use `pgrep kraken_bot` or similar commands to confirm. If not running, start it from `bot/build`.
- **Always verify the terminal state before running commands.** Make sure you are in the correct directory and that the terminal is not blocked by a running process.
- **If you cannot find log output, check if the bot is running in a different terminal or if output is being redirected.**
- **CRITICAL: Never run sleep or other commands immediately after starting the bot servers, data collection scripts or other proccesses in background.** This interrupts the process. Instead, use dedicated terminals for long-running processes or proper process management with `&` and job control.
- **High-frequency collector health:** The price collector now exposes `/api/collector/status` on the proxy server and will emit a fatal condition when consecutive data collection errors exceed a configurable threshold (env `PRICE_COLLECTOR_CONSECUTIVE_ERROR_THRESHOLD`). This can be configured to exit the process (`PRICE_COLLECTOR_FAIL_FAST=true`) so failures are visible and addressed rather than silently falling back to arbitrary values.
  - New: Collector prefers a WebSocket-based real-time feed as the primary ingestion path. The WS connection status and metrics are surfaced via `/api/collector/status` with fields `ws_status`, `last_ws_connected_ts`, `last_ws_message_ts`, and `ws_message_count`. If WS is unavailable the collector will fall back to REST polling; monitor WS fields and collector `last_successful_sample_ts` for signal quality.
- **Update this section with any new operational lessons learned to help future agents avoid common pitfalls.**

Additional operational note (sidecar):
- A lightweight health sidecar (`server/health-sidecar.js`) is available that reads the `data/price_history.db` and exposes `/health/collector` on port 3006. Use this as a reliable fallback probe when `/api/collector/status` or other debug endpoints on the main proxy are returning unexpected HTML 404s (diagnostic evidence shows some local responders may intermittently answer loopback requests with HTML 404). The monitor script (`scripts/monitor_paper_run.js`) has been updated to probe this sidecar at `http://localhost:3006/health/collector` when the primary status endpoints are unavailable.

## Experimentation & Automation (NEW)

We maintain an autonomous experiment pipeline that continuously runs paper-mode experiments, performs offline validation, and promotes candidates that pass guardrails.

- `scripts/generate_candidates_dynamic.js` — generate dynamic-vol TP/SL candidate lists from historical trades (`logs/candidates_dynamic.json`).
- `scripts/walk_forward_backtest.js` & `scripts/walk_forward_grid_search.js` — walk-forward tests and grid searches for OOS validation.
- `scripts/orchestrate_paper_experiments.js` — orchestrator that runs sequential candidate experiments, supports candidate files, monitor overrides, and loop mode.
- `scripts/auto_promotion_watchdog.js` — automatic validation and promotion of candidates that exceed `PROMOTE_PNL`.
- `scripts/train_direction_model.js` — train a simple direction model on historical trades and save `data/direction_model.json`.
- `scripts/fetch_public_trades.js` — periodic fetch of public trades via `/api/trades/:pair` to feed model features.
- `scripts/analyze_directional_misfires.js` — detect pairs where flipping trade direction improves historical outcomes and writes `data/direction_rules.json`.

Operational notes:
- Artifacts and logs are saved to `logs/` and `data/` — treat `data/` SQLite DBs as the single source of truth. JSON artifacts are for experiments and model training only.
- Safety: `scripts/monitor_trade_pnl.js` enforces stop-loss and profit-target thresholds (configurable via environment variables). Use `KELLY_FRACTION_OVERRIDE` to limit exposure for aggressive experiments.
- Model lifecycle: the direction model is retrained by the orchestrator after experiments and hot-reloaded by the bot's learning engine during continuous learning cycles.

If you make changes to experiment scripts, update the README and `Must_read_before_any_agent_task.md` so future agents follow the current process.

---
*Last updated: January 22, 2026*