#include <iostream>
#include <memory>
#include <thread>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include <future>
#include <vector>
#include <mutex>
#include <iomanip>
#include <set>
#include <map>
#include "kraken_api.hpp"
#include "learning_engine.hpp"

using namespace std::chrono_literals;

struct PerformanceMetrics {
    double total_pnl = 0.0;
    double total_trades = 0;
    double winning_trades = 0;
    double losing_trades = 0;
    double win_rate = 0.0;
    double avg_win = 0.0;
    double avg_loss = 0.0;
    double sharpe_ratio = 0.0;
    double max_drawdown = 0.0;
    double current_drawdown = 0.0;
    double peak_pnl = 0.0;
    std::vector<double> pnl_history;
    std::chrono::system_clock::time_point last_update;

    void update_trade(double pnl) {
        total_pnl += pnl;
        total_trades++;
        pnl_history.push_back(pnl);

        if (pnl > 0) {
            winning_trades++;
            avg_win = ((avg_win * (winning_trades - 1)) + pnl) / winning_trades;
        } else {
            losing_trades++;
            avg_loss = ((avg_loss * (losing_trades - 1)) + pnl) / losing_trades;
        }

        win_rate = winning_trades / total_trades;

        // Update drawdown
        if (total_pnl > peak_pnl) {
            peak_pnl = total_pnl;
            current_drawdown = 0.0;
        } else {
            current_drawdown = peak_pnl - total_pnl;
            max_drawdown = std::max(max_drawdown, current_drawdown);
        }

        // Calculate Sharpe ratio (simplified)
        if (pnl_history.size() > 1) {
            double mean_return = total_pnl / total_trades;
            double variance = 0.0;
            for (double p : pnl_history) {
                variance += (p - mean_return) * (p - mean_return);
            }
            variance /= (total_trades - 1);
            double std_dev = std::sqrt(variance);
            sharpe_ratio = (mean_return / std_dev) * std::sqrt(365); // Annualized
        }

        last_update = std::chrono::system_clock::now();
    }

    void print_summary() {
        std::cout << "\n📊 PERFORMANCE SUMMARY:" << std::endl;
        std::cout << "  Total P&L: $" << std::fixed << std::setprecision(2) << total_pnl << std::endl;
        std::cout << "  Total Trades: " << (int)total_trades << std::endl;
        std::cout << "  Win Rate: " << std::fixed << std::setprecision(1) << (win_rate * 100) << "%" << std::endl;
        std::cout << "  Avg Win: $" << avg_win << " | Avg Loss: $" << avg_loss << std::endl;
        std::cout << "  Sharpe Ratio: " << sharpe_ratio << std::endl;
        std::cout << "  Max Drawdown: $" << max_drawdown << std::endl;
    }
};

struct BotConfig {
    bool paper_trading = true;
    bool enable_learning = true;
    int learning_cycle_trades = 25;  // Analyze every 25 trades
    std::string strategy_file = "strategies.json";
    std::string trade_log_file = "trade_log.json";
    int max_concurrent_trades = 3; // Reduced for quality over quantity
    double target_leverage = 1.5;  // Conservative leverage
    double position_size_usd = 100;
    double min_momentum_threshold = 0.003; // 0.3% minimum momentum to enter
    double take_profit_pct = 0.015;  // 1.5% take profit
    double stop_loss_pct = 0.008;    // 0.8% stop loss (better risk:reward)
    int min_timeframe_seconds = 60;  // Minimum 60 seconds for price to move
    int max_timeframe_seconds = 300; // Maximum 5 minutes
    double min_volatility = 1.5;     // Need 1.5%+ 24h volatility
    double max_spread_pct = 0.3;     // Max 0.3% spread
    std::set<std::string> blacklisted_pairs;  // Pairs that consistently lose
};

struct ScanResult {
    std::string pair;
    double volatility = 0.0;
    double spread = 0.0;
    double trend_strength = 0.0;
    double volume_score = 0.0;
    double momentum = 0.0;         // Short-term price momentum
    double momentum_5m = 0.0;      // 5-minute momentum
    bool is_bullish = false;       // Direction bias
    StrategyConfig strategy;
    bool valid = false;
};

