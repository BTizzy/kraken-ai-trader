#include "learning_engine.hpp"
#include <numeric>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <cmath>
#include <set>

LearningEngine::LearningEngine() {
    // Initialize SQLite database (project root data directory)
    // Allow override via TRADES_DB for testing/CI
    const char* env_db = std::getenv("TRADES_DB");
    std::string db_path = env_db && *env_db ? std::string(env_db) : std::string("../../data/trades.db");
    init_database(db_path);
    // Attempt to load a direction model for adaptive entry direction/leveraging
    try {
        std::ifstream f("data/direction_model.json");
        if (f.good()) {
            nlohmann::json jm;
            f >> jm;
            if (jm.contains("weights") && jm["weights"].is_object()) {
                for (auto it = jm["weights"].begin(); it != jm["weights"].end(); ++it) {
                    direction_model_weights[it.key()] = it.value().get<double>();
                }
                direction_model_bias = jm.value("bias", 0.0);
                direction_model_loaded = true;
                std::cout << "Loaded direction model with " << direction_model_weights.size() << " weights" << std::endl;
            }
        }
    } catch (...) {
        // ignore
    }
}

LearningEngine::~LearningEngine() {
    if (db_) {
        sqlite3_close(db_);
        db_ = nullptr;
    }
}

void LearningEngine::init_database(const std::string& db_path) {
    db_path_ = db_path;
    
    // Try to open (and create if missing) the trades DB
    int rc = sqlite3_open_v2(db_path.c_str(), &db_, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "❌ Failed to open or create SQLite database at " << db_path << ": " << sqlite3_errmsg(db_) << std::endl;
        if (db_) {
            sqlite3_close(db_);
            db_ = nullptr;
        }
        return;
    }
    
    // Create trades table if not exists
    const char* create_table_sql = R"(
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair TEXT NOT NULL,
            direction TEXT DEFAULT 'LONG',
            entry_price REAL,
            exit_price REAL,
            position_size REAL,
            leverage INTEGER DEFAULT 1,
            pnl REAL,
            gross_pnl REAL,
            fees_paid REAL,
            exit_reason TEXT,
            timestamp INTEGER,
            entry_time INTEGER,
            hold_time INTEGER,
            timeframe_seconds INTEGER,
            volatility_pct REAL,
            bid_ask_spread REAL,
            rsi REAL,
            macd_histogram REAL,
            macd_signal REAL,
            bb_position REAL,
            volume_ratio REAL,
            momentum_score REAL,
            atr_pct REAL,
            market_regime INTEGER,
            trend_direction REAL,
            max_profit REAL,
            max_loss REAL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(pair, timestamp)
        );
        CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
        CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair);
        CREATE INDEX IF NOT EXISTS idx_trades_regime ON trades(market_regime);
    )";
    
    char* err_msg = nullptr;
    rc = sqlite3_exec(db_, create_table_sql, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        std::cerr << "❌ Failed to create trades table: " << err_msg << std::endl;
        sqlite3_free(err_msg);
    } else {
        std::cout << "✅ SQLite database initialized: " << db_path << std::endl;
    }
    
    // Load existing trades from database
    load_trades_from_db();
}

void LearningEngine::save_trade_to_db(const TradeRecord& trade) {
    if (!db_) {
        std::cerr << "⚠️ Database not initialized, cannot save trade" << std::endl;
        return;
    }
    
    const char* insert_sql = R"(
        INSERT OR IGNORE INTO trades (
            pair, direction, entry_price, exit_price, position_size, leverage,
            pnl, gross_pnl, fees_paid, exit_reason, timestamp, entry_time, hold_time,
            timeframe_seconds, volatility_pct, bid_ask_spread, rsi, macd_histogram,
            macd_signal, bb_position, volume_ratio, momentum_score, atr_pct,
            market_regime, trend_direction, max_profit, max_loss
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    )";
    
    sqlite3_stmt* stmt;
    int rc = sqlite3_prepare_v2(db_, insert_sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "❌ Failed to prepare insert statement: " << sqlite3_errmsg(db_) << std::endl;
        return;
    }
    
    auto timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        trade.timestamp.time_since_epoch()).count();
    
    sqlite3_bind_text(stmt, 1, trade.pair.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, trade.direction.empty() ? "LONG" : trade.direction.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_double(stmt, 3, trade.entry_price);
    sqlite3_bind_double(stmt, 4, trade.exit_price);
    sqlite3_bind_double(stmt, 5, trade.position_size);
    sqlite3_bind_int(stmt, 6, static_cast<int>(trade.leverage));
    sqlite3_bind_double(stmt, 7, trade.pnl);
    sqlite3_bind_double(stmt, 8, trade.gross_pnl);
    sqlite3_bind_double(stmt, 9, trade.fees_paid);
    sqlite3_bind_text(stmt, 10, trade.exit_reason.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(stmt, 11, timestamp_ms);
    sqlite3_bind_int64(stmt, 12, timestamp_ms);  // entry_time same as timestamp for now
    sqlite3_bind_int(stmt, 13, trade.timeframe_seconds);
    sqlite3_bind_int(stmt, 14, trade.timeframe_seconds);
    sqlite3_bind_double(stmt, 15, trade.volatility_at_entry);
    sqlite3_bind_double(stmt, 16, trade.bid_ask_spread);
    sqlite3_bind_double(stmt, 17, trade.rsi);
    sqlite3_bind_double(stmt, 18, trade.macd_histogram);
    sqlite3_bind_double(stmt, 19, trade.macd_signal);
    sqlite3_bind_double(stmt, 20, trade.bb_position);
    sqlite3_bind_double(stmt, 21, trade.volume_ratio);
    sqlite3_bind_double(stmt, 22, trade.momentum_score);
    sqlite3_bind_double(stmt, 23, trade.atr_pct);
    sqlite3_bind_int(stmt, 24, trade.market_regime);
    sqlite3_bind_double(stmt, 25, trade.trend_direction);
    sqlite3_bind_double(stmt, 26, trade.max_profit);
    sqlite3_bind_double(stmt, 27, trade.max_loss);
    
    rc = sqlite3_step(stmt);
    if (rc != SQLITE_DONE) {
        std::cerr << "❌ Failed to insert trade: " << sqlite3_errmsg(db_) << std::endl;
    } else {
        std::cout << "💾 Trade saved to SQLite: " << trade.pair << " " 
                  << (trade.pnl > 0 ? "+" : "") << "$" << std::fixed << std::setprecision(2) << trade.pnl << std::endl;
    }
    
    sqlite3_finalize(stmt);
}

void LearningEngine::load_trades_from_db() {
    if (!db_) return;
    
    // Use explicit column names to avoid index issues
    const char* select_sql = R"(
        SELECT 
            pair, direction, entry_price, exit_price, position_size, leverage,
            pnl, gross_pnl, fees_paid, exit_reason, timestamp,
            timeframe_seconds, volatility_pct, bid_ask_spread,
            rsi, macd_histogram, macd_signal, bb_position, volume_ratio,
            momentum_score, atr_pct, market_regime, trend_direction
        FROM trades 
        WHERE leverage > 1.0
        ORDER BY timestamp ASC
    )";
    sqlite3_stmt* stmt;
    
    int rc = sqlite3_prepare_v2(db_, select_sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "❌ Failed to prepare select statement: " << sqlite3_errmsg(db_) << std::endl;
        return;
    }
    
    int count = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        TradeRecord trade;
        
        // Column 0: pair
        const char* pair = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        trade.pair = pair ? pair : "";
        
        // Column 1: direction
        const char* dir = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
        trade.direction = dir ? dir : "LONG";
        
        // Columns 2-5: price/position data
        trade.entry_price = sqlite3_column_double(stmt, 2);
        trade.exit_price = sqlite3_column_double(stmt, 3);
        trade.position_size = sqlite3_column_double(stmt, 4);
        trade.leverage = sqlite3_column_double(stmt, 5);
        
        // Columns 6-9: P&L and exit
        trade.pnl = sqlite3_column_double(stmt, 6);
        trade.gross_pnl = sqlite3_column_double(stmt, 7);
        trade.fees_paid = sqlite3_column_double(stmt, 8);
        
        const char* reason = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 9));
        trade.exit_reason = reason ? reason : "unknown";
        
        // Column 10: timestamp
        int64_t ts = sqlite3_column_int64(stmt, 10);
        trade.timestamp = system_clock::time_point(milliseconds(ts));
        
        // Columns 11-13: timeframe, volatility, spread
        trade.timeframe_seconds = sqlite3_column_int(stmt, 11);
        trade.volatility_at_entry = sqlite3_column_double(stmt, 12);
        trade.bid_ask_spread = sqlite3_column_double(stmt, 13);
        
        // Columns 14-22: technical indicators
        trade.rsi = sqlite3_column_double(stmt, 14);
        trade.macd_histogram = sqlite3_column_double(stmt, 15);
        trade.macd_signal = sqlite3_column_double(stmt, 16);
        trade.bb_position = sqlite3_column_double(stmt, 17);
        trade.volume_ratio = sqlite3_column_double(stmt, 18);
        trade.momentum_score = sqlite3_column_double(stmt, 19);
        trade.atr_pct = sqlite3_column_double(stmt, 20);
        trade.market_regime = sqlite3_column_int(stmt, 21);
        trade.trend_direction = sqlite3_column_double(stmt, 22);
        
        // Add to in-memory structures (don't use record_trade to avoid re-saving)
        trade_history.push_back(trade);
        trades_by_pair[trade.pair].push_back(trade);
        count++;
    }
    
    sqlite3_finalize(stmt);
    std::cout << "📊 Loaded " << count << " trades from SQLite database" << std::endl;
}

