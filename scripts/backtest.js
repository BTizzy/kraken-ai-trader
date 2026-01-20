#!/usr/bin/env node
/**
 * Backtest Script - Simulate strategy changes on historical trades
 * 
 * Usage:
 *   node scripts/backtest.js                    # Run with default strategy
 *   node scripts/backtest.js --tp=2.0 --sl=0.8  # Test different TP/SL
 *   node scripts/backtest.js --trailing=0.4     # Test different trailing start
 *   node scripts/backtest.js --compare          # Compare multiple strategies
 */

const fs = require('fs');
const path = require('path');

// Default strategy parameters (from config)
const DEFAULT_STRATEGY = {
    take_profit_pct: 1.5,
    stop_loss_pct: 0.6,
    trailing_start_pct: 0.5,
    trailing_stop_pct: 0.25,
    taker_fee_pct: 0.4,
    position_size_usd: 100
};

// Load trade log
function loadTrades() {
    const tradeLogPath = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
    if (!fs.existsSync(tradeLogPath)) {
        console.error('❌ trade_log.json not found');
        process.exit(1);
    }
    
    const data = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8'));
    return data.trades || [];
}

// Simulate a single trade with given strategy
function simulateTrade(trade, strategy) {
    // If we don't have entry/exit prices, use P&L to estimate outcome
    const hasValidPrices = trade.entry_price > 0 && trade.exit_price > 0;
    
    if (!hasValidPrices) {
        // Fallback: use original P&L if we can't simulate
        return {
            pair: trade.pair,
            direction: trade.direction || 'LONG',
            original_pnl: trade.pnl || 0,
            simulated_pnl: trade.pnl || 0,
            exit_reason: trade.exit_reason || 'unknown',
            simulated_exit_reason: trade.exit_reason || 'unknown',
            could_simulate: false
        };
    }
    
    const entryPrice = trade.entry_price;
    const exitPrice = trade.exit_price;
    const direction = trade.direction || 'LONG';
    const isShort = direction === 'SHORT';
    
    // Calculate price movement percentage
    let pricePct;
    if (isShort) {
        pricePct = ((entryPrice - exitPrice) / entryPrice) * 100;  // SHORT: profit when price drops
    } else {
        pricePct = ((exitPrice - entryPrice) / entryPrice) * 100;  // LONG: profit when price rises
    }
    
    // Determine simulated exit based on strategy
    let simExitReason = trade.exit_reason;
    let simPricePct = pricePct;
    
    // Would we have hit take profit?
    if (pricePct >= strategy.take_profit_pct) {
        simExitReason = 'take_profit';
        simPricePct = strategy.take_profit_pct;
    }
    // Would we have hit stop loss?
    else if (pricePct <= -strategy.stop_loss_pct) {
        simExitReason = 'stop_loss';
        simPricePct = -strategy.stop_loss_pct;
    }
    // Would trailing stop have triggered?
    else if (pricePct >= strategy.trailing_start_pct) {
        // Assume best case: we trail from the peak
        // In reality depends on price path, but this estimates
        const peakProfit = Math.max(pricePct, strategy.trailing_start_pct);
        const trailedProfit = peakProfit - strategy.trailing_stop_pct;
        if (trailedProfit > pricePct) {
            simExitReason = 'trailing_stop';
            simPricePct = Math.max(trailedProfit, pricePct);  // Can't do better than actual
        }
    }
    // Else: timeout with current price
    
    // Calculate P&L
    const positionSize = trade.position_size || strategy.position_size_usd;
    const grossPnl = positionSize * (simPricePct / 100);
    const fees = positionSize * (strategy.taker_fee_pct / 100) * 2;  // Round trip
    const netPnl = grossPnl - fees;
    
    return {
        pair: trade.pair,
        direction: direction,
        entry_price: entryPrice,
        exit_price: exitPrice,
        original_pnl: trade.pnl || 0,
        simulated_pnl: netPnl,
        exit_reason: trade.exit_reason,
        simulated_exit_reason: simExitReason,
        price_change_pct: pricePct,
        simulated_price_pct: simPricePct,
        could_simulate: true
    };
}

