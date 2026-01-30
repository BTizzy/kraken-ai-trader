# Kraken Trading Bot - C++ Self-Learning Version

> **NOTE:** This README contains historical and technical context for the C++ bot. For the most current architecture, operational, and strategy information, see `../Must_read_before_any_agent_task.md`.

## ⚡️ Overview

A **high-performance C++ trading bot** for Kraken with:
- 50x more robust self-learning than baseline
- C++ for speed (microsecond-level operations)
- Multi-dimensional pattern recognition (pair + leverage + timeframe)
- One-click live deployment with paper trading validation
- Automatic strategy evolution every 25 trades
- Statistical rigor with confidence scoring

---

## ⚠️ Data Persistence

- **Current:** All trade records, learning data, and analytics are stored in SQLite (`data/trades.db`).
- **Legacy:** JSON and CSV persistence is deprecated and should not be used for trading or analytics. (Kept for historical reference only.)

---

## 🚀 Quick Start

```bash
# Set API keys
export KRAKEN_API_KEY="your_key"
export KRAKEN_API_SECRET="your_secret"

# Build
cd bot && mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release .. && make -j$(nproc)

# Run in paper trading (recommended first!)
./kraken_bot

# After 50+ paper trades with 55%+ win rate:
./kraken_bot --live  # One-click deployment
```

See [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md) for complete guide.

---

## 💠 Architecture

### Core Components

```
┌───────────────────────────┐
│  KRAKEN TRADING BOT (C++)              │
├───────────────────────────┤
│                                        │
│  🔍 MARKET SCANNER                 │
│     Scan 100+ pairs                  │
│     Check volatility + spread        │
│                │                     │
│                │                     │
│  🤖 STRATEGY ENGINE                │
│     Query learning database          │
│     Select optimal strategy          │
│     Calculate position size          │
│                │                     │
│                │                     │
│  💰 POSITION MANAGER               │
│     Entry: Market order              │
│     Hold: Real-time monitoring       │
│     Exit: TP/SL/Timeout              │
│                │                     │
│                │                     │
│  📊 LEARNING ENGINE               │
│     Record every trade               │
│     Analyze every 25 trades          │
│     Update strategy database         │
│                                        │
├───────────────────────────┤
│ KRAKEN API (WebSocket + REST)        │
├───────────────────────────┤
│ PERSISTENCE: JSON + CSV             │
└───────────────────────────┘
```

### Key Files

| File | Purpose |
|------|----------|
| `src/main.cpp` | Trading loop + lifecycle |
| `src/learning_engine.cpp` | Pattern analysis + strategy updates |
| `src/kraken_api.cpp` | Kraken integration (paper/live) |
| `include/learning_engine.hpp` | Learning engine interface |
| `include/kraken_api.hpp` | Kraken API interface |
| `CMakeLists.txt` | Build configuration |

---

## 🤖 50x More Robust Learning

### What's Improved?

#### 1. Multi-Dimensional Patterns
Instead of: "BTC wins 60% of the time"
We now track:
- BTC/USD @ 2x leverage @ 60-second hold = 62% win rate
- BTC/USD @ 5x leverage @ 30-second hold = 45% win rate  
- BTC/USD @ 1x leverage @ 120-second hold = 58% win rate

**Result:** Pick the specific pattern that works, not just "BTC"

#### 2. Statistical Rigor
- **Sharpe Ratio**: Risk-adjusted returns (higher = better)
- **Sortino Ratio**: Downside-only risk (ignores lucky ups)
- **Profit Factor**: Wins / losses ratio
- **Max Drawdown**: Worst peak-to-trough loss
- **Confidence Score**: Statistical significance (0-1)

#### 3. Correlation Analysis
Identifies synergies:
- Which patterns win together?
- Which patterns conflict?
- Cross-pair opportunities?

#### 4. Regime Detection
Adapts to market conditions:
- High volatility ≠ low volatility
- Trending ≠ ranging
- Adjust leverage and timeframes accordingly

#### 5. Outlier Handling
Avoids over-fitting to lucky trades:
- Trades > 2.5 std deviations marked as outliers
- Extreme winners/losers excluded from pattern learning
- But still recorded for regression analysis

#### 6. Strategy Database
Versioned strategy evolution:
```json
{
  "BTC/USD_2x_60s": {
    "leverage": 2.0,
    "timeframe": 60,
    "win_rate": 0.62,
    "profit_factor": 1.85,
    "sharpe": 2.1,
    "confidence": 0.78,
    "trades_tested": 47,
    "validated": true
  }
}
```

---

## 📈 Learning Cycle

### Every 25 Trades:

```
🤖 ANALYZE
  ├─ Group by (pair, leverage, timeframe)
  ├─ Calculate Sharpe/Sortino/P.F.
  ├─ Compute confidence scores
  ├─ Identify outliers
  └─ Remove < 15 sample patterns

🏆 IDENTIFY WINNERS
  ├─ Winning patterns (edge + confidence > 60%)
  ├─ Correlation analysis
  └─ Regime shifts

🔄 UPDATE STRATEGIES
  ├─ Create configs from winning patterns
  ├─ Optimize position sizing
  ├─ Adjust leverage allocation
  └─ Set take profit / stop loss targets

💾 PERSIST
  ├─ Save to strategies.json
  ├─ Archive trade logs
  └─ Backup learning data
```

---

## 🐛 Requirements

### System
- Linux/macOS/Windows with C++20
- CMake 3.10+
- 4GB RAM minimum

### Libraries
- CURL (HTTP requests)
- OpenSSL (Encryption)
- libwebsockets (WebSocket)
- nlohmann/json (JSON parsing)

### Install Dependencies

**Ubuntu/Debian:**
```bash
sudo apt-get install -y \
  build-essential cmake git \
  libcurl4-openssl-dev \
  libssl-dev \
  libwebsockets-dev \
  nlohmann-json3-dev
```

**macOS:**
```bash
brew install cmake openssl curl libwebsockets nlohmann-json
```

---

## 💰 Paper vs Live

### Paper Trading
```bash
# Virtual $10k starting bankroll
# Real Kraken prices via WebSocket
# No real money at risk
# Perfect for validation

./kraken_bot
```

### Live Trading (Requires Approval)
```bash
# Uses your real Kraken API keys
# Real money trades
# One-click deployment after paper validation
# Minimum requirements:
#   - 50+ paper trades
#   - 55%+ win rate  
#   - 2+ validated strategies
#   - Confidence > 70%

./kraken_bot --live
```

---

## ⚠️ Risk Management

### Built-in Protections

1. **Position Size Limits**
   - Max 5% of bankroll per trade
   - Learned optimal sizes per strategy
   - Reduced after consecutive losses

2. **Stop Losses**
   - Learned from historical data
   - Adaptive based on volatility
   - Automatic execution

3. **Take Profits**
   - Multiple levels
   - Partial exits supported
   - Trailing stops available

4. **Daily Loss Limits**
   - Paper: -$1000 (10%)
   - Live: -5% of account
   - Auto-stop trading when hit

5. **Drawdown Monitoring**
   - Track max drawdown per strategy
   - Disable strategy if DD > 30%
   - Regime detection before recovery

---

## 📈 Monitoring

### Real-Time Metrics

```bash
# Watch trade stream
tail -f trade_log.json | jq '.[-1]'

# Check process health
top -p $(pgrep kraken_bot)

# Monitor strategy performance
grep 'confidence' trade_log.json | tail -20
```

### Key Metrics

- **Win Rate**: % profitable trades
- **Profit Factor**: Wins / losses
- **Sharpe Ratio**: Return per risk unit
- **Max Drawdown**: Peak-to-trough loss
- **Confidence**: Statistical certainty (0-1)

---

## 🦀 Troubleshooting

### "No opportunities found"
- Market is ranging (low volatility)
- Spreads too wide
- All patterns require specific conditions
- Try different pair subsets

### "Authentication failed"
```bash
# Verify env vars
echo $KRAKEN_API_KEY
echo $KRAKEN_API_SECRET

# Test API access
curl -H 'API-Key: <key>' https://api.kraken.com/0/public/AssetPairs
```

### "Low win rate"
- Need 25+ paper trades minimum
- Volatility changing market conditions
- Leverage too high
- Position size too large

---

## 📝 Next Steps

1. **Build**: `cd bot && mkdir build && cd build && cmake .. && make`
2. **Run Paper**: `./kraken_bot`
3. **Trade 50+**: Paper trade until 55%+ win rate
4. **Review**: Check learning analysis
5. **Deploy**: `./kraken_bot --live` (with "YES" confirmation)
6. **Monitor**: Watch first week closely

---

## 🔐 API Keys Security

### DO NOT:
- ❌ Commit `.env` files
- ❌ Share API secrets
- ❌ Use keys without IP whitelist
- ❌ Allow withdraw permissions

### DO:
- ✅ Store in environment variables
- ✅ Use dedicated API keys (one per bot)
- ✅ Restrict to trading-only permissions
- ✅ Enable IP whitelist
- ✅ Rotate keys monthly

---

## 📐 Documentation

- [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md) - Complete setup guide
- [DEPLOYMENT.md](../DEPLOYMENT.md) - Production operations
- [STRATEGY_LOG.md](../STRATEGY_LOG.md) - Strategy evolution history

---

**Ready to trade?** See [BUILD_AND_DEPLOY.md](BUILD_AND_DEPLOY.md)!