int LearningEngine::get_db_trade_count() const {
    if (!db_) return 0;
    
    const char* count_sql = "SELECT COUNT(*) FROM trades WHERE leverage > 1.0";
    sqlite3_stmt* stmt;
    
    int rc = sqlite3_prepare_v2(db_, count_sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) return 0;
    
    int count = 0;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        count = sqlite3_column_int(stmt, 0);
    }
    
    sqlite3_finalize(stmt);
    return count;
}

void LearningEngine::record_trade(const TradeRecord& trade) {
    // Save to SQLite FIRST (single source of truth)
    save_trade_to_db(trade);
    
    // Then update in-memory structures
    trade_history.push_back(trade);
    trades_by_pair[trade.pair].push_back(trade);
    
    // Generate pattern key for this trade (includes direction: LONG or SHORT)
    int timeframe_bucket;
    if (trade.timeframe_seconds < 30) timeframe_bucket = 0;
    else if (trade.timeframe_seconds < 60) timeframe_bucket = 1;
    else if (trade.timeframe_seconds < 120) timeframe_bucket = 2;
    else timeframe_bucket = 3;
    
    // Default to LONG for legacy trades without direction
    std::string direction = trade.direction.empty() ? "LONG" : trade.direction;
    
    // Generate both basic and enhanced pattern keys
    std::string basic_key = generate_pattern_key(trade.pair, direction, trade.leverage, timeframe_bucket);
    std::string enhanced_key = generate_enhanced_pattern_key(trade.pair, direction, trade.leverage, 
                                                              timeframe_bucket, trade.volatility_at_entry, 
                                                              trade.market_regime);
    
    // Store in both for compatibility and granularity
    trades_by_strategy[basic_key].push_back(trade);
    trades_by_strategy[enhanced_key].push_back(trade);
    
    // Print what we learned from this trade
    std::cout << "📝 Trade recorded: " << trade.pair << " " << direction
              << " | " << (trade.is_win() ? "WIN ✅" : "LOSS ❌")
              << " | ROI: " << std::fixed << std::setprecision(2) << trade.roi() << "%" 
              << " | Pattern: " << basic_key 
              << " | Enhanced: " << enhanced_key << std::endl;
    
    // Auto-analyze every 25 trades
    if (trade_history.size() % 25 == 0) {
        std::cout << "\n📊 AUTO-ANALYZING at trade #" << trade_history.size() << "..." << std::endl;
        analyze_patterns();
    }
}

void LearningEngine::analyze_patterns() {
    if (trade_history.size() < MIN_TRADES_FOR_ANALYSIS) {
        std::cout << "⏳ Need " << MIN_TRADES_FOR_ANALYSIS << " trades for analysis (have " 
                  << trade_history.size() << ")" << std::endl;
        return;
    }
    
    std::cout << "🤖 LEARNING ENGINE: Analyzing " << trade_history.size() << " trades..." << std::endl;
    
    // 1. GROUP TRADES BY PATTERN (both basic and enhanced)
    std::map<std::string, std::vector<TradeRecord>> patterns;
    for (const auto& trade : trade_history) {
        int timeframe_bucket;
        if (trade.timeframe_seconds < 30) timeframe_bucket = 0;
        else if (trade.timeframe_seconds < 60) timeframe_bucket = 1;
        else if (trade.timeframe_seconds < 120) timeframe_bucket = 2;
        else timeframe_bucket = 3;
        
        // Default to LONG for legacy trades without direction
        std::string direction = trade.direction.empty() ? "LONG" : trade.direction;
        
        // Generate basic key
        std::string basic_key = generate_pattern_key(trade.pair, direction, trade.leverage, timeframe_bucket);
        patterns[basic_key].push_back(trade);
        
        // Generate enhanced key with volatility and regime
        std::string enhanced_key = generate_enhanced_pattern_key(trade.pair, direction, trade.leverage, 
                                                                  timeframe_bucket, trade.volatility_at_entry, 
                                                                  trade.market_regime);
        patterns[enhanced_key].push_back(trade);
    }
    
    std::cout << "📊 Generated " << patterns.size() << " unique patterns from " << trade_history.size() << " trades" << std::endl;
    
    // 2. CALCULATE METRICS FOR EACH PATTERN
    for (auto& [pattern_key, trades] : patterns) {
        if (trades.size() < 5) continue;  // Need 5+ samples
        
        PatternMetrics metrics;
        metrics.total_trades = trades.size();
        
        std::vector<double> returns;
        double gross_wins = 0, gross_losses = 0;
        
        for (const auto& t : trades) {
            if (t.is_win()) {
                metrics.winning_trades++;
                gross_wins += t.gross_pnl;
                returns.push_back(t.roi());
            } else {
                metrics.losing_trades++;
                gross_losses += std::abs(t.gross_pnl);
                returns.push_back(t.roi());
            }
            metrics.total_pnl += t.pnl;
            metrics.total_fees += t.fees_paid;
        }
        
        // Parse pattern key: PAIR_DIRECTION_LEVERAGEx_TIMEFRAME
        // e.g., "BTCUSD_LONG_1x_2" or legacy "BTCUSD_1x_2"
        size_t pos1 = pattern_key.find('_');
        size_t pos2 = pattern_key.find('_', pos1 + 1);
        size_t pos3 = pattern_key.find('_', pos2 + 1);
        
        metrics.pair = pattern_key.substr(0, pos1);
        
        // Check if this is the new format with direction or legacy format
        std::string second_part = pattern_key.substr(pos1 + 1, pos2 - pos1 - 1);
        if (second_part == "LONG" || second_part == "SHORT") {
            // New format: PAIR_DIRECTION_LEVERAGEx_TIMEFRAME
            std::string leverage_str = pattern_key.substr(pos2 + 1, pos3 - pos2 - 1);
            // Remove the 'x' suffix if present
            if (!leverage_str.empty() && leverage_str.back() == 'x') {
                leverage_str.pop_back();
            }
            metrics.leverage = leverage_str.empty() ? 1.0 : std::stod(leverage_str);
            metrics.timeframe_bucket = std::stoi(pattern_key.substr(pos3 + 1));
        } else {
            // Legacy format: PAIR_LEVERAGEx_TIMEFRAME
            std::string leverage_str = second_part;
            // Remove the 'x' suffix if present
            if (!leverage_str.empty() && leverage_str.back() == 'x') {
                leverage_str.pop_back();
            }
            metrics.leverage = leverage_str.empty() ? 1.0 : std::stod(leverage_str);
            metrics.timeframe_bucket = std::stoi(pattern_key.substr(pos2 + 1));
        }
        
        // Win rate
        metrics.win_rate = (double)metrics.winning_trades / metrics.total_trades;
        
        // Averages
        metrics.avg_win = metrics.winning_trades > 0 ? gross_wins / metrics.winning_trades : 0;
        metrics.avg_loss = metrics.losing_trades > 0 ? gross_losses / metrics.losing_trades : 0;
        
        // Profit factor
        metrics.profit_factor = metrics.losing_trades > 0 ? gross_wins / gross_losses : gross_wins;
        
        // Statistical measures
        metrics.sharpe_ratio = calculate_sharpe_ratio(returns);
        metrics.sortino_ratio = calculate_sortino_ratio(returns);
        metrics.max_drawdown = calculate_max_drawdown(returns);
        
        // Confidence score (0-1)
        metrics.confidence_score = calculate_confidence_score(metrics);
        
        // Edge detection
        double expected_pnl = (metrics.win_rate * metrics.avg_win) + 
                            ((1.0 - metrics.win_rate) * -metrics.avg_loss);
        metrics.has_edge = expected_pnl > metrics.total_fees * 1.5;  // Must beat fees
        metrics.edge_percentage = metrics.avg_win > 0 ? (expected_pnl / metrics.avg_win) * 100 : 0;
        
        pattern_database[pattern_key] = metrics;
        
        // Print
        if (metrics.winning_trades > 0 || metrics.losing_trades > 0) {
            std::cout << "  📈 " << pattern_key
                      << " | Trades: " << std::setw(3) << metrics.total_trades
                      << " | Win Rate: " << std::fixed << std::setprecision(1) << metrics.win_rate * 100 << "%"
                      << " | P/F: " << std::setprecision(2) << metrics.profit_factor
                      << " | Sharpe: " << std::setprecision(2) << metrics.sharpe_ratio
                      << " | Conf: " << std::setprecision(0) << metrics.confidence_score * 100 << "%"
                      << (metrics.has_edge ? " ✅" : " ❌") << std::endl;
        }
    }
    
    // 3. IDENTIFY WINNING PATTERNS
    identify_winning_patterns();
    
    // 4. CORRELATION ANALYSIS
    correlate_patterns();
    
    // 5. REGIME DETECTION
    detect_regime_shifts();
    
    // 6. INDICATOR EFFECTIVENESS ANALYSIS (from awesome-systematic-trading)
    analyze_indicator_patterns();
    
    // 7. UPDATE STRATEGY DATABASE
    update_strategy_database();
    
    // 8. SAVE PATTERN DATABASE FOR API ACCESS
    save_pattern_database_to_file("pattern_database.json");
}

