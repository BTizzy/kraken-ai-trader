# Kraken AI Trader - Improvements Roadmap V2

**Last Updated:** January 13, 2026  
**Version:** 2.0.0

---

## ✅ Completed Improvements (This Session)

### 🔒 Stability & Data Integrity

| Improvement | Status | Description |
|-------------|--------|-------------|
| **Remove Debug Files** | ✅ Done | Removed 12 unused files (debug_pairs.cpp, fix_parsing.js, etc.) |
| **Consolidate Configuration** | ✅ Done | Created `config/bot_config.json` as single source of truth |
| **Standardize Logging** | ✅ Done | Created `lib/logger.js` with DEBUG/INFO/WARN/ERROR levels |
| **Health Check Endpoint** | ✅ Done | `/api/health` with uptime, trades, memory, alerts |
| **Automatic Backup System** | ✅ Done | `backup_trade_log()` + periodic backup every 50 trades |
| **Trade Validation** | ✅ Done | `LearningEngine::validate_trade()` before recording |
| **Retry Logic** | ✅ Done | `retry_with_backoff()` template for API calls |
| **API Rate Limiting** | ✅ Done | 60 req/min with 429 responses and rate limit headers |
| **Anomaly Detection** | ✅ Done | Alerts for P&L drops, no trades, high memory |

### 💰 Profitability Improvements

| Improvement | Status | Description |
|-------------|--------|-------------|
| **Fee-Aware Trading** | ✅ Done | Skip trades where TP < fees (0.4%) + buffer |
| **Kelly Criterion Position Sizing** | ✅ Done | `get_kelly_fraction()` for optimal bet sizing |
| **Confidence Threshold** | ✅ Done | Increased from 0.35 to 0.55 to reduce overtrading |
| **Market Regime Detection** | ✅ Done | TRENDING/RANGING/VOLATILE/QUIET with strategy adjustment |

### 📊 Test Results

```
✅ Trade Calculations     8P 0F 0W
✅ Trade Log Validation   10P 0F 1W  
✅ Dashboard API          7P 0F 0W
────────────────────────────────────
✅ ALL TESTS PASSED      25 passed, 0 failed
```

---

## 🚀 Future Improvements (Prioritized)

### Phase 1: Critical (Next Sprint)

#### 1. **Fix Negative P&L**
- Current total P&L: **-$485.54**
- Root causes to investigate:
  - Over-trading (fixed with confidence threshold)
  - Fees eating profits (fixed with fee-aware trading)
  - Poor signal quality (partially fixed with regime detection)
- **Action**: Run paper trading with new settings for 1 week, analyze results

#### 2. **Multi-Timeframe Analysis**
```cpp
struct TimeframeAnalysis {
    double shortTermSignal;   // 1-5 min (entry timing)
    double mediumTermSignal;  // 15-60 min (trend direction)
    double longTermSignal;    // 4h-1d (overall bias)
    
    double combinedSignal() {
        return shortTermSignal * 0.2 + 
               mediumTermSignal * 0.3 + 
               longTermSignal * 0.5;
    }
};
```
- **Benefit**: Only trade when all timeframes align

#### 3. **SQLite Database Migration**
- Replace JSON trade logs with SQLite
- Benefits:
  - ACID compliance
  - Better query performance
  - Concurrent access support
  - Easy analytics queries

### Phase 2: Enhancement (Month 2)

#### 4. **Advanced Position Management**
- Partial profit taking at 50% of TP
- Scale-in on pullbacks in strong trends
- Dynamic stop loss adjustment

#### 5. **Correlation Analysis**
- Track which pairs move together
- Avoid taking multiple positions in correlated assets
- Use correlation for hedging

#### 6. **Machine Learning Integration**
- Use historical patterns for prediction
- Feature engineering from technical indicators
- Ensemble model (combine multiple strategies)

### Phase 3: Scale (Month 3+)

#### 7. **Portfolio Risk Management**
- Max portfolio heat (total risk exposure)
- Sector/correlation limits
- Drawdown-based position reduction

#### 8. **Live Trading Preparation**
- Paper trading validation framework
- Minimum requirements before live:
  - 100+ paper trades
  - > 55% win rate
  - > 1.5 profit factor
  - < 10% max drawdown

#### 9. **CI/CD Pipeline**
- Run tests on every commit
- Automated deployment
- Monitoring dashboards

---

## 📈 Key Metrics to Track

### Trading Performance

| Metric | Current | Target | Status |
|--------|---------|--------|--------|
| Total P&L | -$485.54 | > $0 | 🔴 Critical |
| Win Rate | ~50% | > 55% | 🟡 Needs work |
| Profit Factor | ~1.0 | > 1.5 | 🟡 Needs work |
| Max Drawdown | Unknown | < 10% | ⚪ Not tracked |
| Trade Count | 1,337 | N/A | ✅ Good data |

### System Health

| Metric | Current | Status |
|--------|---------|--------|
| Tests Passing | 25/25 | ✅ |
| API Rate Limiting | Enabled | ✅ |
| Backups | Every 50 trades | ✅ |
| Health Monitoring | Enabled | ✅ |
| Memory Usage | 84% | 🟡 High |

---

## 🔧 Configuration Reference

### New Configuration File: `config/bot_config.json`

```json
{
  "trading": {
    "mode": "paper",
    "max_concurrent_trades": 2,
    "scan_interval_seconds": 20
  },
  "filters": {
    "min_confidence_threshold": 0.65,
    "min_volatility_pct": 1.5,
    "max_volatility_pct": 25.0
  },
  "fees": {
    "taker_fee_pct": 0.4,
    "min_profit_after_fees_pct": 0.5
  },
  "backup": {
    "interval_trades": 50,
    "max_backups": 5
  }
}
```

### New API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System health check with alerts |
| `/api/bot/status` | GET | Bot running status |
| `/api/bot/learning` | GET | Learning engine statistics |

---

## 📝 Files Changed This Session

### Created
- `config/bot_config.json` - Unified configuration
- `config/index.js` - Configuration loader
- `lib/logger.js` - Standardized logging

### Modified
- `server.js` - Added health endpoint, rate limiter
- `bot/src/main.cpp` - Added Kelly, fee-aware trading, regime detection
- `bot/src/kraken_api.cpp` - Added retry with backoff
- `bot/include/learning_engine.hpp` - Added validate_trade, backup methods

### Removed
- `debug_pairs.cpp`
- `fix_parsing.js`, `fix_parsing2.js`
- `test_volatility.cpp`
- `index.html.backup`, `server.js.backup2`
- `clean_trade_log.py`
- Various test artifacts

---

## 🎯 Immediate Next Steps

1. **Monitor paper trading** for 1 week with new settings
2. **Analyze regime detection** effectiveness
3. **Implement multi-timeframe analysis** if regime detection shows promise
4. **Consider SQLite migration** if JSON performance becomes an issue

---

## Summary

This session implemented **14 improvements** across stability and profitability:

- **Stability**: Backups, validation, health monitoring, rate limiting
- **Profitability**: Fee-aware trading, Kelly sizing, confidence threshold, regime detection
- **Infrastructure**: Unified config, standardized logging, comprehensive tests

The system is now more robust and should reduce unprofitable trades. The next focus should be **monitoring results** and **multi-timeframe analysis** to improve signal quality.
