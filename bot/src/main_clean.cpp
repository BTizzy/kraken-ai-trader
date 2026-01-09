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
    int max_concurrent_trades = 1;
    double target_leverage = 2.0;
    double position_size_usd = 100;
};

struct ScanResult {
    std::string pair;
    double volatility = 0.0;
    double spread = 0.0;
    double trend_strength = 0.0;
    double volume_score = 0.0;
    StrategyConfig strategy;
    bool valid = false;
};

class KrakenTradingBot {
public:
    KrakenTradingBot(const BotConfig& config) : config(config) {
        api = std::make_unique<KrakenAPI>(config.paper_trading);
        learning_engine = std::make_unique<LearningEngine>();
        
        std::cout << "\n🤖 KRAKEN TRADING BOT v1.0 (C++)" << std::endl;
        std::cout << "Mode: " << (config.paper_trading ? "PAPER TRADING" : "LIVE TRADING") << std::endl;
        std::cout << "Learning enabled: " << (config.enable_learning ? "YES" : "NO") << std::endl;
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
                
                // SCAN ALL PAIRS IN PARALLEL
                std::cout << "\n🔍 Scanning " << usd_pairs.size() << " pairs..." << std::endl;
                
                std::vector<std::future<ScanResult>> futures;
                for (const auto& pair : usd_pairs) {
                    futures.push_back(std::async(std::launch::async, 
                        [this, pair]() { return scan_single_pair(pair); }));
                }
                
                // Collect results
                std::vector<ScanResult> scan_results;
                for (auto& future : futures) {
                    ScanResult result = future.get();
                    if (result.valid) {
                        scan_results.push_back(result);
                    }
                }
                
                std::cout << "✅ Found " << scan_results.size() << " valid opportunities" << std::endl;
                
                if (!scan_results.empty()) {
                    // Sort by volume score (higher volume = better)
                    std::sort(scan_results.begin(), scan_results.end(), 
                        [](const ScanResult& a, const ScanResult& b) {
                            return a.volume_score > b.volume_score;
                        });
                    
                    // Take the best opportunity
                    const auto& best_result = scan_results[0];
                    const auto& best_pair = best_result.pair;
                    const auto& best_strategy = best_result.strategy;
                    const auto& best_volatility = best_result.volatility;
                    
                    std::cout << "\n🎯 BEST OPPORTUNITY: " << best_pair << std::endl;
                    std::cout << "  Volatility: " << std::fixed << std::setprecision(2) << best_volatility << "%" << std::endl;
                    std::cout << "  Trend Strength: " << std::fixed << std::setprecision(3) << best_result.trend_strength << std::endl;
                    std::cout << "  Volume Score: " << std::fixed << std::setprecision(2) << best_result.volume_score << std::endl;
                    std::cout << "  Strategy: " << best_strategy.leverage << "x leverage, " 
                              << best_strategy.timeframe_seconds << "s timeframe" << std::endl;
                    
                    // EXECUTE TRADE
                    std::cout << "\n💹 EXECUTING TRADE..." << std::endl;
                    
                    // Get current price
                    auto ticker = api->get_ticker(best_pair);
                    double entry_price = std::stod(std::string(ticker["c"][0]));
                    auto entry_time = std::chrono::system_clock::now();
                    
                    std::cout << "  Entry Price: $" << std::fixed << std::setprecision(2) << entry_price << std::endl;
                    std::cout << "  Position Size: $" << best_strategy.position_size_usd << std::endl;
                    std::cout << "  Leverage: " << best_strategy.leverage << "x" << std::endl;
                    
                    // Calculate position size in base currency
                    double position_size_base = best_strategy.position_size_usd / entry_price;
                    double volume = position_size_base * best_strategy.leverage;
                    
                    // Place limit order slightly better than market
                    double limit_price = entry_price * (best_strategy.leverage > 1 ? 1.0001 : 0.9999);
                    
                    auto order = api->place_limit_order(
                        best_pair, 
                        best_strategy.leverage > 1 ? "buy" : "sell",
                        volume,
                        limit_price
                    );
                    
                    std::string order_id = order.order_id;
                    
                    if (!order_id.empty()) {
                        std::cout << "  ✅ Order placed: " << order_id << std::endl;
                        
                        // Wait for the full timeframe (simplified - no early exit checking)
                        std::this_thread::sleep_for(std::chrono::seconds(best_strategy.timeframe_seconds));
                        
                        // Get exit price
                        auto exit_ticker = api->get_ticker(best_pair);
                        double exit_price = std::stod(std::string(exit_ticker["c"][0]));
                        std::cout << "  📈 Exit Price: $" << std::fixed << std::setprecision(2) << exit_price << std::endl;
                        
                        // Calculate P&L
                        double gross_pnl = (exit_price - entry_price) * position_size_base * best_strategy.leverage;
                        double fees = best_strategy.position_size_usd * 0.004; // 0.4% fee
                        double net_pnl = gross_pnl - fees;
                        
                        std::cout << "  💰 Gross P&L: $" << std::fixed << std::setprecision(2) << gross_pnl << std::endl;
                        std::cout << "  💸 Fees: $" << std::fixed << std::setprecision(2) << fees << std::endl;
                        std::cout << "  🏆 Net P&L: $" << std::fixed << std::setprecision(2) << net_pnl << std::endl;
                        
                        // Record trade
                        TradeRecord trade;
                        trade.pair = best_pair;
                        trade.entry_price = entry_price;
                        trade.exit_price = exit_price;
                        trade.leverage = best_strategy.leverage;
                        trade.position_size = best_strategy.position_size_usd;
                        trade.pnl = net_pnl;
                        trade.gross_pnl = gross_pnl;
                        trade.fees_paid = fees;
                        trade.timestamp = entry_time;
                        trade.exit_reason = net_pnl > 0 ? "take_profit" : "timeout";
                        trade.timeframe_seconds = best_strategy.timeframe_seconds;
                        trade.volatility_at_entry = best_volatility;
                        
                        learning_engine->record_trade(trade);
                        trade_count++;
                        
                        // Track performance
                        performance.update_trade(net_pnl);
                        
                        // Adjust parameters based on performance
                        adjust_parameters_based_on_performance();
                        
                        // Brief cooldown
                        std::this_thread::sleep_for(2s);
                    } else {
                        std::cout << "  ❌ Order failed to place" << std::endl;
                    }
                }
                
                // Performance summary every 10 trades
                if (trade_count > 0 && trade_count % 10 == 0) {
                    std::cout << "\n📊 PERFORMANCE UPDATE (" << trade_count << " trades):" << std::endl;
                    performance.print_summary();
                    
                    auto runtime = std::chrono::duration_cast<std::chrono::hours>(
                        std::chrono::system_clock::now() - start_time).count();
                    std::cout << "  Runtime: " << runtime << " hours" << std::endl;
                    std::cout << "  Trades per hour: " << std::fixed << std::setprecision(1) 
                              << (double)trade_count / std::max(1.0, (double)runtime) << std::endl;
                }
                
                // Print parameter adjustments
                if (performance.total_trades >= 5 && (int)performance.total_trades % 5 == 0) {
                    std::cout << "\n🔧 PARAMETER ADJUSTMENT:" << std::endl;
                    std::cout << "  Position Size: $" << config.position_size_usd << std::endl;
                    std::cout << "  Target Leverage: " << config.target_leverage << "x" << std::endl;
                    std::cout << "  Win Rate: " << std::fixed << std::setprecision(1) << (performance.win_rate * 100) << "%" << std::endl;
                    std::cout << "  Sharpe Ratio: " << performance.sharpe_ratio << std::endl;
                }
                
                // Sleep until next cycle (30 seconds minimum)
                auto cycle_time = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::system_clock::now() - cycle_start).count();
                int sleep_time = std::max(0, 30 - (int)cycle_time);
                if (sleep_time > 0) {
                    std::cout << "⏱️  Sleeping " << sleep_time << " seconds..." << std::endl;
                    std::this_thread::sleep_for(std::chrono::seconds(sleep_time));
                }
                
            } catch (const std::exception& e) {
                std::cerr << "❌ Trading loop error: " << e.what() << std::endl;
                std::this_thread::sleep_for(30s);
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
    
    // Scan a single pair for trading opportunity
    ScanResult scan_single_pair(const std::string& pair) {
        ScanResult result;
        result.pair = pair;
        
        try {
            auto ticker = api->get_ticker(pair);
            
            // Calculate volatility from high/low prices
            double high_24h = std::stod(std::string(ticker["h"][0]));
            double low_24h = std::stod(std::string(ticker["l"][0]));
            double open_24h = std::stod(std::string(ticker["o"]));
            double current_price = std::stod(std::string(ticker["c"][0]));
            
            double volatility = ((high_24h - low_24h) / open_24h) * 100.0;  // % volatility
            
            // Skip if volatility is too low or invalid
            if (volatility <= 0.1 || volatility > 1000) return result;
            
            double spread = api->get_bid_ask_spread(pair);
            
            // Filter by spread
            if (spread > 1.0) return result;  // Allow up to 1% spread
            
            // Calculate trend strength: (current - open) / open
            double trend_strength = (current_price - open_24h) / open_24h;
            
            // Calculate volume score (normalize volume)
            double volume_24h = std::stod(std::string(ticker["v"][1]));  // 24h volume
            // Simple volume scoring - higher volume = better (normalized 0-1)
            result.volume_score = std::min(1.0, volume_24h / 1000000.0);  // Scale by $1M volume
            
            // Get strategy for this pair
            auto strategy = learning_engine->get_optimal_strategy(pair, volatility);
            
            // Adjust strategy based on trend
            if (trend_strength > 0.02) {  // Strong uptrend
                strategy.leverage *= 1.2;  // Increase leverage in uptrends
                strategy.take_profit_pct *= 1.5;  // Wider profit targets
            } else if (trend_strength < -0.02) {  // Strong downtrend
                strategy.leverage *= 0.8;  // Reduce leverage in downtrends
                strategy.stop_loss_pct *= 1.2;  // Tighter stops
            }
            
            // Dynamic position sizing based on volatility and account balance
            double account_balance = api->get_balance("USD");
            double base_position_size = std::min(100.0, account_balance * 0.02);  // Max 2% of account
            
            // Scale position size with volatility (higher vol = smaller position)
            double vol_factor = std::max(0.1, 1.0 - (volatility / 50.0));  // Reduce size for very volatile pairs
            strategy.position_size_usd = base_position_size * vol_factor;
            
            // Ensure minimum position size
            strategy.position_size_usd = std::max(10.0, strategy.position_size_usd);
            
            // Market regime detection and adjustment
            std::string regime = detect_market_regime();
            if (regime == "bull") {
                strategy.leverage *= 1.1;
                strategy.take_profit_pct *= 1.2;
            } else if (regime == "bear") {
                strategy.leverage *= 0.9;
                strategy.stop_loss_pct *= 1.1;
            } else {  // consolidation
                strategy.timeframe_seconds *= 1.5;  // Hold longer in consolidation
            }
            
            result.volatility = volatility;
            result.spread = spread;
            result.trend_strength = trend_strength;
            result.strategy = strategy;
            result.valid = true;
            
        } catch (const std::exception& e) {
            // Skip this pair on error
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