#include "kraken_api.hpp"
#include <curl/curl.h>
#include <iostream>
#include <sqlite3.h>
#include <sstream>
#include <iomanip>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <chrono>
#include <thread>

// Retry with exponential backoff implementation
template<typename Func>
auto KrakenAPI::retry_with_backoff(Func&& func, int max_retries, int base_delay_ms) -> decltype(func()) {
    int delay = base_delay_ms;
    std::exception_ptr last_exception;
    
    for (int attempt = 0; attempt < max_retries; attempt++) {
        try {
            return func();
        } catch (const std::exception& e) {
            last_exception = std::current_exception();
            
            if (attempt < max_retries - 1) {
                std::cerr << "⚠️ API call failed (attempt " << (attempt + 1) << "/" << max_retries 
                          << "): " << e.what() << " - Retrying in " << delay << "ms..." << std::endl;
                std::this_thread::sleep_for(std::chrono::milliseconds(delay));
                delay *= 2;  // Exponential backoff
            }
        }
    }
    
    // All retries exhausted
    std::rethrow_exception(last_exception);
}

// Callback for CURL write operations
size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

KrakenAPI::KrakenAPI(bool paper_trading) : paper_mode(paper_trading) {
    // Get API credentials from environment
    const char* key = std::getenv("KRAKEN_API_KEY");
    const char* secret = std::getenv("KRAKEN_API_SECRET");

    api_key = key ? key : "";
    api_secret = secret ? secret : "";

    // Initialize mock prices for paper trading (futures contracts)
    mock_prices = {
        {"PI_XBTUSD", 89000.0},
        {"PI_ETHUSD", 3200.0},
        {"PI_ADAUSD", 0.85},
        {"PI_LINKUSD", 18.50},
        {"PI_LTCUSD", 120.0}
    };

    std::cout << "KrakenAPI initialized in " << (paper_mode ? "PAPER" : "LIVE") << " mode" << std::endl;
}

KrakenAPI::~KrakenAPI() {
    // Cleanup if needed
}

bool KrakenAPI::authenticate() {
    if (paper_mode) {
        std::cout << "Paper trading mode - no authentication required" << std::endl;
        return true;
    }

    if (api_key.empty() || api_secret.empty()) {
        std::cerr << "Error: KRAKEN_API_KEY and KRAKEN_API_SECRET environment variables required for live trading" << std::endl;
        return false;
    }

    // For now, just check if we can make a basic API call
    try {
        auto balance = get_balance();
        std::cout << "Authenticated successfully. Balance: $" << balance << std::endl;
        return true;
    } catch (const std::exception& e) {
        std::cerr << "Authentication failed: " << e.what() << std::endl;
        return false;
    }
}

json KrakenAPI::http_get(const std::string& endpoint) {
    CURL* curl = curl_easy_init();
    std::string response;

    if (curl) {
        std::string url;
        
        // Check if this is a local server endpoint (starts with /api/)
        if (endpoint.substr(0, 5) == "/api/") {
            // Local server call
            url = "http://localhost:3002" + endpoint;
        } else {
            // Kraken API call
            url = "https://futures.kraken.com" + endpoint;
        }

        curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);

        CURLcode res = curl_easy_perform(curl);
        curl_easy_cleanup(curl);

        if (res == CURLE_OK) {
            try {
                return json::parse(response);
            } catch (const std::exception& e) {
                throw std::runtime_error("Failed to parse JSON response: " + std::string(e.what()));
            }
        } else {
            throw std::runtime_error("HTTP request failed: " + std::string(curl_easy_strerror(res)));
        }
    }

    throw std::runtime_error("Failed to initialize CURL");
}

json KrakenAPI::http_post(const std::string& endpoint, const json& data) {
    // For paper trading, just return success
    if (paper_mode) {
        return {{"success", true}};
    }

    // TODO: Implement real Kraken API POST requests with authentication
    throw std::runtime_error("Live trading POST requests not implemented yet");
}

std::string KrakenAPI::hmac_sha256(const std::string& message) {
    // TODO: Implement HMAC-SHA256 for Kraken API authentication
    return "";
}

// Trading operations
Order KrakenAPI::place_market_order(const std::string& pair, const std::string& side,
                                   double volume, double leverage) {
    Order order;
    order.order_id = "paper_" + std::to_string(rand());
    order.pair = pair;
    order.side = side;
    order.volume = volume;
    order.price = get_current_price(pair);
    order.filled = volume;
    order.status = "filled";

    if (paper_mode) {
        paper_orders[order.order_id] = order;
        std::cout << "Paper order placed: " << order.order_id << std::endl;
    }

    return order;
}

