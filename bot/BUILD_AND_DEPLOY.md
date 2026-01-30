# Kraken Trading Bot - C++ Version

> **NOTE:** For the most current build, deployment, and operational information, always check `../Must_read_before_any_agent_task.md`.

## ⚠️ Data Persistence
- **Current:** All trade records, learning data, and analytics are stored in SQLite (`data/trades.db`).
- **Legacy:** JSON persistence is deprecated and should not be used for trading or analytics. (Kept for historical reference only.)

## 🚀 Quick Start

### 1. Environment Setup

```bash
# Set your Kraken API credentials (from environment variables)
export KRAKEN_API_KEY="your_api_key"
export KRAKEN_API_SECRET="your_api_secret"

# Optional: Set paper trading mode (default: paper)
export KRAKEN_PAPER_MODE="true"  # Set to false for live
```

### 2. Build the Bot

```bash
cd bot/
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
make -j$(nproc)
```

### 3. Run in Paper Trading Mode (RECOMMENDED FIRST)

```bash
./kraken_bot
```

This will:
- Connect to Kraken WebSocket for real prices
- Paper trade with virtual $10k bankroll
- Analyze every 25 trades automatically
- Save trade logs to `trade_log.json`
- Learn and improve strategies

### 4. Monitor Learning Progress

After 25+ trades, check the learning summary:

```bash
# The bot automatically prints learning metrics every 25 trades
# Look for:
# - Winning patterns (pair + leverage + timeframe combinations)
# - Correlation analysis between different strategies  
# - Market regime detection
# - Strategy validation scores
# - Confidence levels (must be 60%+ to trade)
```

### 5. One-Click Live Deployment

Once you have 50+ paper trades with 55%+ win rate:

```bash
./kraken_bot --live
```

The bot will ask for confirmation:
```
⚠️  ONE-CLICK LIVE DEPLOYMENT
==================================================
This will switch from PAPER to LIVE TRADING.
Your Kraken API keys from environment variables will be used.

❓ Type 'YES' to deploy:
```

Type `YES` to go live. Your real Kraken keys will be used.

---

## 📊 50x Robust Self-Learning System

### What Makes It 50x Better?

#### 1. **Multi-Dimensional Pattern Matching**
Instead of tracking single features, analyzes combinations:
- Trading pair (BTC/USD, ETH/USD, etc.)
- Leverage level (1x, 2x, 5x, 10x)
- Timeframe bucket (0-30s, 30-60s, 60-120s, 120+ s)
- Market volatility at entry
- Bid-ask spread at entry

#### 2. **Statistical Rigor**
- **Confidence scores** (0-1): How confident are we in this pattern?
- **Profit factor**: Gross wins / gross losses (2.0 = 2x wins)
- **Sharpe ratio**: Risk-adjusted returns
- **Sortino ratio**: Downside risk only
- **Max drawdown**: Peak-to-trough losses
- **Win rate at confidence**: Estimate accuracy with confidence intervals

#### 3. **Correlation Analysis**
Identifies which patterns tend to win/lose together:
- Pearson correlation coefficients
- Regime-dependent relationships  
- Cross-pair synergies

#### 4. **Regime Detection**
Detects market shifts:
- High volatility vs consolidation
- Trending up/down vs ranging
- Shifts automatically adjust strategies

#### 5. **Outlier Handling**
- Removes extreme trades that don't represent typical performance
- Uses 2.5 standard deviation threshold
- Prevents over-fitting to lucky trades

#### 6. **Strategy Evolution Database**
Maintains versioned strategy configs:
```json
{
  "strategies": [
    {
      "name": "BTC/USD_2x_60s",
      "pair": "BTC/USD",
      "leverage": 2.0,
      "timeframe": 60,
      "win_rate": 0.58,
      "profit_factor": 1.85,
      "sharpe_ratio": 2.1,
      "confidence": 0.78,
      "trades": 47,
      "timestamp": "2026-01-08T19:55:00Z"
    }
  ]
}
```

#### 7. **Ensemble Methods**
Combines multiple strategies:
- Bagging (bootstrap aggregating)
- Weighted averaging based on Sharpe ratio
- Risk-adjusted position sizing

#### 8. **Drawdown Tracking**
Tracks drawdown by strategy:
- Maximum consecutive losses
- Recovery time after drawdown
- Expected drawdown vs realized

---

## 🎯 Learning Cycle (Every 25 Trades)

### Automatic Analysis at Trade 25, 50, 75, 100+

```
📊 ANALYSIS CYCLE:
├─ Group trades by pattern (pair + leverage + timeframe)
├─ Calculate performance metrics for each pattern
├─ Identify winning patterns (with 60%+ confidence)
├─ Analyze correlations between patterns
├─ Detect market regime shifts
├─ Update strategy database
├─ Optimize position sizing
└─ Print summary with confidence scores
```

### Example Output After 25 Trades:

