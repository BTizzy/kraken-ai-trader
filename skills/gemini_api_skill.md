# Gemini Exchange API — Prediction Markets Integration Skill

## Core Mental Model: Why This Bot Exists

Gemini launched prediction markets in **December 2025**. They are **deliberately thin** — low volume, wide spreads, slow price discovery. Gemini NEEDS liquidity providers. Our bot IS the liquidity. Every trade we make adds depth to their books.

**Information hierarchy:**
- Polymarket + Kalshi = price discovery engines (always right, we READ from them)
- Gemini Prediction Markets = thin book, slow to reprice (our TRADING VENUE)
- Our bot = market maker on Gemini, guided by Poly/Kalshi signals

**Fee advantage (Gemini best in class):**
```
Gemini taker:   0.05% flat
Gemini maker:   0.01% (use "maker-or-cancel" option!)
Round-trip:     ~0.12%
vs Polymarket:  ~4%
vs Kalshi:      ~2.4%
vs PredictIt:   10%
```
**Consequence: Always post LIMIT orders with `"maker-or-cancel"` when possible. Market orders only for urgent exits.**

---

## HMAC Authentication (Private Endpoints)

### Three required headers for ALL private calls
```javascript
const crypto = require('crypto');
const nonce = Date.now().toString();  // must be strictly increasing

const payloadJson = JSON.stringify({
  request: '/v1/order/new',  // endpoint path
  nonce,
  // ...additional order fields
});
const payloadB64 = Buffer.from(payloadJson).toString('base64');
const signature = crypto
  .createHmac('sha384', process.env.GEMINI_API_SECRET)
  .update(payloadB64)
  .digest('hex');

headers['X-GEMINI-APIKEY']    = process.env.GEMINI_API_KEY;
headers['X-GEMINI-PAYLOAD']   = payloadB64;
headers['X-GEMINI-SIGNATURE'] = signature;
```

### Nonce rules
- Must be **strictly increasing** per API key
- `Date.now()` (ms epoch) is standard
- Two simultaneous requests → one will be rejected, add 1ms sleep between calls
- For high-frequency: append a counter `Date.now() * 1000 + counter`

### HTTP method
- All private calls: `POST`
- Content-Type: `application/json`
- **Body is empty or duplicate of payload** — the actual data goes in `X-GEMINI-PAYLOAD`

---

## Prediction Market REST API

### Base URLs
```
Public data:  https://www.gemini.com/prediction-markets
Trading API:  https://api.gemini.com/v1/...
Order book:   https://api.gemini.com/v1/book/{instrumentSymbol}
```

### Batch Tickers Endpoint (saves API calls!)
```
GET https://api.gemini.com/v1/pricefeed
```
Returns all available tickers. For prediction market tickers specifically:
```
GET https://www.gemini.com/prediction-markets/tickers/crypto
```
Response contains: `instrumentSymbol`, `bestBid`, `bestAsk`, `lastTradePrice`, `volume`, `openInterest`

### Fetch All Active Markets (no auth)
```
GET https://www.gemini.com/prediction-markets?status=active&category=crypto&limit=60
```
**Response envelope:**
```json
{
  "data": [
    {
      "id": "...",
      "title": "BTC Price on February 18",
      "ticker": "BTC-FEB18-12PM",
      "category": "crypto",
      "status": "active",
      "contracts": [
        {
          "id": "...",
          "label": "BTC > $67,500",
          "instrumentSymbol": "btcusd-pred-above-67500-20260218-12",
          "expiryDate": "2026-02-18T17:00:00Z",
          "marketState": "open",
          "prices": {
            "bestBid": "0.59",
            "bestAsk": "0.63",
            "lastTradePrice": "0.61",
            "buy": { "yes": "0.63", "no": "0.37" },
            "sell": { "yes": "0.59", "no": "0.41" }
          }
        }
      ]
    }
  ],
  "pagination": { "limit": 60, "offset": 0, "total": 221 }
}
```

**IMPORTANT: Only use `bestBid`/`bestAsk` for trading decisions — NEVER `buy.yes`/`sell.yes` (indicative only)**

### Order Book Depth
```
GET https://api.gemini.com/v1/book/{instrumentSymbol}?limit_bids=5&limit_asks=5
```
- `instrumentSymbol` must be **lowercase**
- Response: `{ "bids": [{"price": "0.59", "amount": "500"}, ...], "asks": [...] }`
- Field names: `price` and `amount` (not `size`)

---

## Order Placement

### Endpoint + Payload Structure
```
POST https://api.gemini.com/v1/order/new
```

```javascript
{
  request: '/v1/order/new',
  nonce: Date.now().toString(),
  client_order_id: `bot-${Date.now()}`,  // your own tracking ID
  symbol: 'btcusd-pred-above-67500-20260218-12',  // instrumentSymbol (lowercase)
  amount: '10',     // number of contracts as STRING
  price: '0.59',    // limit price as STRING
  side: 'buy',      // 'buy' or 'sell'
  type: 'exchange limit',   // always use limit orders
  options: ['maker-or-cancel']  // ALWAYS include for maker fee (0.01% vs 0.05%)
}
```