class KrakenTradingBot {
public:
    KrakenTradingBot(const BotConfig& config) : config(config) {
        api = std::make_unique<KrakenAPI>(config.paper_trading);
        learning_engine = std::make_unique<LearningEngine>();
        
        // Try to load previous learning data
        learning_engine->load_from_file(config.trade_log_file);
        
        std::cout << "\n🤖 KRAKEN TRADING BOT v1.0 (C++)" << std::endl;
        std::cout << "Mode: " << (config.paper_trading ? "PAPER TRADING" : "LIVE TRADING") << std::endl;
        std::cout << "Learning enabled: " << (config.enable_learning ? "YES" : "NO") << std::endl;
        std::cout << "Max concurrent trades: " << config.max_concurrent_trades << std::endl;
        std::cout << "=================================\n" << std::endl;
    }
    
    ~KrakenTradingBot() {
        if (learning_engine) {
            learning_engine->print_summary();
            learning_engine->save_to_file(config.trade_log_file);
        }
        performance.print_summary();
    }
    
    void run() {
        std::cout << "📊 Authenticating with Kraken..." << std::endl;
        if (!api->authenticate()) {
            std::cerr << "❌ Authentication failed. Check KRAKEN_API_KEY and KRAKEN_API_SECRET." << std::endl;
            return;
        }
        std::cout << "✅ Authenticated successfully" << std::endl;
        
        // Get available pairs
        auto pairs = api->get_trading_pairs();
        std::cout << "\n📈 Available trading pairs: " << pairs.size() << std::endl;
        
        // Filter to USD pairs only
        std::vector<std::string> usd_pairs;
        for (const auto& pair : pairs) {
            if (pair.find("USD") != std::string::npos && pair.find("USD") == pair.length() - 3) {
                usd_pairs.push_back(pair);
            }
        }
        
        std::cout << "💰 USD pairs: " << usd_pairs.size() << std::endl;
        
        // Performance tracking
        int trade_count = 0;
        auto start_time = std::chrono::system_clock::now();
        
        std::cout << "\n🚀 STARTING TRADING LOOP..." << std::endl;
        std::cout << std::string(50, '=') << std::endl;
        
        while (true) {
            try {
                auto cycle_start = std::chrono::system_clock::now();
                std::cout << "\n🔍 Scanning " << usd_pairs.size() << " pairs..." << std::endl;
                std::vector<std::future<ScanResult>> futures;
                for (const auto& pair : usd_pairs) {
                    futures.push_back(std::async(std::launch::async, [this, pair]() { return scan_single_pair(pair); }));
                }
                std::vector<ScanResult> scan_results;
                for (auto& future : futures) {
                    ScanResult result = future.get();
                    if (result.valid) {
                        scan_results.push_back(result);
                    }
                }
                std::cout << "✅ Found " << scan_results.size() << " valid opportunities" << std::endl;
                if (!scan_results.empty()) {
                    // Sort by a composite score: momentum * volume * (1/spread)
                    std::sort(scan_results.begin(), scan_results.end(), [](const ScanResult& a, const ScanResult& b) {
                        double score_a = std::abs(a.momentum) * a.volume_score * (1.0 / (a.spread + 0.01));
                        double score_b = std::abs(b.momentum) * b.volume_score * (1.0 / (b.spread + 0.01));
                        return score_a > score_b;
                    });
                    // Take up to max_concurrent_trades best opportunities
                    int num_trades = std::min(config.max_concurrent_trades, (int)scan_results.size());
                    std::vector<std::thread> trade_threads;
                    for (int i = 0; i < num_trades; ++i) {
                        const auto& best_result = scan_results[i];
                        trade_threads.emplace_back([this, best_result]() {
                            execute_trade_with_tpsl(best_result);
                        });
                    }
                    for (auto& th : trade_threads) th.join();
                    
                    // After all trades complete, check if we should trigger learning analysis
                    {
                        std::lock_guard<std::mutex> lock(learning_mutex);
                        if (trade_count > 0 && trade_count % 25 == 0) {
                            std::cout << "\n🎓 TRIGGERING LEARNING ANALYSIS..." << std::endl;
                            learning_engine->analyze_patterns();
                            learning_engine->print_summary();
                            learning_engine->save_to_file(config.trade_log_file);
                        }
                    }
                }
                
                {
                    std::lock_guard<std::mutex> lock(performance_mutex);
                    if (performance.total_trades > 0 && (int)performance.total_trades % 10 == 0) {
                    std::cout << "\n📊 PERFORMANCE UPDATE (" << performance.total_trades << " trades):" << std::endl;
                    performance.print_summary();
                    auto runtime = std::chrono::duration_cast<std::chrono::hours>(std::chrono::system_clock::now() - start_time).count();
                    std::cout << "  Runtime: " << runtime << " hours" << std::endl;
                    std::cout << "  Trades per hour: " << std::fixed << std::setprecision(1) << (double)performance.total_trades / std::max(1.0, (double)runtime) << std::endl;
                    }
                }
                {
                    std::lock_guard<std::mutex> lock(performance_mutex);
                    if (performance.total_trades >= 5 && (int)performance.total_trades % 5 == 0) {
                    std::cout << "\n🔧 PARAMETER ADJUSTMENT:" << std::endl;
                    std::cout << "  Position Size: $" << config.position_size_usd << std::endl;
                    std::cout << "  Target Leverage: " << config.target_leverage << "x" << std::endl;
                    std::cout << "  Win Rate: " << std::fixed << std::setprecision(1) << (performance.win_rate * 100) << "%" << std::endl;
                    std::cout << "  Sharpe Ratio: " << performance.sharpe_ratio << std::endl;
                    }
                }
                auto cycle_time = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now() - cycle_start).count();
                int sleep_time = std::max(0, 10 - (int)cycle_time); // Short sleep for rapid testing
                if (sleep_time > 0) {
                    std::cout << "⏱️  Sleeping " << sleep_time << " seconds..." << std::endl;
                    std::this_thread::sleep_for(std::chrono::seconds(sleep_time));
                }
            } catch (const std::exception& e) {
                std::cerr << "❌ Trading loop error: " << e.what() << std::endl;
                std::this_thread::sleep_for(5s);
            }
        }
    }
    
    // One-click live deployment
    bool deploy_live() {
        std::cout << "\n⚠️  ONE-CLICK LIVE DEPLOYMENT" << std::endl;
        std::cout << std::string(50, '=') << std::endl;
        std::cout << "This will switch from PAPER to LIVE TRADING." << std::endl;
        std::cout << "Your Kraken API keys from environment variables will be used." << std::endl;
        std::cout << "\n❓ Type 'YES' to deploy: ";
        
        std::string response;
        std::getline(std::cin, response);
        
        if (response != "YES") {
            std::cout << "❌ Deployment cancelled" << std::endl;
            return false;
        }
        
        config.paper_trading = false;
        api->set_paper_mode(false);
        
        std::cout << "✅ DEPLOYED TO LIVE TRADING" << std::endl;
        std::cout << "⚠️  Real money is now at risk!" << std::endl;
        std::cout << std::string(50, '=') << std::endl;
        
        return true;
    }
    
