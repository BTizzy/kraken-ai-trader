# Parameters Guide

## Overview

The prediction market bot uses adaptive parameters that self-tune based on trading performance. All parameters are stored in `config/prediction_params.json` and also in the SQLite database for runtime updates.

## Signal Scoring Parameters

The signal detector scores each opportunity on a 0-100 scale across 5 components:

### Price Velocity (default weight: 20)
- Measures how fast a market's price is moving
- Calculated from the last 10 price snapshots (2-second intervals)
- Higher velocity = stronger signal
- **Tune up** if you want to chase momentum more aggressively
- **Tune down** if you're getting false signals from volatile markets

### Spread Differential (default weight: 20)
- Compares the spread between Gemini and reference platforms (Polymarket/Kalshi)
- Wider Gemini spread = more profit potential
- Min spread: 0.02 (2¢) to filter noise
- **Tune up** if Gemini consistently has wider spreads
- **Tune down** if spread opportunities are rare

### Cross-Platform Consensus (default weight: 25)
- Measures agreement between Polymarket and Kalshi prices
- Higher agreement = more reliable signal
- This is the **most important** component since it validates the signal
- **Tune up** to be more conservative (require strong consensus)
- **Tune down** to trade on single-platform signals

### Price Staleness (default weight: 15)
- Detects when Gemini's price hasn't updated while other platforms moved
- Stale Gemini prices = potential arbitrage window
- Measured in seconds since last Gemini price change
- **Tune up** if Gemini is slow to update
- **Tune down** if Gemini updates quickly

### Category Win Rate (default weight: 20)
- Historical win rate for the market category (crypto, politics, etc.)
- Bootstrapped at 50% until enough trades exist
- Self-improving as more trades are collected
- **Leave alone** — this auto-calibrates

## Position Sizing Parameters

### Signal Threshold (default: 55)
- Minimum score required to enter a trade
- Range: 0-100 (lower = more trades, higher = fewer but higher quality)
- **Start at 55**, raise to 65+ once you see patterns
- Below 40 will generate too much noise

### Minimum Edge (default: 0.08)
- Minimum probability edge required (8%)
- Edge = (score / 100) - 0.5
- A score of 58 = edge of 0.08
- **Raise** if win rate is below 55%
- **Lower** if you're missing good opportunities

### Kelly Fraction (default: 0.25)
- Fraction of full Kelly criterion to use
- Full Kelly is mathematically optimal but very volatile
- 0.25 = quarter-Kelly (conservative)
- **Never exceed 0.5** without extensive backtesting
- **Lower to 0.15** if drawdowns are too large

### Max Position Percentage (default: 0.12)
- Maximum % of wallet for any single position
- Hard cap regardless of Kelly calculation
- 0.12 = $60 max on a $500 wallet
- **Lower to 0.08** for more diversification
- **Raise to 0.15** only after proven profitability

### Max Open Positions (default: 5)
- Maximum concurrent open positions
- More positions = more diversification but thinner coverage
- **Keep at 3-5** during initial phase
- **Raise to 8-10** once strategy is validated

## Exit Parameters

### Take Profit (default: 0.10)
- Close position when price moves 10¢ in our favor
- For a YES trade at entry 0.60: TP triggers at ≤ 0.50
- **Lower to 0.05** for more frequent small wins
- **Raise to 0.15** for fewer but larger wins

### Stop Loss (default: 0.05)
- Close position when price moves 5¢ against us
- For a YES trade at entry 0.60: SL triggers at ≥ 0.65
- **Never raise above 0.10** — risk management is critical
- **Lower to 0.03** for tighter risk control

### Max Hold Seconds (default: 120)
- Force exit after 2 minutes regardless of P&L
- Prevents capital lock-up in stale positions
- **Lower to 60** for faster turnover
- **Raise to 300** for swing-style trades

## Adaptive Learning

Every 30 seconds, the bot runs a learning cycle that:

1. **Calculates recent performance** (last 20 trades)
2. **Adjusts parameters** based on win rate:
   - Win rate > 60%: Loosens threshold, increases position size
   - Win rate < 45%: Tightens threshold, decreases position size
3. **Tracks category performance** for category_weight adjustments
4. **Logs parameter changes** for audit

### Learning Boundaries

Parameters are clamped to safe ranges:

| Parameter | Min | Max |
|-----------|-----|-----|
| `signal_threshold` | 35 | 85 |
| `min_edge` | 0.03 | 0.20 |
| `max_position_pct` | 0.05 | 0.20 |
| `kelly_fraction` | 0.10 | 0.50 |
| `take_profit` | 0.03 | 0.25 |
| `stop_loss` | 0.02 | 0.15 |

## Manual Parameter Sweep

Run parameter experiments:

```bash
# Edit config/prediction_params.json with test values
# Run backtest
node scripts/backtest_prediction_strategy.js --days 7

# Compare results across different parameter sets
# Look for highest Sharpe ratio and win rate
```

## Recommended Tuning Sequence

1. **Week 1:** Use defaults. Collect data.
2. **Week 2:** Analyze trades with `node scripts/monitor_paper_positions.js`
   - If win rate > 55%: Lower `signal_threshold` by 5
   - If win rate < 45%: Raise `signal_threshold` by 5
   - If avg hold time < 10s: Raise `max_hold_seconds`
3. **Week 3:** Train ML model: `node scripts/train_opportunity_model.js`
   - Use model weights to adjust component weights
4. **Ongoing:** Let adaptive learning handle incremental tuning
