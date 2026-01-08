# 🚀 Kraken Volatility Trading Bot

**High-frequency volatility scraper and mean reversion trader for Kraken cryptocurrency exchange**

![Status](https://img.shields.io/badge/Status-Production%20Ready-blue?style=flat-square)
![Exchange](https://img.shields.io/badge/Exchange-Kraken-orange?style=flat-square)
![Language](https://img.shields.io/badge/Language-JavaScript-yellow?style=flat-square)

---

## 📋 Strategy Overview

This bot is a **volatility-based trading system** that:

1. **Scans Kraken markets** for high-volatility cryptocurrency pairs
2. **Identifies mean reversion** opportunities (oversold conditions)
3. **Executes rapid trades** with strict risk management
4. **Exits quickly** to lock in profits before momentum reverses

**Trading Approach:**
- **Exchange:** Kraken (0.4% taker fees on spot, margin trading available)
- **Timeframe:** Ultra-short term (seconds to minutes)
- **Strategy:** Mean reversion + volatility arbitrage
- **Assets:** Top 50-100 cryptocurrency pairs (BTC, ETH, SOL, ADA, etc.)
- **Mode:** Paper trading mode for testing, real trading when ready

---

## 🎮 Quick Start

### Installation

```bash
# Clone repository
git clone https://github.com/BTizzy/polymarket-ai-trader.git
cd polymarket-ai-trader

# Install dependencies
npm install

# Start the bot
npm start
# Opens interface in browser at localhost:3000
```

### Configuration

Edit `config.js` to customize:

```javascript
GAME_CONFIG = {
    startingBankroll: 1000,           // Paper trading capital ($)
    priceSource: 'real',              // 'real' or 'simulated'
    
    // Kraken-Specific Settings
    exchange: 'kraken',
    krakenWebsocket: 'wss://ws.kraken.com',
    
    // Volatility Scanner Settings
    volatilityThreshold: 2.5,         // Min % change to trigger scan
    minVolume: 1000000,               // Min 24h volume ($)
    
    // Trading Parameters
    positionSize: 100,                // $ per trade
    leverage: 1,                      // 1x = spot only, 2-50x = margin
    maxPositions: 5,                  // Max concurrent trades
    
    // Exit Rules
    profitTarget: 0.5,                // Exit at +0.5% gain
    stopLoss: 0.3,                    // Exit at -0.3% loss
    timeoutSeconds: 30                // Max hold time
}
```

---

## 📊 How It Works

### 1. Volatility Scanning

```javascript
// Real-time Kraken WebSocket feeds top 50-100 pairs
// Monitors:
// ✓ Price changes (% move)
// ✓ Volume spikes
// ✓ Bid-ask spread widening
// ✓ Order book imbalance

Trigger Condition:
IF volatility > threshold AND volume > minimum
THEN: Evaluate entry signals
```

### 2. Entry Signal

```javascript
// Mean Reversion Entry
Entry IF:
  ✓ Price pulled back 0.5-2% from recent high
  ✓ RSI < 30 (oversold)
  ✓ Volume spike detection
  ✓ Not in cooldown from recent loss
```

### 3. Position Management

```javascript
// Quick Exit Strategy
Position Size: $100 (adjustable)
Leverage: 1x (spot trading, no margin for now)
Max Positions: 5 concurrent
Max Daily Loss: -$500 (circuit breaker)

Exit Conditions (in priority order):
1. Profit target +0.5%  (highest priority)
2. Stop loss -0.3%
3. Timeout after 30 seconds
4. Manual sell
```

### 4. Risk Management

```javascript
Per-Trade Risk:
  • Position size: $100
  • Leverage: 1x (no margin initially)
  • Max loss: -$30 per trade
  • Daily loss limit: -$500

Portfolio Risk:
  • Max concurrent: 5 trades
  • Max correlation: Avoid > 3 correlated pairs
  • Rebalance: Daily (reset at UTC midnight)
```

---

## 🔧 Technical Stack

### Core Files

```
✓ index.html          - Web UI (dashboard + controls)
✓ game.js             - Trading engine & state management
✓ kraken.js           - Kraken WebSocket API wrapper
✓ config.js           - Strategy parameters
✓ api.js              - Market data handlers
✓ server.js           - Node.js backend
✓ styles.css          - UI styling
```

### Data Source

- **Real-time:** Kraken WebSocket (TRADE feed)
- **Fallback:** Kraken REST API (30-second polling)
- **Pair List:** `kraken-data/usd_pairs_top_filtered.json`

### Features Implemented

- ✅ WebSocket connection to Kraken
- ✅ Multi-pair price streaming
- ✅ Volatility detection
- ✅ Paper trading mode
- ✅ Real-time P&L tracking
- ✅ Trade history logging
- ⏳ Live Kraken API integration (keys needed)
- ⏳ Margin trading support
- ⏳ Advanced risk management

---

## 📈 Getting Real Kraken Data

### WebSocket Connection

```javascript
// Automatically connects to Kraken WebSocket
const krakenFeed = new KrakenPriceFeed();
await krakenFeed.connect();

// Subscribes to 50-100 top pairs
// Real-time trade data every 100-500ms
const price = krakenFeed.getPrice('XBT/USD');
```

### REST Fallback

```javascript
// If WebSocket drops, falls back to REST
// Polls every 30 seconds
https://api.kraken.com/0/public/Ticker?pair=XBT/USD,ETH/USD,...
```

### Paper Trading

```javascript
// Use simulated prices for testing
// No real API keys needed
// Full functionality for strategy development
```

---

## 💰 Fee Structure (Kraken)

### Spot Trading Fees

```
Maker Fee:  0.16%
Taker Fee:  0.26% (standard)
Volume Fee: 0.20% (at $50k/month)

Round-Trip Cost Example:
Entry:  $100 @ 0.26% taker = $0.26
Exit:   $100.50 @ 0.26% taker = $0.26
Total:  $0.52 per $100 position
Round-trip cost: 0.52%

Profit Target:
+0.5% gross = -0.52% in fees = -0.02% net (BREAKEVEN)
Need +1.0% gross to make $0.48/trade profit
```

### Margin Trading Fees (Future)

```
Openning fee: 0.02% per 4 hours
Closing fee:  Included in taker fee
Interest:     6% APY on borrowed amount
```

---

## 🎯 Trading Rules

### Position Entry

✅ **DO:**
- Size: Start with $100 positions
- Leverage: 1x only (no margin initially)
- Pairs: Top 50 by volume
- Timing: During high-volatility windows
- Frequency: Max 5 concurrent trades

❌ **DON'T:**
- Use margin/leverage until proven
- Trade pairs with <$1M daily volume
- Hold positions >30 seconds without target hit
- Ignore stop losses
- Trade during illiquid hours (midnight UTC)

### Exit Rules

**Priority Order:**
1. Profit target: +0.5% (close immediately)
2. Stop loss: -0.3% (cut losses)
3. Timeout: 30 seconds (take exit opportunity)
4. Manual: User clicks sell

**Rationale:**
- Fast exits reduce slippage
- Tight stops prevent catastrophic losses
- Time-based exit manages risk

---

## 📊 Dashboard Metrics

```
Header Stats:
├─ Balance:        $1,000 (or actual account balance)
├─ Daily P&L:      +$12.50 (real-time)
├─ Win Rate:       68% (trades won / total)
└─ Trade Count:    50 (total today)

Active Positions:
├─ Pair:           XBT/USD
├─ Entry Price:    $42,500
├─ Current Price:  $42,714
├─ P&L:            +$214 (+0.5%)
└─ Hold Time:      12 seconds

Recent Trades:
├─ FOGO:   +$1.50 (5s)
├─ ETH/USD: -$0.80 (8s)
└─ SOL/USD: +$0.95 (11s)
```

---

## 🚀 Production Roadmap

### Phase 1: Testing (Week 1-2)
- ✓ Paper trading on real Kraken prices
- ✓ Test entry/exit logic
- ✓ Track P&L metrics
- **Target:** 60%+ win rate over 100+ trades

### Phase 2: Live Trading (Week 3-4)
- ✓ Real Kraken API keys configured
- ✓ Risk management layer active
- ✓ Position sizing validated
- **Start:** $50-100 positions
- **Target:** Maintain 60%+ WR with real money

### Phase 3: Scale (Week 5+)
- ✓ Increase position sizes gradually
- ✓ Add margin trading capability
- ✓ Optimize for specific pairs/hours
- **Target:** $500-1000 positions, $100+/day profit

---

## ⚠️ Risk Management

### Daily Loss Limits

```
Daily Loss Circuit Breaker: -$500
If day loss exceeds -$500:
  • Stop all new trades immediately
  • Close all open positions
  • Alert user
  • Resume next day
```

### Position Sizing

```
Bankroll Protection:
  $1,000 bankroll
  $100 per trade = 10% risk per position
  5 concurrent = 50% max portfolio risk
  
This is AGGRESSIVE - scale down for safety:
  Conservative: $50/trade, 2 concurrent
  Moderate: $75/trade, 3 concurrent
  Aggressive: $100/trade, 5 concurrent
```

### Correlation Risk

```
Don't stack correlated trades:
  XBT + ETH = High correlation (avoid)
  XBT + SOL = Medium correlation (OK)
  XBT + USDT = Low correlation (preferred)
```

---

## 🔐 API Setup

### Getting Kraken API Keys (for real trading)

1. **Login to Kraken:** https://www.kraken.com
2. **Settings → API**
3. **Create new key:**
   - Name: "Volatility Bot"
   - Nonce window: 0
   - Post-only: No (allow market orders)
   - Permissions:
     - Query Funds
     - Query Open Orders/Trades
     - Query Closed Orders/Trades
     - Create & Modify Orders
     - Cancel/Close Orders
4. **Rate limit:** Standard
5. **Save in environment:**
   ```bash
   export KRAKEN_API_KEY="your-key"
   export KRAKEN_API_SECRET="your-secret"
   ```

---

## 📝 Keyboard Shortcuts

```
SPACE  → Sell now (quick exit)
ENTER  → Start trade
ESC    → Cancel trade
R      → Refresh pairs
S      → Settings
```

---

## 🛠️ Troubleshooting

### WebSocket Connection Fails

```
Problem: "WebSocket connection failed"
Solution:
  1. Check internet connection
  2. Verify Kraken status: status.kraken.com
  3. Bot falls back to REST polling
```

### No Price Updates

```
Problem: "Waiting for price data..."
Solution:
  1. Check pair list: kraken-data/usd_pairs_top_filtered.json exists?
  2. Try manual refresh (R key)
  3. Check browser console for errors
```

### Trades Not Executing

```
Problem: "Click but no trade happens"
Solution:
  1. Verify paper trading is ON
  2. Check position limit (max 5 concurrent)
  3. Check daily loss limit (-$500 circuit breaker)
```

---

## 📚 Learning Resources

### Kraken API Docs
- WebSocket: https://docs.kraken.com/websockets/
- REST: https://docs.kraken.com/rest/
- Pairs & Symbols: https://docs.kraken.com/rest/references/public-market-data/#get-asset-info

### Mean Reversion Trading
- Investopedia guide on mean reversion
- Academic: "On the Profitability of Mean Reversion Strategies" (2016)

### Volatility Trading
- Vol smile dynamics
- Opening gaps and intraday reversions

---

## 🤝 Contributing

See `CONTRIBUTING.md` for:
- Strategy improvements
- Bug reports
- Feature requests

---

## 📄 License

MIT License - See `LICENSE`

---

## 👥 Author

**Ryan Bartell** (@BTizzy) - Providence, Rhode Island
- Passion: Mountains 🏔️, Beaches 🏖️, Money 💰
- Current Focus: Kraken volatility trading automation
- Next Goal: $100+/day consistent profit

---

**Ready to trade? Start with paper mode, prove the strategy, then scale with real money. 🚀**

*Disclaimer: This bot is for educational purposes. Always test thoroughly. Past performance ≠ future results. Cryptocurrency trading is risky.*
