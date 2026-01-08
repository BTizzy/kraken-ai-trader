# Kraken Volatility Bot - Repository Structure

**Project Status:** Production-Ready | January 2026

---

## 📋 File Organization

### 🏄 **CORE BOT FILES** (Must-Have)

```
✅ ESSENTIAL - These run the bot
├─ index.html              Main trading UI & dashboard
├─ game.js                Trading engine & state management
├─ kraken.js              Kraken WebSocket API wrapper
├─ config.js              Strategy parameters (editable)
├─ api.js                 Market data handlers
├─ styles.css             UI styling
└─ server.js              Node.js backend for real-time feeds
```

**What They Do:**
- **index.html** - Web interface where you see prices, place trades, monitor P&L
- **game.js** - The actual trading logic (entry/exit signals, position management)
- **kraken.js** - Connects to Kraken WebSocket for real-time prices
- **config.js** - All the tweakable parameters (profit target, stop loss, position size)
- **api.js** - Handles API calls to Kraken and data formatting
- **styles.css** - Makes the UI look good
- **server.js** - Backend server that keeps WebSocket alive

### 📈 **STRATEGY DOCS** (Read These)

```
📋 ESSENTIAL READING
├─ README.md                 Quick start & overview
├─ KRAKEN_STRATEGY.md       Complete strategy guide (9,000+ words)
└─ KRAKEN_STRUCTURE.md      This file
```

**What to Read First:**
1. **README.md** (5 min) - What the bot does and how to start
2. **KRAKEN_STRATEGY.md** (30 min) - Deep dive into strategy, parameters, roadmap
3. **KRAKEN_STRUCTURE.md** (this file, 5 min) - Where everything is

### 📄 **DATA & PAIRS** (Reference)

```
📄 KRAKEN-SPECIFIC DATA
├─ kraken-data/
│  └─ usd_pairs_top_filtered.json   List of 50-100 top trading pairs
├─ logs/                          Trading logs & execution records
└─ test-results/                  Historical backtest results
```