std::string LearningEngine::generate_pattern_key(const std::string& pair, const std::string& direction, double leverage, int timeframe) const {
    return pair + "_" + direction + "_" + std::to_string((int)leverage) + "x_" + std::to_string(timeframe);
}

// NEW: Enhanced pattern key with volatility and regime for more granular patterns
std::string LearningEngine::generate_enhanced_pattern_key(const std::string& pair, const std::string& direction, 
                                                           double leverage, int timeframe, 
                                                           double volatility, int regime) const {
    // Volatility buckets: 0=low(<2%), 1=med(2-5%), 2=high(5-10%), 3=extreme(>10%)
    int vol_bucket = 0;
    if (volatility < 2.0) vol_bucket = 0;
    else if (volatility < 5.0) vol_bucket = 1;
    else if (volatility < 10.0) vol_bucket = 2;
    else vol_bucket = 3;
    
    // Regime: 0=quiet, 1=ranging, 2=trending, 3=volatile
    std::string regime_str;
    switch (regime) {
        case 0: regime_str = "Q"; break;  // Quiet
        case 1: regime_str = "R"; break;  // Ranging
        case 2: regime_str = "T"; break;  // Trending
        case 3: regime_str = "V"; break;  // Volatile
        default: regime_str = "U"; break; // Unknown
    }
    
    return pair + "_" + direction + "_" + std::to_string((int)leverage) + "x_" + 
           std::to_string(timeframe) + "_V" + std::to_string(vol_bucket) + "_" + regime_str;
}

// Get pattern metrics by key
PatternMetrics LearningEngine::get_pattern_metrics(const std::string& pattern_key) const {
    auto it = pattern_database.find(pattern_key);
    if (it != pattern_database.end()) {
        return it->second;
    }
    // Return empty metrics if pattern not found
    return PatternMetrics();
}

void LearningEngine::identify_winning_patterns() {
    std::cout << "\n🏆 WINNING PATTERNS:" << std::endl;
    
    std::vector<std::pair<std::string, PatternMetrics>> winners;
    
    for (const auto& [key, metrics] : pattern_database) {
        if (metrics.has_edge && metrics.confidence_score >= CONFIDENCE_THRESHOLD) {
            winners.push_back({key, metrics});
        }
    }
    
    // Sort by profit factor
    std::sort(winners.begin(), winners.end(),
        [](const auto& a, const auto& b) { return a.second.profit_factor > b.second.profit_factor; });
    
    for (int i = 0; i < std::min(5, (int)winners.size()); i++) {
        const auto& [key, metrics] = winners[i];
        std::cout << "  #" << i+1 << ": " << key
                  << " | PF: " << std::setprecision(2) << metrics.profit_factor
                  << " | WR: " << std::setprecision(1) << metrics.win_rate * 100 << "%"
                  << " | Trades: " << metrics.total_trades << std::endl;
    }
}

void LearningEngine::correlate_patterns() {
    // Check which patterns tend to win/lose together
    std::cout << "\n🔗 PATTERN CORRELATIONS:" << std::endl;
    
    std::vector<std::pair<std::string, double>> correlations;
    
    // Simple correlation: if both patterns win frequently
    for (const auto& [key1, metrics1] : pattern_database) {
        if (!metrics1.has_edge) continue;
        
        for (const auto& [key2, metrics2] : pattern_database) {
            if (key1 >= key2 || !metrics2.has_edge) continue;
            
            // Measure correlation via Pearson coefficient
            std::vector<double> wins1, wins2;
            
            for (const auto& t : trades_by_strategy[key1]) {
                wins1.push_back(t.is_win() ? 1.0 : 0.0);
            }
            for (const auto& t : trades_by_strategy[key2]) {
                wins2.push_back(t.is_win() ? 1.0 : 0.0);
            }
            
            if (wins1.size() > 0 && wins2.size() > 0) {
                double mean1 = std::accumulate(wins1.begin(), wins1.end(), 0.0) / wins1.size();
                double mean2 = std::accumulate(wins2.begin(), wins2.end(), 0.0) / wins2.size();
                
                double cov = 0, var1 = 0, var2 = 0;
                for (size_t i = 0; i < std::min(wins1.size(), wins2.size()); i++) {
                    cov += (wins1[i] - mean1) * (wins2[i] - mean2);
                    var1 += std::pow(wins1[i] - mean1, 2);
                    var2 += std::pow(wins2[i] - mean2, 2);
                }
                
                if (var1 > 0 && var2 > 0) {
                    double corr = cov / std::sqrt(var1 * var2);
                    if (std::abs(corr) > 0.3) {
                        correlations.push_back({key1 + " <-> " + key2, corr});
                    }
                }
            }
        }
    }
    
    // Show top correlations
    std::sort(correlations.begin(), correlations.end(),
        [](const auto& a, const auto& b) { return std::abs(a.second) > std::abs(b.second); });
    
    for (int i = 0; i < std::min(3, (int)correlations.size()); i++) {
        std::cout << "  " << correlations[i].first << ": " 
                  << std::setprecision(2) << correlations[i].second << std::endl;
    }
}

void LearningEngine::detect_regime_shifts() {
    std::cout << "\n📊 REGIME ANALYSIS:" << std::endl;
    
    if (trade_history.size() < 20) {
        std::cout << "  Insufficient data for regime detection" << std::endl;
        return;
    }
    
    // Recent vs older trades
    std::vector<double> recent_rets, old_rets;
    
    size_t cutoff = trade_history.size() / 2;
    for (size_t i = 0; i < cutoff; i++) {
        old_rets.push_back(trade_history[i].roi());
    }
    for (size_t i = cutoff; i < trade_history.size(); i++) {
        recent_rets.push_back(trade_history[i].roi());
    }
    
    double old_wr = std::count_if(old_rets.begin(), old_rets.end(),
        [](double x) { return x > 0; }) / (double)old_rets.size();
    double recent_wr = std::count_if(recent_rets.begin(), recent_rets.end(),
        [](double x) { return x > 0; }) / (double)recent_rets.size();
    
    std::cout << "  Old period win rate: " << std::setprecision(1) << old_wr * 100 << "%" << std::endl;
    std::cout << "  Recent period win rate: " << recent_wr * 100 << "%" << std::endl;
    
    if (recent_wr < old_wr - 0.15) {
        std::cout << "  ⚠️  REGIME SHIFT DETECTED - Strategy may need adjustment" << std::endl;
    }
}

std::string LearningEngine::detect_market_regime() const {
    if (trade_history.empty()) return "unknown";
    
    // Measure recent volatility and direction
    std::vector<double> recent_returns;
    int lookback = std::min(20, (int)trade_history.size());
    
    for (int i = trade_history.size() - lookback; i < (int)trade_history.size(); i++) {
        recent_returns.push_back(trade_history[i].roi());
    }
    
    double avg_return = std::accumulate(recent_returns.begin(), recent_returns.end(), 0.0) / recent_returns.size();
    double volatility = calculate_std_dev(recent_returns);
    
    if (volatility > 5.0) return "high_volatility";
    if (avg_return > 2.0) return "trending_up";
    if (avg_return < -2.0) return "trending_down";
    return "consolidating";
}