```
🤖 LEARNING ENGINE: Analyzing 25 trades...
  📈 BTC/USD_2x_1 | Trades: 8 | Win Rate: 62.5% | P/F: 1.92 | Sharpe: 2.1 | Conf: 78% ✅
  📈 ETH/USD_1x_2 | Trades: 12 | Win Rate: 58.3% | P/F: 1.65 | Sharpe: 1.8 | Conf: 65% ✅
  📈 SOL/USD_5x_0 | Trades: 5 | Win Rate: 40.0% | P/F: 0.88 | Sharpe: -0.5 | Conf: 35% ❌

🏆 WINNING PATTERNS:
  #1: BTC/USD_2x_1 | PF: 1.92 | WR: 62.5% | Trades: 8
  #2: ETH/USD_1x_2 | PF: 1.65 | WR: 58.3% | Trades: 12

🔗 PATTERN CORRELATIONS:
  BTC/USD_2x_1 <-> ETH/USD_1x_2: 0.45 (positive)
  BTC/USD_2x_1 <-> SOL/USD_5x_0: -0.12 (negative)

📊 REGIME ANALYSIS:
  Old period win rate: 56%
  Recent period win rate: 61%
  ✅ Improving trend detected

🔄 UPDATING STRATEGY DATABASE...
  ✅ Created 2 validated strategies
```

---

## 💡 Strategy Configuration

Each strategy learns:

```cpp
struct StrategyConfig {
    std::string name;           // "BTC/USD_2x_60s"
    double min_volatility;      // 0.5% minimum to trade
    double max_spread_pct;      // 0.1% max spread
    double leverage;            // 1-10x
    int timeframe_seconds;      // How long to hold
    double take_profit_pct;     // Exit target (learned from history)
    double stop_loss_pct;       // Exit stop (learned from history)
    double position_size_usd;   // $50-$500 (learned from capital curve)
    bool use_trailing_stop;     // Adaptive exit
    bool use_partial_exits;     // Exit 50% at TP, trail rest
};
```

---

## 📈 Performance Monitoring

### Key Metrics Tracked:

1. **Win Rate**: % of profitable trades
2. **Profit Factor**: Gross wins / gross losses
3. **Sharpe Ratio**: Return per unit of risk
4. **Sortino Ratio**: Return per unit of downside risk
5. **Max Drawdown**: Largest peak-to-trough decline
6. **Confidence Score**: Statistical confidence in pattern (0-1)
7. **Edge**: Expected profit % per trade

### Minimum Thresholds for Trading:

```
Win Rate:          > 45%
Profit Factor:     > 1.0
Sharpe Ratio:      > 0.5
Confidence:        > 60%
Min Sample Size:   15+ trades
```

If pattern falls below thresholds → **Strategy is disabled**

---

## 🔐 Security & Keys

### Environment Variables (DO NOT COMMIT)

```bash
# .env (NOT in git)
KRAKEN_API_KEY="xxx"
KRAKEN_API_SECRET="yyy"
KRAKEN_PAPER_MODE="true"
```

### Add to `.gitignore`:
```
.env
*.key
*.secret
api_keys/
```

### Key Rotation

For live trading:
1. Create API key pair in Kraken dashboard
2. Restrict to trading only (no withdraw)
3. Set IP whitelist
4. Set trading pair whitelist (only pairs you trade)
5. Store in environment variables
6. Never commit to git

---

## 🐛 Troubleshooting

### "Authentication failed"
```bash
# Check env vars are set
echo $KRAKEN_API_KEY
echo $KRAKEN_API_SECRET

# Test connection
curl -H 'API-Key: <key>' https://api.kraken.com/0/public/AssetPairs
```

### "No good opportunities found"
- Market might be ranging (low volatility)
- Spread might be too wide
- All learned patterns might require specific conditions
- Increase timeframe to catch more trades

### "Low win rate"
- Need more paper trades (25+ minimum)
- Volatility might be changing
- Leverage might be too high
- Position size might be too large

---

## 📊 Deployment Checklist

Before going LIVE:

- [ ] 50+ paper trades completed
- [ ] 55%+ win rate achieved
- [ ] 2+ validated strategies found
- [ ] Max drawdown < 20%
- [ ] Sharpe ratio > 1.0
- [ ] Confidence score > 70% on main strategies
- [ ] Paper trading ran for 2+ days
- [ ] No regime shifts detected
- [ ] API keys rotated and restricted
- [ ] IP whitelist enabled
- [ ] Position size conservative ($50-100)
- [ ] Leverage at 2x or less
- [ ] Stop losses set on all trades
- [ ] Daily loss limit set to 5%
- [ ] Monitoring dashboard open

---

## 🚀 Production Operations

### Monitor Running Bot

```bash
# Watch live output
tail -f trade_log.json | jq '.[-1]'

# Check process
ps aux | grep kraken_bot

# Stop bot (graceful)
kill -TERM <pid>
```

### Daily Operations

1. Check overnight trades
2. Review learning analysis 
3. Verify strategies still profitable
4. Check for regime changes
5. Monitor drawdown
6. Adjust leverage if needed

### Weekly Review

1. Analyze full week performance
2. Check correlation shifts
3. Rebalance position sizes
4. Review regime predictions
5. Consider strategy updates

---

## 📝 Next Steps

1. ✅ Build and test in paper mode
2. ✅ Run 50+ paper trades
3. ✅ Verify learning analysis
4. ✅ Confirm strategies are profitable
5. ⚠️ Deploy to live (one-click)
6. 🔐 Monitor closely first week
7. 📈 Scale gradually

---

**Questions?** Check DEPLOYMENT.md for more details.
