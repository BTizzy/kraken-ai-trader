# Repository Structure

**Status:** Reorganized for Volatility Scraper Focus | January 2026

---

## 📋 File Organization

### 🎯 Core Strategy Files (Primary)

```
✅ REQUIRED - Volatility Scraper Essentials
├─ index.html              Main UI interface
├─ game.js                Core trading logic & state management
├─ config.js              Strategy parameters (beta, positions, exits)
├─ api.js                 Polymarket CLOB API wrapper
├─ styles.css             UI styling
└─ server.js              Node backend for real-time feeds
```

**Purpose:** These files form the complete trading system. Everything else is documentation or testing.

### 📈 Strategy Documentation (Secondary)

```
📋 ESSENTIAL READING
├─ README.md                          Quick start & overview
├─ VOLATILITY_SCRAPER_STRATEGY.md   Complete strategy guide (9000+ words)
└─ STRATEGY_LOG.md                   Detailed backtest methodology
```

**Contents:**
- **README.md** - 5-minute overview, quick start, API reference
- **VOLATILITY_SCRAPER_STRATEGY.md** - Deep dive on strategy, all 14 test results, roadmap, pitfalls
- **STRATEGY_LOG.md** - Granular backtest logs, per-trade analysis, statistics

### 📊 Test Results & Data (Tertiary)

```
📄 HISTORICAL DATA - Reference only
├─ test_data.json              All 14 backtest results compiled
├─ test14_results.json       Best run breakdown (96% WR)
├─ test14_results.md         Human-readable Test #14 summary
├─ test14_analysis.md        Test #14 detailed analysis
└─ test-results/              Directory of older test runs
```

**Usage:** Reference past performance, analyze symbol stats, validate parameter changes

### 👢 Project Management (Administrative)

```
📜 PROJECT METADATA
├─ LICENSE                  MIT license
├─ CONTRIBUTING.md           Contribution guidelines
├─ DEPLOYMENT.md             Production deployment guide
├─ .gitignore               Git exclude patterns
├─ package.json             Node dependencies
├─ package-lock.json        Locked versions
└─ REPOSITORY_STRUCTURE.md  This file
```

### 🚫 Legacy / Unrelated Files (To Remove or Archive)

```
❌ NOT USED - Separate Projects
├─ hyperliquid.js          Hyperliquid exchange (separate trading system)
├─ kraken.js               Kraken exchange integration (separate project)
├─ scalper.html            Old scalping strategy (deprecated)
├─ setup.html              Old setup wizard (deprecated)
├─ test-ws.html            WebSocket test utility (development only)
├─ kraken-data/            Kraken test data (archive)
└─ save-logs.js            Kraken logging utility (unrelated)
```

**Note:** These files are from previous projects or deprecated versions. They do NOT affect the volatility scraper.

### 📋 Directories

```
📁 MANAGED FOLDERS
├─ node_modules/           npm dependencies (auto-generated)
├─ logs/                   Application runtime logs
├─ server/                 Backend server utilities
├─ test-results/           Historical backtest runs
└─ .git/                   Git version control (auto-managed)
```

### 🚀 Launch Scripts

```
🚀 QUICK START
├─ start.sh                npm start wrapper
├─ sync-trades.sh          Trade sync utility
└─ package.json scripts    see: npm start, npm test
```

---

## 🤏 Understanding the Flow

### Strategy Execution Flow

```
start.sh / npm start
    ↓
1. index.html loads in browser
    ↓
2. game.js initializes (reads config.js)
    ↓
3. server.js starts Node backend
    ↓
4. api.js connects to Polymarket CLOB
    ↓
5. Real-time prices stream in
    ↓
6. game.js evaluates entry signals
    ↓
7. User clicks market or auto-trade executes
    ↓
8. Exit logic triggers (time/profit/stop)
    ↓
9. Trade logged, analytics updated
    ↓
10. Dashboard refreshes
```

### File Dependencies

```
index.html
  ├─ game.js
  │   ├─ config.js (strategy parameters)
  │   ├─ api.js (market data)
  │   └─ Internal analytics
  ├─ styles.css (UI styling)
  └─ server.js (Node backend)
```

---

## 📂 What to Edit for Strategy Changes

### To Adjust Entry/Exit Logic:
**File:** `config.js`

