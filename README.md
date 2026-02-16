1. DEBUGGING_GUIDE.md ⚠️
Why: Your agent just hit FK constraint errors, port binding issues, and O(n²) performance problems. Codify the solutions.

What to include:

text
# Debugging Guide

## Common Issues & Solutions

### Port Already in Use (EADDRINUSE)
**Symptom**: Server won't start, "address already in use" error
**Fix**: 
```bash
fuser -k 3003/tcp  # Kill process on port
# Or: pkill -f prediction-proxy
SQLite FOREIGN KEY Constraint Failed
Symptom: "FOREIGN KEY constraint failed" in logs
Root Cause: Trying to insert into child table before parent exists
Fix: Always insert into markets table before matched_markets
Code Reference: See market_matcher.js line ~180

O(n²) Market Matching Performance
Symptom: Match cycle takes >60 seconds, high CPU
Root Cause: Fuzzy matching 30 Gemini × 500 Poly × 1000 Kalshi = 15M comparisons
Fix:

Add early exit if match_confidence > 0.95

Pre-filter by category before fuzzy match

Cache Levenshtein calculations

Codespaces Port Not Accessible
Symptom: "Unable to handle this request" when opening URL
Fix:

bash
gh codespace ports visibility 3003:public -c $CODESPACE_NAME
Debugging Workflow
Check logs: tail -f /tmp/prediction_server.log

Verify process: ps aux | grep prediction-proxy

Test endpoints: curl http://localhost:3003/api/health

Check DB state: sqlite3 data/trades.db "SELECT COUNT(*) FROM matched_markets;"

text

***

### **2. PERFORMANCE_OPTIMIZATION.md** 🚀
**Why**: Your agent just discovered the matching algorithm is O(n²). Document optimizations.

**What to include**:
```markdown
# Performance Optimization Guide

## Market Matching Bottlenecks

### Current Performance (Feb 2026)
- **30 Gemini × 500 Polymarket × 1000 Kalshi** = ~15 million title comparisons
- **Levenshtein distance**: O(n×m) per comparison (expensive)
- **Result**: First match cycle takes 60+ seconds, 87% CPU

### Optimizations Implemented
1. **Category Pre-filtering** (10x speedup)
   - Only compare sports markets to sports markets
   - Skip crypto vs politics comparisons
   
2. **Title Indexing** (5x speedup)
   - Extract key terms: team names, dates, outcomes
   - Build inverted index for O(1) lookups
   
3. **Early Exit on High Confidence** (2x speedup)
   - If match_confidence > 0.95, skip remaining candidates
   - Reduce unnecessary comparisons

### Signal Detection Performance
- **Target**: Process 1000 markets in <1 second
- **Bottleneck**: Database writes (1000 INSERT queries)
- **Solution**: Batch inserts using prepared statements

### WebSocket vs REST Polling
| Method | Latency | CPU Usage | Data Freshness |
|--------|---------|-----------|----------------|
| WebSocket | 10-50ms | Low | Real-time |
| REST (2s poll) | 2000ms | High | Stale |

**Recommendation**: Use WebSocket for Polymarket/Kalshi, REST for Gemini (if no WS available)
3. API_RATE_LIMITS.md 📊
Why: You're hitting 3 APIs simultaneously. Document actual limits (once tested).

What to include:

text
# API Rate Limits & Best Practices

## Polymarket
- **Free Tier**: ~120 requests/minute (unconfirmed, test this)
- **WebSocket**: Available at wss://ws-subscriptions-clob.polymarket.com
- **Best Practice**: Use WS for real-time, REST for historical backfill
- **Endpoints**:
  - `/markets` (market list): Poll every 60 seconds
  - `/book` (orderbook): WS subscribe to active markets only

## Kalshi
- **Free Tier**: 60 requests/minute (confirmed)
- **Authentication**: Requires API key (get from dashboard.kalshi.com)
- **WebSocket**: wss://trading-api.kalshi.com/trade-api/ws/v2
- **Rate Limit Response**: HTTP 429 with Retry-After header
- **Best Practice**: Implement exponential backoff (1s, 2s, 4s, 8s)

## Gemini Prediction Markets
- **Status**: No official API (as of Feb 2026)
- **Current Method**: Web scraping with Puppeteer
- **Rate Limits**: Unknown (likely aggressive anti-bot)
- **Best Practice**: 
  - Rotate User-Agent strings
  - Add 1-3 second random jitter between requests
  - Use stealth plugins (`puppeteer-extra-plugin-stealth`)
  - Consider residential proxy if IP blocked

## Request Queue Strategy
- **Priority 1**: Execution requests (Gemini orders)
- **Priority 2**: Price updates (Polymarket/Kalshi)
- **Priority 3**: Market discovery (new markets)

