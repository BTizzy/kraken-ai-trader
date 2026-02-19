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

---

## HMAC Authentication (Private Endpoints)

### Three required headers for ALL private calls
```javascript
const crypto = require('crypto');
// CRITICAL: nonce must be in SECONDS (not ms!) and strictly increasing
const nowSec = Math.floor(Date.now() / 1000);
if (nowSec > this._lastNonce) this._lastNonce = nowSec;
else this._lastNonce++;
const nonce = String(this._lastNonce);

const payloadJson = JSON.stringify({
  request: '/v1/prediction-markets/order',  // endpoint path
  nonce,
  account: 'primary',  // REQUIRED on all private endpoints
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

### Nonce rules (V14 CORRECTED)
- Must be **in SECONDS** (NOT milliseconds!) — server rejects nonces > ±30s from server time
- Must be **strictly increasing** per API key
- Track `_lastNonce` and increment when multiple requests in same second
- `Date.now()` returns ms → use `Math.floor(Date.now() / 1000)`
- NEVER use `Date.now() * 1000 + counter` — that makes nonce 56 years in the future

### HTTP method
- All private calls: `POST`
- Content-Type: `text/plain`
- `account: 'primary'` MUST be included in the payload JSON

---

## Instrument Symbol Format (CORRECTED)

Real Gemini prediction market symbols:
```
GEMI-{ASSET}{YYMMDDHHNN}-HI{STRIKE}
```
Examples:
```
GEMI-BTC2602190200-HI66500    (BTC > $66,500, Feb 19 02:00 UTC = 9pm EST)
GEMI-ETH2602190800-HI1800     (ETH > $1,800, Feb 19 08:00 UTC = 3am EST)
GEMI-SOL2602190800-HI80       (SOL > $80, Feb 19 08:00 UTC)
GEMI-XRP2602190800-HI1D3      (XRP > $1.3 — D=decimal point)
```

**NOT** `btcusd-pred-above-67500-20260218-12` — that format does not exist.

---

## Prediction Market Trading API (CORRECTED)

**CRITICAL: Prediction markets use SEPARATE endpoints from the standard exchange.**
`/v1/order/new` does NOT work for `GEMI-*` symbols (returns `InvalidSymbol`).

### Base URL
```
Production: https://api.gemini.com
Sandbox:    https://api.sandbox.gemini.com  (NO prediction market symbols!)
```

### Place Order
```
POST /v1/prediction-markets/order
```
```javascript
{
  request: '/v1/prediction-markets/order',
  nonce: String(Math.floor(Date.now() / 1000)),
  account: 'primary',
  symbol: 'GEMI-BTC2602190200-HI66500',
  orderType: 'limit',
  side: 'buy',           // 'buy' or 'sell'
  quantity: '5',          // number of contracts as STRING
  price: '0.59',          // limit price as STRING
  outcome: 'yes',         // 'yes' or 'no'
  timeInForce: 'good-til-cancel'
}
```

### Response (201 Created)
```json
{
  "orderId": 145828831565994216,
  "status": "filled",     // "open", "filled", "cancelled"
  "symbol": "GEMI-BTC2602190200-HI66500",
  "side": "buy",
  "outcome": "no",
  "orderType": "limit",
  "quantity": "5",
  "filledQuantity": "5",
  "remainingQuantity": "0",
  "price": "0.99",
  "avgExecutionPrice": "0.99"
}
```

### Cancel Order
```
POST /v1/prediction-markets/order/cancel
{ request: '...', nonce: '...', account: 'primary', orderId: '145828831565994216' }
```
Returns: `{ "result": "ok", "message": "Order ... cancelled successfully" }`

### List Active Orders
```
POST /v1/prediction-markets/orders/active
{ request: '...', nonce: '...', account: 'primary' }
```
Returns: `{ "orders": [...], "pagination": { limit, offset, count } }`

### Order History
```
POST /v1/prediction-markets/orders/history
{ request: '...', nonce: '...', account: 'primary' }
```

### Positions
```
POST /v1/prediction-markets/positions
{ request: '...', nonce: '...', account: 'primary' }
```
Returns positions with full `contractMetadata` and current `prices`.

### Balances (standard exchange endpoint)
```
POST /v1/balances
{ request: '/v1/balances', nonce: '...', account: 'primary' }
```

---

## Public Data Endpoints (No Auth)

### Fetch All Active Markets
```
GET https://www.gemini.com/prediction-markets?status=active&category=crypto&limit=60
```
Response: `{ data: [Event], pagination: { limit, offset, total } }`

### Batch Tickers (fast price refresh)
```
GET https://www.gemini.com/prediction-markets/tickers/crypto
```
Returns: `[{ instrumentSymbol, bestBid, bestAsk, lastTradePrice, volume, openInterest }]`

**IMPORTANT: Only use `bestBid`/`bestAsk` for trading decisions — NEVER `buy.yes`/`sell.yes` (indicative only)**

---

## LIVE TRADING SAFETY GUARDS (V14)

```javascript
// In paper_trading_engine.js enterPosition():

