#!/usr/bin/env node
/**
 * Simple grid search optimizer for strategy parameters using historical trades
 * Outputs the top candidate strategies by total simulated P&L and profit factor
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DEFAULT_STRATEGY = {
    take_profit_pct: 1.5,
    stop_loss_pct: 0.6,
    trailing_start_pct: 0.5,
    trailing_stop_pct: 0.25,
    taker_fee_pct: 0.4,
    position_size_usd: 100
};

function loadTrades() {
    const tradeLogPath = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
    if (!fs.existsSync(tradeLogPath)) {
        console.error('❌ trade_log.json not found');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(tradeLogPath, 'utf8')).trades || [];
}

function simulateTrade(trade, strategy) {
    const hasValidPrices = trade.entry_price > 0 && trade.exit_price > 0;
    if (!hasValidPrices) return { could_simulate: false, original_pnl: trade.pnl || 0 };

    const entryPrice = trade.entry_price;
    const exitPrice = trade.exit_price;
    const direction = trade.direction || 'LONG';
    const isShort = direction === 'SHORT';
    let pricePct = isShort ? ((entryPrice - exitPrice) / entryPrice * 100) : ((exitPrice - entryPrice) / entryPrice * 100);

    let simExitReason = trade.exit_reason;
    let simPricePct = pricePct;

    if (pricePct >= strategy.take_profit_pct) {
        simExitReason = 'take_profit';
        simPricePct = strategy.take_profit_pct;
    } else if (pricePct <= -strategy.stop_loss_pct) {
        simExitReason = 'stop_loss';
        simPricePct = -strategy.stop_loss_pct;
    } else if (pricePct >= strategy.trailing_start_pct) {
        const peakProfit = Math.max(pricePct, strategy.trailing_start_pct);
        const trailedProfit = peakProfit - strategy.trailing_stop_pct;
        if (trailedProfit > pricePct) {
            simExitReason = 'trailing_stop';
            simPricePct = Math.max(trailedProfit, pricePct);
        }
    }

    const positionSize = trade.position_size || strategy.position_size_usd;
    const grossPnl = positionSize * (simPricePct / 100);
    const fees = positionSize * (strategy.taker_fee_pct / 100) * 2;
    const netPnl = grossPnl - fees;

    return { could_simulate: true, simulated_pnl: netPnl, original_pnl: trade.pnl || 0 };
}

function calculateMetrics(results) {
    const simulated = results.filter(r => r.could_simulate);
    const wins = simulated.filter(r => r.simulated_pnl > 0);
    const losses = simulated.filter(r => r.simulated_pnl <= 0);
    const totalPnl = simulated.reduce((s, r) => s + r.simulated_pnl, 0);
    const winPnl = wins.reduce((s, r) => s + r.simulated_pnl, 0);
    const lossPnl = Math.abs(losses.reduce((s, r) => s + r.simulated_pnl, 0));
    return {
        simulated_trades: simulated.length,
        total_pnl: totalPnl,
        win_rate: simulated.length > 0 ? (wins.length / simulated.length) * 100 : 0,
        profit_factor: lossPnl > 0 ? (winPnl / lossPnl) : (winPnl > 0 ? Infinity : 0)
    };
}

function gridSearch(trades) {
    const tps = [1.0, 1.25, 1.5, 1.75, 2.0];
    const sls = [0.2, 0.4, 0.6, 0.8, 1.0];
    const trails = [0.3, 0.4, 0.5, 0.6];
    const trailStops = [0.1, 0.2, 0.25, 0.3];

    const results = [];

    for (const tp of tps) {
        for (const sl of sls) {
            for (const tr of trails) {
                for (const ts of trailStops) {
                    const strat = { ...DEFAULT_STRATEGY, take_profit_pct: tp, stop_loss_pct: sl, trailing_start_pct: tr, trailing_stop_pct: ts };
                    const simulated = trades.map(t => simulateTrade(t, strat));
                    const metrics = calculateMetrics(simulated);
                    if (metrics.simulated_trades < 10) continue; // skip tiny samples
                    results.push({ strat, metrics });
                }
            }
        }
    }

    results.sort((a, b) => b.metrics.total_pnl - a.metrics.total_pnl);
    return results.slice(0, 10);
}

function main() {
    console.log('Running quick grid search optimization on historical trades');
    const trades = loadTrades();
    console.log(`Loaded ${trades.length} trades`);
    const top = gridSearch(trades);
    console.log('\nTop candidate strategies:');
    top.forEach((t, idx) => {
        const m = t.metrics;
        console.log(`#${idx+1}: TP=${t.strat.take_profit_pct}% SL=${t.strat.stop_loss_pct}% TRAIL=${t.strat.trailing_start_pct}% TRSTOP=${t.strat.trailing_stop_pct}% -> Trades=${m.simulated_trades} P&L=${m.total_pnl.toFixed(2)} WinRate=${m.win_rate.toFixed(1)}% PF=${m.profit_factor.toFixed(2)}`);
    });
}

main();