private:
    BotConfig config;
    std::unique_ptr<KrakenAPI> api;
    std::unique_ptr<LearningEngine> learning_engine;
    PerformanceMetrics performance;
    std::mutex performance_mutex;  // Protect shared state from concurrent updates
    std::mutex learning_mutex;     // Protect learning engine from concurrent updates
    int trade_count = 0;           // Track total trades for this session
    std::map<std::string, int> pair_loss_streak;  // Track consecutive losses per pair
    
    // Execute trade with proper take-profit and stop-loss monitoring
    void execute_trade_with_tpsl(const ScanResult& scan_result) {
        auto pair = scan_result.pair;
        auto strategy = scan_result.strategy;
        auto volatility = scan_result.volatility;
        bool is_long = scan_result.is_bullish;
        
        std::cout << "\n🎯 TRADING: " << pair << (is_long ? " (LONG)" : " (SHORT)") << std::endl;
        std::cout << "  Volatility: " << std::fixed << std::setprecision(2) << volatility << "%" << std::endl;
        std::cout << "  Momentum: " << std::fixed << std::setprecision(3) << scan_result.momentum << std::endl;
        std::cout << "  Spread: " << std::fixed << std::setprecision(3) << scan_result.spread << "%" << std::endl;
        std::cout << "  Strategy: " << std::fixed << std::setprecision(1) << strategy.leverage << "x leverage" << std::endl;
        std::cout << "  Take Profit: " << std::fixed << std::setprecision(2) << (strategy.take_profit_pct * 100) << "%" << std::endl;
        std::cout << "  Stop Loss: " << std::fixed << std::setprecision(2) << (strategy.stop_loss_pct * 100) << "%" << std::endl;
        std::cout << "  Max Hold: " << strategy.timeframe_seconds << "s" << std::endl;
        
        try {
            // Get entry price
            auto ticker = api->get_ticker(pair);
            double entry_price = std::stod(std::string(ticker["c"][0]));
            auto entry_time = std::chrono::system_clock::now();
            
            std::cout << "\n💹 ENTERING TRADE..." << std::endl;
            std::cout << "  Entry Price: $" << std::fixed << std::setprecision(6) << entry_price << std::endl;
            std::cout << "  Position Size: $" << std::setprecision(2) << strategy.position_size_usd << std::endl;
            
            // Calculate position
            double position_size_base = strategy.position_size_usd / entry_price;
            double volume = position_size_base * strategy.leverage;
            
            // Calculate take-profit and stop-loss prices
            double tp_price, sl_price;
            if (is_long) {
                tp_price = entry_price * (1.0 + strategy.take_profit_pct);
                sl_price = entry_price * (1.0 - strategy.stop_loss_pct);
            } else {
                tp_price = entry_price * (1.0 - strategy.take_profit_pct);
                sl_price = entry_price * (1.0 + strategy.stop_loss_pct);
            }
            
            std::cout << "  Take Profit @ $" << std::fixed << std::setprecision(6) << tp_price << std::endl;
            std::cout << "  Stop Loss @ $" << std::fixed << std::setprecision(6) << sl_price << std::endl;
            
            // Place entry order
            double limit_price = is_long ? entry_price * 1.001 : entry_price * 0.999;
            auto order = api->place_limit_order(pair, is_long ? "buy" : "sell", volume, limit_price);
            
            if (order.order_id.empty()) {
                std::cout << "  ❌ Order failed to place" << std::endl;
                return;
            }
            
            std::cout << "  ✅ Order placed: " << order.order_id << std::endl;
            
            // Monitor position with TP/SL
            std::string exit_reason = "timeout";
            double exit_price = entry_price;
            int check_interval = 2;  // Check every 2 seconds
            int elapsed = 0;
            
            while (elapsed < strategy.timeframe_seconds) {
                std::this_thread::sleep_for(std::chrono::seconds(check_interval));
                elapsed += check_interval;
                
                try {
                    auto current_ticker = api->get_ticker(pair);
                    double current_price = std::stod(std::string(current_ticker["c"][0]));
                    
                    // Calculate current P&L %
                    double pnl_pct = is_long ? 
                        (current_price - entry_price) / entry_price * 100 :
                        (entry_price - current_price) / entry_price * 100;
                    
                    // Print progress every 10 seconds
                    if (elapsed % 10 == 0) {
                        std::cout << "    " << elapsed << "s | Price: $" << std::fixed << std::setprecision(6) 
                                  << current_price << " | P&L: " << std::setprecision(2) << pnl_pct << "%" << std::endl;
                    }
                    
                    // Check take-profit
                    if ((is_long && current_price >= tp_price) || (!is_long && current_price <= tp_price)) {
                        exit_price = current_price;
                        exit_reason = "take_profit";
                        std::cout << "  🎉 TAKE PROFIT HIT!" << std::endl;
                        break;
                    }
                    
                    // Check stop-loss
                    if ((is_long && current_price <= sl_price) || (!is_long && current_price >= sl_price)) {
                        exit_price = current_price;
                        exit_reason = "stop_loss";
                        std::cout << "  ⚠️ STOP LOSS HIT!" << std::endl;
                        break;
                    }
                    
                    // Trailing stop: if we're up more than 0.5%, move stop to breakeven
                    if (pnl_pct > 0.5) {
                        double new_sl = is_long ? 
                            std::max(sl_price, entry_price * 1.001) : 
                            std::min(sl_price, entry_price * 0.999);
                        if ((is_long && new_sl > sl_price) || (!is_long && new_sl < sl_price)) {
                            sl_price = new_sl;
                            std::cout << "    📈 Trailing stop moved to breakeven" << std::endl;
                        }
                    }
                    
                    exit_price = current_price;  // Update exit price for timeout case
                    
                } catch (...) {
                    // If we can't get price, wait and try again
                }
            }
            
            // Calculate final P&L
            double gross_pnl = is_long ?
                (exit_price - entry_price) * position_size_base * strategy.leverage :
                (entry_price - exit_price) * position_size_base * strategy.leverage;
            
            double fees = strategy.position_size_usd * 0.004;  // 0.4% round-trip
            double net_pnl = gross_pnl - fees;
            
            std::cout << "\n📊 TRADE RESULT:" << std::endl;
            std::cout << "  Exit Reason: " << exit_reason << std::endl;
            std::cout << "  Entry: $" << std::fixed << std::setprecision(6) << entry_price << std::endl;
            std::cout << "  Exit: $" << exit_price << std::endl;
            std::cout << "  Gross P&L: $" << std::setprecision(2) << gross_pnl << std::endl;
            std::cout << "  Fees: $" << fees << std::endl;
            std::cout << "  Net P&L: $" << net_pnl << (net_pnl > 0 ? " ✅" : " ❌") << std::endl;
            
            // Record trade
            TradeRecord trade;
            trade.pair = pair;
            trade.entry_price = entry_price;
            trade.exit_price = exit_price;
            trade.leverage = strategy.leverage;
            trade.position_size = strategy.position_size_usd;
            trade.pnl = net_pnl;
            trade.gross_pnl = gross_pnl;
            trade.fees_paid = fees;
            trade.timestamp = entry_time;
            trade.exit_reason = exit_reason;
            trade.timeframe_seconds = elapsed;
            trade.volatility_at_entry = volatility;
            trade.bid_ask_spread = scan_result.spread;
            trade.trend_direction = is_long ? 1.0 : -1.0;
            
            // Thread-safe updates
            {
                std::lock_guard<std::mutex> lock(learning_mutex);
                learning_engine->record_trade(trade);
                
                // Track loss streaks for blacklisting
                if (net_pnl < 0) {
                    pair_loss_streak[pair]++;
                    if (pair_loss_streak[pair] >= 5) {
                        config.blacklisted_pairs.insert(pair);
                        std::cout << "  🚫 " << pair << " BLACKLISTED (5 consecutive losses)" << std::endl;
                    }
                } else {
                    pair_loss_streak[pair] = 0;  // Reset on win
                }
            }
            
            {
                std::lock_guard<std::mutex> lock(performance_mutex);
                performance.update_trade(net_pnl);
                trade_count++;
                
                std::cout << "\n🧠 LEARNING UPDATE:" << std::endl;
                std::cout << "  Total Trades: " << trade_count << std::endl;
                std::cout << "  Win Rate: " << std::fixed << std::setprecision(1) << (performance.win_rate * 100) << "%" << std::endl;
                std::cout << "  Total P&L: $" << std::setprecision(2) << performance.total_pnl << std::endl;
                
                adjust_parameters_based_on_performance();
            }
            
        } catch (const std::exception& e) {
            std::cerr << "  ❌ Trade error: " << e.what() << std::endl;
        }
    }
    
    // Scan a single pair for trading opportunity
    ScanResult scan_single_pair(const std::string& pair) {
        ScanResult result;
        result.pair = pair;
        
        // Check blacklist
        if (config.blacklisted_pairs.count(pair) > 0) {
            return result;  // Skip blacklisted pairs
        }
        
        try {
            auto ticker = api->get_ticker(pair);
            
            // Calculate volatility from high/low prices
            double high_24h = std::stod(std::string(ticker["h"][0]));
            double low_24h = std::stod(std::string(ticker["l"][0]));
            double open_24h = std::stod(std::string(ticker["o"]));
            double current_price = std::stod(std::string(ticker["c"][0]));
            double bid = std::stod(std::string(ticker["b"][0]));
            double ask = std::stod(std::string(ticker["a"][0]));
            
            // Calculate bid-ask spread percentage
            double spread = ((ask - bid) / current_price) * 100.0;
            
            // CRITICAL: Skip if spread is too high (kills profitability)
            if (spread > config.max_spread_pct) return result;
            
            double volatility = ((high_24h - low_24h) / open_24h) * 100.0;  // % volatility
            
            // CRITICAL: Need enough volatility to overcome fees
            // Kraken fees are ~0.4% round-trip, so need >0.5% movement minimum
            if (volatility < config.min_volatility || volatility > 50) return result;
            
            // Calculate 24h trend strength
            double trend_24h = (current_price - open_24h) / open_24h;
            
            // Calculate momentum (current price vs recent activity)
            // VWAP approximation: (high + low + close) / 3
            double vwap_approx = (high_24h + low_24h + current_price) / 3.0;
            double vwap_deviation = (current_price - vwap_approx) / vwap_approx;
            
            // Momentum: price relative to 24h range
            double range_position = (current_price - low_24h) / (high_24h - low_24h);
            
            // Strong momentum: price is in top 30% of range with positive trend
            bool strong_bullish = (range_position > 0.7 && trend_24h > 0.01);
            // Or price is in bottom 30% with strong reversal potential
            bool reversal_potential = (range_position < 0.3 && trend_24h > -0.02);
            
            // CRITICAL: Only enter if there's clear momentum/direction
            result.momentum = trend_24h;
            result.is_bullish = strong_bullish || (reversal_potential && vwap_deviation < -0.01);
            
            // Skip if no clear direction
            if (!result.is_bullish && !strong_bullish) {
                // Check for bearish opportunity (short)
                bool strong_bearish = (range_position < 0.3 && trend_24h < -0.01);
                if (!strong_bearish) return result;
                result.is_bullish = false;
            }
            
            // Volume check
            double volume_24h = std::stod(std::string(ticker["v"][1]));
            result.volume_score = std::min(1.0, volume_24h / 1000000.0);
            
            // Require minimum volume
            if (result.volume_score < 0.1) return result;
            
            // Get strategy for this pair (check learning data)
            auto strategy = learning_engine->get_optimal_strategy(pair, volatility);
            
            // CRITICAL: Ensure timeframe is long enough for price to move past fees
            strategy.timeframe_seconds = std::max(config.min_timeframe_seconds, 
                std::min(config.max_timeframe_seconds, (int)(30 / volatility * 100)));
            
            // Calculate expected movement based on volatility
            double expected_move_pct = volatility / 24.0 * (strategy.timeframe_seconds / 3600.0) * 100;
            
            // Skip if expected movement < fees (0.4%)
            if (expected_move_pct < 0.5) {
                strategy.timeframe_seconds = std::min(300, strategy.timeframe_seconds * 2);
            }
            
            // Set take-profit and stop-loss based on volatility
            strategy.take_profit_pct = std::max(0.01, volatility / 100.0 * 0.3);  // 30% of daily volatility
            strategy.stop_loss_pct = std::max(0.005, volatility / 100.0 * 0.15);  // 15% of daily volatility
            
            // Position sizing based on volatility (higher vol = smaller position)
            double vol_factor = std::max(0.3, 1.0 - (volatility / 30.0));
            strategy.position_size_usd = config.position_size_usd * vol_factor;
            
            // Leverage based on confidence in direction
            double direction_confidence = std::abs(trend_24h) / volatility;
            strategy.leverage = std::max(1.0, std::min(3.0, 1.0 + direction_confidence * 5.0));
            
            result.volatility = volatility;
            result.spread = spread;
            result.trend_strength = trend_24h;
            result.strategy = strategy;
            result.valid = true;
            
        } catch (const std::exception& e) {
            return result;
        }
        
        return result;
    }
    
    // Detect market regime
    std::string detect_market_regime() {
        // Simple regime detection based on recent performance
        if (performance.total_trades < 10) return "unknown";
        
        double recent_win_rate = performance.win_rate;
        double recent_sharpe = performance.sharpe_ratio;
        
        if (recent_win_rate > 0.6 && recent_sharpe > 1.0) return "bull";
        if (recent_win_rate < 0.4 && recent_sharpe < 0.5) return "bear";
        return "consolidation";
    }
    
    // Adjust parameters based on performance
    void adjust_parameters_based_on_performance() {
        if (performance.total_trades < 5) return;  // Need minimum trades
        
        // Adjust position size based on win rate
        if (performance.win_rate > 0.6) {
            config.position_size_usd = std::min(config.position_size_usd * 1.1, 500.0);  // Increase up to $500
        } else if (performance.win_rate < 0.4) {
            config.position_size_usd = std::max(config.position_size_usd * 0.9, 25.0);  // Decrease down to $25
        }
        
        // Adjust leverage based on Sharpe ratio
        if (performance.sharpe_ratio > 1.5) {
            config.target_leverage = std::min(config.target_leverage * 1.05, 5.0);  // Increase up to 5x
        } else if (performance.sharpe_ratio < 0.5) {
            config.target_leverage = std::max(config.target_leverage * 0.95, 1.0);  // Decrease down to 1x
        }
    }
};

int main(int argc, char* argv[]) {
    // Parse arguments
    BotConfig config;
    
    for (int i = 1; i < argc; i++) {
        if (std::string(argv[i]) == "--live") {
            config.paper_trading = false;
            std::cout << "🚨 WARNING: LIVE TRADING MODE" << std::endl;
        } else if (std::string(argv[i]) == "--learning-off") {
            config.enable_learning = false;
        } else if (std::string(argv[i]) == "--help") {
            std::cout << "Usage: " << argv[0] << " [options]" << std::endl;
            std::cout << "Options:" << std::endl;
            std::cout << "  --live         Run in live trading mode" << std::endl;
            std::cout << "  --learning-off Disable learning engine" << std::endl;
            std::cout << "  --help         Show this help" << std::endl;
            return 0;
        }
    }
    
    KrakenTradingBot bot(config);
    bot.run();
    
    return 0;
}