void LearningEngine::update_strategy_database() {
    std::cout << "\n🔄 UPDATING STRATEGY DATABASE..." << std::endl;
    
    strategy_configs.clear();
    
    // Create configs from winning patterns
    for (const auto& [key, metrics] : pattern_database) {
        if (!metrics.has_edge || metrics.confidence_score < CONFIDENCE_THRESHOLD) continue;
        
        StrategyConfig config;
        config.name = key;
        config.leverage = metrics.leverage;
        config.timeframe_seconds = metrics.timeframe_bucket * 30 + 15;  // midpoint
        config.min_volatility = 0.5;  // 0.5% minimum
        config.max_spread_pct = 0.1;  // 0.1% max spread
        config.take_profit_pct = metrics.avg_win / 100.0;  // Based on historical
        config.stop_loss_pct = metrics.avg_loss / 100.0;
        config.position_size_usd = 100;  // Base size
        config.is_validated = true;
        config.estimated_edge = metrics.edge_percentage;
        
        strategy_configs.push_back(config);
    }
    
    std::cout << "  ✅ Created " << strategy_configs.size() << " validated strategies" << std::endl;
}

StrategyConfig LearningEngine::get_optimal_strategy(const std::string& pair, double current_volatility) {
    // Check if this pair has consistently lost - suggest avoiding
    int total_pair_trades = 0;
    int pair_wins = 0;
    double pair_pnl = 0;
    
    for (const auto& [key, metrics] : pattern_database) {
        if (key.find(pair + "_") == 0) {
            total_pair_trades += metrics.total_trades;
            pair_wins += metrics.winning_trades;
            pair_pnl += metrics.total_pnl;
        }
    }
    
    // If we have enough data and this pair is a consistent loser, return very conservative strategy
    if (total_pair_trades >= 10) {
        double pair_win_rate = (double)pair_wins / total_pair_trades;
        if (pair_win_rate < 0.3 || pair_pnl < -5.0) {
            std::cout << "⚠️ " << pair << " has poor history (WR: " << std::fixed << std::setprecision(1) 
                      << (pair_win_rate * 100) << "%, P&L: $" << std::setprecision(2) << pair_pnl 
                      << ") - using ULTRA CONSERVATIVE" << std::endl;
            
            StrategyConfig conservative;
            conservative.name = "avoid_" + pair;
            conservative.leverage = 1.0;
            conservative.timeframe_seconds = 120;  // Longer hold for recovery
            conservative.take_profit_pct = 0.02;   // 2% TP to overcome fees
            conservative.stop_loss_pct = 0.005;    // 0.5% SL - cut losses fast
            conservative.position_size_usd = 25;   // Minimum size
            conservative.min_volatility = 3.0;     // Only trade if very volatile
            conservative.max_spread_pct = 0.1;     // Very tight spread required
            return conservative;
        }
    }
    
    // If we have learned strategies with edge, use them
    if (!strategy_configs.empty()) {
        std::vector<StrategyConfig> candidates;
        
        for (const auto& config : strategy_configs) {
            if (config.name.find(pair) == 0 && current_volatility >= config.min_volatility) {
                candidates.push_back(config);
            }
        }
        
        if (!candidates.empty()) {
            // Return best (highest estimated edge)
            auto best = std::max_element(candidates.begin(), candidates.end(),
                [](const auto& a, const auto& b) {
                    return a.estimated_edge < b.estimated_edge;
                });
            
            std::cout << "🎯 Using LEARNED strategy for " << pair 
                      << " | Edge: " << std::fixed << std::setprecision(1) << best->estimated_edge << "%" << std::endl;
            return *best;
        }
    }
    
    // Check if we have pattern data and use it to customize strategy
    double best_win_rate = 0;
    double best_leverage = 1.0;
    int best_timeframe = 60;
    
    for (const auto& [key, metrics] : pattern_database) {
        if (key.find(pair + "_") == 0 && metrics.total_trades >= 3 && metrics.win_rate > best_win_rate) {
            best_win_rate = metrics.win_rate;
            best_leverage = metrics.leverage;
            best_timeframe = metrics.timeframe_bucket * 30 + 30;
            
            std::cout << "📊 Found winning pattern for " << pair 
                      << " | WR: " << std::fixed << std::setprecision(1) << (metrics.win_rate * 100) << "%"
                      << " | Leverage: " << metrics.leverage << "x" << std::endl;
        }
    }
    
    // Build strategy based on learned data or defaults
    StrategyConfig adaptive;
    adaptive.name = "adaptive_" + pair;
    
    // Use learned parameters if we found any, otherwise use volatility-based defaults
    if (best_win_rate > 0.4) {
        adaptive.leverage = best_leverage;
        adaptive.timeframe_seconds = best_timeframe;
    } else {
        // More conservative defaults for unknown pairs
        adaptive.leverage = std::min(2.0, std::max(1.0, current_volatility / 3.0));
        adaptive.timeframe_seconds = std::max(60, std::min(180, (int)(60 / current_volatility * 5)));
    }
    
    // Take profit must exceed fees (0.4%) plus buffer
    adaptive.take_profit_pct = std::max(0.015, current_volatility / 100.0 * 0.4);  // At least 1.5%
    adaptive.stop_loss_pct = std::max(0.008, current_volatility / 100.0 * 0.2);    // At least 0.8%
    
    // Position sizing: smaller for unknown pairs
    adaptive.position_size_usd = total_pair_trades < 5 ? 50 : 75;  // Start conservative
    adaptive.min_volatility = 1.5;  // Need decent volatility
    adaptive.max_spread_pct = 0.3;
    
    if (total_pair_trades == 0) {
        std::cout << "🔄 Using ADAPTIVE strategy for " << pair << " (no data yet)" << std::endl;
    } else {
        std::cout << "🔄 Using ADAPTIVE strategy for " << pair 
                  << " | Historical WR: " << std::fixed << std::setprecision(1) << ((double)pair_wins/total_pair_trades*100) << "%" << std::endl;
    }
    
    return adaptive;
}

PatternMetrics LearningEngine::get_pattern_metrics(const std::string& pair, double leverage, int timeframe_bucket) const {
    std::string key = pair + "_" + std::to_string((int)leverage) + "x_" + std::to_string(timeframe_bucket);
    if (pattern_database.count(key)) {
        return pattern_database.at(key);
    }
    return PatternMetrics{};
}

// Statistical helpers
double LearningEngine::calculate_std_dev(const std::vector<double>& values) const {
    if (values.empty()) return 0;
    double mean = std::accumulate(values.begin(), values.end(), 0.0) / values.size();
    double variance = 0;
    for (double v : values) {
        variance += std::pow(v - mean, 2);
    }
    return std::sqrt(variance / values.size());
}

double LearningEngine::calculate_sharpe_ratio(const std::vector<double>& returns) const {
    if (returns.size() < 2) return 0;
    double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
    double std_dev = calculate_std_dev(returns);
    if (std_dev == 0) return 0;
    return (mean - 0) / std_dev;  // Assuming 0% risk-free rate
}

double LearningEngine::calculate_sortino_ratio(const std::vector<double>& returns) const {
    if (returns.size() < 2) return 0;
    double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
    
    double downside_var = 0;
    for (double r : returns) {
        if (r < 0) {
            downside_var += std::pow(r, 2);
        }
    }
    double downside_std = std::sqrt(downside_var / returns.size());
    if (downside_std == 0) return 0;
    return mean / downside_std;
}

double LearningEngine::calculate_max_drawdown(const std::vector<double>& returns) const {
    if (returns.empty()) return 0;
    double peak = returns[0];
    double max_dd = 0;
    for (double r : returns) {
        if (r > peak) peak = r;
        max_dd = std::max(max_dd, peak - r);
    }
    return max_dd;
}

double LearningEngine::calculate_confidence_score(const PatternMetrics& metrics) const {
    // Confidence increases with:
    // 1. More samples
    // 2. Higher win rate
    // 3. Higher profit factor
    
    double sample_score = std::min(1.0, metrics.total_trades / 30.0);  // 30+ trades = 100%
    double wr_score = std::max(0.0, metrics.win_rate - 0.35) / 0.35;  // 35% baseline
    double pf_score = std::min(1.0, metrics.profit_factor / 1.5);  // 1.5 = 100%
    
    return (sample_score * 0.4 + wr_score * 0.3 + pf_score * 0.3);
}

