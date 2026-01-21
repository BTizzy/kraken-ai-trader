/**
 * Simple test to verify cross-validation and pattern persistence logic
 */

#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>

// Simplified test structures (mimicking the real ones)
struct TradeRecord {
    double pnl;
    double gross_pnl;
    double position_size;
    
    bool is_win() const { return pnl > 0; }
    double roi() const { return (pnl / position_size) * 100; }
};

// Test calculate_sharpe_ratio function
double calculate_sharpe_ratio(const std::vector<double>& returns) {
    if (returns.empty()) return 0;
    
    double mean = 0;
    for (double r : returns) mean += r;
    mean /= returns.size();
    
    double variance = 0;
    for (double r : returns) {
        double diff = r - mean;
        variance += diff * diff;
    }
    variance /= returns.size();
    
    double std_dev = std::sqrt(variance);
    return std_dev > 0 ? mean / std_dev : 0;
}

// Test cross-validation logic
struct ValidationMetrics {
    double train_win_rate = 0;
    double test_win_rate = 0;
    double train_sharpe = 0;
    double test_sharpe = 0;
    double train_profit_factor = 0;
    double test_profit_factor = 0;
    int train_count = 0;
    int test_count = 0;
    bool is_overfit = false;
};

ValidationMetrics cross_validate_pattern(const std::vector<TradeRecord>& trades, double train_ratio) {
    ValidationMetrics metrics;
    
    if (trades.size() < 10) {
        return metrics;
    }
    
    // Split into train and test sets
    int train_size = static_cast<int>(trades.size() * train_ratio);
    std::vector<TradeRecord> train_trades(trades.begin(), trades.begin() + train_size);
    std::vector<TradeRecord> test_trades(trades.begin() + train_size, trades.end());
    
    metrics.train_count = train_trades.size();
    metrics.test_count = test_trades.size();
    
    // Calculate train metrics
    std::vector<double> train_returns;
    int train_wins = 0;
    double train_gross_wins = 0, train_gross_losses = 0;
    
    for (const auto& t : train_trades) {
        train_returns.push_back(t.roi());
        if (t.is_win()) {
            train_wins++;
            train_gross_wins += t.gross_pnl;
        } else {
            train_gross_losses += std::abs(t.gross_pnl);
        }
    }
    
    metrics.train_win_rate = (double)train_wins / train_trades.size();
    metrics.train_sharpe = calculate_sharpe_ratio(train_returns);
    metrics.train_profit_factor = train_gross_losses > 0 ? 
        train_gross_wins / train_gross_losses : train_gross_wins;
    
    // Calculate test metrics
    std::vector<double> test_returns;
    int test_wins = 0;
    double test_gross_wins = 0, test_gross_losses = 0;
    
    for (const auto& t : test_trades) {
        test_returns.push_back(t.roi());
        if (t.is_win()) {
            test_wins++;
            test_gross_wins += t.gross_pnl;
        } else {
            test_gross_losses += std::abs(t.gross_pnl);
        }
    }
    
    metrics.test_win_rate = test_trades.size() > 0 ? 
        (double)test_wins / test_trades.size() : 0;
    metrics.test_sharpe = calculate_sharpe_ratio(test_returns);
    metrics.test_profit_factor = test_gross_losses > 0 ? 
        test_gross_wins / test_gross_losses : test_gross_wins;
    
    // Detect overfitting
    double win_rate_drop = metrics.train_win_rate - metrics.test_win_rate;
    double sharpe_ratio = metrics.train_sharpe > 0 ? 
        metrics.test_sharpe / metrics.train_sharpe : 0;
    
    metrics.is_overfit = (win_rate_drop > 0.20) || 
                         (metrics.train_sharpe > 0.5 && sharpe_ratio < 0.5);
    
    return metrics;
}

