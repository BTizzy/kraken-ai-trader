# Scripts Organization

This folder contains operational and analysis scripts for the prediction market bot.

## Core Orchestrators (Root)

The following scripts are the **primary user-facing entry points**:

- **`run_two_day_campaign.js`** — Multi-hour campaign runner with checkpoint-resumable mode (primary validation tool)
- **`run_capped_live_session.js`** — Single bounded trading session (15m-4h) with gating and reconciliation
- **`run_capped_session_batch.js`** — Batch runner for multiple sequential sessions
- **`verify_gates.js`** — Pre-flight safety verification (flat state, no orphaned positions, no phantoms)
- **`activate_session_profile.js`** — Profile activation for trading parameters
- **`manual_scalp.js`** — Manual one-off trade execution
- **`monte_carlo_liquidity_sim.js`** — Liquidity simulation for edge estimation

## Subdirectories

### `backtest/` — Historical Backtesting & Strategy Validation
- `backtest_v17.js`, `backtest_crossplatform.js` — Main backtester engines
- `walk_forward_*.js` — Walk-forward validation framework
- `orchestrate_paper_experiments.js` — Batch experiment runner
- `stress_test_*.js` — Stress testing under various market conditions

Use these to:
- Validate parameter sweeps (edge thresholds, stop loss, hold times)
- Test cross-platform arbitrage feasibility
- Estimate win rates and Sharpe ratios before live deployment

### `analysis/` — Live Trade Analysis & Debugging
- `analyze_*.js` — Post-trade analysis (directional misfires, PnL attribution, etc.)
- `validate_*.js` — Session validation (settlement outcomes, position reconciliation)
- `check_*.js` — Health checks (PnL reconciliation, balance audits)
- `extract_*.js` — Data extraction from trade history
- `train_*.js` — Offline model training from live data

Use these to:
- Debug trading failures
- Extract lessons from live trades
- Audit balance/PnL consistency
- Retrain models based on observed performance

### `monitoring/` — Real-Time Monitoring & Troubleshooting
- `live_watchdog.sh`, `live_fair_value_validation.js` — Continuous monitoring during sessions
- `observe_real_markets.js` — Market observation without trading
- `monitor_*.js` — Session/trade monitoring utilities

Use these to:
- Watch bot health during live runs
- Troubleshoot anomalies in real time
- Observe market conditions without execution

## Quick Start

**Validate product works (two-day campaign):**
```bash
node scripts/run_two_day_campaign.js --hours 2 --session-seconds 900 --profit-target-usd 1
```

**Check system readiness:**
```bash
node scripts/verify_gates.js
```

**Run single 15-min session:**
```bash
node scripts/run_capped_live_session.js
```

**Backtest parameters:**
```bash
node scripts/backtest/backtest_v17.js --edge-threshold 5 --stop-loss 10
```

**Analyze last trades:**
```bash
node scripts/analysis/analyze_live_trades.js
```
