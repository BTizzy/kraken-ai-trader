#pragma once

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <nlohmann/json.hpp>
#include <curl/curl.h>
#include <thread>
#include <queue>

using json = nlohmann::json;

struct Order {
    std::string order_id;
    std::string pair;
    std::string side;  // "buy" or "sell"
    double price;
    double volume;
    double filled;
    std::string status;  // "pending", "filled", "cancelled"
};

struct Position {
    std::string pair;
    double size;
    double entry_price;
    double leverage;
    double current_price;
    double unrealized_pnl;
};

struct OHLC {
    long timestamp;
    double open;
    double high;
    double low;
    double close;
    double volume;
};

class KrakenAPI {
public:
    KrakenAPI(bool paper_trading = true);
    ~KrakenAPI();
    
    // Authentication - uses environment variables
    bool authenticate();
    
    // Trading
    Order place_market_order(const std::string& pair, const std::string& side, 
                            double volume, double leverage = 1.0);
    Order place_limit_order(const std::string& pair, const std::string& side,
                           double volume, double price, double leverage = 1.0);
    bool cancel_order(const std::string& order_id);
    
    // Positions
    std::vector<Position> get_open_positions();
    Position get_position(const std::string& pair);
    bool close_position(const std::string& pair);
    
    // Account
    double get_balance(const std::string& currency = "USD");
    double get_equity();
    
    // Market data
    double get_current_price(const std::string& pair);
    json get_ticker(const std::string& pair);
    double get_bid_ask_spread(const std::string& pair);
    std::vector<std::string> get_trading_pairs();
    std::vector<OHLC> get_ohlc(const std::string& pair, int interval = 1);
    
    // Paper trading
    void set_paper_mode(bool enabled) { paper_mode = enabled; }
    bool is_paper_mode() const { return paper_mode; }
    
    // Deploy live (one-click)
    bool deploy_live();
    
private:
    bool paper_mode;
    std::string api_key;
    std::string api_secret;
    std::string base_url = "https://api.kraken.com";
    
    // Paper trading state
    double paper_balance = 10000;  // $10k starting
    std::map<std::string, Position> paper_positions;
    std::map<std::string, Order> paper_orders;
    
    // HTTP helpers
    json http_get(const std::string& endpoint);
    json http_post(const std::string& endpoint, const json& data);
    std::string hmac_sha256(const std::string& message);
    
    // Mock data
    std::map<std::string, double> mock_prices;
};