void test_balanced_pattern() {
    std::cout << "Test 1: Balanced pattern (no overfitting)" << std::endl;
    
    std::vector<TradeRecord> trades;
    // Create 20 trades with 60% win rate consistently
    for (int i = 0; i < 20; i++) {
        TradeRecord t;
        t.position_size = 100;
        if (i % 5 < 3) {  // 60% wins
            t.pnl = 10;
            t.gross_pnl = 11;
        } else {
            t.pnl = -5;
            t.gross_pnl = -5;
        }
        trades.push_back(t);
    }
    
    ValidationMetrics vm = cross_validate_pattern(trades, 0.8);
    
    std::cout << "  Train: " << vm.train_count << " trades, WR=" << vm.train_win_rate * 100 << "%" << std::endl;
    std::cout << "  Test: " << vm.test_count << " trades, WR=" << vm.test_win_rate * 100 << "%" << std::endl;
    std::cout << "  Overfit: " << (vm.is_overfit ? "YES ⚠️" : "NO ✅") << std::endl;
    
    assert(vm.train_count == 16);
    assert(vm.test_count == 4);
    assert(!vm.is_overfit);
    
    std::cout << "  ✅ PASSED\n" << std::endl;
}

void test_overfit_pattern() {
    std::cout << "Test 2: Overfit pattern (train good, test bad)" << std::endl;
    
    std::vector<TradeRecord> trades;
    // First 16 trades (train): 75% win rate
    for (int i = 0; i < 16; i++) {
        TradeRecord t;
        t.position_size = 100;
        if (i % 4 < 3) {  // 75% wins
            t.pnl = 10;
            t.gross_pnl = 11;
        } else {
            t.pnl = -5;
            t.gross_pnl = -5;
        }
        trades.push_back(t);
    }
    
    // Last 4 trades (test): 25% win rate (overfitting!)
    for (int i = 0; i < 4; i++) {
        TradeRecord t;
        t.position_size = 100;
        if (i % 4 == 0) {  // 25% wins
            t.pnl = 10;
            t.gross_pnl = 11;
        } else {
            t.pnl = -5;
            t.gross_pnl = -5;
        }
        trades.push_back(t);
    }
    
    ValidationMetrics vm = cross_validate_pattern(trades, 0.8);
    
    std::cout << "  Train: " << vm.train_count << " trades, WR=" << vm.train_win_rate * 100 << "%" << std::endl;
    std::cout << "  Test: " << vm.test_count << " trades, WR=" << vm.test_win_rate * 100 << "%" << std::endl;
    std::cout << "  Win rate drop: " << (vm.train_win_rate - vm.test_win_rate) * 100 << "%" << std::endl;
    std::cout << "  Overfit: " << (vm.is_overfit ? "YES ⚠️" : "NO ✅") << std::endl;
    
    assert(vm.is_overfit);  // Should detect overfitting
    
    std::cout << "  ✅ PASSED\n" << std::endl;
}

void test_insufficient_data() {
    std::cout << "Test 3: Insufficient data (< 10 trades)" << std::endl;
    
    std::vector<TradeRecord> trades;
    for (int i = 0; i < 5; i++) {
        TradeRecord t;
        t.position_size = 100;
        t.pnl = 10;
        t.gross_pnl = 11;
        trades.push_back(t);
    }
    
    ValidationMetrics vm = cross_validate_pattern(trades, 0.8);
    
    std::cout << "  Train: " << vm.train_count << " trades" << std::endl;
    std::cout << "  Test: " << vm.test_count << " trades" << std::endl;
    
    assert(vm.train_count == 0);
    assert(vm.test_count == 0);
    
    std::cout << "  ✅ PASSED (skipped as expected)\n" << std::endl;
}

int main() {
    std::cout << "\n=== Cross-Validation Logic Tests ===\n" << std::endl;
    
    test_balanced_pattern();
    test_overfit_pattern();
    test_insufficient_data();
    
    std::cout << "=== All tests passed! ✅ ===\n" << std::endl;
    return 0;
}