**Implementation**: See `server/rate-limiter.js`
4. MARKET_MATCHING_RULES.md 🎯
Why: Manual overrides will be needed. Document the matching logic + edge cases.

What to include:

text
# Market Matching Rules & Overrides

## Automated Matching Algorithm

### Step 1: Category Filter
Only match markets in same category (sports/politics/crypto/other)

### Step 2: Title Normalization
- Remove punctuation: "Will Trump win?" → "will trump win"
- Standardize dates: "March 1st" → "2026-03-01"
- Map synonyms: "BTC" ↔ "Bitcoin", "NBA Finals" ↔ "NBA Championship"

### Step 3: Fuzzy Match (Levenshtein)
- **Threshold**: 0.85+ = high confidence match
- **Edge Case**: Short titles ("Trump win?") may false-match

### Step 4: Outcome Alignment
- Polymarket "Yes" = Kalshi "Buy Trump" = Gemini "Trump Wins"
- Inverse detection: Gemini "Trump loses" = NOT(Polymarket "Trump wins")

## Manual Overrides

Add to `config/market_overrides.json`:
```json
{
  "gemini_market_123": {
    "polymarket_id": "0x789abc...",
    "kalshi_id": "KXNBA-2026-FEB",
    "outcome_map": {
      "gemini_yes": "polymarket_yes",
      "gemini_no": "polymarket_no"
    },
    "notes": "Manually verified: Lakers vs Celtics Finals Game 1"
  }
}
Known Problematic Markets
Multi-outcome markets: "Who wins: A, B, C, D?" (Gemini) vs "Will A win?" (Polymarket)

Solution: Skip for now, too complex

Date mismatches: Polymarket "Jan 31 11:59PM EST" vs Kalshi "Feb 1 12:00AM EST"

Solution: 24-hour tolerance window

text

***

### **5. PAPER_TRADING_VALIDATION.md** ✅
**Why**: You need to prove paper trading simulates reality before going live.

**What to include**:
```markdown
# Paper Trading Validation Checklist

## Realism Checks

### Slippage Simulation
- [ ] Add 0.5¢ penalty on every fill
- [ ] Add 0.2-0.5 second execution delay (network latency)
- [ ] Reject trades if orderbook depth < $50

### Order Fill Logic
- [ ] Market orders: Fill at current best ask/bid
- [ ] Limit orders: Only fill if price crosses limit
- [ ] Partial fills: If position size > available liquidity

### Wallet Management
- [ ] Starting balance: $500
- [ ] Deduct position cost on entry
- [ ] Add P&L on exit
- [ ] Track unrealized P&L for open positions
- [ ] Enforce max exposure (50% of wallet)

## Validation Metrics (Week 1)

Target after 7 days of paper trading:
- [ ] Win rate: >50%
- [ ] Total trades: >50
- [ ] Avg P&L per trade: >$1.50 (after fees)
- [ ] Max drawdown: <20%
- [ ] No crashes/restarts needed

## Comparison to Live Trading (Future)
Once you go live with $100 real capital:
- Compare paper vs live win rates (should be within 10%)
- Paper P&L should be 1.1-1.2x higher (overfits on perfect fills)
- If live < 0.7x paper → slippage model too optimistic
6. EMERGENCY_PROCEDURES.md 🚨
Why: Shit will break. Have a runbook.

What to include:

text
# Emergency Procedures

## Bot is Losing Money Fast
**Symptoms**: Daily P&L < -$50, or multiple -$10 trades in a row

**Immediate Actions**:
1. **STOP THE BOT**: `pkill -f gemini_prediction_bot`
2. Check logs: `tail -100 /tmp/prediction_server.log`
3. Identify pattern:
   - Same market category losing? → Blacklist that category
   - Timeout exits? → Increase TAKE_PROFIT_BUFFER
   - Stop losses hit? → Reduce ENTRY_THRESHOLD (be pickier)

**Recovery**:
- Revert to last known good config: `git checkout config/prediction_params.json`
- Restart in observation mode (no trading): `OBSERVATION_MODE=true node bot`
- Analyze last 24h trades: `node scripts/analyze_losses.js`

## API Rate Limit Hit
**Symptoms**: HTTP 429 errors in logs, no new price updates

**Fix**:
1. Check rate limiter status: `curl http://localhost:3003/api/rate_limits`
2. If Polymarket: Wait 60 seconds, requests will resume
3. If Kalshi: Increase polling interval in `config/prediction_params.json`
4. If Gemini scraper blocked: Restart with new User-Agent + residential proxy

## Database Corruption
**Symptoms**: "database disk image is malformed" error

