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
#include <deque>
#include <fstream>
#include <algorithm>
#include <cmath>
#include "kraken_api.hpp"
#include "learning_engine.hpp"

using namespace std::chrono_literals;

struct BotConfig {
    bool paper_trading = true;
    bool enable_learning = true;
    int learning_cycle_trades = 10;
    std::string trade_log_file = "trade_log.json";
    int max_concurrent_trades = 2;
    double base_position_size_usd = 100.0;
    double min_position_size_usd = 25.0;
    double max_position_size_usd = 500.0;
    int min_hold_seconds = 180;
    int max_hold_seconds = 1800;
    int default_hold_seconds = 600;
    double min_volatility_pct = 1.5;      // Lowered to get more trades
    double max_volatility_pct = 25.0;     // Avoid extreme volatility
    double max_spread_pct = 0.15;         // Standard spread
    double min_momentum_pct = 0.4;        // Lowered from 0.7 - still filters noise
    double min_volume_usd = 50000.0;      // Lowered from 100k for more pairs
    double take_profit_pct = 1.5;         // Reasonable TP
    double stop_loss_pct = 0.6;           // Tighter SL for faster learning
    double trailing_start_pct = 0.8;
    double trailing_stop_pct = 0.3;
    double trailing_distance_pct = 0.3;
    int min_trades_to_blacklist = 3;
    double min_pair_winrate = 0.35;
    int min_pair_trades_for_stats = 5;
    std::set<std::string> blacklisted_pairs;
    std::map<std::string, int> pair_loss_streak;
    std::map<std::string, double> pair_win_rates;
    std::map<std::string, int> pair_trade_counts;
    std::map<std::string, double> pair_total_pnl;
};

struct PerformanceMetrics {
    double total_pnl = 0.0;
    double total_fees = 0.0;
    int total_trades = 0;
    int winning_trades = 0;
    int losing_trades = 0;
    int tp_exits = 0;
    int sl_exits = 0;
    int trailing_exits = 0;
    int timeout_exits = 0;
    double win_rate = 0.0;
    double avg_win = 0.0;
    double avg_loss = 0.0;
    double best_trade = 0.0;
    double worst_trade = 0.0;
    double peak_pnl = 0.0;
    double max_drawdown = 0.0;
    std::chrono::system_clock::time_point start_time;
    std::deque<double> recent_pnl;

    void record_trade(double pnl, const std::string& exit_reason) {
        total_pnl += pnl;
        total_trades++;
        recent_pnl.push_back(pnl);
        if (recent_pnl.size() > 50) recent_pnl.pop_front();
        if (pnl > 0) {
            winning_trades++;
            avg_win = ((avg_win * (winning_trades - 1)) + pnl) / winning_trades;
            if (pnl > best_trade) best_trade = pnl;
        } else {
            losing_trades++;
            avg_loss = ((avg_loss * (losing_trades - 1)) + pnl) / losing_trades;
            if (pnl < worst_trade) worst_trade = pnl;
        }
        win_rate = (double)winning_trades / total_trades;
        if (exit_reason == "take_profit") tp_exits++;
        else if (exit_reason == "stop_loss") sl_exits++;
        else if (exit_reason == "trailing_stop") trailing_exits++;
        else timeout_exits++;
        if (total_pnl > peak_pnl) peak_pnl = total_pnl;
        else {
            double dd = peak_pnl - total_pnl;
            if (dd > max_drawdown) max_drawdown = dd;
        }
    }

    double get_recent_winrate() const {
        if (recent_pnl.empty()) return 0.5;
        int wins = std::count_if(recent_pnl.begin(), recent_pnl.end(), [](double p) { return p > 0; });
        return (double)wins / recent_pnl.size();
    }

    double get_profit_factor() const {
        double gross_wins = avg_win * winning_trades;
        double gross_losses = std::abs(avg_loss) * losing_trades;
        return gross_losses > 0 ? gross_wins / gross_losses : (gross_wins > 0 ? 10.0 : 1.0);
    }