// Calculate aggregate metrics from simulation results
function calculateMetrics(results) {
    const simulated = results.filter(r => r.could_simulate);
    const wins = simulated.filter(r => r.simulated_pnl > 0);
    const losses = simulated.filter(r => r.simulated_pnl <= 0);
    
    const totalPnl = simulated.reduce((sum, r) => sum + r.simulated_pnl, 0);
    const winPnl = wins.reduce((sum, r) => sum + r.simulated_pnl, 0);
    const lossPnl = Math.abs(losses.reduce((sum, r) => sum + r.simulated_pnl, 0));
    
    const exitReasons = {};
    simulated.forEach(r => {
        exitReasons[r.simulated_exit_reason] = (exitReasons[r.simulated_exit_reason] || 0) + 1;
    });
    
    // Compare to original
    const originalPnl = results.reduce((sum, r) => sum + r.original_pnl, 0);
    const originalWins = results.filter(r => r.original_pnl > 0).length;
    
    return {
        total_trades: results.length,
        simulated_trades: simulated.length,
        
        // Simulated metrics
        win_rate: simulated.length > 0 ? (wins.length / simulated.length * 100) : 0,
        profit_factor: lossPnl > 0 ? (winPnl / lossPnl) : (winPnl > 0 ? Infinity : 0),
        total_pnl: totalPnl,
        avg_pnl: simulated.length > 0 ? (totalPnl / simulated.length) : 0,
        exit_reasons: exitReasons,
        
        // Original metrics (for comparison)
        original_pnl: originalPnl,
        original_win_rate: results.length > 0 ? (originalWins / results.length * 100) : 0,
        
        // Improvement
        pnl_improvement: totalPnl - originalPnl,
        pnl_improvement_pct: originalPnl !== 0 ? ((totalPnl - originalPnl) / Math.abs(originalPnl) * 100) : 0
    };
}

// Format currency
function formatUSD(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
}

// Format percentage
function formatPct(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
}

