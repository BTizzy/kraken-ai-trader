#pragma once

#include <string>
#include <vector>
#include <map>
#include <deque>
#include <mutex>
#include <memory>
#include <chrono>
#include <sqlite3.h>
#include "learning_engine.hpp"

/*
 * SHARED MARKET DATA CACHE
 *
 * Provides real-time market data access for both the market collector
 * and learning engine. Ensures thread-safe access to live market data.
 */

class MarketDataCache {
public:
    static MarketDataCache& getInstance() {
        static MarketDataCache instance;
        return instance;
    }

    // Market data point structure (matches learning engine)
    struct MarketDataPoint {
        std::string pair;
        double bid_price;
        double ask_price;
        double last_price;
        double volume;
        double vwap;
        int64_t timestamp;
        double volatility_pct;
        int market_regime;
    };

    // Update market data (called by collector)
    void updateMarketData(const MarketDataPoint& data);

    // Get latest data for a pair
    MarketDataPoint getLatestData(const std::string& pair) const;

    // Get recent data for analysis
    std::vector<MarketDataPoint> getRecentData(const std::string& pair, int minutes = 60) const;

    // Get all active pairs
    std::vector<std::string> getActivePairs() const;

    // Calculate real-time metrics
    double calculateVolatility(const std::string& pair, int minutes = 30) const;
    int detectRegime(const std::string& pair, int minutes = 60) const;

    // Database persistence for market data
    void initDatabase(const std::string& db_path = "../../data/market_data.db");
    void saveToDatabase() const;

private:
    MarketDataCache() = default;
    ~MarketDataCache() = default;
    MarketDataCache(const MarketDataCache&) = delete;
    MarketDataCache& operator=(const MarketDataCache&) = delete;

    // Data storage
    std::map<std::string, std::deque<MarketDataPoint>> market_data_;
    std::map<std::string, MarketDataPoint> latest_data_;
    mutable std::mutex data_mutex_;

    // Database
    sqlite3* db_ = nullptr;
    std::string db_path_;

    // Constants
    static const size_t MAX_DATA_POINTS = 2000;  // Store last 2000 points per pair

    // Database helpers
    void createTables();
    void loadFromDatabase();
};