void LearningEngine::save_to_file(const std::string& filepath) {
    json data;
    data["version"] = "2.0";
    data["total_trades"] = trade_history.size();
    
    for (const auto& t : trade_history) {
        json trade_json;
        // Core trade data
        trade_json["pair"] = t.pair;
        trade_json["direction"] = t.direction.empty() ? "LONG" : t.direction;
        trade_json["entry_price"] = t.entry_price;
        trade_json["exit_price"] = t.exit_price;
        trade_json["position_size"] = t.position_size;
        trade_json["leverage"] = t.leverage;
        trade_json["timeframe_seconds"] = t.timeframe_seconds;
        
        // P&L data
        trade_json["pnl_usd"] = t.pnl;
        trade_json["gross_pnl"] = t.gross_pnl;
        trade_json["fees_paid"] = t.fees_paid;
        trade_json["exit_reason"] = t.exit_reason;
        
        // Timestamp
        auto timestamp_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            t.timestamp.time_since_epoch()).count();
        trade_json["timestamp"] = timestamp_ms;
        
        // Market conditions at entry
        trade_json["volatility_at_entry"] = t.volatility_at_entry;
        trade_json["bid_ask_spread"] = t.bid_ask_spread;
        
        // Technical indicators (for ML/learning)
        trade_json["rsi"] = t.rsi;
        trade_json["macd_histogram"] = t.macd_histogram;
        trade_json["macd_signal"] = t.macd_signal;
        trade_json["bb_position"] = t.bb_position;
        trade_json["volume_ratio"] = t.volume_ratio;
        trade_json["momentum_score"] = t.momentum_score;
        trade_json["atr_pct"] = t.atr_pct;
        trade_json["market_regime"] = t.market_regime;
        trade_json["trend_direction"] = t.trend_direction;
        
        // Trade dynamics
        trade_json["max_profit"] = t.max_profit;
        trade_json["max_loss"] = t.max_loss;
        
        data["trades"].push_back(trade_json);
    }
    
    std::ofstream file(filepath);
    file << data.dump(2) << std::endl;
    file.close();
    
    std::cout << "💾 Saved " << trade_history.size() << " trades to " << filepath << std::endl;
}

void LearningEngine::backup_trade_log(const std::string& filepath) {
    // Create backup filename with timestamp
    auto now = std::chrono::system_clock::now();
    auto timestamp = std::chrono::duration_cast<std::chrono::seconds>(
        now.time_since_epoch()).count();
    
    // Extract directory and filename
    size_t last_slash = filepath.find_last_of('/');
    std::string dir = (last_slash != std::string::npos) ? filepath.substr(0, last_slash + 1) : "";
    std::string backup_path = dir + "trade_log_backup_" + std::to_string(timestamp) + ".json";
    
    // Copy file contents
    std::ifstream src(filepath, std::ios::binary);
    if (!src.good()) {
        std::cerr << "⚠️ Cannot backup - source file not found: " << filepath << std::endl;
        return;
    }
    
    std::ofstream dst(backup_path, std::ios::binary);
    dst << src.rdbuf();
    
    src.close();
    dst.close();
    
    std::cout << "💾 Backup created: " << backup_path << std::endl;
    
    // Clean up old backups (keep last 5)
    // This would require directory listing - skipping for simplicity
}

bool LearningEngine::validate_trade(const TradeRecord& trade) {
    // Validate required fields
    if (trade.pair.empty()) {
        std::cerr << "❌ Trade validation failed: empty pair" << std::endl;
        return false;
    }
    if (trade.entry_price <= 0) {
        std::cerr << "❌ Trade validation failed: invalid entry_price " << trade.entry_price << std::endl;
        return false;
    }
    if (trade.exit_price <= 0) {
        std::cerr << "❌ Trade validation failed: invalid exit_price " << trade.exit_price << std::endl;
        return false;
    }
    if (trade.position_size <= 0) {
        std::cerr << "❌ Trade validation failed: invalid position_size " << trade.position_size << std::endl;
        return false;
    }
    if (trade.timeframe_seconds <= 0) {
        std::cerr << "❌ Trade validation failed: invalid timeframe_seconds " << trade.timeframe_seconds << std::endl;
        return false;
    }
    
    // Validate timestamp is not in the future
    auto now = std::chrono::system_clock::now();
    if (trade.timestamp > now) {
        std::cerr << "❌ Trade validation failed: timestamp in future" << std::endl;
        return false;
    }
    
    // Validate direction
    if (!trade.direction.empty() && trade.direction != "LONG" && trade.direction != "SHORT") {
        std::cerr << "❌ Trade validation failed: invalid direction " << trade.direction << std::endl;
        return false;
    }
    
    // Validate P&L is reasonable (within 50% of position size)
    if (std::abs(trade.pnl) > trade.position_size * 0.5) {
        std::cerr << "⚠️ Trade validation warning: P&L " << trade.pnl << " is >50% of position" << std::endl;
        // Don't fail, just warn
    }
    
    return true;
}

void LearningEngine::save_pattern_database_to_file(const std::string& filepath) {
    json data;
    data["version"] = "1.0";
    data["total_patterns"] = pattern_database.size();
    data["last_updated"] = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    
    // Convert pattern database to JSON
    json patterns_json = json::object();
    for (const auto& [key, metrics] : pattern_database) {
        json pattern_json;
        pattern_json["pair"] = metrics.pair;
        pattern_json["leverage"] = metrics.leverage;
        pattern_json["timeframe_bucket"] = metrics.timeframe_bucket;
        pattern_json["total_trades"] = metrics.total_trades;
        pattern_json["winning_trades"] = metrics.winning_trades;
        pattern_json["losing_trades"] = metrics.losing_trades;
        pattern_json["win_rate"] = metrics.win_rate;
        pattern_json["avg_win"] = metrics.avg_win;
        pattern_json["avg_loss"] = metrics.avg_loss;
        pattern_json["profit_factor"] = metrics.profit_factor;
        pattern_json["sharpe_ratio"] = metrics.sharpe_ratio;
        pattern_json["sortino_ratio"] = metrics.sortino_ratio;
        pattern_json["max_drawdown"] = metrics.max_drawdown;
        pattern_json["confidence_score"] = metrics.confidence_score;
        pattern_json["has_edge"] = metrics.has_edge;
        pattern_json["edge_percentage"] = metrics.edge_percentage;
        pattern_json["total_pnl"] = metrics.total_pnl;
        pattern_json["total_fees"] = metrics.total_fees;
        
        patterns_json[key] = pattern_json;
    }
    
    data["pattern_database"] = patterns_json;
    
    std::ofstream file(filepath);
    file << data.dump(2) << std::endl;
    file.close();
    
    std::cout << "🧠 Saved " << pattern_database.size() << " patterns to " << filepath << std::endl;
}

void LearningEngine::load_from_file(const std::string& filepath) {
    std::ifstream file(filepath);
    if (!file.good()) {
        std::cerr << "Cannot load file: " << filepath << std::endl;
        return;
    }
    
    json data;
    file >> data;
    file.close();
    
    // Parse and load trade history
    if (data.contains("trades") && data["trades"].is_array()) {
        trade_history.clear();
        trades_by_pair.clear();
        trades_by_strategy.clear();
        
        for (const auto& trade_json : data["trades"]) {
            TradeRecord trade;
            trade.pair = trade_json.value("pair", "");
            trade.direction = trade_json.value("direction", "LONG");  // Default to LONG for legacy trades
            trade.entry_price = trade_json.value("entry", 0.0);
            trade.exit_price = trade_json.value("exit", 0.0);
            trade.leverage = trade_json.value("leverage", 1.0);
            trade.pnl = trade_json.value("pnl", 0.0);
            trade.exit_reason = trade_json.value("reason", "unknown");
            
            // Load timestamp from milliseconds since epoch, or use current time for legacy trades
            if (trade_json.contains("timestamp")) {
                auto timestamp_ms = trade_json["timestamp"].get<long long>();
                trade.timestamp = system_clock::time_point(std::chrono::milliseconds(timestamp_ms));
            } else {
                trade.timestamp = std::chrono::system_clock::now();  // Fallback for legacy trades
            }
            
            // Set defaults for required fields
            trade.timeframe_seconds = 60;  // Default 1 minute
            trade.position_size = 100.0;   // Default $100
            trade.gross_pnl = trade.pnl;   // Assume no fees if not saved
            trade.fees_paid = 0.0;
            trade.volatility_at_entry = 0.0;
            trade.bid_ask_spread = 0.0;
            
            trade_history.push_back(trade);
            
            // Update auxiliary data structures
            trades_by_pair[trade.pair].push_back(trade);
            
            int timeframe_bucket = 1;  // Default bucket for 60s
            // Default to LONG for legacy trades without direction
            std::string direction = trade.direction.empty() ? "LONG" : trade.direction;
            std::string key = generate_pattern_key(trade.pair, direction, trade.leverage, timeframe_bucket);
            trades_by_strategy[key].push_back(trade);
        }
        
        std::cout << "📂 Loaded " << trade_history.size() << " trades from " << filepath << std::endl;
        
        // Run analysis if we have enough data
        if (trade_history.size() >= MIN_TRADES_FOR_ANALYSIS) {
            std::cout << "🔄 Running initial pattern analysis..." << std::endl;
            analyze_patterns();
        }
    } else {
        std::cout << "⚠️  No trades found in " << filepath << std::endl;
    }
}

json LearningEngine::get_statistics_json() const {
    json stats;
    stats["total_trades"] = trade_history.size();
    stats["patterns_found"] = pattern_database.size();
    stats["strategies"] = strategy_configs.size();
    
    double total_pnl = 0;
    int wins = 0;
    for (const auto& t : trade_history) {
        total_pnl += t.pnl;
        if (t.is_win()) wins++;
    }
    
    stats["total_pnl"] = total_pnl;
    stats["win_rate"] = trade_history.empty() ? 0 : (double)wins / trade_history.size();
    stats["regime"] = detect_market_regime();
    
    return stats;
}