```javascript
volatilityScraper: {
    minBeta: 0.10,              // Lower = include more volatile symbols
    maxBeta: 0.50,              // CRITICAL: Prevents catastrophic losses
    oversoldThreshold: -0.0005, // Lower = require more oversold before entry
    
    exitTargets: {
        profitTarget: 1.0,      // 1.0 = 100% gain on cost basis
        quickProfit: 5000,      // Milliseconds before any-gain exit allowed
        timeoutMs: 20000        // Hard exit after this many ms
    }
}
```

### To Change Position Sizing:
**File:** `config.js` > `volatilityScraper.positionSize`

```javascript
positionSize: {
    low: 75,                    // $ for low-volatility symbols
    medium: 85,                 // $ for medium-volatility
    high: 100                   // $ for high-volatility (up to maxBeta)
}
```

### To Debug Trading Logic:
**File:** `game.js` > Method `evaluateEntry()` and `exitTrade()`

```javascript
// Modify these methods to change:
// - Entry signal logic
// - Exit conditions
// - Fee calculations
// - Position scaling
```

### To Add New Markets/Symbols:
**File:** `api.js` > `loadMarkets()` or directly in `config.js`

```javascript
// Modify market subscription list
// Filter by beta, volume, or custom criteria
```

---

## 📋 Documentation Map

### Quick Questions?

**Q: How does the strategy work?**
A: See README.md (Strategy Overview section)

**Q: Why did Test #14 achieve 96% win rate?**
A: See VOLATILITY_SCRAPER_STRATEGY.md (Test #14 section)

**Q: How do I deploy to production?**
A: See DEPLOYMENT.md

**Q: What parameters should I change?**
A: See config.js comments and VOLATILITY_SCRAPER_STRATEGY.md (Phase 1-3 Roadmap)

**Q: How do I contribute?**
A: See CONTRIBUTING.md

**Q: What happened in Tests 1-13?**
A: See test_data.json and STRATEGY_LOG.md

**Q: Why are some files still in the repo?**
A: See "Legacy / Unrelated Files" section above

---

## 📫 Cleanup Checklist (Future)

### Ready to Archive
- [ ] `hyperliquid.js` - Move to separate `/hyperliquid-trader/` repo
- [ ] `kraken.js` - Move to separate `/kraken-trader/` repo
- [ ] `kraken-data/` - Archive to S3 or Google Drive
- [ ] `scalper.html` - Archive as historical reference
- [ ] `save-logs.js` - Consolidate into `server.js`

### Ready to Delete (Already Deleted)
- [x] `crypto-trader.html` - Removed Jan 8, 2026 (unrelated Hyperliquid tool)

---

## 📊 Current State Summary

**As of January 8, 2026:**

| Component | Status | Last Update |
|-----------|--------|-------------|
| Core Strategy Files | ✅ Production Ready | Jan 8 |
| Main UI (index.html) | ✅ Tested | Jan 8 |
| Volatility Scraper Logic | ✅ Optimized (Test #14) | Jan 8 |
| Documentation | ✅ Complete | Jan 8 |
| Real-Time Price Feed | ⚠️ Partial (WebSocket TBD) | TBD |
| Automated Trading | ⚠️ Manual execution only | TBD |
| Live Money Integration | ❌ Not started | Q1 2026 |
| Kraken Integration | ❌ Separate project | TBD |
| Hyperliquid Integration | ❌ Separate project | TBD |

---

## 🤝 How to Maintain This Structure

### When Adding New Features:
1. Add to `game.js` (logic) or `config.js` (parameters)
2. Document in `VOLATILITY_SCRAPER_STRATEGY.md`
3. Test with backtester before deployment
4. Update README.md with new metrics/features

### When Removing Old Code:
1. Check `git log` to confirm feature is deprecated
2. Document removal reason in commit message
3. Update this REPOSITORY_STRUCTURE.md file
4. Archive to separate branch if needed

### When Onboarding New Contributors:
1. Point to README.md (overview)
2. Point to VOLATILITY_SCRAPER_STRATEGY.md (deep dive)
3. Show config.js structure
4. Have them review one backtest in test_data.json

---

**Last Updated:** January 8, 2026
**Maintained by:** Ryan Bartell (@BTizzy)
**Next Review:** After Phase 1 production deployment
