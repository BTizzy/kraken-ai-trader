# ⚠️ LEGACY README — See `Must_read_before_any_agent_task.md` for all current info

> **IMPORTANT:** This file contains legacy and game-oriented documentation for the original JS-based volatility bot. The current production system is a C++/SQLite trading bot. All agents and contributors should refer to `Must_read_before_any_agent_task.md` for up-to-date architecture, operational, and strategy information.

---

## Historical Context (Legacy Bot)

- The original bot was a volatility-based mean reversion system for Kraken, written in JavaScript, with a web UI and paper/live trading modes.
- Strategy: Scan for high-volatility pairs, enter mean reversion trades, exit quickly with strict risk management.
- Key features included: WebSocket price feeds, volatility detection, paper trading, and a browser dashboard.
- Risk management, position sizing, and exit logic were tuned for ultra-short-term trades (seconds to minutes).
- See below for legacy config and technical details (for historical reference only).

---

## For all current and future development, see:

## Experimentation & Automation (NEW)

This project now includes an experiment automation and model training pipeline used to run continuous paper-mode experiments, generate candidate parameter sets, and autonomously promote validated strategies. Key scripts:

- `scripts/orchestrate_paper_experiments.js` — Run sequential candidate experiments, supports candidate files (`--candidates-file`), monitor overrides, and looping mode `--loop`.
- `scripts/auto_promotion_watchdog.js` — Watches experiment results and triggers validation runs + promotion when candidate P&L exceeds `PROMOTE_PNL`.
- `scripts/generate_candidates_dynamic.js` — Create dynamic-vol TP/SL candidate sets from historical trades.
- `scripts/walk_forward_backtest.js` & `scripts/walk_forward_grid_search.js` — Walk‑forward validation and grid search utilities.
- `scripts/train_direction_model.js` — Train a simple direction model (logistic) from historical trades and save `data/direction_model.json`.
- `scripts/fetch_public_trades.js` — Fetch recent public trades via the server for model features and save `data/market_data.json`.
- `scripts/analyze_directional_misfires.js` — Analyze historical trades to detect pairs that historically do better when inverted; writes `data/direction_rules.json`.

Logs and artifacts are written to `logs/` and `data/`. Reads and writes are SQLite-first; the JSON artifacts are for experiment tracking and model training.

Safety notes: all automated experiments run with a live monitor (`scripts/monitor_trade_pnl.js`) which will stop runs based on stop-loss and profit target. These thresholds are configurable via environment variables (e.g. `MONITOR_STOP_LOSS`, `MONITOR_PROFIT_TARGET`). Use conservative Kelly fractions (`KELLY_FRACTION_OVERRIDE`) for aggressive experiments.

For details and operational instructions see `Must_read_before_any_agent_task.md` which has been updated with experiment guidelines.
