#include <iostream>
#include <string>
#include <nlohmann/json.hpp>
#include <curl/curl.h>

using json = nlohmann::json;

// Callback for CURL
size_t WriteCallback(void* contents, size_t size, size_t nmemb, void* userp) {
    ((std::string*)userp)->append((char*)contents, size * nmemb);
    return size * nmemb;
}

// Simple HTTP GET
json http_get(const std::string& endpoint) {
    CURL* curl = curl_easy_init();
    std::string response;

    if (curl) {
        curl_easy_setopt(curl, CURLOPT_URL, ("https://api.kraken.com" + endpoint).c_str());
        curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, WriteCallback);
        curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 0L);
        curl_easy_setopt(curl, CURLOPT_SSL_VERIFYHOST, 0L);

        CURLcode res = curl_easy_perform(curl);
        curl_easy_cleanup(curl);

        if (res == CURLE_OK) {
            return json::parse(response);
        }
    }

    return {};
}

int main() {
    std::cout << "Testing Kraken API volatility calculation...\n";

    // Test with XBTUSD
    auto response = http_get("/0/public/Ticker?pair=XBTUSD");
    if (response.contains("result") && response["result"].contains("XXBTZUSD")) {
        auto ticker = response["result"]["XXBTZUSD"];

        // Extract prices
        double high_24h = std::stod(std::string(ticker["h"][0]));
        double low_24h = std::stod(std::string(ticker["l"][0]));
        double open_24h = std::stod(std::string(ticker["o"]));

        // Calculate volatility
        double volatility = ((high_24h - low_24h) / open_24h) * 100.0;

        std::cout << "XBTUSD:\n";
        std::cout << "  High: $" << high_24h << "\n";
        std::cout << "  Low: $" << low_24h << "\n";
        std::cout << "  Open: $" << open_24h << "\n";
        std::cout << "  Volatility: " << volatility << "%\n";

        // Calculate spread
        double ask = std::stod(std::string(ticker["a"][0]));
        double bid = std::stod(std::string(ticker["b"][0]));
        double spread_pct = ((ask - bid) / bid) * 100.0;

        std::cout << "  Spread: " << spread_pct << "%\n";
    }

    return 0;
}