void LearningEngine::print_summary() const {
    std::cout << "\n" << std::string(60, '=') << std::endl;
    std::cout << "🎯 LEARNING ENGINE SUMMARY" << std::endl;
    std::cout << std::string(60, '=') << std::endl;
    
    auto stats = get_statistics_json();
    std::cout << "  Total Trades: " << stats["total_trades"] << std::endl;
    std::cout << "  Win Rate: " << std::fixed << std::setprecision(1)
              << double(stats["win_rate"]) * 100 << "%" << std::endl;
    std::cout << "  Total P&L: $" << std::setprecision(2) << stats["total_pnl"] << std::endl;
    std::cout << "  Patterns Found: " << stats["patterns_found"] << std::endl;
    std::cout << "  Validated Strategies: " << stats["strategies"] << std::endl;
    std::cout << "  Market Regime: " << stats["regime"] << std::endl;
    std::cout << std::string(60, '=') << std::endl;
}

// ============================================================================
// TECHNICAL INDICATOR CALCULATIONS (from awesome-systematic-trading research)
// ============================================================================

double LearningEngine::calculate_sma(const std::vector<double>& prices, int period) const {
    if (prices.size() < static_cast<size_t>(period)) return 0.0;
    double sum = 0.0;
    for (int i = prices.size() - period; i < static_cast<int>(prices.size()); i++) {
        sum += prices[i];
    }
    return sum / period;
}