// Print results
function printResults(metrics, strategy, label = 'Strategy') {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║  ${label.padEnd(56)}║`);
    console.log(`╠════════════════════════════════════════════════════════════╣`);
    console.log(`║  Parameters:                                               ║`);
    console.log(`║    Take Profit: ${(strategy.take_profit_pct + '%').padEnd(8)} Stop Loss: ${(strategy.stop_loss_pct + '%').padEnd(8)}         ║`);
    console.log(`║    Trail Start: ${(strategy.trailing_start_pct + '%').padEnd(8)} Trail Stop: ${(strategy.trailing_stop_pct + '%').padEnd(8)}        ║`);
    console.log(`╠════════════════════════════════════════════════════════════╣`);
    console.log(`║  Results (${metrics.simulated_trades} simulated / ${metrics.total_trades} total trades):              ║`);
    console.log(`║    Win Rate:     ${(metrics.win_rate.toFixed(1) + '%').padEnd(10)} (was ${metrics.original_win_rate.toFixed(1)}%)           ║`);
    console.log(`║    Profit Factor: ${metrics.profit_factor.toFixed(2).padEnd(8)}                                ║`);
    console.log(`║    Total P&L:    ${formatUSD(metrics.total_pnl).padEnd(12)} (was ${formatUSD(metrics.original_pnl)})     ║`);
    console.log(`║    Avg P&L:      ${formatUSD(metrics.avg_pnl).padEnd(12)}/trade                       ║`);
    console.log(`╠════════════════════════════════════════════════════════════╣`);
    console.log(`║  Exit Reasons:                                             ║`);
    Object.entries(metrics.exit_reasons).sort((a, b) => b[1] - a[1]).forEach(([reason, count]) => {
        const pct = (count / metrics.simulated_trades * 100).toFixed(1);
        console.log(`║    ${reason.padEnd(15)}: ${String(count).padStart(4)} (${pct}%)`.padEnd(61) + '║');
    });
    console.log(`╠════════════════════════════════════════════════════════════╣`);
    console.log(`║  Improvement vs Original:                                  ║`);
    console.log(`║    P&L Change: ${formatUSD(metrics.pnl_improvement).padEnd(12)} (${formatPct(metrics.pnl_improvement_pct)})            ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝`);
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const strategy = { ...DEFAULT_STRATEGY };
    let compare = false;
    
    args.forEach(arg => {
        if (arg === '--compare') {
            compare = true;
        } else if (arg.startsWith('--tp=')) {
            strategy.take_profit_pct = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--sl=')) {
            strategy.stop_loss_pct = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--trailing=') || arg.startsWith('--trail-start=')) {
            strategy.trailing_start_pct = parseFloat(arg.split('=')[1]);
        } else if (arg.startsWith('--trail-stop=')) {
            strategy.trailing_stop_pct = parseFloat(arg.split('=')[1]);
        } else if (arg === '--help' || arg === '-h') {
            console.log(`
Usage: node scripts/backtest.js [options]

Options:
  --tp=<value>          Take profit percentage (default: 1.5)
  --sl=<value>          Stop loss percentage (default: 0.6)
  --trailing=<value>    Trailing start percentage (default: 0.5)
  --trail-stop=<value>  Trailing stop percentage (default: 0.25)
  --compare             Compare multiple strategy variations
  --help, -h            Show this help message
            `);
            process.exit(0);
        }
    });
    
    return { strategy, compare };
}

// Compare multiple strategies
function runComparison(trades) {
    const strategies = [
        { label: 'Current (aggressive trailing)', ...DEFAULT_STRATEGY },
        { label: 'Wider TP (2.0%)', ...DEFAULT_STRATEGY, take_profit_pct: 2.0 },
        { label: 'Tighter TP (1.0%)', ...DEFAULT_STRATEGY, take_profit_pct: 1.0 },
        { label: 'Tighter SL (0.4%)', ...DEFAULT_STRATEGY, stop_loss_pct: 0.4 },
        { label: 'Earlier trail (0.3%)', ...DEFAULT_STRATEGY, trailing_start_pct: 0.3 },
        { label: 'Original settings', take_profit_pct: 1.5, stop_loss_pct: 0.6, trailing_start_pct: 0.8, trailing_stop_pct: 0.3, taker_fee_pct: 0.4, position_size_usd: 100 },
    ];
    
    console.log('\n📊 STRATEGY COMPARISON');
    console.log('═'.repeat(80));
    console.log(`${'Strategy'.padEnd(30)} | ${'Win Rate'.padEnd(10)} | ${'P/F'.padEnd(8)} | ${'P&L'.padEnd(12)} | Improvement`);
    console.log('─'.repeat(80));
    
    strategies.forEach(strat => {
        const results = trades.map(t => simulateTrade(t, strat));
        const metrics = calculateMetrics(results);
        
        const improvement = metrics.pnl_improvement >= 0 
            ? `🟢 ${formatUSD(metrics.pnl_improvement)}` 
            : `🔴 ${formatUSD(metrics.pnl_improvement)}`;
        
        console.log(
            `${strat.label.padEnd(30)} | ` +
            `${(metrics.win_rate.toFixed(1) + '%').padEnd(10)} | ` +
            `${metrics.profit_factor.toFixed(2).padEnd(8)} | ` +
            `${formatUSD(metrics.total_pnl).padEnd(12)} | ` +
            improvement
        );
    });
    
    console.log('═'.repeat(80));
}

// Main
function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║        KRAKEN AI TRADER - STRATEGY BACKTEST                ║');
    console.log('╚════════════════════════════════════════════════════════════╝');
    
    const trades = loadTrades();
    console.log(`\n📊 Loaded ${trades.length} historical trades`);
    
    // Count trades with valid price data
    const validTrades = trades.filter(t => t.entry_price > 0 && t.exit_price > 0);
    console.log(`📈 ${validTrades.length} trades have valid price data for simulation`);
    
    if (validTrades.length === 0) {
        console.log('\n⚠️  No trades have entry/exit prices - simulation will use original P&L');
        console.log('   Run the bot longer to collect trades with price data');
    }
    
    const { strategy, compare } = parseArgs();
    
    if (compare) {
        runComparison(trades);
    } else {
        const results = trades.map(t => simulateTrade(t, strategy));
        const metrics = calculateMetrics(results);
        printResults(metrics, strategy, 'Custom Strategy');
    }
}

main();
