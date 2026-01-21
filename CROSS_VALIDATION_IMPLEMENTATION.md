# Cross-Validation & Pattern Persistence Implementation

## Overview
This implementation adds two critical features to the learning engine:
1. **Cross-validation** (train/test splits) to prevent overfitting
2. **Pattern persistence** in SQLite to retain knowledge across bot restarts

## Key Changes

### 1. SQLite Schema Enhancement (`learned_patterns` table)

New table to persist learned patterns across restarts:
- **Primary Key**: `pattern_key` (e.g., "BTCUSD_LONG_2x_1")
- **Metrics Stored**: total_trades, winning_trades, win_rate, sharpe_ratio, profit_factor, confidence_score, has_edge, etc.
- **Indexes**: On `pair`, `has_edge`, and `confidence_score` for fast queries
- **Auto-timestamping**: `updated_at` field tracks when pattern was last updated

### 2. Cross-Validation Implementation

**Function**: `cross_validate_pattern(trades, train_ratio=0.8)`

**Algorithm**:
1. Requires minimum 10 trades for meaningful validation
2. Splits trades into 80% training, 20% test sets
3. Calculates metrics for both sets:
   - Win rate
   - Sharpe ratio
   - Profit factor
4. Detects overfitting when:
   - Test win rate is >20% lower than train win rate, OR
   - Test Sharpe ratio is <50% of train Sharpe ratio

**Output**: Logs validation metrics with ⚠️ warning if overfitting detected

### 3. Pattern Persistence Functions

**`save_patterns_to_db()`**:
- Called automatically after each `analyze_patterns()` run (every 25 trades)
- Saves all PatternMetrics from `pattern_database` to SQLite
- Uses `INSERT OR REPLACE` to update existing patterns
- Logs count of patterns saved

**`load_patterns_from_db()`**:
- Called during `LearningEngine()` constructor
- Loads all previously learned patterns from SQLite into memory
- Builds on prior knowledge instead of starting from scratch
- Logs count of patterns loaded

### 4. Integration Points

**In `analyze_patterns()` method**:
```cpp
// After calculating pattern metrics (line ~426):
pattern_database[pattern_key] = metrics;

// NEW: Cross-validation for patterns with enough samples
if (trades.size() >= 10) {
    ValidationMetrics validation = cross_validate_pattern(trades, 0.8);
    log_validation_metrics(pattern_key, validation);
}

// At the end (line ~459):
// 9. NEW: PERSIST PATTERNS TO SQLITE
save_patterns_to_db();
```

**In `init_database()` method**:
```cpp
// At the end (line ~102):
load_trades_from_db();
load_patterns_from_db();  // NEW: Load patterns on startup
```

## Console Output Examples

### Cross-Validation Output
```
🔍 Cross-Validation [BTCUSD_LONG_2x_1]:
   Train (16 trades): WR=75.0%, Sharpe=1.45, P/F=2.30
   Test  (4 trades): WR=25.0%, Sharpe=0.42, P/F=0.85 ⚠️ OVERFIT WARNING
```

### Pattern Persistence Output
```
💾 Saved 47 learned patterns to SQLite
```

On next restart:
```
📂 Loaded 47 learned patterns from SQLite
```

## Benefits

1. **Prevents Overfitting**: Cross-validation identifies patterns that work on training data but fail on unseen test data
2. **Knowledge Retention**: Bot builds on previous learning instead of starting fresh each restart
3. **Faster Bootstrap**: New sessions immediately have access to historical pattern performance
4. **Data Integrity**: SQLite ensures patterns are durably persisted
5. **No Breaking Changes**: Existing learning cycle (every 25 trades) unchanged

## Testing

A standalone test program (`bot/test_validation.cpp`) validates:
- ✅ Balanced patterns (no overfitting)
- ✅ Overfit patterns (correctly detected)
- ✅ Insufficient data handling (< 10 trades)

All tests pass successfully.

## Database Files

- **Trades**: `/data/trades.db` (table: `trades`)
- **Patterns**: `/data/trades.db` (table: `learned_patterns`)

Both stored in the same SQLite database for consistency.