**Market orders:** `type: 'exchange market'` — use sparingly (takes 5x more fees)

### Response Fields
```json
{
  "order_id": "...",
  "client_order_id": "bot-1708123456789",
  "symbol": "btcusd-pred-above-67500-20260218-12",
  "price": "0.59",
  "avg_execution_price": "0.59",
  "side": "buy",
  "type": "exchange limit",
  "is_live": true,
  "is_cancelled": false,
  "executed_amount": "0",
  "remaining_amount": "10",
  "original_amount": "10",
  "timestamp": "1708123456",
  "timestampms": 1708123456789
}
```

### Cancel Order
```
POST https://api.gemini.com/v1/order/cancel
{
  request: '/v1/order/cancel',
  nonce: Date.now().toString(),
  order_id: '...'   // or client_order_id
}
```

### Active Orders
```
POST https://api.gemini.com/v1/orders   (private — requires HMAC)
{ request: '/v1/orders', nonce: Date.now().toString() }
```

---

## PAPER vs LIVE Mode Guard

**Critical safety pattern — must be in gemini_client.js:**
```javascript
// In GeminiClient constructor
this.mode = options.mode || 'paper';
// NEVER flip to 'live' without:
//   1. API key set in .env
//   2. At least 500 paper trades with positive Sharpe
//   3. Explicit confirmation in config

placeOrder(params) {
  if (this.mode !== 'live') {
    return this.executePaperTrade(params);  // safe fallback always
  }
  return this._signedPost('/v1/order/new', params);
}
```

---

## Instrument Symbol Format

Pattern observed in live data:
```
{asset}usd-pred-{direction}-{strike}-{date}-{hour}
```
Examples:
```
btcusd-pred-above-67500-20260218-12    (BTC > $67,500, Feb 18 12pm)
ethusd-pred-above-3500-20260218-08     (ETH > $3,500, Feb 18 8am)
solusd-pred-below-200-20260217-17      (SOL < $200, Feb 17 5pm)
```

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| Public market data | ~60 req/min (unconfirmed) |
| Private (trading) | 600 req/min per API key |
| WebSocket | No per-message limit |

HTTP 429 response → back off 3s, then retry.

---

## Kalshi WebSocket (Real-Time Bracket Data)

**Endpoint:** `wss://trading-api.kalshi.com/trade-api/ws/v2`

**Auth:** `Authorization: Bearer <KALSHI_API_KEY>` header on WS upgrade

**Subscribe to bracket markets:**
```javascript
ws.send(JSON.stringify({
  id: 1,                    // incrementing request ID
  cmd: 'subscribe',
  params: {
    channels: ['ticker_v2'],
    market_tickers: ['KXBTC-26FEB1712-B67000', 'KXBTC-26FEB1712-B67500']
  }
}));
```

**Incoming ticker_v2 message:**
```json
{
  "type": "ticker",
  "market_ticker": "KXBTC-26FEB1712-B67500",
  "yes_bid": 59,      // in CENTS (divide by 100)
  "yes_ask": 63,
  "last_price": 61,
  "volume": 1250,
  "open_interest": 3400
}
```
**Remember: Kalshi prices are in CENTS (0-100), divide by 100.**

**Crypto series tickers:**
- BTC: `KXBTC`
- ETH: `KXETH`
- SOL: `KXSOL`

**Event ticker format:** `KXBTC-26FEB1712` (series-YYMMDDHR)

**Individual bracket:** `KXBTC-26FEB1712-B67500` (B = between bracket, floor = 67500)

---

## Strategy Reminder: Gemini as Liquidity Provider

Since Gemini is thin, our ideal execution pattern is:

1. **Detect mispricing**: FairValue (from Kalshi/Poly) says contract is worth 0.62
2. **Gemini ask**: 0.65 (too expensive to buy)
3. **Post bid**: Place limit order at 0.61 (`maker-or-cancel`)
   → Our bid is the new best bid on Gemini, providing liquidity
4. **If Kalshi/Poly price drops to 0.59**: Tighten or cancel
5. **If filled at 0.61**: We own a 0.62-fair-value contract for 0.61 — instant 1¢ edge

**This is market-making + statistical arb**, not pure price-taking. The key metric is:
```
edge = fairValue - limit_price - fee_per_side
Profitable when edge > fee_per_side (0.01% maker)
```

---

## DEPLOYMENT CHECKLIST (before going live)

- [ ] 500+ paper trades completed with positive Sharpe (>2.0)
- [ ] Max drawdown < 10% in paper mode over 30 days
- [ ] GEMINI_API_KEY set in `.env` (never commit!)
- [ ] GEMINI_API_SECRET set in `.env`
- [ ] Rate limiting confirmed working (logs show < 600 req/min)
- [ ] Discord alerts configured and tested
- [ ] Starting capital ≤ $500 (as per bot design)
- [ ] mode manually flipped to 'live' in instantiation
- [ ] Kill switch tested (POST /api/bot/stop works)
