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
    bool learning_mode = true;  // NEW: When true, bypasses edge filter to gather pattern data
    int edge_filter_min_trades = 10;  // Minimum trades before applying edge filter
    double edge_filter_min_winrate = 0.35;  // Minimum win rate for edge
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
    
    // Regime filter - data shows VOLATILE regime has 70% WR
    bool regime_filter_enabled = true;
    bool allow_volatile_regime = true;
    bool allow_trending_regime = false;  // Data shows losing money in trends
    bool allow_ranging_regime = false;   // Data shows -$1498 loss in ranging
    bool allow_quiet_regime = false;
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
            // Use abs(pnl) to track magnitude of losses (pnl is negative for losses)
            double loss_magnitude = std::abs(pnl);
            avg_loss = ((avg_loss * (losing_trades - 1)) + loss_magnitude) / losing_trades;
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
    
    // Kelly Criterion position sizing
    // Returns optimal fraction of bankroll to bet (0.0 to 1.0)
    double get_kelly_fraction() const {
        if (total_trades < 10 || winning_trades == 0 || losing_trades == 0) {
            return 0.25;  // Default conservative 25% until we have data
        }
        
        // Kelly formula: f* = (p * b - q) / b
        // Where: p = win probability, q = loss probability (1-p)
        //        b = average win / average loss ratio
        double p = win_rate;
        double q = 1.0 - p;
        
        // Guard against division by zero
        if (avg_loss <= 0) {
            return 0.25;  // Default if no loss data
        }
        double b = avg_win / avg_loss;  // Both are now positive magnitudes
        
        double kelly = (p * b - q) / b;
        
        // Clamp and use fractional Kelly (25-50% of full Kelly for safety)
        const double KELLY_FRACTION = 0.25;  // Use 25% of full Kelly
        kelly = std::max(0.0, std::min(1.0, kelly));
        kelly *= KELLY_FRACTION;
        
        // Never bet more than 25% of bankroll
        return std::min(0.25, kelly);
    }
    
    // Calculate optimal position size based on Kelly and bankroll
    double get_optimal_position_size(double bankroll, double min_size, double max_size) const {
        double kelly = get_kelly_fraction();
        double optimal = bankroll * kelly;
        
        // Clamp to min/max
        return std::max(min_size, std::min(max_size, optimal));
    }

    double get_profit_factor() const {
        double gross_wins = avg_win * winning_trades;
        double gross_losses = avg_loss * losing_trades;  // avg_loss is already magnitude (positive)
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

// Market Regime enumeration
enum class MarketRegime { TRENDING, RANGING, VOLATILE, QUIET };

std::string regime_to_string(MarketRegime regime) {
    switch (regime) {
        case MarketRegime::TRENDING: return "TRENDING";
        case MarketRegime::RANGING: return "RANGING";
        case MarketRegime::VOLATILE: return "VOLATILE";
        case MarketRegime::QUIET: return "QUIET";
        default: return "UNKNOWN";
    }
}

struct ScanResult {
    std::string pair;
    double current_price = 0.0;
    double spread_pct = 0.0;
    double volatility_pct = 0.0;
    double momentum_pct = 0.0;
    double volume_usd = 0.0;
    double range_position = 0.0;
    bool is_bullish = false;
    bool is_bearish = false;   // NEW: Support SHORT trades
    std::string direction = "LONG";  // NEW: "LONG" or "SHORT"
    double signal_strength = 0.0;
    int suggested_hold_seconds = 600;
    double suggested_tp_pct = 1.5;
    double suggested_sl_pct = 0.5;
    MarketRegime regime = MarketRegime::RANGING;  // NEW: Market regime
    bool valid = false;
    
    // Technical indicators (populated from price history)
    double rsi = 50.0;              // RSI (0-100), 50 = neutral
    double macd_histogram = 0.0;    // MACD histogram
    double macd_line = 0.0;         // MACD line
    double macd_signal = 0.0;       // MACD signal line
    double sma_20 = 0.0;            // 20-period SMA
    double sma_50 = 0.0;            // 50-period SMA
    double ema_12 = 0.0;            // 12-period EMA (for MACD)
    double ema_26 = 0.0;            // 26-period EMA (for MACD)
    double atr = 0.0;               // Average True Range
    double atr_pct = 0.0;           // ATR as % of price
    
    // NEW: OBV and Ichimoku Cloud indicators
    double obv = 0.0;               // On-Balance Volume
    double tenkan_sen = 0.0;        // Ichimoku: Conversion Line
    double kijun_sen = 0.0;         // Ichimoku: Base Line
    double senkou_span_a = 0.0;     // Ichimoku: Leading Span A
    double senkou_span_b = 0.0;     // Ichimoku: Leading Span B
    double chikou_span = 0.0;       // Ichimoku: Lagging Span
};

// Price History Buffer for calculating indicators
struct PriceBar {
    double open;
    double high;
    double low;
    double close;
    double volume;
    long timestamp;
};

class TechnicalIndicators {
public:
    // Calculate RSI (Relative Strength Index)
    // Uses Wilder's smoothing method (standard RSI)
    static double calculate_rsi(const std::deque<PriceBar>& bars, int period = 14) {
        if (bars.size() < period + 1) return 50.0;  // Not enough data
        
        double avg_gain = 0.0, avg_loss = 0.0;
        
        // Calculate initial average gain/loss
        for (size_t i = bars.size() - period; i < bars.size(); i++) {
            double change = bars[i].close - bars[i-1].close;
            if (change > 0) avg_gain += change;
            else avg_loss += std::abs(change);
        }
        avg_gain /= period;
        avg_loss /= period;
        
        if (avg_loss == 0) return 100.0;  // All gains
        double rs = avg_gain / avg_loss;
        return 100.0 - (100.0 / (1.0 + rs));
    }
    
    // Calculate EMA (Exponential Moving Average)
    static double calculate_ema(const std::deque<PriceBar>& bars, int period) {
        if (bars.size() < (size_t)period) return bars.back().close;
        
        double multiplier = 2.0 / (period + 1.0);
        double ema = bars[bars.size() - period].close;  // Start with SMA of first period
        
        for (size_t i = bars.size() - period + 1; i < bars.size(); i++) {
            ema = (bars[i].close - ema) * multiplier + ema;
        }
        return ema;
    }
    
    // Calculate SMA (Simple Moving Average)
    static double calculate_sma(const std::deque<PriceBar>& bars, int period) {
        if (bars.size() < (size_t)period) return bars.back().close;
        
        double sum = 0.0;
        for (size_t i = bars.size() - period; i < bars.size(); i++) {
            sum += bars[i].close;
        }
        return sum / period;
    }
    
    // Calculate MACD (Moving Average Convergence Divergence)
    // Returns: {macd_line, signal_line, histogram}
    static std::tuple<double, double, double> calculate_macd(const std::deque<PriceBar>& bars, 
                                                              int fast = 12, int slow = 26, int signal = 9) {
        if (bars.size() < (size_t)slow + signal) {
            return {0.0, 0.0, 0.0};  // Not enough data
        }
        
        double ema_fast = calculate_ema(bars, fast);
        double ema_slow = calculate_ema(bars, slow);
        double macd_line = ema_fast - ema_slow;
        
        // Calculate signal line (EMA of MACD line)
        // This is a simplification - proper MACD needs historical MACD values
        // For now, use the current MACD as a proxy
        double signal_line = macd_line * 0.9;  // Simplified signal
        double histogram = macd_line - signal_line;
        
        return {macd_line, signal_line, histogram};
    }
    
    // Calculate ATR (Average True Range)
    static double calculate_atr(const std::deque<PriceBar>& bars, int period = 14) {
        if (bars.size() < (size_t)period + 1) return 0.0;
        
        double atr_sum = 0.0;
        for (size_t i = bars.size() - period; i < bars.size(); i++) {
            double high_low = bars[i].high - bars[i].low;
            double high_prev_close = std::abs(bars[i].high - bars[i-1].close);
            double low_prev_close = std::abs(bars[i].low - bars[i-1].close);
            double tr = std::max({high_low, high_prev_close, low_prev_close});
            atr_sum += tr;
        }
        return atr_sum / period;
    }
    
    // Calculate Bollinger Band position (0 = lower band, 1 = upper band)
    static double calculate_bb_position(const std::deque<PriceBar>& bars, int period = 20, double std_dev = 2.0) {
        if (bars.size() < (size_t)period) return 0.5;
        
        double sma = calculate_sma(bars, period);
        
        // Calculate standard deviation
        double sum_sq = 0.0;
        for (size_t i = bars.size() - period; i < bars.size(); i++) {
            double diff = bars[i].close - sma;
            sum_sq += diff * diff;
        }
        double std = std::sqrt(sum_sq / period);
        
        double upper_band = sma + (std_dev * std);
        double lower_band = sma - (std_dev * std);
        
        if (upper_band == lower_band) return 0.5;
        return (bars.back().close - lower_band) / (upper_band - lower_band);
    }
    
    // Calculate On-Balance Volume (OBV)
    static double calculate_obv(const std::deque<PriceBar>& bars) {
        if (bars.size() < 2) return 0.0;
        
        double obv = 0.0;
        for (size_t i = 1; i < bars.size(); i++) {
            if (bars[i].close > bars[i-1].close) {
                obv += bars[i].volume;
            } else if (bars[i].close < bars[i-1].close) {
                obv -= bars[i].volume;
            }
            // If close == prev close, OBV stays the same
        }
        return obv;
    }
    
    // Calculate Ichimoku Cloud components
    // Returns: {tenkan_sen, kijun_sen, senkou_span_a, senkou_span_b, chikou_span}
    static std::tuple<double, double, double, double, double> calculate_ichimoku(
        const std::deque<PriceBar>& bars) {
        
        if (bars.size() < 52) {
            // Not enough data for full Ichimoku calculation
            double price = bars.empty() ? 0.0 : bars.back().close;
            return {price, price, price, price, price};
        }
        
        // Tenkan-sen (Conversion Line): (9-period high + 9-period low) / 2
        double tenkan_high = bars[bars.size() - 9].high;
        double tenkan_low = bars[bars.size() - 9].low;
        for (size_t i = bars.size() - 9; i < bars.size(); i++) {
            tenkan_high = std::max(tenkan_high, bars[i].high);
            tenkan_low = std::min(tenkan_low, bars[i].low);
        }
        double tenkan_sen = (tenkan_high + tenkan_low) / 2.0;
        
        // Kijun-sen (Base Line): (26-period high + 26-period low) / 2
        double kijun_high = bars[bars.size() - 26].high;
        double kijun_low = bars[bars.size() - 26].low;
        for (size_t i = bars.size() - 26; i < bars.size(); i++) {
            kijun_high = std::max(kijun_high, bars[i].high);
            kijun_low = std::min(kijun_low, bars[i].low);
        }
        double kijun_sen = (kijun_high + kijun_low) / 2.0;
        
        // Senkou Span A (Leading Span A): (Tenkan-sen + Kijun-sen) / 2
        // Projected 26 periods ahead
        double senkou_span_a = (tenkan_sen + kijun_sen) / 2.0;
        
        // Senkou Span B (Leading Span B): (52-period high + 52-period low) / 2
        // Projected 26 periods ahead
        double senkou_high = bars[0].high;
        double senkou_low = bars[0].low;
        for (size_t i = 0; i < std::min((size_t)52, bars.size()); i++) {
            senkou_high = std::max(senkou_high, bars[bars.size() - 52 + i].high);
            senkou_low = std::min(senkou_low, bars[bars.size() - 52 + i].low);
        }
        double senkou_span_b = (senkou_high + senkou_low) / 2.0;
        
        // Chikou Span (Lagging Span): Current closing price shifted back 26 periods
        double chikou_span = bars.back().close;
        
        return {tenkan_sen, kijun_sen, senkou_span_a, senkou_span_b, chikou_span};
    }
};

class KrakenTradingBot {
public:
    KrakenTradingBot(BotConfig& cfg) : config(cfg) {
        api = std::make_unique<KrakenAPI>(config.paper_trading);
        learning_engine = std::make_unique<LearningEngine>();
        metrics.start_time = std::chrono::system_clock::now();
        
        // SQLite is the ONLY source of truth
        // Trades loaded automatically in LearningEngine constructor
        // No JSON fallback - SQLite must have data or start fresh
        
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
            // SQLite saves happen automatically in record_trade()
            // No need for JSON save on exit
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
    
    // Price history cache for technical indicators
    // Key: pair name, Value: deque of price bars (most recent at back)
    std::map<std::string, std::deque<PriceBar>> price_history;
    std::mutex price_history_mutex;
    static const size_t MAX_PRICE_HISTORY = 100;  // Store up to 100 bars per pair
    
    // Update price history for a pair from OHLC data
    void update_price_history(const std::string& pair, const std::vector<OHLC>& ohlc_data) {
        std::lock_guard<std::mutex> lock(price_history_mutex);
        
        auto& history = price_history[pair];
        
        for (const auto& candle : ohlc_data) {
            // Check if this bar is already in history (by timestamp)
            bool exists = false;
            for (const auto& bar : history) {
                if (bar.timestamp == candle.timestamp) {
                    exists = true;
                    break;
                }
            }
            
            if (!exists) {
                PriceBar bar;
                bar.open = candle.open;
                bar.high = candle.high;
                bar.low = candle.low;
                bar.close = candle.close;
                bar.volume = candle.volume;
                bar.timestamp = candle.timestamp;
                history.push_back(bar);
            }
        }
        
        // Keep only the most recent bars
        while (history.size() > MAX_PRICE_HISTORY) {
            history.pop_front();
        }
    }
    
    // Get price history for indicator calculations
    std::deque<PriceBar> get_price_history(const std::string& pair) {
        std::lock_guard<std::mutex> lock(price_history_mutex);
        if (price_history.count(pair)) {
            return price_history[pair];
        }
        return std::deque<PriceBar>();
    }
    
    // Calculate all technical indicators for a pair
    void calculate_indicators(ScanResult& result) {
        auto history = get_price_history(result.pair);
        
        if (history.size() < 15) {
            // Not enough data for meaningful indicators
            return;
        }
        
        // RSI (14-period)
        result.rsi = TechnicalIndicators::calculate_rsi(history, 14);
        
        // MACD (12, 26, 9)
        auto [macd_line, signal_line, histogram] = TechnicalIndicators::calculate_macd(history, 12, 26, 9);
        result.macd_line = macd_line;
        result.macd_signal = signal_line;
        result.macd_histogram = histogram;
        
        // Moving averages
        result.sma_20 = TechnicalIndicators::calculate_sma(history, std::min((size_t)20, history.size()));
        result.sma_50 = TechnicalIndicators::calculate_sma(history, std::min((size_t)50, history.size()));
        result.ema_12 = TechnicalIndicators::calculate_ema(history, std::min((size_t)12, history.size()));
        result.ema_26 = TechnicalIndicators::calculate_ema(history, std::min((size_t)26, history.size()));
        
        // ATR
        result.atr = TechnicalIndicators::calculate_atr(history, std::min((size_t)14, history.size() - 1));
        if (result.current_price > 0) {
            result.atr_pct = (result.atr / result.current_price) * 100.0;
        }
        
        // Bollinger Band position (updates range_position with more accurate value)
        double bb_pos = TechnicalIndicators::calculate_bb_position(history, 20, 2.0);
        if (history.size() >= 20) {
            result.range_position = bb_pos;  // Use BB position if we have enough data
        }
        
        // NEW: OBV (On-Balance Volume)
        result.obv = TechnicalIndicators::calculate_obv(history);
        
        // NEW: Ichimoku Cloud
        if (history.size() >= 52) {
            auto [tenkan, kijun, span_a, span_b, chikou] = TechnicalIndicators::calculate_ichimoku(history);
            result.tenkan_sen = tenkan;
            result.kijun_sen = kijun;
            result.senkou_span_a = span_a;
            result.senkou_span_b = span_b;
            result.chikou_span = chikou;
            
            // Log Ichimoku values for verification
            std::cout << "  📊 Ichimoku for " << result.pair << ": Tenkan=" << std::fixed << std::setprecision(2) 
                      << tenkan << ", Kijun=" << kijun << ", Span A=" << span_a 
                      << ", Span B=" << span_b << std::endl;
        }
    }

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
            // Get OHLC data to analyze recent price action AND update price history
            double trend_score = 0.0;
            int bullish_candles = 0;
            int bearish_candles = 0;
            try {
                auto ohlc = api->get_ohlc(pair, 15);  // 15-minute candles
                
                // Update price history for technical indicators
                if (!ohlc.empty()) {
                    update_price_history(pair, ohlc);
                }
                
                if (!ohlc.empty() && ohlc.size() >= 4) {
                    // Check last 4 candles (1 hour of 15-min data)
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
            
            // Calculate technical indicators from price history
            calculate_indicators(result);

            // MARKET REGIME DETECTION
            // Based on historical data analysis:
            // - Avg volatility: 2.82%, only 7.7% of trades > 8%
            // - VOLATILE (>4%) has 70% WR, RANGING loses money
            const double HIGH_VOL_THRESHOLD = 4.0;   // >4% = volatile (was 8%, too restrictive)
            const double LOW_VOL_THRESHOLD = 1.5;    // <1.5% = quiet
            const double TREND_THRESHOLD = 0.10;     // >10% trend score = trending
            
            if (result.volatility_pct > HIGH_VOL_THRESHOLD) {
                result.regime = MarketRegime::VOLATILE;
            } else if (result.volatility_pct < LOW_VOL_THRESHOLD) {
                result.regime = MarketRegime::QUIET;
            } else if (std::abs(trend_score) > TREND_THRESHOLD || bullish_candles >= 3 || bearish_candles >= 3) {
                result.regime = MarketRegime::TRENDING;
            } else {
                result.regime = MarketRegime::RANGING;
            }

            // ENTRY CRITERIA: Must have momentum and not be overextended
            // Bullish (LONG): upward momentum, not at extreme highs
            bool bullish = (result.momentum_pct > config.min_momentum_pct && 
                           result.range_position > 0.25 &&   // Not at lows (bounce zone)
                           result.range_position < 0.85);    // Not at extreme highs
            
            // Bearish (SHORT): downward momentum, not at extreme lows
            // Mirror the long criteria but inverted
            bool bearish = (result.momentum_pct < -config.min_momentum_pct &&  // Negative momentum
                           result.range_position < 0.75 &&   // Not at extreme highs (bounce zone)
                           result.range_position > 0.15);    // Not at extreme lows (potential reversal)

            if (!bullish && !bearish) return result;
            result.is_bullish = bullish;
            result.is_bearish = bearish;
            result.direction = bullish ? "LONG" : "SHORT";

            // Scoring - momentum weighted heavily (use absolute value for both directions)
            double mom_score = std::min(1.0, std::abs(result.momentum_pct) / 2.0);  // Scale to 2% for max (was 4%)
            double vol_score = std::min(1.0, result.volatility_pct / 5.0);          // Lower bar (was 8%)
            double spread_score = 1.0 - (result.spread_pct / config.max_spread_pct);
            double volume_score = std::min(1.0, result.volume_usd / 200000.0);      // Lowered (was 500k)

            // For shorts, adjust trend score (negative trend is good)
            if (bearish) {
                trend_score = -trend_score;  // Flip trend bonus for shorts
            }

            double history_bonus = 0.0;
            if (config.pair_trade_counts.count(pair) && config.pair_trade_counts[pair] >= 3) {
                double wr = config.pair_win_rates.count(pair) ? config.pair_win_rates[pair] : 0.5;
                history_bonus = (wr - 0.5) * 0.5;
            }

            // Reweighted: momentum 40%, volume 20%, trend 15%, spread 10%, volatility 10%, history 5%
            result.signal_strength = mom_score * 0.40 + volume_score * 0.20 + trend_score + spread_score * 0.10 + vol_score * 0.10 + history_bonus * 0.05;
            
            // MINIMUM CONFIDENCE THRESHOLD - increased to reduce overtrading
            // Was 0.35, now 0.55 to only take high-confidence trades
            const double MIN_CONFIDENCE_THRESHOLD = 0.55;
            if (result.signal_strength < MIN_CONFIDENCE_THRESHOLD) return result;

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
            
            // REGIME FILTER: Data shows VOLATILE regime has 70% WR, RANGING loses money
            if (config.regime_filter_enabled) {
                bool regime_allowed = false;
                switch (result.regime) {
                    case MarketRegime::VOLATILE:
                        regime_allowed = config.allow_volatile_regime;
                        break;
                    case MarketRegime::TRENDING:
                        regime_allowed = config.allow_trending_regime;
                        break;
                    case MarketRegime::RANGING:
                        regime_allowed = config.allow_ranging_regime;
                        break;
                    case MarketRegime::QUIET:
                        regime_allowed = config.allow_quiet_regime;
                        break;
                }
                if (!regime_allowed) {
                    std::cout << "  [REGIME BLOCKED] " << pair << " (regime: " << static_cast<int>(result.regime) 
                              << ", vol: " << result.volatility_pct << "%)" << std::endl;
                    return result;
                }
            }
            
            result.valid = true;
        } catch (...) {}
        return result;
    }

    void execute_trade(const ScanResult& opp) {
        std::string trade_id = "T" + std::to_string(std::time(nullptr)) + "_" + opp.pair;
        bool is_short = opp.direction == "SHORT";
        
        // LEARNING ENGINE INTEGRATION: Get optimal strategy from learned patterns
        StrategyConfig learned_config;
        {
            std::lock_guard<std::mutex> lock(learning_mutex);
            learned_config = learning_engine->get_optimal_strategy(opp.pair, opp.volatility_pct);
        }
        
        // KELLY CRITERION POSITION SIZING
        // Use Kelly-based position size if we have enough data, otherwise learned/default
        double position_usd;
        {
            std::lock_guard<std::mutex> lock(metrics_mutex);
            if (metrics.total_trades >= 10) {
                // We have enough data for Kelly calculation
                // Assume a conservative bankroll of $1000 for paper trading
                const double ASSUMED_BANKROLL = 1000.0;
                position_usd = metrics.get_optimal_position_size(
                    ASSUMED_BANKROLL, 
                    config.min_position_size_usd, 
                    config.max_position_size_usd
                );
                std::cout << "  📊 Kelly position size: $" << std::fixed << std::setprecision(2) 
                          << position_usd << " (Kelly: " << (metrics.get_kelly_fraction() * 100) << "%)" << std::endl;
            } else if (learned_config.position_size_usd > 0) {
                position_usd = learned_config.position_size_usd;
            } else {
                position_usd = config.base_position_size_usd;
            }
        }
        
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

        // PATTERN EDGE FILTER: Only trade if pattern has proven edge
        // LEARNING_MODE: When enabled, bypasses edge filter to gather pattern data
        if (!config.learning_mode) {
            std::lock_guard<std::mutex> lock(learning_mutex);
            // Use default hold time for pattern lookup (will be refined below)
            int default_hold = learned_config.timeframe_seconds > 0 ? learned_config.timeframe_seconds : config.default_hold_seconds;
            int timeframe_bucket = default_hold < 30 ? 0 : default_hold < 60 ? 1 : default_hold < 120 ? 2 : 3;
            
            // Use the existing public get_pattern_metrics method
            auto pattern_metrics = learning_engine->get_pattern_metrics(opp.pair, 1.0, timeframe_bucket);
            
            if (pattern_metrics.total_trades >= config.edge_filter_min_trades) {
                if (!pattern_metrics.has_edge || pattern_metrics.win_rate < config.edge_filter_min_winrate) {
                    std::cout << "⚠️ Skipping " << opp.pair << ": Pattern has no edge (WR: " 
                              << (pattern_metrics.win_rate * 100) << "%, PF: " 
                              << pattern_metrics.profit_factor << ")" << std::endl;
                    return;
                }
                std::cout << "✅ Pattern has edge! WR: " << (pattern_metrics.win_rate * 100) 
                          << "%, PF: " << pattern_metrics.profit_factor << std::endl;
            }
        } else {
            std::cout << "📊 LEARNING_MODE: Trading " << opp.pair << " to gather pattern data" << std::endl;
        }

        // LEARNING ENGINE: Override TP/SL with learned values if available
        double tp_pct = learned_config.take_profit_pct > 0 ? learned_config.take_profit_pct * 100.0 : 
                       (opp.suggested_tp_pct > 0 ? opp.suggested_tp_pct : config.take_profit_pct);
        double sl_pct = learned_config.stop_loss_pct > 0 ? learned_config.stop_loss_pct * 100.0 :
                       (opp.suggested_sl_pct > 0 ? opp.suggested_sl_pct : config.stop_loss_pct);
        int hold_time = learned_config.timeframe_seconds > 0 ? learned_config.timeframe_seconds :
                       (opp.suggested_hold_seconds > 0 ? opp.suggested_hold_seconds : config.default_hold_seconds);
        hold_time = std::max(config.min_hold_seconds, std::min(hold_time, config.max_hold_seconds));

        // REGIME-BASED STRATEGY ADJUSTMENT
        // Modify position size and targets based on market regime
        switch (opp.regime) {
            case MarketRegime::VOLATILE:
                // In volatile markets, reduce position size and widen stops
                position_usd *= 0.5;  // Half size
                sl_pct *= 1.5;        // Wider stop
                std::cout << "📊 VOLATILE regime - reducing position, widening stops" << std::endl;
                break;
            case MarketRegime::QUIET:
                // In quiet markets, skip trading (low opportunity)
                std::cout << "⚠️ Skipping " << opp.pair << ": QUIET market regime - waiting for opportunity" << std::endl;
                return;
            case MarketRegime::TRENDING:
                // In trending markets, use momentum strategy with trailing stops
                hold_time = std::min(hold_time * 2, config.max_hold_seconds);  // Hold longer
                std::cout << "📈 TRENDING regime - extended hold time, momentum strategy" << std::endl;
                break;
            case MarketRegime::RANGING:
                // In ranging markets, use mean reversion with tighter targets
                tp_pct *= 0.8;  // Tighter TP
                std::cout << "↔️ RANGING regime - tighter targets, mean reversion" << std::endl;
                break;
        }

        // FEE-AWARE TRADING: Only trade if expected profit > fees
        // Round-trip fee is 0.8% (0.4% entry + 0.4% exit)
        const double FEE_RATE = 0.008;  // 0.8% round-trip fees
        const double MIN_PROFIT_BUFFER = 0.001;  // 0.1% buffer above fees
        double expected_fees_pct = FEE_RATE * 100.0;  // Convert to percentage (0.8%)
        double min_required_tp = expected_fees_pct + (MIN_PROFIT_BUFFER * 100.0);  // 0.9% minimum
        
        // Also check if expected profit (TP * win_rate - SL * loss_rate) > fees
        double estimated_win_rate = learned_config.is_validated ? 0.55 : 0.50;  // Conservative estimate
        double expected_profit = (tp_pct * estimated_win_rate) - (sl_pct * (1.0 - estimated_win_rate));
        
        bool passes_fee_filter = (tp_pct >= min_required_tp) && (expected_profit >= expected_fees_pct);
        
        if (!passes_fee_filter) {
            if (config.learning_mode) {
                // In learning mode, allow trade but log that it wouldn't pass fee filter
                std::cout << "📚 LEARNING: Trading " << opp.pair << " despite low expected profit (" 
                          << expected_profit << "% vs " << expected_fees_pct << "% fees)" << std::endl;
            } else {
                // In production mode, skip trades that don't cover fees
                if (tp_pct < min_required_tp) {
                    std::cout << "⚠️ Skipping " << opp.pair << ": TP " << tp_pct << "% < min required " 
                              << min_required_tp << "% (fees + buffer)" << std::endl;
                } else {
                    std::cout << "⚠️ Skipping " << opp.pair << ": Expected profit " << expected_profit 
                              << "% < fees " << expected_fees_pct << "%" << std::endl;
                }
                return;
            }
        }

        std::cout << "\n--- ENTER " << opp.direction << " " << opp.pair << " ---" << std::endl;
        std::cout << "  Direction: " << (is_short ? "📉 SHORT" : "📈 LONG") << std::endl;
        std::cout << "  Price: $" << std::fixed << std::setprecision(6) << confirmed_entry_price << std::endl;
        std::cout << "  Position: $" << position_usd << " (" << amount << " units)" << std::endl;
        std::cout << "  TP: " << tp_pct << "% | SL: " << sl_pct << "% | Max: " << hold_time << "s" << std::endl;
        std::cout << "  📊 Expected profit: " << std::setprecision(2) << expected_profit << "% (after " << expected_fees_pct << "% fees)" << std::endl;
        if (learned_config.is_validated) {
            std::cout << "  🧠 USING LEARNED STRATEGY | Edge: " << std::setprecision(1) 
                      << learned_config.estimated_edge << "%" << std::endl;
        }

        // For LONG: buy first, sell to close
        // For SHORT: sell first, buy to close (simulated in paper trading)
        std::string entry_side = is_short ? "sell" : "buy";
        Order entry_order = api->place_market_order(opp.pair, entry_side, amount);
        if (entry_order.status == "error") {
            std::cerr << "Entry failed: " << entry_order.order_id << std::endl;
            return;
        }

        double entry_price = confirmed_entry_price;  // Use the confirmed price
        
        // TP/SL prices are different for LONG vs SHORT
        // LONG: TP is above entry, SL is below entry
        // SHORT: TP is below entry (price drops = profit), SL is above entry (price rises = loss)
        double tp_price, sl_price, trailing_start;
        if (is_short) {
            tp_price = entry_price * (1.0 - tp_pct / 100.0);  // TP when price drops
            sl_price = entry_price * (1.0 + sl_pct / 100.0);  // SL when price rises
            trailing_start = entry_price * (1.0 - config.trailing_start_pct / 100.0);  // Trailing starts on drop
        } else {
            tp_price = entry_price * (1.0 + tp_pct / 100.0);  // TP when price rises
            sl_price = entry_price * (1.0 - sl_pct / 100.0);  // SL when price drops
            trailing_start = entry_price * (1.0 + config.trailing_start_pct / 100.0);  // Trailing starts on rise
        }
        
        double best_price = entry_price;  // Track best price (highest for long, lowest for short)
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

                // Update best price and trailing stop based on direction
                if (is_short) {
                    // For SHORT: track lowest price (best for us)
                    if (current < best_price) {
                        best_price = current;
                        if (trailing_active) {
                            trailing_stop = best_price * (1.0 + config.trailing_stop_pct / 100.0);
                        }
                    }
                    
                    // Activate trailing when price drops enough
                    if (!trailing_active && current <= trailing_start) {
                        trailing_active = true;
                        trailing_stop = current * (1.0 + config.trailing_stop_pct / 100.0);
                        std::cout << "  [" << opp.pair << " SHORT] Trailing activated at $" << current << std::endl;
                    }
                    
                    // SHORT TP: price dropped to target
                    if (current <= tp_price) {
                        exit_reason = "take_profit";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " SHORT] TP HIT at $" << current << std::endl;
                        break;
                    }
                    
                    // SHORT SL: price rose against us
                    if (current >= sl_price) {
                        exit_reason = "stop_loss";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " SHORT] SL HIT at $" << current << std::endl;
                        break;
                    }
                    
                    // SHORT trailing: price bounced up from our best
                    if (trailing_active && current >= trailing_stop) {
                        exit_reason = "trailing_stop";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " SHORT] TRAIL HIT at $" << current << std::endl;
                        break;
                    }
                } else {
                    // For LONG: track highest price (best for us)
                    if (current > best_price) {
                        best_price = current;
                        if (trailing_active) {
                            trailing_stop = best_price * (1.0 - config.trailing_stop_pct / 100.0);
                        }
                    }

                    if (!trailing_active && current >= trailing_start) {
                        trailing_active = true;
                        trailing_stop = current * (1.0 - config.trailing_stop_pct / 100.0);
                        std::cout << "  [" << opp.pair << " LONG] Trailing activated at $" << current << std::endl;
                    }

                    if (current >= tp_price) {
                        exit_reason = "take_profit";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " LONG] TP HIT at $" << current << std::endl;
                        break;
                    }

                    if (current <= sl_price) {
                        exit_reason = "stop_loss";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " LONG] SL HIT at $" << current << std::endl;
                        break;
                    }

                    if (trailing_active && current <= trailing_stop) {
                        exit_reason = "trailing_stop";
                        exit_price = current;
                        std::cout << "  [" << opp.pair << " LONG] TRAIL HIT at $" << current << std::endl;
                        break;
                    }
                }  // end of LONG-specific logic

                if (elapsed >= hold_time) {
                    exit_price = current;
                    break;
                }

                if (elapsed % 30 == 0 && elapsed > 0) {
                    // P&L display is different for LONG vs SHORT
                    double change_pct;
                    if (is_short) {
                        change_pct = ((entry_price - current) / entry_price) * 100.0;  // SHORT: profit when price drops
                    } else {
                        change_pct = ((current - entry_price) / entry_price) * 100.0;  // LONG: profit when price rises
                    }
                    std::cout << "  [" << opp.pair << " " << opp.direction << "] " << elapsed << "s: $" << current 
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

        // Exit order: For LONG we sell, for SHORT we buy to close
        std::string exit_side = is_short ? "buy" : "sell";
        Order exit_order = api->place_market_order(opp.pair, exit_side, amount);

        // A trade is only valid if we got at least one price update during monitoring
        // Since we confirm price at entry, this means the API worked at least once
        // If we never got updates, something went very wrong - skip recording
        if (successful_price_updates == 0) {
            std::cerr << "\n--- INVALID TRADE " << opp.pair << " ---" << std::endl;
            std::cerr << "  No price updates received during " << hold_time << "s monitoring period" << std::endl;
            std::cerr << "  This trade will NOT be recorded to preserve data integrity" << std::endl;
            return;  // Don't record - we have no valid data
        }

        // P&L calculation: LONG profits when price goes up, SHORT profits when price goes down
        double pnl_pct;
        if (is_short) {
            pnl_pct = ((entry_price - exit_price) / entry_price) * 100.0;  // SHORT: profit when price drops
        } else {
            pnl_pct = ((exit_price - entry_price) / entry_price) * 100.0;  // LONG: profit when price rises
        }
        double pnl_usd = position_usd * (pnl_pct / 100.0);
        double fees = position_usd * 0.008;  // 0.8% round-trip: 0.4% entry + 0.4% exit
        double net_pnl = pnl_usd - fees;
        bool is_win = net_pnl > 0;

        std::string direction = is_short ? "SHORT" : "LONG";

        auto hold_duration = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::system_clock::now() - entry_time).count();

        std::cout << "\n--- EXIT " << direction << " " << opp.pair << " [" << exit_reason << "] ---" << std::endl;
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
            trade.direction = direction;  // "LONG" or "SHORT"
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
            
            // Technical indicators from price history calculations
            trade.rsi = opp.rsi;
            trade.macd_histogram = opp.macd_histogram;
            trade.macd_signal = opp.macd_signal;
            trade.bb_position = opp.range_position;
            trade.atr_pct = opp.atr_pct > 0 ? opp.atr_pct : opp.volatility_pct;
            
            // NEW: OBV and Ichimoku Cloud indicators
            trade.obv = opp.obv;
            trade.tenkan_sen = opp.tenkan_sen;
            trade.kijun_sen = opp.kijun_sen;
            trade.senkou_span_a = opp.senkou_span_a;
            trade.senkou_span_b = opp.senkou_span_b;
            trade.chikou_span = opp.chikou_span;
            
            // Momentum score: normalize momentum_pct to -1 to 1 range
            trade.momentum_score = std::max(-1.0, std::min(1.0, opp.momentum_pct / 10.0));
            
            // Volume ratio: normalize against 100k baseline
            trade.volume_ratio = opp.volume_usd / 100000.0;
            
            // Trend direction from entry signal
            trade.trend_direction = opp.is_bullish ? 1.0 : (opp.is_bearish ? -1.0 : 0.0);
            
            // Market regime: map enum to int
            switch (opp.regime) {
                case MarketRegime::TRENDING:
                    trade.market_regime = opp.is_bullish ? 1 : -1;  // Trending up or down
                    break;
                case MarketRegime::VOLATILE:
                    trade.market_regime = 2;  // High volatility regime
                    break;
                case MarketRegime::QUIET:
                    trade.market_regime = -2;  // Low volatility regime
                    break;
                default:
                    trade.market_regime = 0;  // Ranging/consolidation
            }
            
            // Validate trade before recording
            if (!LearningEngine::validate_trade(trade)) {
                std::cerr << "⚠️ Trade failed validation - not recording to preserve data integrity" << std::endl;
            } else {
                learning_engine->record_trade(trade);
                
                // SQLite saves automatically in record_trade()
                // Log milestone trades
                if (learning_engine->get_trade_count() % 50 == 0) {
                    std::cout << "� Milestone: " << learning_engine->get_trade_count() << " trades in database" << std::endl;
                }
            }
            
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

    // Load config from JSON file if it exists
    // Bot runs from bot/build/, so path is ../../config/bot_config.json
    std::string config_path = "../../config/bot_config.json";
    std::ifstream config_file(config_path);
    if (config_file.is_open()) {
        try {
            std::string config_content((std::istreambuf_iterator<char>(config_file)),
                                       std::istreambuf_iterator<char>());
            config_file.close();
            
            // Parse learning_mode from config
            auto find_bool = [&](const std::string& key) -> bool {
                size_t pos = config_content.find("\"" + key + "\"");
                if (pos != std::string::npos) {
                    pos = config_content.find(":", pos);
                    if (pos != std::string::npos) {
                        std::string val = config_content.substr(pos + 1, 20);
                        return val.find("true") != std::string::npos;
                    }
                }
                return false;
            };
            
            auto find_int = [&](const std::string& key) -> int {
                size_t pos = config_content.find("\"" + key + "\"");
                if (pos != std::string::npos) {
                    pos = config_content.find(":", pos);
                    if (pos != std::string::npos) {
                        return std::stoi(config_content.substr(pos + 1, 10));
                    }
                }
                return 0;
            };
            
            auto find_double = [&](const std::string& key) -> double {
                size_t pos = config_content.find("\"" + key + "\"");
                if (pos != std::string::npos) {
                    pos = config_content.find(":", pos);
                    if (pos != std::string::npos) {
                        return std::stod(config_content.substr(pos + 1, 15));
                    }
                }
                return 0.0;
            };
            
            config.learning_mode = find_bool("learning_mode");
            int edge_min_trades = find_int("edge_filter_min_trades");
            if (edge_min_trades > 0) config.edge_filter_min_trades = edge_min_trades;
            double edge_min_wr = find_double("edge_filter_min_winrate");
            if (edge_min_wr > 0) config.edge_filter_min_winrate = edge_min_wr;
            
            // Load risk management parameters
            double tp = find_double("take_profit_pct");
            if (tp > 0) config.take_profit_pct = tp;
            double sl = find_double("stop_loss_pct");
            if (sl > 0) config.stop_loss_pct = sl;
            double trail_start = find_double("trailing_start_pct");
            if (trail_start > 0) config.trailing_start_pct = trail_start;
            double trail_stop = find_double("trailing_stop_pct");
            if (trail_stop > 0) config.trailing_stop_pct = trail_stop;
            
            // Load blacklisted pairs from config
            // Format: "blacklisted_pairs": ["BONKUSD", "ADAUSD", ...]
            size_t blacklist_pos = config_content.find("\"blacklisted_pairs\"");
            if (blacklist_pos != std::string::npos) {
                size_t arr_start = config_content.find("[", blacklist_pos);
                size_t arr_end = config_content.find("]", arr_start);
                if (arr_start != std::string::npos && arr_end != std::string::npos) {
                    std::string arr_content = config_content.substr(arr_start + 1, arr_end - arr_start - 1);
                    size_t quote_start = 0;
                    while ((quote_start = arr_content.find("\"", quote_start)) != std::string::npos) {
                        size_t quote_end = arr_content.find("\"", quote_start + 1);
                        if (quote_end != std::string::npos) {
                            std::string pair = arr_content.substr(quote_start + 1, quote_end - quote_start - 1);
                            if (!pair.empty()) {
                                config.blacklisted_pairs.insert(pair);
                            }
                            quote_start = quote_end + 1;
                        } else break;
                    }
                }
            }
            
            std::cout << "Loaded config from " << config_path << std::endl;
            std::cout << "  learning_mode: " << (config.learning_mode ? "true" : "false") << std::endl;
            std::cout << "  edge_filter_min_trades: " << config.edge_filter_min_trades << std::endl;
            std::cout << "  edge_filter_min_winrate: " << config.edge_filter_min_winrate << std::endl;
            std::cout << "  take_profit_pct: " << config.take_profit_pct << "%" << std::endl;
            std::cout << "  stop_loss_pct: " << config.stop_loss_pct << "%" << std::endl;
            std::cout << "  trailing_start_pct: " << config.trailing_start_pct << "%" << std::endl;
            std::cout << "  trailing_stop_pct: " << config.trailing_stop_pct << "%" << std::endl;
            std::cout << "  regime_filter: VOLATILE only (RANGING/TRENDING blocked)" << std::endl;
            if (!config.blacklisted_pairs.empty()) {
                std::cout << "  blacklisted_pairs: " << config.blacklisted_pairs.size() << " pairs (";
                int count = 0;
                for (const auto& p : config.blacklisted_pairs) {
                    if (count++ > 0) std::cout << ", ";
                    std::cout << p;
                    if (count >= 5) { std::cout << "..."; break; }
                }
                std::cout << ")" << std::endl;
            }
        } catch (const std::exception& e) {
            std::cerr << "Error parsing config: " << e.what() << std::endl;
        }
    } else {
        std::cout << "No config file found at " << config_path << ", using defaults" << std::endl;
    }

    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--live") config.paper_trading = false;
        else if (arg == "--paper") config.paper_trading = true;
        else if (arg == "--learning") config.learning_mode = true;
        else if (arg == "--no-learning") config.learning_mode = false;
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
