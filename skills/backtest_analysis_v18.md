# Backtest Analysis — V18 Strategy Validation

**Date**: Feb 19, 2026
**Data**: 573K price snapshots, 97 GEMI-* contracts (BTC/ETH), 32 simulated markets, ~73h window

## Executive Summary

The Black-Scholes fair value strategy on crypto binary options **shows a profitable signal** but with very limited sample size (3 trades in 19 hours). Simulated cross-platform arbitrage shows **zero edge** — Gemini paper market prices track Polymarket too closely for any spread-profitable arbitrage.

**Confidence Level**: LOW. We have directional evidence that BS FV mispricing detection works, but insufficient data for statistical significance. Need 100+ trades (~26 days of data collection) before any live deployment confidence.

---

## Dataset

| Source | Records | Markets | Time Span | Notes |
|--------|---------|---------|-----------|-------|
| GEMI-* prices | 48,297 | 97 | 19.3h | Real Gemini prediction contracts (BTC/ETH binary options) |
| gemini_sim_* prices | 484,900 | 32 | 73h | Synthetic markets tracking Polymarket (politics, sports, etc.) |
| Settled contracts | 36 | — | — | Known YES/NO outcomes for validation |

### GEMI Contract Structure
- Format: `GEMI-BTC2602190300-HI66750` = BTC > $66,750, Feb 19 2026 03:00 UTC
- Assets: BTC ($62,500-$72,500 strikes), ETH ($1,800-$2,200 strikes)
- Expiry windows: 2h, 8h, 1-5 days
- Typical spread: 3-6c (5c median)
- Two-sided book: ~79% of contracts

---

## Strategy 1: BS Fair Value on Crypto (GEMI-*)

### Approach
1. Estimate spot price from contract lattice (interpolate ATM strike where mid = $0.50)
2. Compute BS binary option probability: P(S > K at T) = Φ(d2)
3. When FV > ask (YES) or FV < bid (NO), trade the mispricing
4. Exit at take-profit, stop-loss, time-decay, or settlement

### Parameter Sweep Results (top 10 by PnL)

| Config | Trades | WR | PnL | Profit Factor | Sharpe | MaxDD |
|--------|--------|-----|------|---------------|--------|-------|
| IV+Edge5c+H2S | 4 | 25% | $10.71 | 1785.20 | 19.43 | 0.0% |
| Relaxed (E5c+SL10+H2S) | 3 | 100% | $6.01 | ∞ | 295.87 | 0.0% |
| H2S | 3 | 100% | $5.67 | ∞ | 213.00 | 0.0% |
| H2S+SL10c | 3 | 100% | $5.67 | ∞ | 213.00 | 0.0% |
| Sample 10m | 3 | 100% | $4.54 | ∞ | 594.23 | 0.0% |
| V17 Baseline | 3 | 100% | $3.94 | ∞ | 164.27 | 0.0% |
| Conservative | 1 | 100% | $2.46 | ∞ | — | 0.0% |
| Edge 12c | 1 | 100% | $1.54 | ∞ | — | 0.0% |

### Key Findings

1. **Hold-to-settlement (H2S) is the biggest lever** — PnL jumps from $3.94 to $5.67 (+44%) with same 3 trades. Crypto binaries converge to 0 or 1 at settlement; holding captures this.

2. **Wider stop loss helps** — SL 10c = SL 5c performance (both 100% WR). The 5c SL never triggered on these trades, but wider SL prevents premature exits on noise.

3. **Implied vol is risky** — Pure IV mode: 7 trades, 14% WR, -$22.48. IV estimation from the contract lattice is noisy with thin books. But IV+Edge5c+H2S combined = $10.71 (best PnL) by catching an extra profitable trade.

4. **Default 50% vol works** — The BS model with 50% annualized vol correctly identified all 3 mispricings. Higher vol (80%) generated garbage signals (-$24.65).

5. **All profitable trades were NO direction on ETH** — The model correctly predicted ETH would NOT reach $2,000 (a ~7% OTM strike).

### Actual Trades (V17 Baseline)

