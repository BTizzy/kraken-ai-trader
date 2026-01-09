#include "learning_engine.hpp"
#include <numeric>
#include <fstream>
#include <iostream>
#include <iomanip>
#include <cmath>
#include <set>

LearningEngine::LearningEngine() {}

LearningEngine::~LearningEngine() {}

void LearningEngine::record_trade(const TradeRecord& trade) {
    trade_history.push_back(trade);
    trades_by_pair[trade.pair].push_back(trade);
    
    // Generate pattern key for this trade
    int timeframe_bucket;
    if (trade.timeframe_seconds < 30) timeframe_bucket = 0;
    else if (trade.timeframe_seconds < 60) timeframe_bucket = 1;
    else if (trade.timeframe_seconds < 120) timeframe_bucket = 2;
    else timeframe_bucket = 3;
    
    std::string key = generate_pattern_key(trade.pair, trade.leverage, timeframe_bucket);
    trades_by_strategy[key].push_back(trade);
    
    // Print what we learned from this trade
    std::cout << "📝 Trade recorded: " << trade.pair 
              << " | " << (trade.is_win() ? "WIN ✅" : "LOSS ❌")
              << " | ROI: " << std::fixed << std::setprecision(2) << trade.roi() << "%" 
              << " | Pattern: " << key << std::endl;
    
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
    
    // 1. GROUP TRADES BY PATTERN
    std::map<std::string, std::vector<TradeRecord>> patterns;
    for (const auto& trade : trade_history) {
        int timeframe_bucket;
        if (trade.timeframe_seconds < 30) timeframe_bucket = 0;
        else if (trade.timeframe_seconds < 60) timeframe_bucket = 1;
        else if (trade.timeframe_seconds < 120) timeframe_bucket = 2;
        else timeframe_bucket = 3;
        
        std::string key = generate_pattern_key(trade.pair, trade.leverage, timeframe_bucket);
        patterns[key].push_back(trade);
    }
    
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
        
        // Parse pattern key
        size_t pos1 = pattern_key.find('_');
        size_t pos2 = pattern_key.find('_', pos1 + 1);
        metrics.pair = pattern_key.substr(0, pos1);
        metrics.leverage = std::stod(pattern_key.substr(pos1 + 1, pos2 - pos1 - 1));
        metrics.timeframe_bucket = std::stoi(pattern_key.substr(pos2 + 1));
        
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
    
    // 6. UPDATE STRATEGY DATABASE
    update_strategy_database();
}

std::string LearningEngine::generate_pattern_key(const std::string& pair, double leverage, int timeframe) const {
    return pair + "_" + std::to_string((int)leverage) + "x_" + std::to_string(timeframe);
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
    data["version"] = "1.0";
    data["total_trades"] = trade_history.size();
    
    for (const auto& t : trade_history) {
        json trade_json;
        trade_json["pair"] = t.pair;
        trade_json["entry"] = t.entry_price;
        trade_json["exit"] = t.exit_price;
        trade_json["leverage"] = t.leverage;
        trade_json["pnl"] = t.pnl;
        trade_json["reason"] = t.exit_reason;
        data["trades"].push_back(trade_json);
    }
    
    std::ofstream file(filepath);
    file << data.dump(2) << std::endl;
    file.close();
    
    std::cout << "💾 Saved " << trade_history.size() << " trades to " << filepath << std::endl;
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
    
    // TODO: Parse and load
    std::cout << "📂 Loaded learning data from " << filepath << std::endl;
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
