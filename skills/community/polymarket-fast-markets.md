# Polymarket Fast Markets — Fee Warning + Momentum Signal

> Source: [openclaw/skills — adlai88/polymarket-fast-loop](https://github.com/openclaw/skills/tree/main/skills/adlai88/polymarket-fast-loop)
> Relevant to: `lib/signal_detector.js`, `lib/paper_trading_engine.js`, `lib/polymarket_client.js`

## Critical: Fast Market Fee = 10%

> ⚠️ Fast markets (5-min, 15-min sprint contracts) carry Polymarket's **10% fee** (`is_paid: true`).
> This is **5× higher** than regular Polymarket markets (2% taker).

**Breakeven changes completely:**

| Market Type | Fee per Side | Gross Edge Needed |
|-------------|-------------|-------------------|
| Regular Polymarket | 2% | ~4% (2 sides) |
| Fast/Sprint market | 10% | ~20% (2 sides) |
| Kalshi | ~1.2% | ~2.4% (2 sides) |

**Detection**: Check `is_paid: true` in Gamma API market response.

If the bot ever scans Polymarket sprint/fast markets, it must apply a 10× multiplier to the fee assumption or filter them out entirely.

---

## CEX → Prediction Market Momentum Signal

How to wire a real-time exchange price into a prediction market trade decision:

```
1. Fetch last 5 one-minute candles from Binance (BTCUSDT)
2. momentum = (price_now - price_5min_ago) / price_5min_ago
3. Compare momentum direction to current Polymarket odds
4. Trade when:
   - momentum ≥ min_momentum_pct (0.5%)
   - odds diverge from 50¢ by ≥ entry_threshold (5¢)
   - volume_ratio > 0.5× average (filter thin moves)
```

**Example:** BTC up 0.8% in last 5 min, but fast market YES price is only $0.52.
The 3¢ divergence from the expected ~$0.55 → buy YES.

This is exactly what the bot's **Strategy 3: Event-Driven Momentum** does — comparing spot price movement against Gemini contract repricing lag. The key parameters map to:
- `min_momentum_pct` = `momentumThreshold` in signal_detector
- `entry_threshold` = `minEdge`
- `volume_ratio` = `ask_depth` check in paper_trading_engine

## Volume-Weighted Signal Confidence

Weight signal strength by volume ratio vs recent average:
```javascript
const volumeRatio = currentVolume / avgVolume;
if (volumeRatio < 0.5) return null; // thin — skip
const confidenceMultiplier = Math.min(volumeRatio, 2.0); // cap at 2×
const adjustedScore = baseScore * confidenceMultiplier;
```

## USDC.e vs Native USDC (Polymarket-Specific)

Polymarket uses **USDC.e** (bridged USDC on Polygon, contract `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`) — NOT native USDC.

If live Polymarket execution is ever added: ensure the wallet holds USDC.e, not native USDC from a recent bridge.

## Market Discovery Pattern

Query Gamma API for live fast markets — don't rely on cached lists:
```
GET https://gamma-api.polymarket.com/markets?active=true&tag=fast
```
Runs every 5 minutes to catch new windows as they open.

Minimum time remaining check: skip markets with < 60s until expiry (can't fill before settlement).