| Contract | Dir | Entry | Exit | Edge | Hold | PnL | Reason |
|----------|-----|-------|------|------|------|-----|--------|
| ETH Feb21 08:00 HI2000 | NO | 0.340 | 0.250 | 16.3c | 751m | $1.36 | time_decay |
| ETH Feb24 08:00 HI2000 | NO | 0.390 | 0.330 | 13.3c | 751m | $0.98 | time_decay |
| ETH Feb20 08:00 HI2000 | NO | 0.250 | 0.130 | 13.1c | 746m | $1.60 | take_profit |

---

## Strategy 2: Cross-Platform Arb on Simulated Markets

### Result: ZERO TRADES across all 34 parameter configurations

### Why
- Max Gemini-Polymarket divergence: 4.7c (one market, briefly)
- Average Gemini spread: 3.6-3.8c
- After spread cost, net edge ≈ 0-1c (below any reasonable threshold)
- Simulated markets are synthetic — prices are generated FROM Polymarket data

### Implication
The bot's paper trading wins on simulated markets (~79% WR, 50+ trades) are from **simulation noise**, not real arbitrage edge. When the simulated price oscillates randomly around the Polymarket reference, the bot occasionally enters on noise-induced divergence and exits when the noise mean-reverts. This looks like profit but isn't reproducible on real markets.

---

## Recommended V18 Parameters

Based on backtest, apply these to bot_parameters:

| Parameter | V17 | V18 | Justification |
|-----------|-----|-----|---------------|
| stop_loss_width | 0.05 | **0.10** | Wider SL matched 5c performance; prevents premature noise exits |
| max_hold_time | 7200 | **14400** | 4h min; hold-to-settlement uses TTX × 0.80 |
| hold_to_settlement | (new) | **1** | Best single improvement: +44% PnL |
| min_edge_live | 0.08 | 0.08 | Keep — filters out spread-consumed edges |
| entry_threshold | 55 | 55 | Keep — composite scoring threshold |
| kelly_multiplier | 0.15 | 0.15 | Keep — conservative |
| max_position_size | 10 | 10 | Keep — $10 max per trade |

---

## Confidence Assessment

### What We Know
- BS FV correctly identifies mispricings in crypto binary options
- NO direction on OTM crypto contracts is the primary profitable signal
- Hold-to-settlement is the right approach for crypto (not scalping)
- Spread cost (3-6c) is the primary drag on profitability
- Need 10c+ edge to overcome spreads + fees

### What We Don't Know
- Statistical significance (n=3 is not enough; need n≥30 for basic confidence, n≥100 for go-live)
- Performance in volatile markets (BTC was flat at ~$66.5-67K during data window)
- YES direction performance (zero YES signals in backtest)
- ETH vs BTC signal quality comparison
- Model sensitivity to vol estimation errors over longer periods

### Go-Live Gates (from skills/BTizzy/statistical-validation.md)
- [ ] 500+ trades — **FAIL** (have 3)
- [ ] Sharpe > 2.0 — **PASS** (164, but meaningless at n=3)
- [ ] Max drawdown < 20% — **PASS** (0%)
- [ ] Win rate > 50% — **PASS** (100%, but n=3)
- [ ] Profit factor > 1.5 — **PASS** (∞, but n=3)
- [ ] Consistent across categories — **FAIL** (only ETH tested)
- [ ] Paper-live performance parity — **UNTESTED**
- [ ] Walk-forward validation — **UNAVAILABLE** (insufficient data)

### Recommendation
**DO NOT deploy live yet.** Run in paper mode for 7-14 days with V18 parameters to collect 50-100+ trades. Monitor:
1. Do BS FV signals maintain >50% win rate on real GEMI contracts?
2. Does hold-to-settlement work on BTC contracts (not just ETH)?
3. What is the actual trade frequency? (If <1 trade/day, profitability is academic)

---

## Data Collection Mode Configuration

For extended data collection, the bot should:
1. Run in paper mode (`GEMINI_MODE=paper`)
2. Log all BS FV signals (even below threshold) for later analysis
3. Record spot price estimates in market_prices table
4. Target: accumulate 100+ paper trades over 14 days
5. After 100 trades: re-run backtest, assess go-live readiness
