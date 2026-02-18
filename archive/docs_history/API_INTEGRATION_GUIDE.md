# API Integration Guide

## Platform APIs

### Polymarket

**Base URLs:**
- Gamma API: `https://gamma-api.polymarket.com`
- CLOB API: `https://clob.polymarket.com`

**No API keys required** for read-only market data.

**Key Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/markets` | GET | List all active markets |
| `/markets?closed=false&limit=100` | GET | Paginated active markets |
| `/book?token_id={id}` | GET | Order book for a specific outcome |
| `/prices?token_ids={id}` | GET | Current prices |

**Rate Limits:** ~2 requests/second recommended. The bot implements 500ms spacing.

**Data Format:**
```json
{
  "id": "0x...",
  "question": "Will BTC hit $100k by Dec 31?",
  "outcomes": ["Yes", "No"],
  "outcomePrices": ["0.65", "0.35"],
  "volume": "1500000",
  "endDate": "2024-12-31",
  "active": true,
  "closed": false
}
```

---

### Kalshi

**Base URL:** `https://api.elections.kalshi.com/trade-api/v2`

**Authentication:** Required for trading, not for market data.

**Key Endpoints:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/events` | GET | List events with markets |
| `/events?status=open&limit=100` | GET | Paginated open events |
| `/markets/{ticker}` | GET | Single market details |
| `/markets/{ticker}/orderbook` | GET | Order book |

**Rate Limits:** ~1 request/second. The bot implements 1000ms spacing.

**Data Format:**
```json
{
  "ticker": "KXBTC-24DEC31-T100000",
  "title": "Bitcoin above $100,000?",
  "yes_bid": 65,
  "yes_ask": 67,
  "no_bid": 33,
  "no_ask": 35,
  "volume": 50000,
  "close_time": "2024-12-31T23:59:59Z",
  "status": "open"
}
```

**Note:** Kalshi prices are in **cents** (0-100). The client divides by 100 to normalize to 0-1.

---

### Gemini

**Base URL:** `https://api.gemini.com/v1`

**Authentication:** API key + secret for trading.

**Status:** Gemini prediction markets are new. The bot operates in **paper mode** by default, simulating Gemini markets based on Polymarket/Kalshi data.

**Paper Mode Simulation:**
- Spreads: 22-27¢ (wider than established platforms)
- Slippage: 0.5¢ added to entry price
- Exit discount: 0.3¢ subtracted from exit price
- Price delay: 2-5 second lag vs. reference markets

**To Switch to Live Mode:**
1. Set `GEMINI_API_KEY` and `GEMINI_API_SECRET` in `config/api_keys.json`
2. Change mode in `config/prediction_params.json`: `"gemini_mode": "live"`
3. Restart the bot

---

## Configuration Files

### `config/api_keys.json`

```json
{
  "gemini": {
    "api_key": "your-key",
    "api_secret": "your-secret"
  },
  "kalshi": {
    "email": "your-email",
    "password": "your-password"
  }
}
```

Copy from `config/api_keys.json.example` and fill in your credentials. This file is `.gitignore`d.

### `config/prediction_params.json`

All tunable parameters with their purposes:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `signal_threshold` | 55 | Minimum score (0-100) to consider a trade |
| `min_edge` | 0.08 | Minimum edge (probability) required |
| `max_position_pct` | 0.12 | Max % of wallet per position |
| `max_open_positions` | 5 | Maximum concurrent positions |
| `take_profit` | 0.10 | Take profit delta (10¢) |
| `stop_loss` | 0.05 | Stop loss delta (5¢) |
| `max_hold_seconds` | 120 | Force exit after 2 minutes |
| `kelly_fraction` | 0.25 | Kelly criterion multiplier |
| `velocity_weight` | 20 | Weight for price velocity component |
| `spread_weight` | 20 | Weight for spread differential |
| `consensus_weight` | 25 | Weight for platform consensus |
| `staleness_weight` | 15 | Weight for price staleness |
| `category_weight` | 20 | Weight for category win rate |
| `gemini_mode` | "paper" | Trading mode: paper/live/scraper |

---

## Rate Limiting

The rate limiter uses a sliding window with priority queue:

| Platform | Max Requests/Window | Window (ms) | Priority Levels |
|----------|-------------------|-------------|-----------------|
| Polymarket | 2 | 1000 | 1=exec, 2=price, 3=analytics |
| Kalshi | 1 | 1000 | Same |
| Gemini | 5 | 1000 | Same |

Exponential backoff kicks in after 3 consecutive failures (max 30s delay).

---

## Adding a New Platform

1. Create `lib/{platform}_client.js`:
   ```javascript
   const { Logger } = require('./logger');
   
   class NewPlatformClient {
     constructor() {
       this.log = new Logger('PLATFORM');
       this.baseUrl = 'https://api.platform.com';
     }
     
     async getMarkets(limit = 100) {
       // Fetch and normalize markets
     }
     
     normalizeMarket(raw) {
       return {
         market_id: `platform_${raw.id}`,
         title: raw.question,
         platform: 'platform',
         category: this.categorize(raw),
         yes_price: raw.yes_price,
         no_price: raw.no_price,
         volume: raw.volume,
         end_date: raw.end_date,
         status: 'active'
       };
     }
   }
   
   module.exports = NewPlatformClient;
   ```

2. Register in `server/prediction-proxy.js`:
   ```javascript
   const NewPlatformClient = require('../lib/newplatform_client');
   const newPlatform = new NewPlatformClient();
   ```

3. Add to `updatePrices()` fetch cycle
4. Add rate limits in the rate limiter config
5. Update market matcher to include the new platform

---

## Database Schema

The SQLite database (`data/prediction_markets.db`) has these tables:

| Table | Purpose |
|-------|---------|
| `markets` | All tracked markets from all platforms |
| `matched_markets` | Cross-platform market matches |
| `market_prices` | Price history snapshots |
| `prediction_trades` | Paper and live trades |
| `signals` | Detected trading signals |
| `paper_wallet` | Wallet balance tracking |
| `bot_parameters` | Adaptive parameter values |
| `daily_performance` | Aggregated daily stats |

Access via `PredictionDatabase` class in `lib/prediction_db.js`.