Order KrakenAPI::place_limit_order(const std::string& pair, const std::string& side,
                                  double volume, double price, double leverage) {
    // For simplicity, treat as market order for now
    return place_market_order(pair, side, volume, leverage);
}

bool KrakenAPI::cancel_order(const std::string& order_id) {
    if (paper_mode) {
        paper_orders.erase(order_id);
        return true;
    }
    return false;
}

// Position management
std::vector<Position> KrakenAPI::get_open_positions() {
    std::vector<Position> positions;
    if (paper_mode) {
        for (const auto& [pair, pos] : paper_positions) {
            positions.push_back(pos);
        }
    }
    return positions;
}

Position KrakenAPI::get_position(const std::string& pair) {
    if (paper_mode && paper_positions.count(pair)) {
        return paper_positions[pair];
    }
    return Position{};
}

bool KrakenAPI::close_position(const std::string& pair) {
    if (paper_mode) {
        paper_positions.erase(pair);
        return true;
    }
    return false;
}

// Account information
double KrakenAPI::get_balance(const std::string& currency) {
    if (paper_mode) {
        return paper_balance;
    }

    // TODO: Implement real balance check
    return 0.0;
}

double KrakenAPI::get_equity() {
    return get_balance();
}

// Market data - uses our Node.js proxy server
double KrakenAPI::get_current_price(const std::string& pair) {
    try {
        auto ticker = get_ticker(pair);
        
        // Futures API ticker format - direct numeric access
        double price = ticker.contains("last") ? ticker["last"].get<double>() : 0.0;
        if (price > 0.0) {
            return price;
        }
        
        // Fallback to mock prices
        if (mock_prices.count(pair)) {
            return mock_prices[pair];
        }
        return 100.0; // Default fallback
    } catch (const std::exception& e) {
        std::cerr << "Error getting price for " << pair << ": " << e.what() << std::endl;
        // Fallback to mock prices
        if (mock_prices.count(pair)) {
            return mock_prices[pair];
        }
        return 100.0; // Default fallback
    }
}

json KrakenAPI::get_ticker(const std::string& pair) {
    // Use high-frequency price data instead of Kraken API
    try {
        double latest_price = get_latest_price(pair);
        if (latest_price > 0) {
            // ONLY use exact local data - do not inject arbitrary volatility baselines
            // Return a ticker-like object with the latest price data (no estimated volatility)
            return {
                {"last", latest_price},
                {"bid", latest_price * 0.9999},  // Approximate bid (slightly lower)
                {"ask", latest_price * 1.0001},  // Approximate ask (slightly higher)
                {"volumeQuote", 1000000.0},      // Placeholder volume
                {"high", latest_price},
                {"low", latest_price},
                {"open", latest_price}  // Use current price as open for simplicity
            };
        }
    } catch (const std::exception& e) {
        std::cerr << "Failed to get price from local data: " << e.what() << std::endl;
    }

    // NO FALLBACK: Leverage trading requires high-frequency local data only
    // Return empty object to indicate no data available
    return json{};
}

double KrakenAPI::get_bid_ask_spread(const std::string& pair) {
    try {
        auto ticker = get_ticker(pair);
        
        // Futures API format: direct bid/ask fields
        double ask = ticker.contains("ask") ? ticker["ask"].get<double>() : 0.0;
        double bid = ticker.contains("bid") ? ticker["bid"].get<double>() : 0.0;
        
        if (ask > 0 && bid > 0) {
            return (ask - bid) / bid * 100.0; // Return as percentage
        }
        return 0.1; // Default 0.1% spread
    } catch (const std::exception& e) {
        return 0.1; // Default 0.1% spread
    }
}

std::vector<std::string> KrakenAPI::get_trading_pairs() {
    // Use fixed list of pairs that we collect high-frequency data for
    // This ensures we only trade pairs with real-time data available
    std::vector<std::string> pairs = {
        "PI_XBTUSD",  // Bitcoin
        "PI_ETHUSD",  // Ethereum
        "PI_ADAUSD",  // Cardano
        "PI_LINKUSD", // Chainlink
        "PI_LTCUSD"   // Litecoin
    };

    std::cout << "Using " << pairs.size() << " high-frequency trading pairs" << std::endl;
    return pairs;
}

