#include "kraken_api.hpp"
#include <curl/curl.h>
#include <iostream>
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

    // Initialize mock prices for paper trading
    mock_prices = {
        {"XBTUSD", 91000.0},
        {"ETHUSD", 3200.0},
        {"ADAUSD", 0.85},
        {"DOTUSD", 8.50},
        {"LINKUSD", 18.50}
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
        std::string url = "http://localhost:8000" + endpoint;

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
        // Convert Kraken pair format (e.g., "XBTUSD") to our API format
        std::string api_pair = pair;
        if (pair == "XBTUSD") api_pair = "XXBTZUSD";

        auto ticker = get_ticker(api_pair);
        auto last_trade = ticker.value("c", json::array({"0"}));
        if (last_trade.is_array() && !last_trade.empty()) {
            std::string price_str = last_trade[0];
            return price_str.empty() ? 0.0 : std::stod(price_str);
        }
        return 0.0;
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
    // Use retry logic for API calls
    return retry_with_backoff([this, &pair]() -> json {
        std::string endpoint = "/api/ticker/" + pair;
        auto response = http_get(endpoint);

        if (response.contains("result") && response["result"].contains(pair)) {
            return response["result"][pair];
        }

        throw std::runtime_error("No ticker data for " + pair);
    }, 3, 500);  // 3 retries, starting at 500ms delay
}

double KrakenAPI::get_bid_ask_spread(const std::string& pair) {
    try {
        auto ticker = get_ticker(pair);
        auto ask_array = ticker.value("a", json::array({"100"}));
        auto bid_array = ticker.value("b", json::array({"99"}));

        if (ask_array.is_array() && !ask_array.empty() &&
            bid_array.is_array() && !bid_array.empty()) {
            double ask = std::stod(std::string(ask_array[0]));
            double bid = std::stod(std::string(bid_array[0]));
            return (ask - bid) / bid * 100.0; // Return as percentage
        }
        return 0.1; // Default 0.1% spread
    } catch (const std::exception& e) {
        return 0.1; // Default 0.1% spread
    }
}

std::vector<std::string> KrakenAPI::get_trading_pairs() {
    try {
        auto response = http_get("/api/assetpairs");
        std::vector<std::string> pairs;

        if (response.contains("result")) {
            for (const auto& [key, value] : response["result"].items()) {
                // More restrictive filtering: only pairs that END with USD and are online
                if (value.contains("status") && value["status"] == "online" &&
                    key.length() > 3 && key.substr(key.length() - 3) == "USD") {
                    // Skip pairs with special characters that might cause issues
                    bool valid = true;
                    for (char c : key) {
                        if (!isalnum(c)) {
                            valid = false;
                            break;
                        }
                    }
                    if (valid) {
                        pairs.push_back(key);
                    }
                }
            }
        }

        // Limit to top 100 pairs by volume (if we have too many)
        if (pairs.size() > 100) {
            // For now, just take the first 100
            pairs.resize(100);
        }

        if (pairs.empty()) {
            // Fallback pairs
            pairs = {"XBTUSD", "ETHUSD", "ADAUSD", "DOTUSD", "LINKUSD"};
        }

        std::cout << "Found " << pairs.size() << " valid USD trading pairs" << std::endl;
        return pairs;

    } catch (const std::exception& e) {
        std::cerr << "Error fetching trading pairs: " << e.what() << std::endl;
        // Return fallback pairs
        return {"XBTUSD", "ETHUSD", "ADAUSD", "DOTUSD", "LINKUSD"};
    }
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
                            ohlc.open = std::stod(candle[1].get<std::string>());
                            ohlc.high = std::stod(candle[2].get<std::string>());
                            ohlc.low = std::stod(candle[3].get<std::string>());
                            ohlc.close = std::stod(candle[4].get<std::string>());
                            ohlc.volume = std::stod(candle[6].get<std::string>());
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

bool KrakenAPI::deploy_live() {
    if (paper_mode) {
        std::cout << "Switching from paper trading to live trading..." << std::endl;
        paper_mode = false;
        return authenticate();
    }
    return true;
}