    void print_summary() const {
        std::cout << "\n" << std::string(60, '=') << std::endl;
        std::cout << "FINAL PERFORMANCE SUMMARY" << std::endl;
        std::cout << std::string(60, '=') << std::endl;
        std::cout << "  Total P&L: $" << std::fixed << std::setprecision(2) << total_pnl << std::endl;
        std::cout << "  Total Trades: " << total_trades << std::endl;
        std::cout << "  Win Rate: " << std::setprecision(1) << (win_rate * 100) << "%" << std::endl;
        std::cout << "  Profit Factor: " << std::setprecision(2) << get_profit_factor() << std::endl;
        std::cout << std::string(60, '=') << std::endl;
    }
};

struct ScanResult {
    std::string pair;
    double current_price = 0.0;
    double spread_pct = 0.0;
    double volatility_pct = 0.0;
    double momentum_pct = 0.0;
    double volume_usd = 0.0;
    double range_position = 0.0;
    bool is_bullish = false;
    double signal_strength = 0.0;
    int suggested_hold_seconds = 600;
    double suggested_tp_pct = 1.5;
    double suggested_sl_pct = 0.5;
    bool valid = false;
};

class KrakenTradingBot {
public:
    KrakenTradingBot(BotConfig& cfg) : config(cfg) {
        api = std::make_unique<KrakenAPI>(config.paper_trading);
        learning_engine = std::make_unique<LearningEngine>();
        metrics.start_time = std::chrono::system_clock::now();
        learning_engine->load_from_file(config.trade_log_file);
        std::cout << "\n" << std::string(60, '=') << std::endl;
        std::cout << "KRAKEN AI TRADING BOT v2.0" << std::endl;
        std::cout << std::string(60, '=') << std::endl;
        std::cout << "  Mode: " << (config.paper_trading ? "PAPER" : "LIVE") << std::endl;
        std::cout << "  Position: $" << config.base_position_size_usd << std::endl;
        std::cout << "  Hold: " << config.min_hold_seconds << "-" << config.max_hold_seconds << "s" << std::endl;
        std::cout << "  TP: " << config.take_profit_pct << "% | SL: " << config.stop_loss_pct << "%" << std::endl;
        std::cout << std::string(60, '=') << std::endl;
    }

    ~KrakenTradingBot() {
        metrics.print_summary();
        if (learning_engine) {
            learning_engine->print_summary();
            learning_engine->save_to_file(config.trade_log_file);
        }
    }

    void run() {
        std::cout << "\nAuthenticating..." << std::endl;
        if (!api->authenticate()) {
            std::cerr << "Auth failed!" << std::endl;
            return;
        }
        std::cout << "Authenticated" << std::endl;

        auto all_pairs = api->get_trading_pairs();
        std::vector<std::string> usd_pairs;
        for (const auto& pair : all_pairs) {
            if (pair.length() > 3 && pair.substr(pair.length() - 3) == "USD") {
                usd_pairs.push_back(pair);
            }
        }
        std::cout << "Found " << usd_pairs.size() << " USD pairs" << std::endl;

        while (true) {
            try {
                auto cycle_start = std::chrono::system_clock::now();
                std::cout << "\nScanning " << usd_pairs.size() << " pairs..." << std::endl;

                std::vector<ScanResult> opportunities;
                std::vector<std::future<ScanResult>> futures;
                
                for (const auto& pair : usd_pairs) {
                    futures.push_back(std::async(std::launch::async, [this, &pair]() {
                        return scan_pair(pair);
                    }));
                }

                for (auto& f : futures) {
                    ScanResult r = f.get();
                    if (r.valid) opportunities.push_back(r);
                }

                std::cout << "Found " << opportunities.size() << " opportunities" << std::endl;

                if (!opportunities.empty()) {
                    std::sort(opportunities.begin(), opportunities.end(),
                        [](const ScanResult& a, const ScanResult& b) {
                            return a.signal_strength > b.signal_strength;
                        });

                    int num_trades = std::min(config.max_concurrent_trades, (int)opportunities.size());
                    std::vector<std::thread> threads;

                    for (int i = 0; i < num_trades; i++) {
                        const auto& opp = opportunities[i];
                        std::cout << "Top #" << (i+1) << ": " << opp.pair 
                                  << " (signal: " << std::fixed << std::setprecision(2) 
                                  << opp.signal_strength << ")" << std::endl;
                        threads.emplace_back([this, opp]() { execute_trade(opp); });
                    }

                    for (auto& t : threads) if (t.joinable()) t.join();
                }

                if (metrics.total_trades > 0 && metrics.total_trades % 5 == 0) {
                    print_status();
                }

                auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::system_clock::now() - cycle_start).count();
                // Scan every 20s for faster opportunity detection (was 60s)
                int sleep = std::max(10, 20 - (int)elapsed);
                std::cout << "Next scan in " << sleep << "s..." << std::endl;
                std::this_thread::sleep_for(std::chrono::seconds(sleep));

            } catch (const std::exception& e) {
                std::cerr << "Error: " << e.what() << std::endl;
                std::this_thread::sleep_for(10s);
            }
        }
    }