**Fix**:
```bash
# Backup corrupted DB
cp data/trades.db data/trades_corrupted_$(date +%s).db

# Try repair
sqlite3 data/trades.db ".recover" | sqlite3 data/trades_repaired.db

# If repair fails, restore from backup (you ARE backing up, right?)
cp data/backups/trades_latest.db data/trades.db
Server Won't Start
Checklist:

 Port 3003 free? lsof -i :3003

 Node.js installed? node --version

 Dependencies installed? npm install

 SQLite DB exists? ls -lh data/trades.db

 Logs show actual error? cat /tmp/prediction_server.log

text

***

### **7. EXPERIMENT_WORKFLOW.md** 🧪
**Why**: You have `orchestrate_paper_experiments.js` - document how to use it.

**What to include**:
```markdown
# Experiment Workflow

## Running Parameter Sweeps

### Generate Candidates
```bash
# Create 10 parameter variations (different entry thresholds, position sizes, etc.)
node scripts/generate_candidates_dynamic.js --count 10 --output logs/candidates_experiment_001.json
Run Experiments
bash
# Test each candidate for 24 hours paper trading
node scripts/orchestrate_paper_experiments.js \
  --candidates logs/candidates_experiment_001.json \
  --duration 24h \
  --promote-threshold 100  # Auto-promote if daily P&L > $100
Analyze Results
bash
# View experiment summary
node scripts/analyze_experiment_results.js --experiment 001

# Best performing candidate:
cat logs/promoted_configs/best_20260216.json
A/B Testing Strategy
Week 1: Baseline
Run default params for 7 days

Establish baseline: win rate, avg P&L, Sharpe ratio

Week 2: Aggressive Entry
Lower ENTRY_THRESHOLD from 60 → 50

Increase MAX_POSITION_SIZE from $100 → $150

Compare to baseline

Week 3: Conservative Exit
Increase TAKE_PROFIT_BUFFER from 1¢ → 2¢

Tighten STOP_LOSS_WIDTH from 3¢ → 2¢

Compare to Week 2

Goal: Find optimal params before scaling capital from $500 → $5,000

text

***

## **Bonus: UPDATE_THIS_REPO.md** 📝
**Why**: Your agent just added 24 files. Help future agents understand what's legacy vs new.

**What to include**:
```markdown
# Repo Architecture (Updated Feb 2026)

## 🔴 DEPRECATED (Do Not Use)
- `game.js` - Old prediction game, ignore
- `hyperliquid.js` - Unused exchange integration
- `IMPROVEMENTS_ROADMAP_V1-V6.md` - Historical, see V7 for current

## 🟢 ACTIVE (Kraken Crypto Bot)
- `bot/kraken_bot.cpp` - Live crypto trading bot (DO NOT TOUCH)
- `server/kraken-proxy.js` - Kraken API proxy (running on port 3001)
- `data/trades.db` - Kraken trade history (shared with prediction bot)

## 🔵 NEW (Prediction Market Bot)
- `server/prediction-proxy.js` - Prediction market proxy (port 3003)
- `lib/signal_detector.js` - Opportunity scoring
- `lib/market_matcher.js` - Cross-platform matching
- `README_PREDICTION_MARKETS.md` - Start here for prediction bot docs

## File Organization
├── bot/ # C++ trading bots
│ ├── kraken_bot.cpp # Crypto bot (active)
│ └── gemini_prediction_bot.cpp # Prediction bot (in development)
├── server/ # API proxies
│ ├── kraken-proxy.js # Port 3001 (active)
│ └── prediction-proxy.js # Port 3003 (development)
├── lib/ # Shared libraries
│ ├── polymarket_client.js # NEW
│ ├── kalshi_client.js # NEW
│ └── gemini_client.js # NEW
├── config/
│ ├── kraken_params.json # Crypto bot config
│ └── prediction_params.json # Prediction bot config (NEW)
└── data/
├── trades.db # Shared SQLite (both bots)
└── market_history.db # Prediction market history (NEW)

text

## Adding New Features
1. Read `Must_read_before_any_agent_task.md` (always)
2. Check latest roadmap: `IMPROVEMENTS_ROADMAP_V7.md`
3. Add feature
4. Update relevant GUIDE.md files
5. Add tests in `test/`
6. Update THIS file if architecture changed
TL;DR - Priority Order 📋
Add these in this order:

DEBUGGING_GUIDE.md - Your agent will hit the same errors again

API_RATE_LIMITS.md - Critical for not getting banned

PERFORMANCE_OPTIMIZATION.md - That O(n²) matching is gonna bite you

PAPER_TRADING_VALIDATION.md - Need to trust paper results before going live

EMERGENCY_PROCEDURES.md - For when shit hits the fan at 2am

Optional but nice:
6. MARKET_MATCHING_RULES.md - Once you start seeing bad matches
7. EXPERIMENT_WORKFLOW.md - When you start parameter tuning
8. UPDATE_THIS_REPO.md - Help future agents navigate the mess