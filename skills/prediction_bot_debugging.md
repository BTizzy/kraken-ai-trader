# Prediction Bot — Debugging Guide

## Diagnostic Checklist

When the bot is running but not trading, work through this list in order:

### 1. Are markets being fetched?
```bash
curl -s http://localhost:3003/api/prediction/markets | jq '.count'
```
- **0 markets**: Polymarket API may be down, or rate limiting is too aggressive (check `lib/polymarket_client.js` `minRequestInterval`).
- **Markets but no trades**: Continue to step 2.

### 2. Are prices updating?
```bash
curl -s http://localhost:3003/api/prediction/status | jq '.matched_markets[0]'
```
Check `gemini_bid`, `gemini_ask`, `polymarket_last`. If Gemini values are null/zero, `updatePaperMarket()` isn't being called with valid data.

### 3. Are signals being generated?
```bash
curl -s http://localhost:3003/api/prediction/signals | jq '.[0]'
```
- **No signals**: Score threshold may be too high (check `entry_threshold` param), or velocity/spread components are all zero.
- **Signals but not actionable**: Check `direction` (null = no clear trend) and cooldown (30s between signals per market).

### 4. Are positions being entered?
```bash
curl -s http://localhost:3003/api/prediction/trades | jq '.open_count'
```
- **0 open, 0 closed**: `canEnterPosition()` is blocking. Check: max concurrent positions, category limits, drawdown kill switch, duplicate market guard.
- **0 open, many closed**: Trades are entering and immediately exiting. See "Immediate Stop Loss" below.

---

## Common Issues & Fixes

### Immediate Stop Loss (0s hold time)
**Symptom**: All trades exit as `stop_loss` with 0s hold time.
**Root Cause**: Stop loss was evaluated against execution price (bid/ask + slippage), not mid-price. The spread cost (2-4¢) exceeded the stop_loss_width (3¢).
**Fix**: Stop loss now tracks mid-price via `getPaperMidPrice()`. Entry sets stop loss from `(bid+ask)/2 - stop_loss_width`, not from `fill_price - stop_loss_width`.

### Take Profit with Negative PnL
**Symptom**: Trades hit `take_profit` but PnL is negative.
**Root Cause**: `targetPrice` from signal detector was set relative to Polymarket reference price, which could be below the Gemini entry fill when accounting for spread + slippage.
**Fix**: Take profit is clamped: `max(targetPrice, fill_price + 0.015)` for YES, `min(targetPrice, fill_price - 0.015)` for NO.

### Zero Position Size
**Symptom**: Signals fire, `calculatePositionSize()` returns 0.
**Root Cause**: `expectedMove = targetPrice - entryPrice` was negative because Gemini spread exceeded the convergence target.
**Fix**: Edge-based sizing with score-based fallback. If `edge ≤ 0`, use `score * balance * kelly / 60` instead.

### Polymarket Token ID Mismatch
**Symptom**: `getBestPrices()` returns 403/404 for every market.
**Root Cause**: `condition_id` was passed instead of CLOB `token_id`. Condition IDs are short numerics (e.g., "566203"), token IDs are long hex strings.
**Fix**: Added `polymarket_yes_token_id` and `polymarket_no_token_id` columns to `matched_markets`. Market matcher passes token IDs through from Polymarket API response.

### Volume Filter Blocking All Markets
**Symptom**: No markets pass the volume/liquidity filters.
**Root Cause**: Simulated Gemini volume was `poly.volume * 0.05`, which far exceeded `maxGeminiVolume = 30000`. Top Polymarket markets also had 0.001/0.999 probabilities.
**Fix**: Volume capped at `min(20000, poly.volume * 0.001)`. Probability filter: `0.10 ≤ price ≤ 0.90`. Liquidity floor: `≥ 1000`.

### Negative Scores
**Symptom**: Some markets produce negative opportunity scores.
**Root Cause**: `scoreComponent()` could return negative values when `invert=true` and `value > threshold`.
**Fix**: Wrapped in `Math.max(0, ...)`.

### Rate Limiting
**Default**: 200ms between Polymarket API requests.
**Issue**: If set too high (e.g., 2000ms), a cycle with 30 markets takes 60s.
**Config**: `lib/polymarket_client.js` → `this.minRequestInterval`.

---

## Stress Test

```bash
node scripts/stress_test_prediction.js --hours 24 --markets 20
```

Pass criteria: `totalPnL > 0 && winRate > 0.40`

The stress test creates synthetic markets with:
- Random walk + trend persistence (shocks hold for 50-200 ticks)
- 5% convergence rate (slower than live bot's 15%)
- 1.5-2.5¢ spread
- 20 concurrent markets

---

## Quick Status Commands

```bash
# Bot status
curl -s http://localhost:3003/api/prediction/status | jq '{running, trade_count, balance: .wallet.balance}'

# Recent exits
grep "EXIT" logs/prediction_bot.log | tail -10

# Open positions
curl -s http://localhost:3003/api/prediction/trades | jq '.open_trades'

# Current parameters
curl -s http://localhost:3003/api/prediction/parameters | jq '.'

# Server health
curl -s http://localhost:3003/health
```

---

## Lessons Learned

1. **Always trace the full data flow**: Token ID → API call → price → signal → entry → exit. Any break in the chain produces zero trades with no error.
2. **Stop loss must account for entry costs**: Mid-price based stop loss is standard practice. Fill-based stop loss fails whenever spread > stop_loss_width.
3. **Take profit must guarantee profitability**: Reference-based target prices don't account for execution costs. Clamp to fill + minimum profit.
4. **Double convergence is a silent killer**: If both the simulation AND the engine apply convergence, the effective lag is much smaller than intended.
5. **Test with realistic dynamics**: Random walks have no edge. Real markets have persistent information-driven moves.