double LearningEngine::calculate_ema(const std::vector<double>& prices, int period) const {
    if (prices.empty()) return 0.0;
    if (prices.size() < static_cast<size_t>(period)) return prices.back();
    
    double multiplier = 2.0 / (period + 1);
    double ema = calculate_sma(std::vector<double>(prices.begin(), prices.begin() + period), period);
    
    for (size_t i = period; i < prices.size(); i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
}

double LearningEngine::calculate_rsi(const std::vector<double>& prices, int period) const {
    if (prices.size() < static_cast<size_t>(period + 1)) return 50.0;  // Neutral default
    
    double avg_gain = 0.0, avg_loss = 0.0;
    
    // Calculate initial average gain/loss
    for (int i = 1; i <= period; i++) {
        double change = prices[i] - prices[i - 1];
        if (change > 0) avg_gain += change;
        else avg_loss -= change;
    }
    avg_gain /= period;
    avg_loss /= period;
    
    // Calculate smoothed RSI
    for (size_t i = period + 1; i < prices.size(); i++) {
        double change = prices[i] - prices[i - 1];
        double gain = change > 0 ? change : 0;
        double loss = change < 0 ? -change : 0;
        
        avg_gain = (avg_gain * (period - 1) + gain) / period;
        avg_loss = (avg_loss * (period - 1) + loss) / period;
    }
    
    if (avg_loss == 0) return 100.0;
    double rs = avg_gain / avg_loss;
    return 100.0 - (100.0 / (1.0 + rs));
}

std::pair<double, double> LearningEngine::calculate_macd(const std::vector<double>& prices, 
                                                          int fast, int slow, int signal) const {
    if (prices.size() < static_cast<size_t>(slow + signal)) return {0.0, 0.0};
    
    double fast_ema = calculate_ema(prices, fast);
    double slow_ema = calculate_ema(prices, slow);
    double macd_line = fast_ema - slow_ema;
    
    // Calculate signal line (EMA of MACD line)
    std::vector<double> macd_values;
    for (size_t i = slow; i <= prices.size(); i++) {
        std::vector<double> subset(prices.begin(), prices.begin() + i);
        double f = calculate_ema(subset, fast);
        double s = calculate_ema(subset, slow);
        macd_values.push_back(f - s);
    }
    
    double signal_line = calculate_ema(macd_values, signal);
    double histogram = macd_line - signal_line;
    
    return {histogram, signal_line};
}

std::tuple<double, double, double> LearningEngine::calculate_bollinger_bands(
    const std::vector<double>& prices, int period, double std_multiplier) const {
    if (prices.size() < static_cast<size_t>(period)) {
        double price = prices.empty() ? 0.0 : prices.back();
        return {price, price, price};
    }
    
    double sma = calculate_sma(prices, period);
    
    // Calculate standard deviation
    double sum_sq = 0.0;
    for (int i = prices.size() - period; i < static_cast<int>(prices.size()); i++) {
        double diff = prices[i] - sma;
        sum_sq += diff * diff;
    }
    double std_dev = std::sqrt(sum_sq / period);
    
    double upper = sma + (std_multiplier * std_dev);
    double lower = sma - (std_multiplier * std_dev);
    
    return {upper, sma, lower};
}

double LearningEngine::calculate_atr(const std::vector<double>& highs, 
                                      const std::vector<double>& lows,
                                      const std::vector<double>& closes, int period) const {
    if (highs.size() < static_cast<size_t>(period) || 
        lows.size() < static_cast<size_t>(period) || 
        closes.size() < static_cast<size_t>(period)) return 0.0;
    
    std::vector<double> true_ranges;
    for (size_t i = 1; i < closes.size(); i++) {
        double tr1 = highs[i] - lows[i];
        double tr2 = std::abs(highs[i] - closes[i - 1]);
        double tr3 = std::abs(lows[i] - closes[i - 1]);
        true_ranges.push_back(std::max({tr1, tr2, tr3}));
    }
    
    return calculate_sma(true_ranges, period);
}

LearningEngine::TechnicalSignals LearningEngine::calculate_signals(
    const std::vector<double>& prices,
    const std::vector<double>& volumes,
    double current_bid, double current_ask) const {
    
    TechnicalSignals signals;
    
    if (prices.size() < 20) return signals;  // Not enough data
    
    // RSI
    signals.rsi = calculate_rsi(prices, 14);
    
    // MACD
    auto [macd_hist, macd_sig] = calculate_macd(prices, 12, 26, 9);
    signals.macd_histogram = macd_hist;
    signals.macd_signal = macd_sig;
    
    // Bollinger Bands position
    auto [upper, middle, lower] = calculate_bollinger_bands(prices, 20, 2.0);
    double current_price = prices.back();
    if (upper != lower) {
        signals.bb_position = (current_price - lower) / (upper - lower);
    }
    
    // Volume ratio (current vs 20-period average)
    if (volumes.size() >= 20) {
        double avg_vol = calculate_sma(volumes, 20);
        signals.volume_ratio = avg_vol > 0 ? volumes.back() / avg_vol : 1.0;
    }
    
    // Order flow imbalance (bid-ask spread analysis)
    double mid = (current_bid + current_ask) / 2;
    double spread = current_ask - current_bid;
    if (mid > 0 && spread > 0) {
        // If current price is closer to ask, buyers are more aggressive
        signals.order_flow_imbalance = (current_price - current_bid) / spread * 2 - 1;
    }
    
    // Momentum score: combine RSI, MACD, and BB position
    double rsi_score = (signals.rsi - 50) / 50;  // -1 to 1
    double macd_score = signals.macd_histogram > 0 ? 0.5 : -0.5;
    double bb_score = (signals.bb_position - 0.5) * 2;  // -1 to 1
    signals.momentum_score = (rsi_score * 0.4) + (macd_score * 0.3) + (bb_score * 0.3);
    
    // Market regime detection
    double sma20 = calculate_sma(prices, 20);
    double sma50 = prices.size() >= 50 ? calculate_sma(prices, 50) : sma20;
    double price_vs_sma = (current_price - sma20) / sma20 * 100;
    
    if (sma20 > sma50 && price_vs_sma > 1.0) {
        signals.market_regime = 1;  // Uptrend
    } else if (sma20 < sma50 && price_vs_sma < -1.0) {
        signals.market_regime = -1;  // Downtrend
    } else {
        signals.market_regime = 0;  // Consolidation
    }
    
    // Composite score
    signals.composite_score = (signals.momentum_score + signals.order_flow_imbalance) / 2;
    signals.composite_score = std::max(-1.0, std::min(1.0, signals.composite_score));
    
    return signals;
}

json LearningEngine::analyze_indicator_effectiveness() const {
    json results;
    
    if (trade_history.size() < 10) {
        results["error"] = "Need at least 10 trades for indicator analysis";
        return results;
    }
    
    // Analyze which indicator values correlate with wins
    struct IndicatorBucket {
        int count = 0;
        int wins = 0;
        double avg_pnl = 0;
    };
    
    // RSI buckets: oversold (0-30), neutral (30-70), overbought (70-100)
    std::map<std::string, IndicatorBucket> rsi_buckets = {
        {"oversold", {}}, {"neutral", {}}, {"overbought", {}}
    };
    
    // MACD buckets: negative, positive
    std::map<std::string, IndicatorBucket> macd_buckets = {
        {"negative", {}}, {"positive", {}}
    };
    
    // BB position buckets: near_lower, middle, near_upper
    std::map<std::string, IndicatorBucket> bb_buckets = {
        {"near_lower", {}}, {"middle", {}}, {"near_upper", {}}
    };
    
    for (const auto& trade : trade_history) {
        // RSI analysis
        std::string rsi_bucket = trade.rsi < 30 ? "oversold" : 
                                  (trade.rsi > 70 ? "overbought" : "neutral");
        rsi_buckets[rsi_bucket].count++;
        if (trade.is_win()) rsi_buckets[rsi_bucket].wins++;
        rsi_buckets[rsi_bucket].avg_pnl += trade.pnl;
        
        // MACD analysis
        std::string macd_bucket = trade.macd_histogram > 0 ? "positive" : "negative";
        macd_buckets[macd_bucket].count++;
        if (trade.is_win()) macd_buckets[macd_bucket].wins++;
        macd_buckets[macd_bucket].avg_pnl += trade.pnl;
        
        // BB analysis
        std::string bb_bucket = trade.bb_position < 0.3 ? "near_lower" :
                                (trade.bb_position > 0.7 ? "near_upper" : "middle");
        bb_buckets[bb_bucket].count++;
        if (trade.is_win()) bb_buckets[bb_bucket].wins++;
        bb_buckets[bb_bucket].avg_pnl += trade.pnl;
    }
    
    // Build results
    json rsi_results;
    for (auto& [bucket, data] : rsi_buckets) {
        if (data.count > 0) {
            rsi_results[bucket]["count"] = data.count;
            rsi_results[bucket]["win_rate"] = (double)data.wins / data.count * 100;
            rsi_results[bucket]["avg_pnl"] = data.avg_pnl / data.count;
        }
    }
    results["rsi"] = rsi_results;
    
    json macd_results;
    for (auto& [bucket, data] : macd_buckets) {
        if (data.count > 0) {
            macd_results[bucket]["count"] = data.count;
            macd_results[bucket]["win_rate"] = (double)data.wins / data.count * 100;
            macd_results[bucket]["avg_pnl"] = data.avg_pnl / data.count;
        }
    }
    results["macd"] = macd_results;
    
    json bb_results;
    for (auto& [bucket, data] : bb_buckets) {
        if (data.count > 0) {
            bb_results[bucket]["count"] = data.count;
            bb_results[bucket]["win_rate"] = (double)data.wins / data.count * 100;
            bb_results[bucket]["avg_pnl"] = data.avg_pnl / data.count;
        }
    }
    results["bollinger_bands"] = bb_results;
    
    return results;
}

void LearningEngine::analyze_indicator_patterns() {
    std::cout << "\n📊 INDICATOR EFFECTIVENESS ANALYSIS:" << std::endl;
    
    auto results = analyze_indicator_effectiveness();
    
    if (results.contains("error")) {
        std::cout << "  ⏳ " << results["error"].get<std::string>() << std::endl;
        return;
    }
    
    // RSI
    if (results.contains("rsi")) {
        std::cout << "  RSI:" << std::endl;
        for (auto& [bucket, data] : results["rsi"].items()) {
            if (data.contains("count") && data["count"].get<int>() > 0) {
                std::cout << "    " << bucket << ": " 
                          << data["count"] << " trades, "
                          << std::fixed << std::setprecision(1) 
                          << data["win_rate"].get<double>() << "% WR, "
                          << "$" << std::setprecision(2) << data["avg_pnl"].get<double>() << " avg"
                          << std::endl;
            }
        }
    }
    
    // MACD
    if (results.contains("macd")) {
        std::cout << "  MACD:" << std::endl;
        for (auto& [bucket, data] : results["macd"].items()) {
            if (data.contains("count") && data["count"].get<int>() > 0) {
                std::cout << "    " << bucket << ": " 
                          << data["count"] << " trades, "
                          << std::fixed << std::setprecision(1) 
                          << data["win_rate"].get<double>() << "% WR, "
                          << "$" << std::setprecision(2) << data["avg_pnl"].get<double>() << " avg"
                          << std::endl;
            }
        }
    }
    
    // Bollinger Bands
    if (results.contains("bollinger_bands")) {
        std::cout << "  Bollinger Bands:" << std::endl;
        for (auto& [bucket, data] : results["bollinger_bands"].items()) {
            if (data.contains("count") && data["count"].get<int>() > 0) {
                std::cout << "    " << bucket << ": " 
                          << data["count"] << " trades, "
                          << std::fixed << std::setprecision(1) 
                          << data["win_rate"].get<double>() << "% WR, "
                          << "$" << std::setprecision(2) << data["avg_pnl"].get<double>() << " avg"
                          << std::endl;
            }
        }
    }
}

// NEW: Real-time market data interface implementations

void LearningEngine::update_market_data(const MarketDataPoint& data) {
    std::lock_guard<std::mutex> lock(market_data_mutex);
    
    // Update latest data
    latest_market_data[data.pair] = data;
    
    // Add to historical data
    real_time_market_data[data.pair].push_back(data);
    
    // Maintain size limit
    if (real_time_market_data[data.pair].size() > MAX_MARKET_DATA_SIZE) {
        real_time_market_data[data.pair].pop_front();
    }
    
    // Update price history for indicators
    price_history[data.pair].push_back(data.last_price);
    volume_history[data.pair].push_back(data.volume);
    
    if (price_history[data.pair].size() > MAX_HISTORY_SIZE) {
        price_history[data.pair].pop_front();
        volume_history[data.pair].pop_front();
    }
}

LearningEngine::MarketDataPoint LearningEngine::get_latest_market_data(const std::string& pair) const {
    std::lock_guard<std::mutex> lock(market_data_mutex);
    
    auto it = latest_market_data.find(pair);
    if (it != latest_market_data.end()) {
        return it->second;
    }
    
    // Return empty data point if not found
    return MarketDataPoint{pair, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0, 0};
}

std::vector<LearningEngine::MarketDataPoint> LearningEngine::get_recent_market_data(const std::string& pair, int minutes) const {
    std::lock_guard<std::mutex> lock(market_data_mutex);
    
    auto it = real_time_market_data.find(pair);
    if (it == real_time_market_data.end()) {
        return {};
    }
    
    const auto& data = it->second;
    int64_t cutoff_time = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count() - (minutes * 60 * 1000);
    
    std::vector<MarketDataPoint> recent_data;
    for (const auto& point : data) {
        if (point.timestamp > cutoff_time) {
            recent_data.push_back(point);
        }
    }
    
    return recent_data;
}

void LearningEngine::adapt_strategies_to_market_conditions() {
    // Analyze current market conditions and update strategy parameters
    for (auto& [pair, data] : latest_market_data) {
        double current_volatility = calculate_real_time_volatility(pair);
        int current_regime = detect_real_time_regime(pair);
        
        // Adjust strategy parameters based on market conditions
        auto pattern_key = pair + "_adaptive";
        auto it = pattern_database.find(pattern_key);
        if (it != pattern_database.end()) {
            auto& metrics = it->second;
            
            // Adjust take profit based on volatility
            if (current_volatility > 2.0) {
                // High volatility - tighter TP
                metrics.total_pnl *= 0.95;  // Conservative adjustment
            } else if (current_volatility < 0.5) {
                // Low volatility - wider TP but longer hold time
                metrics.total_pnl *= 1.02;  // Slight optimism
            }
            
            // Adjust based on regime
            if (current_regime == 0) {  // Consolidation
                // Be more conservative in ranging markets
                metrics.win_rate *= 0.98;
            }
        }
    }
}

StrategyConfig LearningEngine::get_adaptive_strategy(const std::string& pair, const MarketDataPoint& current_data) {
    // Get base strategy
    StrategyConfig base_strategy = get_optimal_strategy(pair, current_data.volatility_pct);
    
    // Adapt based on real-time conditions
    double real_time_volatility = calculate_real_time_volatility(pair);
    int real_time_regime = detect_real_time_regime(pair);
    
    // Adjust take profit based on current volatility
    if (real_time_volatility > current_data.volatility_pct * 1.5) {
        // Market is more volatile than historical average - tighten TP
        base_strategy.take_profit_pct *= 0.8;
        base_strategy.stop_loss_pct *= 1.2;
    } else if (real_time_volatility < current_data.volatility_pct * 0.7) {
        // Market is less volatile - can afford wider TP
        base_strategy.take_profit_pct *= 1.1;
        base_strategy.timeframe_seconds *= 1.2;  // Longer hold time
    }
    
    // Adjust based on regime
    if (real_time_regime == 0) {  // Consolidation
        base_strategy.take_profit_pct *= 0.9;  // More conservative
        base_strategy.timeframe_seconds *= 0.8;  // Shorter hold time
    } else if (real_time_regime == 1) {  // Uptrend
        base_strategy.take_profit_pct *= 1.05;  // Slightly more aggressive
    }

    // If we have a direction model, use it to bias direction and leverage
    if (direction_model_loaded) {
        double score = score_direction_model(current_data);
        double prob = 1.0 / (1.0 + std::exp(-score));
        // If model strongly favors one direction, set a suggested leverage and mark validated
        if (prob > 0.6) {
            base_strategy.leverage = std::min(10.0, base_strategy.leverage * (1.0 + (prob - 0.6) * 2.0));
            base_strategy.is_validated = true;
            base_strategy.estimated_edge = (prob - 0.5) * 2.0 * 100.0; // percent estimate
        } else if (prob < 0.4) {
            // Strong short signal - also increase leverage but reversed direction will be handled by bot
            base_strategy.leverage = std::min(10.0, base_strategy.leverage * (1.0 + (0.4 - prob) * 2.0));
            base_strategy.is_validated = true;
            base_strategy.estimated_edge = (0.5 - prob) * 2.0 * 100.0;
        }
    }
    
    return base_strategy;
}

// Simple direction model scoring: returns score (logit). Positive => LONG, Negative => SHORT
double LearningEngine::score_direction_model(const MarketDataPoint& current_data) const {
    if (!direction_model_loaded) return 0.0;
    double s = direction_model_bias;
    auto addw = [&](const std::string& k, double v) {
        if (direction_model_weights.count(k)) s += direction_model_weights.at(k) * v;
    };
    addw("volatility_pct", current_data.volatility_pct);
    addw("market_regime", (double)current_data.market_regime);
    if (current_data.vwap > 0) {
        double vdev = (current_data.last_price - current_data.vwap) / current_data.vwap * 100.0;
        addw("vwap_dev", vdev);
    }
    addw("volume", current_data.volume);
    addw("last_price", current_data.last_price);
    addw("volatility_pct_sq", current_data.volatility_pct * current_data.volatility_pct);
    return s;
}

double LearningEngine::calculate_real_time_volatility(const std::string& pair) const {
    auto recent_data = get_recent_market_data(pair, 30);  // Last 30 minutes
    
    if (recent_data.size() < 10) {
        return 0.0;  // Not enough data
    }
    
    std::vector<double> returns;
    for (size_t i = 1; i < recent_data.size(); ++i) {
        double ret = (recent_data[i].last_price - recent_data[i-1].last_price) / recent_data[i-1].last_price;
        returns.push_back(std::abs(ret));  // Use absolute returns for volatility
    }
    
    if (returns.empty()) return 0.0;
    
    double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
    double variance = 0.0;
    for (double ret : returns) {
        variance += std::pow(ret - mean, 2);
    }
    variance /= returns.size();
    
    return std::sqrt(variance) * 100.0;  // Return as percentage
}

int LearningEngine::detect_real_time_regime(const std::string& pair) const {
    auto recent_data = get_recent_market_data(pair, 60);  // Last hour
    
    if (recent_data.size() < 20) {
        return 0;  // Not enough data, assume consolidation
    }
    
    // Simple regime detection based on trend and volatility
    double start_price = recent_data.front().last_price;
    double end_price = recent_data.back().last_price;
    double price_change = (end_price - start_price) / start_price * 100.0;
    
    double volatility = calculate_real_time_volatility(pair);
    
    if (std::abs(price_change) > volatility * 2) {
        return (price_change > 0) ? 1 : -1;  // Strong trend
    } else if (volatility > 1.0) {
        return 2;  // Volatile/consolidation
    } else {
        return 0;  // Quiet consolidation
    }
}

void LearningEngine::perform_continuous_learning() {
    // Load latest market data directly from SQLite database
    // Also attempt to reload direction model if updated by training script
    try {
        std::ifstream f("data/direction_model.json");
        if (f.good()) {
            nlohmann::json jm; f >> jm;
            if (jm.contains("weights")) {
                direction_model_weights.clear();
                for (auto it = jm["weights"].begin(); it != jm["weights"].end(); ++it) {
                    direction_model_weights[it.key()] = it.value().get<double>();
                }
                direction_model_bias = jm.value("bias", 0.0);
                direction_model_loaded = true;
                std::cout << "Reloaded direction model (continuous learning) with " << direction_model_weights.size() << " weights" << std::endl;
            }
        }
    } catch (...) {}
    load_market_data_from_sqlite();
    
    // Update market condition analysis
    adapt_strategies_to_market_conditions();
    
    // Analyze recent trades for patterns
    if (trade_history.size() >= MIN_TRADES_FOR_ANALYSIS) {
        analyze_patterns();
    }
    
    // Update strategy database with new insights
    update_strategy_database();
}

void LearningEngine::load_market_data_from_sqlite(const std::string& db_path) {
    sqlite3* market_db = nullptr;
    
    int rc = sqlite3_open(db_path.c_str(), &market_db);
    if (rc != SQLITE_OK) {
        std::cerr << "Warning: Could not open market data database: " << sqlite3_errmsg(market_db) << std::endl;
        return;
    }
    
    // Query for latest data for each pair (last 5 minutes)
    int64_t cutoff_time = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()
    ).count() - (5 * 60 * 1000); // 5 minutes ago
    
    const char* sql = R"(
        SELECT pair, ask, bid, last, volume, vwap, timestamp
        FROM ticker_data 
        WHERE timestamp > ?
        ORDER BY timestamp DESC
    )";
    
    sqlite3_stmt* stmt;
    rc = sqlite3_prepare_v2(market_db, sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to prepare market data query: " << sqlite3_errmsg(market_db) << std::endl;
        sqlite3_close(market_db);
        return;
    }
    
    sqlite3_bind_int64(stmt, 1, cutoff_time);
    
    std::lock_guard<std::mutex> lock(market_data_mutex);
    
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        std::string pair = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        double ask = sqlite3_column_double(stmt, 1);
        double bid = sqlite3_column_double(stmt, 2);
        double last = sqlite3_column_double(stmt, 3);
        double volume = sqlite3_column_double(stmt, 4);
        double vwap = sqlite3_column_double(stmt, 5);
        int64_t timestamp = sqlite3_column_int64(stmt, 6);
        
        MarketDataPoint point;
        point.pair = pair;
        point.ask_price = ask;
        point.bid_price = bid;
        point.last_price = last;
        point.volume = volume;
        point.vwap = vwap;
        point.timestamp = timestamp;
        point.volatility_pct = 0.0; // Will be calculated
        point.market_regime = 0;    // Will be detected
        
        // Update latest data
        latest_market_data[pair] = point;
        
        // Add to historical data if not already there
        if (real_time_market_data[pair].empty() || 
            real_time_market_data[pair].back().timestamp != timestamp) {
            real_time_market_data[pair].push_back(point);
            
            // Maintain size limit
            if (real_time_market_data[pair].size() > MAX_MARKET_DATA_SIZE) {
                real_time_market_data[pair].pop_front();
            }
        }
        
        // Update price history for indicators
        price_history[pair].push_back(last);
        volume_history[pair].push_back(volume);
        
        if (price_history[pair].size() > MAX_HISTORY_SIZE) {
            price_history[pair].pop_front();
            volume_history[pair].pop_front();
        }
    }
    
    sqlite3_finalize(stmt);
    sqlite3_close(market_db);
}