private:
    BotConfig& config;
    std::unique_ptr<KrakenAPI> api;
    std::unique_ptr<LearningEngine> learning_engine;
    PerformanceMetrics metrics;
    std::mutex metrics_mutex;
    std::mutex learning_mutex;

    ScanResult scan_pair(const std::string& pair) {
        ScanResult result;
        result.pair = pair;
        if (config.blacklisted_pairs.count(pair)) return result;
        if (config.pair_trade_counts.count(pair) && config.pair_trade_counts[pair] >= config.min_pair_trades_for_stats) {
            double wr = config.pair_win_rates.count(pair) ? config.pair_win_rates[pair] : 0.5;
            if (wr < config.min_pair_winrate) return result;
        }

        try {
            auto ticker = api->get_ticker(pair);
            double high = std::stod(std::string(ticker["h"][0]));
            double low = std::stod(std::string(ticker["l"][0]));
            double open = std::stod(std::string(ticker["o"]));
            double price = std::stod(std::string(ticker["c"][0]));
            double bid = std::stod(std::string(ticker["b"][0]));
            double ask = std::stod(std::string(ticker["a"][0]));
            double vol = std::stod(std::string(ticker["v"][1]));

            result.current_price = price;
            result.spread_pct = ((ask - bid) / price) * 100.0;
            if (result.spread_pct > config.max_spread_pct) return result;

            result.volatility_pct = ((high - low) / open) * 100.0;
            if (result.volatility_pct < config.min_volatility_pct || result.volatility_pct > config.max_volatility_pct) return result;

            result.volume_usd = vol * price;
            if (result.volume_usd < config.min_volume_usd) return result;

            result.momentum_pct = ((price - open) / open) * 100.0;
            result.range_position = (high > low) ? (price - low) / (high - low) : 0.5;

            if (std::abs(result.momentum_pct) < config.min_momentum_pct) return result;

            // TREND CONFIRMATION: Check if longer-term trend aligns with entry
            // Get OHLC data to analyze recent price action
            double trend_score = 0.0;
            try {
                auto ohlc = api->get_ohlc(pair, 15);  // 15-minute candles
                if (!ohlc.empty() && ohlc.size() >= 4) {
                    // Check last 4 candles (1 hour of 15-min data)
                    int bullish_candles = 0;
                    int bearish_candles = 0;
                    for (size_t i = ohlc.size() - 4; i < ohlc.size(); i++) {
                        double candle_open = ohlc[i].open;
                        double candle_close = ohlc[i].close;
                        if (candle_close > candle_open) bullish_candles++;
                        else if (candle_close < candle_open) bearish_candles++;
                    }
                    
                    // Bonus for bullish trend, penalty for bearish (but don't block)
                    if (bullish_candles >= 3) trend_score = 0.15;  // Strong uptrend
                    else if (bullish_candles >= 2) trend_score = 0.08;  // Moderate uptrend
                    else if (bearish_candles >= 3) trend_score = -0.1;  // Penalty but allow
                    
                    // Also check if price is above recent lows (support)
                    double recent_low = ohlc[ohlc.size()-1].low;
                    for (size_t i = ohlc.size() - 4; i < ohlc.size(); i++) {
                        if (ohlc[i].low < recent_low) recent_low = ohlc[i].low;
                    }
                    if (price > recent_low * 1.01) trend_score += 0.05;  // Price holding above support
                }
            } catch (...) {
                // If OHLC fails, continue without trend adjustment
            }

            // ENTRY CRITERIA: Must have positive momentum and not be overextended
            // Bullish: upward momentum, not at extreme highs
            bool bullish = (result.momentum_pct > config.min_momentum_pct && 
                           result.range_position > 0.25 &&   // Relaxed from 0.4
                           result.range_position < 0.85);    // Relaxed from 0.75
            
            // DISABLED bearish trades - long-only strategy for now
            bool bearish = false;

            if (!bullish && !bearish) return result;
            result.is_bullish = bullish;

            // Scoring - momentum weighted heavily
            double mom_score = std::min(1.0, std::abs(result.momentum_pct) / 2.0);  // Scale to 2% for max (was 4%)
            double vol_score = std::min(1.0, result.volatility_pct / 5.0);          // Lower bar (was 8%)
            double spread_score = 1.0 - (result.spread_pct / config.max_spread_pct);
            double volume_score = std::min(1.0, result.volume_usd / 200000.0);      // Lowered (was 500k)

            double history_bonus = 0.0;
            if (config.pair_trade_counts.count(pair) && config.pair_trade_counts[pair] >= 3) {
                double wr = config.pair_win_rates.count(pair) ? config.pair_win_rates[pair] : 0.5;
                history_bonus = (wr - 0.5) * 0.5;
            }

            // Reweighted: momentum 40%, volume 20%, trend 15%, spread 10%, volatility 10%, history 5%
            result.signal_strength = mom_score * 0.40 + volume_score * 0.20 + trend_score + spread_score * 0.10 + vol_score * 0.10 + history_bonus * 0.05;
            
            // MINIMUM SIGNAL THRESHOLD - filter out weakest signals only
            if (result.signal_strength < 0.35) return result;  // Lowered from 0.45

            // Adjusted TP/SL based on volatility - aim for 2:1 R:R minimum
            if (result.volatility_pct > 10) {
                result.suggested_hold_seconds = config.min_hold_seconds;
                result.suggested_tp_pct = result.volatility_pct * 0.20;  // 20% of volatility
                result.suggested_sl_pct = result.volatility_pct * 0.08;  // 8% of volatility (2.5:1 R:R)
            } else if (result.volatility_pct > 5) {
                result.suggested_hold_seconds = config.default_hold_seconds;
                result.suggested_tp_pct = result.volatility_pct * 0.25;  // 25% of volatility
                result.suggested_sl_pct = result.volatility_pct * 0.10;  // 10% of volatility (2.5:1 R:R)
            } else {
                result.suggested_hold_seconds = config.max_hold_seconds / 2;
                result.suggested_tp_pct = std::max(1.5, result.volatility_pct * 0.35);
                result.suggested_sl_pct = std::max(0.6, result.volatility_pct * 0.15);
            }

            result.suggested_tp_pct = std::max(result.suggested_tp_pct, 1.2);  // Min 1.2% TP
            result.suggested_sl_pct = std::max(result.suggested_sl_pct, 0.6);  // Min 0.6% SL
            result.valid = true;
        } catch (...) {}
        return result;
    }

    void execute_trade(const ScanResult& opp) {
        std::string trade_id = "T" + std::to_string(std::time(nullptr)) + "_" + opp.pair;
        
        // LEARNING ENGINE INTEGRATION: Get optimal strategy from learned patterns
        StrategyConfig learned_config;
        {
            std::lock_guard<std::mutex> lock(learning_mutex);
            learned_config = learning_engine->get_optimal_strategy(opp.pair, opp.volatility_pct);
        }
        
        // Use learned position size if available, otherwise default
        double position_usd = learned_config.position_size_usd > 0 ? 
                              learned_config.position_size_usd : config.base_position_size_usd;
        
        // CRITICAL FIX: Get a fresh confirmed price before entering the trade
        // This prevents fake trades where we can't track the price during the hold period
        double confirmed_entry_price = 0;
        try {
            auto ticker = api->get_ticker(opp.pair);
            confirmed_entry_price = std::stod(std::string(ticker["c"][0]));
        } catch (const std::exception& e) {
            std::cerr << "Cannot get fresh price for " << opp.pair << ", skipping trade: " << e.what() << std::endl;
            return;  // Don't enter if we can't even get the current price
        }
        
        // Use the confirmed price, not the scan price
        double amount = position_usd / confirmed_entry_price;

        // LEARNING ENGINE: Override TP/SL with learned values if available
        double tp_pct = learned_config.take_profit_pct > 0 ? learned_config.take_profit_pct * 100.0 : 
                       (opp.suggested_tp_pct > 0 ? opp.suggested_tp_pct : config.take_profit_pct);
        double sl_pct = learned_config.stop_loss_pct > 0 ? learned_config.stop_loss_pct * 100.0 :
                       (opp.suggested_sl_pct > 0 ? opp.suggested_sl_pct : config.stop_loss_pct);
        int hold_time = learned_config.timeframe_seconds > 0 ? learned_config.timeframe_seconds :
                       (opp.suggested_hold_seconds > 0 ? opp.suggested_hold_seconds : config.default_hold_seconds);
        hold_time = std::max(config.min_hold_seconds, std::min(hold_time, config.max_hold_seconds));

        std::cout << "\n--- ENTER " << opp.pair << " ---" << std::endl;
        std::cout << "  Price: $" << std::fixed << std::setprecision(6) << confirmed_entry_price << std::endl;
        std::cout << "  Position: $" << position_usd << " (" << amount << " units)" << std::endl;
        std::cout << "  TP: " << tp_pct << "% | SL: " << sl_pct << "% | Max: " << hold_time << "s" << std::endl;
        if (learned_config.is_validated) {
            std::cout << "  🧠 USING LEARNED STRATEGY | Edge: " << std::setprecision(1) 
                      << learned_config.estimated_edge << "%" << std::endl;
        }

        Order entry_order = api->place_market_order(opp.pair, "buy", amount);
        if (entry_order.status == "error") {
            std::cerr << "Entry failed: " << entry_order.order_id << std::endl;
            return;
        }

        double entry_price = confirmed_entry_price;  // Use the confirmed price
        double tp_price = entry_price * (1.0 + tp_pct / 100.0);
        double sl_price = entry_price * (1.0 - sl_pct / 100.0);
        double trailing_start = entry_price * (1.0 + config.trailing_start_pct / 100.0);
        double highest_price = entry_price;
        bool trailing_active = false;
        double trailing_stop = 0;

        auto entry_time = std::chrono::system_clock::now();
        std::string exit_reason = "timeout";
        double exit_price = entry_price;
        double last_valid_price = entry_price;  // Track last known valid price
        int successful_price_updates = 0;  // Track how many times we got a valid price
        int consecutive_errors = 0;
        const int max_consecutive_errors = 10;  // Max errors before force exit

        while (true) {
            std::this_thread::sleep_for(std::chrono::seconds(5));

            auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                std::chrono::system_clock::now() - entry_time).count();

            try {
                auto ticker = api->get_ticker(opp.pair);
                double current = std::stod(std::string(ticker["c"][0]));
                last_valid_price = current;  // Update last valid price on success
                successful_price_updates++;  // Track successful updates
                consecutive_errors = 0;  // Reset error counter on success

                if (current > highest_price) {
                    highest_price = current;
                    if (trailing_active) {
                        trailing_stop = highest_price * (1.0 - config.trailing_stop_pct / 100.0);
                    }
                }

                if (!trailing_active && current >= trailing_start) {
                    trailing_active = true;
                    trailing_stop = current * (1.0 - config.trailing_stop_pct / 100.0);
                    std::cout << "  [" << opp.pair << "] Trailing activated at $" << current << std::endl;
                }

                if (current >= tp_price) {
                    exit_reason = "take_profit";
                    exit_price = current;
                    std::cout << "  [" << opp.pair << "] TP HIT at $" << current << std::endl;
                    break;
                }

                if (current <= sl_price) {
                    exit_reason = "stop_loss";
                    exit_price = current;
                    std::cout << "  [" << opp.pair << "] SL HIT at $" << current << std::endl;
                    break;
                }

                if (trailing_active && current <= trailing_stop) {
                    exit_reason = "trailing_stop";
                    exit_price = current;
                    std::cout << "  [" << opp.pair << "] TRAIL HIT at $" << current << std::endl;
                    break;
                }

                if (elapsed >= hold_time) {
                    exit_price = current;
                    break;
                }

                if (elapsed % 30 == 0 && elapsed > 0) {
                    double change_pct = ((current - entry_price) / entry_price) * 100.0;
                    std::cout << "  [" << opp.pair << "] " << elapsed << "s: $" << current 
                              << " (" << (change_pct >= 0 ? "+" : "") << change_pct << "%)" << std::endl;
                }

            } catch (const std::exception& e) {
                consecutive_errors++;
                std::cerr << "Monitor error " << opp.pair << " (" << consecutive_errors << "/" 
                          << max_consecutive_errors << "): " << e.what() << std::endl;
                
                // If too many consecutive errors, exit with last known price
                if (consecutive_errors >= max_consecutive_errors) {
                    exit_price = last_valid_price;
                    exit_reason = "error_exit";
                    std::cerr << "  [" << opp.pair << "] Exiting due to repeated errors. Using last price: $" 
                              << last_valid_price << std::endl;
                    break;
                }
            }
        }

        // Use last valid price if exit_price wasn't set (e.g., timeout without final price)
        if (exit_price == entry_price && last_valid_price != entry_price) {
            exit_price = last_valid_price;
        }

        Order exit_order = api->place_market_order(opp.pair, "sell", amount);

        // A trade is only valid if we got at least one price update during monitoring
        // Since we confirm price at entry, this means the API worked at least once
        // If we never got updates, something went very wrong - skip recording
        if (successful_price_updates == 0) {
            std::cerr << "\n--- INVALID TRADE " << opp.pair << " ---" << std::endl;
            std::cerr << "  No price updates received during " << hold_time << "s monitoring period" << std::endl;
            std::cerr << "  This trade will NOT be recorded to preserve data integrity" << std::endl;
            return;  // Don't record - we have no valid data
        }

        double pnl_pct = ((exit_price - entry_price) / entry_price) * 100.0;
        double pnl_usd = position_usd * (pnl_pct / 100.0);
        double fees = position_usd * 0.004;
        double net_pnl = pnl_usd - fees;
        bool is_win = net_pnl > 0;

        auto hold_duration = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now() - entry_time).count();

        std::cout << "\n--- EXIT " << opp.pair << " [" << exit_reason << "] ---" << std::endl;
        std::cout << "  Entry: $" << entry_price << " -> Exit: $" << exit_price << std::endl;
        std::cout << "  P&L: $" << std::fixed << std::setprecision(2) << net_pnl 
                  << " (" << (pnl_pct >= 0 ? "+" : "") << pnl_pct << "%)" << std::endl;
        std::cout << "  Hold: " << hold_duration << "s | " << (is_win ? "WIN" : "LOSS") << std::endl;

        {
            std::lock_guard<std::mutex> lock(metrics_mutex);
            metrics.total_trades++;
            if (is_win) metrics.winning_trades++;
            else metrics.losing_trades++;
            metrics.total_pnl += net_pnl;
            metrics.total_fees += fees;
            if (exit_reason == "take_profit") metrics.tp_exits++;
            else if (exit_reason == "stop_loss") metrics.sl_exits++;
            else if (exit_reason == "trailing_stop") metrics.trailing_exits++;
            else metrics.timeout_exits++;
        }

        {
            std::lock_guard<std::mutex> lock(learning_mutex);
            TradeRecord trade;
            trade.pair = opp.pair;
            trade.entry_price = entry_price;
            trade.exit_price = exit_price;
            trade.leverage = 1.0;
            trade.timeframe_seconds = hold_duration;
            trade.position_size = position_usd;
            trade.pnl = net_pnl;
            trade.gross_pnl = pnl_usd;
            trade.fees_paid = fees;
            trade.timestamp = std::chrono::system_clock::now();
            trade.exit_reason = exit_reason;
            trade.volatility_at_entry = opp.volatility_pct;
            trade.bid_ask_spread = opp.spread_pct;
            learning_engine->record_trade(trade);
            
            if (!config.pair_trade_counts.count(opp.pair)) {
                config.pair_trade_counts[opp.pair] = 0;
                config.pair_win_rates[opp.pair] = 0.5;
            }
            config.pair_trade_counts[opp.pair]++;
            double old_wr = config.pair_win_rates[opp.pair];
            double n = config.pair_trade_counts[opp.pair];
            config.pair_win_rates[opp.pair] = old_wr * ((n-1)/n) + (is_win ? 1.0/n : 0.0);

            if (config.pair_trade_counts[opp.pair] >= config.min_pair_trades_for_stats &&
                config.pair_win_rates[opp.pair] < config.min_pair_winrate * 0.5) {
                config.blacklisted_pairs.insert(opp.pair);
                std::cout << "  [BLACKLISTED] " << opp.pair << " (WR: " 
                          << config.pair_win_rates[opp.pair]*100 << "%)" << std::endl;
            }
        }
    }

    void print_status() {
        std::lock_guard<std::mutex> lock(metrics_mutex);
        auto now = std::chrono::system_clock::now();
        auto runtime = std::chrono::duration_cast<std::chrono::minutes>(now - metrics.start_time).count();
        double win_rate = metrics.total_trades > 0 ? (double)metrics.winning_trades / metrics.total_trades * 100.0 : 0.0;

        std::cout << "\n" << std::string(50, '-') << std::endl;
        std::cout << "PERFORMANCE SUMMARY (" << runtime << " min)" << std::endl;
        std::cout << std::string(50, '-') << std::endl;
        std::cout << "  Trades: " << metrics.total_trades << " (W:" << metrics.winning_trades << " L:" << metrics.losing_trades << ")" << std::endl;
        std::cout << "  Win Rate: " << std::fixed << std::setprecision(1) << win_rate << "%" << std::endl;
        std::cout << "  P&L: $" << std::fixed << std::setprecision(2) << metrics.total_pnl << " (fees: $" << metrics.total_fees << ")" << std::endl;
        std::cout << "  Exits: TP:" << metrics.tp_exits << " SL:" << metrics.sl_exits << " Trail:" << metrics.trailing_exits << " TO:" << metrics.timeout_exits << std::endl;
        std::cout << std::string(50, '-') << std::endl;
    }
};

int main(int argc, char* argv[]) {
    BotConfig config;

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--live") config.paper_trading = false;
        else if (arg == "--paper") config.paper_trading = true;
        else if (arg == "--position" && i+1 < argc) config.base_position_size_usd = std::stod(argv[++i]);
        else if (arg == "--tp" && i+1 < argc) config.take_profit_pct = std::stod(argv[++i]);
        else if (arg == "--sl" && i+1 < argc) config.stop_loss_pct = std::stod(argv[++i]);
        else if (arg == "--min-hold" && i+1 < argc) config.min_hold_seconds = std::stoi(argv[++i]);
        else if (arg == "--max-hold" && i+1 < argc) config.max_hold_seconds = std::stoi(argv[++i]);
        else if (arg == "--trades" && i+1 < argc) config.max_concurrent_trades = std::stoi(argv[++i]);
    }

    std::cout << "Starting Kraken AI Trading Bot..." << std::endl;
    KrakenTradingBot bot(config);
    bot.run();
    return 0;
}