**What's In There:**
- **usd_pairs_top_filtered.json** - The cryptocurrency pairs the bot can trade (XBT/USD, ETH/USD, etc.)
- **logs/** - Records of every trade (for debugging and analysis)
- **test-results/** - Old backtest results (reference only)

### 🚫 **OTHER PROJECTS** (Not Relevant)

```
❌ NOT USED - Different projects, can delete later
├─ hyperliquid.js          Hyperliquid exchange adapter (separate project)
├─ crypto-trader.html      Old Hyperliquid UI (outdated)
├─ setup.html              Old setup wizard (deprecated)
└─ save-logs.js            Kraken logging utility (old)
```

**These Are:**
- Previous experiments or old code
- Different exchanges (we use Kraken, not Hyperliquid)
- Can be archived or deleted

### 📚 **PROJECT FILES** (Administrative)

```
📜 SUPPORTING FILES
├─ package.json            Node dependencies list
├─ package-lock.json       Locked dependency versions
├─ LICENSE                 MIT open source license
├─ CONTRIBUTING.md         How to contribute improvements
├─ DEPLOYMENT.md           How to deploy to production
├─ .gitignore             Files to skip in git
└─ start.sh               Quick start script
```

---

## 🎯 How to Use Each File

### **To Trade (Default Usage):**

```bash
1. npm start
2. Opens index.html in browser
3. Click "START SESSION"
4. See markets listed
5. Click market to place trade
6. Monitor P&L in real-time
```

### **To Change Strategy Parameters:**

**Edit:** `config.js`

```javascript
// Example: Change profit target from +0.5% to +1.0%
config.profitTarget = 1.0;  // Line 25

// Change position size from $100 to $150
config.positionSize = 150;  // Line 30

// Change max concurrent positions from 5 to 3
config.maxPositions = 3;    // Line 35
```

### **To Add/Remove Trading Pairs:**

**Edit:** `kraken-data/usd_pairs_top_filtered.json`

```json
[
  { "pair": "XBT/USD", "wsname": "XBT/USD", "volume": "50000000" },
  { "pair": "ETH/USD", "wsname": "ETH/USD", "volume": "30000000" },
  // ... add or remove pairs here
]
```

### **To Adjust Entry/Exit Logic:**

**Edit:** `game.js`

```javascript
// Find evaluateEntry() method (around line 200)
// Modify: RSI threshold, volatility threshold, etc.

// Find exitTrade() method (around line 400)
// Modify: profit target logic, stop loss logic
```

### **To Get Real Kraken Prices (Not Paper Trading):**

**Edit:** `config.js`

```javascript
config.priceSource = 'real';  // Instead of 'simulated'
config.requireRealPrices = true;
```

Then set up Kraken API keys as documented in README.md

---

## 👻 Understanding the Trading Flow

### **Startup Sequence:**

```
1. User opens index.html
   ↓
2. game.js initializes (reads config.js)
   ↓
3. kraken.js connects to Kraken WebSocket
   ↓
4. Real-time prices stream in
   ↓
5. UI displays pairs and prices
   ↓
6. User clicks a market to trade
   ↓
7. Trade panel opens
   ↓
8. User clicks ENTER TRADE or bot auto-enters
```

### **Trade Execution:**

```
ENTRY SIGNAL (game.js):
  ✓ Checks: RSI < 30?
  ✓ Checks: Volume spike?
  ✓ Checks: Price pullback?
  ↓
POSITION OPENED:
  ✓ Position size from config.js
  ✓ Entry price recorded
  ✓ Start timer
  ↓
MONITOR EXIT CONDITIONS:
  ✓ +0.5% profit? → Close (winner)
  ✓ -0.3% loss? → Close (stop loss)
  ✓ 30 seconds? → Close (timeout)
  ↓
POSITION CLOSED:
  ✓ P&L calculated
  ✓ Trade logged
  ✓ Dashboard updated
  ✓ Ready for next trade
```

---

## 🔍 File Dependencies

### **index.html** loads:
- `game.js` (main engine)
- `styles.css` (styling)

### **game.js** depends on:
- `config.js` (parameters)
- `kraken.js` (prices)
- `api.js` (market data)

### **kraken.js** connects to:
- Kraken WebSocket: `wss://ws.kraken.com`
- Fallback: `api.kraken.com` (REST)

### **server.js** runs:
- Node backend
- Keeps WebSocket alive
- Handles reconnections

---

## 🚀 Getting Started Checklist

### **1. First Time Setup:**

```bash
# Clone repo
git clone https://github.com/BTizzy/polymarket-ai-trader.git
cd polymarket-ai-trader

# Install dependencies
npm install

# Start bot
npm start

# Opens http://localhost:3000 in browser
```

### **2. Read Documentation:**

- [ ] README.md (5 min)
- [ ] KRAKEN_STRATEGY.md (30 min)
- [ ] This file (5 min)

### **3. Start Paper Trading:**

- [ ] Click "START SESSION"
- [ ] Watch prices stream in
- [ ] Click a market to place paper trade
- [ ] Monitor position
- [ ] Track P&L
- [ ] Complete 50+ trades

### **4. Review Results:**

- [ ] Calculate win rate
- [ ] Check average profit per trade
- [ ] Identify best/worst pairs
- [ ] Identify best/worst hours

### **5. When Ready for Real Money:**

- [ ] Generate Kraken API keys
- [ ] Update config with real keys
- [ ] Start with $50-100 positions
- [ ] Monitor carefully
- [ ] Scale up gradually

---

## 📉 Configuration Quick Reference

### **Most Important Settings (config.js):**

```javascript
// ENTRY CRITERIA
config.volatilityThreshold = 2.5;     // Min % move to trigger
config.rsiThreshold = 30;             // Entry when RSI < this
config.minVolume = 1000000;           // Min $ volume requirement

// EXIT CRITERIA (CRITICAL)
config.profitTarget = 0.5;            // Exit at +0.5% gain
config.stopLoss = 0.3;                // Exit at -0.3% loss
config.timeoutSeconds = 30;           // Hard exit after 30s

// POSITION MANAGEMENT
config.positionSize = 100;            // $ per trade
config.maxPositions = 5;              // Concurrent trades
config.leverage = 1;                  // 1x = spot only
config.dailyLossLimit = 500;          // Circuit breaker

// DATA SOURCE
config.priceSource = 'simulated';     // 'real' or 'simulated'
config.krakenWebsocket = 'wss://ws.kraken.com';
```

---

## 📚 Quick Troubleshooting

### **"WebSocket failed to connect"**

```
✓ Check internet connection
✓ Verify Kraken status page
✓ Bot will fallback to REST API (30s polling)
✓ Prices still update, just slower
```

### **"No prices showing"**

```
✓ Wait 5 seconds for initial connection
✓ Check console for errors (F12)
✓ Try manual refresh (R key)
✓ Check kraken-data/usd_pairs_top_filtered.json exists
```

### **"Trades won't execute"**

```
✓ Check mode: Paper or Live?
✓ Check position limit (max 5)
✓ Check daily loss limit hit (-$500)
✓ Check balance > position size
```

### **"Performance is slow"**

```
✓ Too many pairs? Reduce in JSON file
✓ Too many concurrent trades? Increase max timeout
✓ Browser lag? Close other tabs
✓ Refresh page if needed
```

---

## 📍 Summary: What You Need to Know

**For Trading:**
- **File:** `index.html` + `game.js`
- **Configure:** Edit `config.js` for parameters
- **Start:** `npm start`

**For Understanding Strategy:**
- **Read:** README.md (5 min)
- **Deep dive:** KRAKEN_STRATEGY.md (30 min)

**For Deployment:**
- **API keys:** See README.md
- **Position sizing:** Start $100, increase gradually
- **Monitoring:** Track metrics in dashboard

**For Improvements:**
- **Parameters:** Edit `config.js`
- **Logic:** Edit methods in `game.js`
- **Pairs:** Edit `kraken-data/usd_pairs_top_filtered.json`

---

**Next Steps:**
1. Run `npm start`
2. Read KRAKEN_STRATEGY.md
3. Paper trade 50+ times
4. Review results
5. Scale up when ready

*Your Kraken bot is ready to go! 🚀*