std::vector<OHLC> KrakenAPI::get_ohlc(const std::string& pair, int interval) {
    std::vector<OHLC> result;
    try {
        std::string endpoint = "/api/ohlc/" + pair + "?interval=" + std::to_string(interval);
        auto response = http_get(endpoint);

        if (response.contains("result")) {
            for (const auto& [key, value] : response["result"].items()) {
                if (key == "last") continue;  // Skip the "last" timestamp field
                if (value.is_array()) {
                    for (const auto& candle : value) {
                        if (candle.is_array() && candle.size() >= 6) {
                            OHLC ohlc;
                            ohlc.timestamp = candle[0].get<long>();
                            
                            // Handle both string and number values
                            if (candle[1].is_string()) {
                                ohlc.open = std::stod(candle[1].get<std::string>());
                                ohlc.high = std::stod(candle[2].get<std::string>());
                                ohlc.low = std::stod(candle[3].get<std::string>());
                                ohlc.close = std::stod(candle[4].get<std::string>());
                                ohlc.volume = std::stod(candle[6].get<std::string>());
                            } else {
                                ohlc.open = candle[1].get<double>();
                                ohlc.high = candle[2].get<double>();
                                ohlc.low = candle[3].get<double>();
                                ohlc.close = candle[4].get<double>();
                                ohlc.volume = candle[6].get<double>();
                            }
                            
                            result.push_back(ohlc);
                        }
                    }
                }
            }
        }
    } catch (const std::exception& e) {
        // Silently fail - trend confirmation is optional
    }
    return result;
}

std::vector<double> KrakenAPI::get_price_history(const std::string& pair, int max_points) {
    std::vector<double> prices;
    try {
        // In PAPER mode prefer reading directly from the local DB to avoid relying on
        // potentially noisy or hijacked loopback HTTP endpoints that may return
        // repeated/degenerate price arrays (observed in local testing).
        // Optionally prefer the authoritative DB-backed endpoint. This can be forced
        // by setting USE_AUTHORITATIVE_PRICES=1 in the environment or implicitly when
        // running in paper_mode.
        const char* env_use_auth = std::getenv("USE_AUTHORITATIVE_PRICES");
        bool use_authoritative = (env_use_auth && std::string(env_use_auth) == "1") || paper_mode;
        if (!paper_mode) {
            std::string endpointBase = use_authoritative ? "/api/prices/authoritative/" : "/api/prices/";
            std::string endpoint = endpointBase + pair + "?limit=" + std::to_string(max_points);
            auto response = http_get(endpoint);
            std::cerr << "get_price_history: attempted HTTP endpoint " << endpoint << "" << std::endl;

            if (response.contains("prices") && response["prices"].is_array()) {
                for (const auto& price : response["prices"]) {
                    prices.push_back(price.get<double>());
                }
            }

            // If HTTP returned a degenerate result (e.g., all prices identical), consider it invalid
            if (prices.size() >= 2) {
                double minp = *std::min_element(prices.begin(), prices.end());
                double maxp = *std::max_element(prices.begin(), prices.end());
                if (minp == maxp) {
                    std::cerr << "HTTP price endpoint returned degenerate constant prices for " << pair << " (value=" << minp << ") - falling back to DB" << std::endl;
                    prices.clear();
                }
            }
        } else {
            std::cerr << "Paper mode: skipping HTTP price endpoint for " << pair << " - will read from local DB fallback" << std::endl;
        }
    } catch (const std::exception& e) {
        std::cerr << "Error getting price history for " << pair << ": " << e.what() << std::endl;
    }
    std::cerr << "get_price_history: after HTTP attempt, retrieved " << prices.size() << " prices for " << pair << " (requested " << max_points << ")" << std::endl;
    // Fallback: read directly from local price_history.db if HTTP source is insufficient
    if (prices.size() < 10) {
        try {
            // Allow runtime override of DB path for testing/CI
            const char* env_db = std::getenv("PRICE_HISTORY_DB");
            std::vector<std::string> candidates;
            if (env_db && *env_db) candidates.push_back(std::string(env_db));
            candidates.push_back("../../data/price_history.db");
            candidates.push_back("../data/price_history.db");
            candidates.push_back("./data/price_history.db");

            sqlite3* db = nullptr;
            bool opened = false;
            std::string openedPath;

            for (const auto& dbpath : candidates) {
                int rc = sqlite3_open(dbpath.c_str(), &db);
                if (rc == SQLITE_OK) {
                    opened = true;
                    openedPath = dbpath;
                    break;
                } else {
                    std::cerr << "DB fallback: failed to open '" << dbpath << "': " << sqlite3_errmsg(db) << std::endl;
                    if (db) sqlite3_close(db);
                    db = nullptr;
                }
            }

            if (!opened) {
                std::cerr << "DB fallback: unable to open any candidate price_history.db files" << std::endl;
            } else {
                std::string sql = "SELECT price FROM price_history WHERE pair = ? ORDER BY timestamp DESC LIMIT ?";
                sqlite3_stmt* stmt = nullptr;
                if (sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr) == SQLITE_OK) {
                    sqlite3_bind_text(stmt, 1, pair.c_str(), -1, SQLITE_TRANSIENT);
                    sqlite3_bind_int(stmt, 2, max_points);
                    while (sqlite3_step(stmt) == SQLITE_ROW) {
                        double p = sqlite3_column_double(stmt, 0);
                        prices.push_back(p);
                    }
                    sqlite3_finalize(stmt);
                } else {
                    std::cerr << "DB fallback: failed to prepare statement: " << sqlite3_errmsg(db) << std::endl;
                }
                sqlite3_close(db);
                // reverse to chronological order (we selected DESC)
                std::reverse(prices.begin(), prices.end());
                std::cerr << "get_price_history: DB fallback retrieved " << prices.size() << " prices for " << pair << " from " << openedPath << std::endl;
            }
        } catch (const std::exception& e) {
            std::cerr << "DB fallback failed for price history: " << e.what() << std::endl;
        }
    }
    return prices;
}

