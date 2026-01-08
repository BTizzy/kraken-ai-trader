#include <iostream>
#include <memory>
#include <thread>
#include <chrono>
#include <cstring>
#include <cstdlib>
#include "kraken_api.hpp"
#include "learning_engine.hpp"

using namespace std::chrono_literals;

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
    }
    
    // Main trading loop
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
        
        int trade_count = 0;
        bool running = true;
        
        std::cout << "\n▶️  Starting trading loop..." << std::endl;
        std::cout << "Press Ctrl+C to stop\n" << std::endl;
        
        while (running) {
            try {
                // 1. SCAN PAIRS FOR OPPORTUNITIES
                std::cout << "\n[" << trade_count + 1 << "] 🔍 Scanning " << pairs.size() << " pairs..." << std::endl;
                
                std::string best_pair = "";
                double best_volatility = 0;
                StrategyConfig best_strategy;
                
                for (const auto& pair : pairs) {
                    try {
                        auto ticker = api->get_ticker(pair);
                        double volatility = ticker.value("vola_24h", 0.0);
                        double spread = api->get_bid_ask_spread(pair);
                        
                        // Filter by spread
                        if (spread > 0.1) continue;  // Skip illiquid
                        
                        // Get strategy for this pair
                        auto strategy = learning_engine->get_optimal_strategy(pair, volatility);
                        
                        if (volatility > best_volatility && strategy.has_edge) {
                            best_volatility = volatility;
                            best_pair = pair;
                            best_strategy = strategy;
                        }
                    } catch (...) {
                        // Skip on error
                    }
                }
                
                if (best_pair.empty()) {
                    std::cout << "  ⏳ No good opportunities found, waiting..." << std::endl;
                    std::this_thread::sleep_for(5s);
                    continue;
                }
                
                std::cout << "  ✅ Found opportunity: " << best_pair 
                          << " (volatility: " << best_volatility << "%, strategy: " 
                          << best_strategy.name << ")" << std::endl;
                
                // 2. EXECUTE TRADE
                std::cout << "  📍 Entering position..." << std::endl;
                
                Order order = api->place_market_order(
                    best_pair,
                    "buy",
                    config.position_size_usd / api->get_current_price(best_pair),
                    best_strategy.leverage
                );
                
                if (order.status == "filled") {
                    std::cout << "  ✅ Order filled: " << order.volume << " " << best_pair 
                              << " @ $" << order.price << " (" << best_strategy.leverage << "x)" << std::endl;
                    
                    // 3. HOLD AND MONITOR
                    double entry_price = order.price;
                    double current_price = entry_price;
                    auto entry_time = std::chrono::system_clock::now();
                    
                    std::cout << "  ⏱️  Holding for " << best_strategy.timeframe_seconds << "s..." << std::endl;
                    
                    for (int i = 0; i < best_strategy.timeframe_seconds; i++) {
                        current_price = api->get_current_price(best_pair);
                        double unrealized_pnl = (current_price - entry_price) * order.volume;
                        double unrealized_pct = ((current_price - entry_price) / entry_price) * 100;
                        
                        // Check for early exit
                        if (unrealized_pnl > (config.position_size_usd * best_strategy.take_profit_pct)) {
                            std::cout << "  🎯 Take profit hit (" << unrealized_pct << "%)!" << std::endl;
                            break;
                        }
                        if (unrealized_pnl < -(config.position_size_usd * best_strategy.stop_loss_pct)) {
                            std::cout << "  ⛔ Stop loss triggered (" << unrealized_pct << "%)!" << std::endl;
                            break;
                        }
                        
                        std::cout << "    " << i << "s: " << best_pair << " @ $" << current_price 
                                  << " (" << std::fixed << std::setprecision(2) << unrealized_pnl 
                                  << " / " << unrealized_pct << "%)" << std::endl;
                        
                        std::this_thread::sleep_for(1s);
                    }
                    
                    // 4. EXIT TRADE
                    std::cout << "  📊 Closing position..." << std::endl;
                    Order exit_order = api->place_market_order(best_pair, "sell", order.volume, 1.0);
                    
                    if (exit_order.status == "filled") {
                        double exit_price = exit_order.price;
                        double gross_pnl = (exit_price - entry_price) * order.volume;
                        double fees = config.position_size_usd * 0.004;  // 0.4% fee
                        double net_pnl = gross_pnl - fees;
                        double roi = (net_pnl / config.position_size_usd) * 100;
                        
                        std::cout << "  ✅ Exit @ $" << exit_price << "\n" << std::endl;
                        std::cout << "  💰 RESULT: " << (net_pnl > 0 ? "+" : "") << net_pnl 
                                  << " (" << roi << "%)" << std::endl;
                        std::cout << "  =========================\n" << std::endl;
                        
                        // 5. RECORD TRADE
                        TradeRecord trade;
                        trade.pair = best_pair;
                        trade.entry_price = entry_price;
                        trade.exit_price = exit_price;
                        trade.leverage = best_strategy.leverage;
                        trade.position_size = config.position_size_usd;
                        trade.pnl = net_pnl;
                        trade.gross_pnl = gross_pnl;
                        trade.fees_paid = fees;
                        trade.timestamp = entry_time;
                        trade.exit_reason = net_pnl > 0 ? "take_profit" : "timeout";
                        trade.timeframe_seconds = best_strategy.timeframe_seconds;
                        trade.volatility_at_entry = best_volatility;
                        
                        learning_engine->record_trade(trade);
                        trade_count++;
                    }
                } else {
                    std::cout << "  ❌ Order failed to fill" << std::endl;
                }
                
                // Brief cooldown
                std::this_thread::sleep_for(2s);
                
            } catch (const std::exception& e) {
                std::cerr << "  ❌ Error: " << e.what() << std::endl;
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
            std::cout << "\nUsage: kraken_bot [options]\n" << std::endl;
            std::cout << "Options:" << std::endl;
            std::cout << "  --live          Use live trading (default: paper)" << std::endl;
            std::cout << "  --learning-off  Disable self-learning" << std::endl;
            std::cout << "  --help          Show this help\n" << std::endl;
            return 0;
        }
    }
    
    try {
        KrakenTradingBot bot(config);
        bot.run();
    } catch (const std::exception& e) {
        std::cerr << "Fatal error: " << e.what() << std::endl;
        return 1;
    }
    
    return 0;
}
