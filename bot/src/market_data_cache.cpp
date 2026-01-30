#include "market_data_cache.hpp"
#include <iostream>
#include <algorithm>
#include <numeric>
#include <cmath>

void MarketDataCache::updateMarketData(const MarketDataPoint& data) {
    std::lock_guard<std::mutex> lock(data_mutex_);

    // Update latest data
    latest_data_[data.pair] = data;

    // Add to historical data
    market_data_[data.pair].push_back(data);

    // Maintain size limit
    if (market_data_[data.pair].size() > MAX_DATA_POINTS) {
        market_data_[data.pair].pop_front();
    }
}

MarketDataCache::MarketDataPoint MarketDataCache::getLatestData(const std::string& pair) const {
    std::lock_guard<std::mutex> lock(data_mutex_);

    auto it = latest_data_.find(pair);
    if (it != latest_data_.end()) {
        return it->second;
    }

    // Return empty data if not found
    return MarketDataPoint{pair, 0.0, 0.0, 0.0, 0.0, 0.0, 0, 0.0, 0};
}

std::vector<MarketDataCache::MarketDataPoint> MarketDataCache::getRecentData(const std::string& pair, int minutes) const {
    std::lock_guard<std::mutex> lock(data_mutex_);

    auto it = market_data_.find(pair);
    if (it == market_data_.end()) {
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

std::vector<std::string> MarketDataCache::getActivePairs() const {
    std::lock_guard<std::mutex> lock(data_mutex_);

    std::vector<std::string> pairs;
    for (const auto& [pair, _] : latest_data_) {
        pairs.push_back(pair);
    }
    return pairs;
}

double MarketDataCache::calculateVolatility(const std::string& pair, int minutes) const {
    auto recent_data = getRecentData(pair, minutes);

    if (recent_data.size() < 10) {
        return 0.0;
    }

    std::vector<double> returns;
    for (size_t i = 1; i < recent_data.size(); ++i) {
        double ret = (recent_data[i].last_price - recent_data[i-1].last_price) / recent_data[i-1].last_price;
        returns.push_back(std::abs(ret));
    }

    if (returns.empty()) return 0.0;

    double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
    double variance = 0.0;
    for (double ret : returns) {
        variance += std::pow(ret - mean, 2);
    }
    variance /= returns.size();

    return std::sqrt(variance) * 100.0;
}

int MarketDataCache::detectRegime(const std::string& pair, int minutes) const {
    auto recent_data = getRecentData(pair, minutes);

    if (recent_data.size() < 20) {
        return 0;  // Consolidation
    }

    double start_price = recent_data.front().last_price;
    double end_price = recent_data.back().last_price;
    double price_change = (end_price - start_price) / start_price * 100.0;

    double volatility = calculateVolatility(pair, minutes);

    if (std::abs(price_change) > volatility * 2) {
        return (price_change > 0) ? 1 : -1;  // Strong trend
    } else if (volatility > 1.0) {
        return 2;  // Volatile
    } else {
        return 0;  // Consolidation
    }
}

void MarketDataCache::initDatabase(const std::string& db_path) {
    db_path_ = db_path;

    int rc = sqlite3_open(db_path.c_str(), &db_);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to open market data database: " << sqlite3_errmsg(db_) << std::endl;
        db_ = nullptr;
        return;
    }

    createTables();
    loadFromDatabase();

    std::cout << "Market data cache database initialized: " << db_path << std::endl;
}

void MarketDataCache::createTables() {
    if (!db_) return;

    const char* create_sql = R"(
        CREATE TABLE IF NOT EXISTS market_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pair TEXT NOT NULL,
            bid_price REAL,
            ask_price REAL,
            last_price REAL,
            volume REAL,
            vwap REAL,
            timestamp INTEGER,
            volatility_pct REAL,
            market_regime INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(pair, timestamp)
        );
        CREATE INDEX IF NOT EXISTS idx_market_timestamp ON market_data(timestamp);
        CREATE INDEX IF NOT EXISTS idx_market_pair ON market_data(pair);
    )";

    char* err_msg = nullptr;
    int rc = sqlite3_exec(db_, create_sql, nullptr, nullptr, &err_msg);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to create market data tables: " << err_msg << std::endl;
        sqlite3_free(err_msg);
    }
}

void MarketDataCache::loadFromDatabase() {
    if (!db_) return;

    const char* select_sql = R"(
        SELECT pair, bid_price, ask_price, last_price, volume, vwap, timestamp, volatility_pct, market_regime
        FROM market_data
        ORDER BY timestamp DESC
        LIMIT 10000
    )";

    sqlite3_stmt* stmt;
    int rc = sqlite3_prepare_v2(db_, select_sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to prepare market data select: " << sqlite3_errmsg(db_) << std::endl;
        return;
    }

    while (sqlite3_step(stmt) == SQLITE_ROW) {
        MarketDataPoint data;
        data.pair = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
        data.bid_price = sqlite3_column_double(stmt, 1);
        data.ask_price = sqlite3_column_double(stmt, 2);
        data.last_price = sqlite3_column_double(stmt, 3);
        data.volume = sqlite3_column_double(stmt, 4);
        data.vwap = sqlite3_column_double(stmt, 5);
        data.timestamp = sqlite3_column_int64(stmt, 6);
        data.volatility_pct = sqlite3_column_double(stmt, 7);
        data.market_regime = sqlite3_column_int(stmt, 8);

        updateMarketData(data);
    }

    sqlite3_finalize(stmt);
}

void MarketDataCache::saveToDatabase() const {
    if (!db_) return;

    std::lock_guard<std::mutex> lock(data_mutex_);

    const char* insert_sql = R"(
        INSERT OR IGNORE INTO market_data
        (pair, bid_price, ask_price, last_price, volume, vwap, timestamp, volatility_pct, market_regime)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    )";

    sqlite3_stmt* stmt;
    int rc = sqlite3_prepare_v2(db_, insert_sql, -1, &stmt, nullptr);
    if (rc != SQLITE_OK) {
        std::cerr << "Failed to prepare market data insert: " << sqlite3_errmsg(db_) << std::endl;
        return;
    }

    for (const auto& [pair, data_deque] : market_data_) {
        for (const auto& data : data_deque) {
            sqlite3_bind_text(stmt, 1, data.pair.c_str(), -1, SQLITE_TRANSIENT);
            sqlite3_bind_double(stmt, 2, data.bid_price);
            sqlite3_bind_double(stmt, 3, data.ask_price);
            sqlite3_bind_double(stmt, 4, data.last_price);
            sqlite3_bind_double(stmt, 5, data.volume);
            sqlite3_bind_double(stmt, 6, data.vwap);
            sqlite3_bind_int64(stmt, 7, data.timestamp);
            sqlite3_bind_double(stmt, 8, data.volatility_pct);
            sqlite3_bind_int(stmt, 9, data.market_regime);

            rc = sqlite3_step(stmt);
            if (rc != SQLITE_DONE) {
                std::cerr << "Failed to insert market data: " << sqlite3_errmsg(db_) << std::endl;
            }

            sqlite3_reset(stmt);
        }
    }

    sqlite3_finalize(stmt);
}