void LearningEngine::load_market_data_from_cache(const std::string& cache_file) {
    // Backwards-compatible: if JSON cache exists, load from it; otherwise fall back to SQLite
    const std::string json_file = cache_file.empty() ? std::string("../../data/market_data.json") : cache_file;
    try {
        std::ifstream f(json_file);
        if (f.good()) {
            nlohmann::json j; f >> j;
            if (j.contains("data") && j["data"].is_array()) {
                std::lock_guard<std::mutex> lock(market_data_mutex);
                for (const auto& item : j["data"]) {
                    MarketDataPoint md;
                    md.pair = item.value("pair", std::string());
                    md.last_price = item.value("last_price", 0.0);
                    md.volume = item.value("volume", 0.0);
                    md.vwap = item.value("vwap", 0.0);
                    md.timestamp = item.value("timestamp", 0);
                    md.volatility_pct = item.value("volatility_pct", 0.0);
                    latest_market_data[md.pair] = md;
                    auto& dq = real_time_market_data[md.pair];
                    dq.push_back(md);
                    if (dq.size() > MAX_MARKET_DATA_SIZE) dq.pop_front();
                }
                std::cout << "Loaded market data cache for " << latest_market_data.size() << " pairs from " << json_file << std::endl;
                return;
            }
        }
    } catch (...) {}
    // Fallback to SQLite loader
    load_market_data_from_sqlite();
}