// 1. Only GEMI-* instruments route to live API
const isRealInstrument = signal.marketId.startsWith('GEMI-');

// 2. Minimum score 45 for live crypto
if (signal.score < 45) return null;

// 3. Reject if no Gemini orderbook data
if (signal.gemini_bid == null && signal.gemini_ask == null) return null;

// 4. Reject if edge < 1 cent vs reference
if (edgeVsRef < 0.01) return null;

// 5. Reject NO orders > $0.85 (deep ITM, too expensive)
if (signal.direction === 'NO' && entryPrice > 0.85) return null;

// 6. Paper exit must NOT run on live trades
if (trade.mode === 'live') continue; // in monitorPositions()

// 7. Mode detection: only GEMI-* get mode='live'
mode: (this.gemini.mode === 'live' && isRealInstrument) ? 'live' : 'paper'
```

---

## Crypto Structural Matching (V14)

Gemini crypto prediction contracts have NO Polymarket equivalents.
They match Kalshi KXBTC/KXETH/KXSOL bracket series by asset + strike:

```
Gemini:  GEMI-BTC2602190200-HI66500  →  "BTC > $66,500"
Kalshi:  KXBTC-26FEB1921 brackets    →  P(BTC > $66,500) via computeSyntheticAbove()

Matching logic:
1. Parse asset from GEMI-{ASSET}... → BTC, ETH, SOL
2. Parse strike from HI{STRIKE} → 66500 (or HI1D3 → 1.3 with D=decimal)
3. Fetch Kalshi brackets via getBracketsByEvent(asset)
4. Compute synthetic "above" probabilities via computeSyntheticAbove()
5. Find nearest Kalshi strike via findSyntheticPrice(aboveProbs, strike)
6. Clamp synthetic probabilities to [0, 1] (bracket sums can exceed 1.0!)
```

**Known issues with synthetic prices:**
- Deep-ITM brackets often have no liquidity → synthetic sums are unreliable
- Brackets with zero bid/ask use lastPrice as mid → stale data inflates probability
- Bracket sums for "above $62,500" when BTC = $67,000 often exceed 1.0

---

## Kalshi WebSocket (Real-Time Bracket Data)

**Endpoint:** `wss://api.elections.kalshi.com/trade-api/ws/v2`
(NOT `trading-api.kalshi.com` — that returns 401 + redirect)

**Auth:** RSA-PSS SHA256 signing (same as REST)

**Crypto series tickers:**
- BTC: `KXBTC`
- ETH: `KXETH`
- SOL: `KXSOL`

**Event ticker format:** `KXBTC-26FEB1917` (series-DDMMMYYHH)
**Individual bracket:** `KXBTC-26FEB1917-B67500` (B = between bracket, floor = 67500)

**Prices in CENTS (0-100), divide by 100.**

---

## DEPLOYMENT STATUS

**Real balance:** ~$1.10 USD (after two bad trades)
**Paper balance:** $549.75 (17W/0L)
**Two live trades executed:**
1. GEMI-BTC2602190200-HI66500 NO @ $0.99 → sold at $0.05 = -$4.70 (bad: deep ITM NO)
2. GEMI-BTC2602230800-HI67500 NO @ $0.59 → open (sell order pending at $0.46)

**Lesson:** The first real money trade lost $4.70 because:
- Kalshi synthetic said 71% probability, Gemini showed 95%
- Bot bought NO at $0.99 (= 1 - 0.01 bestBid)
- Paper exit immediately simulated sale at $0.01, creating $489 phantom profit
- Real position was stuck at $0.99 with NO worth only $0.05