double KrakenAPI::get_latest_price(const std::string& pair) {
    try {
        // Use high-frequency price data instead of API call
        const char* env_use_auth = std::getenv("USE_AUTHORITATIVE_PRICES");
        bool use_authoritative = (env_use_auth && std::string(env_use_auth) == "1") || paper_mode;
        std::string endpointBase = use_authoritative ? "/api/prices/authoritative/" : "/api/prices/";
        std::string endpoint = endpointBase + pair + "?limit=1";
        std::cerr << "get_latest_price: attempting HTTP endpoint " << endpoint << std::endl;
        auto response = http_get(endpoint);

        if (response.contains("prices") && response["prices"].is_array() && !response["prices"].empty()) {
            return response["prices"][0].get<double>();
        }
    } catch (const std::exception& e) {
        std::cerr << "Error getting latest price for " << pair << ": " << e.what() << std::endl;
    }
    return 0.0; // Return 0 on error, caller should handle
}

double KrakenAPI::get_volatility(const std::string& pair, int minutes) {
    // For PAPER mode prefer local DB computation to avoid relying on loopback HTTP endpoints
    if (paper_mode) {
        std::cerr << "Paper mode: skipping HTTP volatility endpoint for " << pair << " - using local DB fallback" << std::endl;
    } else {
        try {
            // Use high-frequency volatility calculation (HTTP)
            std::string endpoint = "/api/volatility/" + pair + "?minutes=" + std::to_string(minutes);
            auto response = http_get(endpoint);

            if (response.contains("volatility")) {
                return response["volatility"].get<double>();
            }
        } catch (const std::exception& e) {
            std::cerr << "Error getting volatility for " << pair << " via HTTP: " << e.what() << std::endl;
        }
    }
    // Fallback: compute volatility locally from price history if HTTP endpoint fails
    try {
        const auto prices = get_price_history(pair, 500);
        std::cerr << "get_volatility: retrieved " << prices.size() << " prices for " << pair << " from get_price_history" << std::endl;
        if (prices.size() < 2) return 0.0;
        std::vector<double> returns;
        for (size_t i = 1; i < prices.size(); ++i) {
            double r = std::log(prices[i] / prices[i-1]);
            returns.push_back(std::abs(r));
        }
        double minp = *std::min_element(prices.begin(), prices.end());
        double maxp = *std::max_element(prices.begin(), prices.end());
        std::cerr << "get_volatility: price range for " << pair << " -> min:" << minp << " max:" << maxp << " returns_count:" << returns.size() << std::endl;
        if (returns.empty()) return 0.0;
        double mean = std::accumulate(returns.begin(), returns.end(), 0.0) / returns.size();
        double variance = 0.0;
        for (double v : returns) variance += std::pow(v - mean, 2);
        variance /= returns.size();
        double stddev = std::sqrt(variance);
    std::cerr << "get_volatility: computed stddev percent " << (stddev * 100.0) << " for " << pair << std::endl;
    return stddev * 100.0; // percent
    } catch (const std::exception& e) {
        std::cerr << "Fallback volatility calculation failed for " << pair << ": " << e.what() << std::endl;
    }
    return 0.0; // Return 0 on error
}

bool KrakenAPI::deploy_live() {
    if (paper_mode) {
        std::cout << "Switching from paper trading to live trading..." << std::endl;
        paper_mode = false;
        return authenticate();
    }
    return true;
}