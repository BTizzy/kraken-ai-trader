#!/usr/bin/env node
/**
 * Walk-forward backtest on historical trades.
 * Splits trade log into N folds and computes metrics per fold for given candidate strategy.
 * Usage:
 *   node scripts/walk_forward_backtest.js --candidate='{"tp":3,"sl":0.2}' --folds=5
 */
const fs = require('fs');
const path = require('path');
const argv = require('minimist')(process.argv.slice(2));

const tradeLogPath = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
if (!fs.existsSync(tradeLogPath)) { console.error('trade_log.json missing; run the bot to collect trades'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(tradeLogPath, 'utf8'));
const trades = (data.trades || []).filter(t => t.entry_price > 0 && t.exit_price > 0).sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
const folds = parseInt(argv.folds || argv.f || '5', 10);
const candidate = argv.candidate ? JSON.parse(argv.candidate) : { tp: 3, sl: 0.2, trail_start: 0.3, trail_stop: 0.1 };

function simulateTrade(trade, cand) {
    // Use backtest.js simulation logic simplified for this script
    const entry = trade.entry_price, exit = trade.exit_price;
    const direction = trade.direction || 'LONG';
    const isShort = direction === 'SHORT';
    let pricePct = isShort ? ((entry - exit)/entry)*100 : ((exit - entry)/entry)*100;
    let simExitPct = pricePct;
    let exitReason = trade.exit_reason || 'timeout';
    if (pricePct >= cand.tp) { simExitPct = cand.tp; exitReason = 'take_profit'; }
    else if (pricePct <= -cand.sl) { simExitPct = -cand.sl; exitReason = 'stop_loss'; }
    else if (pricePct >= cand.trail_start) { simExitPct = Math.max(pricePct, cand.trail_start) - (cand.trail_stop || 0); exitReason = 'trailing_stop'; }
    const positionSize = trade.position_size || 100;
    const gross = positionSize * (simExitPct / 100);
    const fees = positionSize * 0.004 * 2;
    return { simulated_pnl: gross - fees, simulated_exit_reason: exitReason };
}

function metricsForResults(results) {
    const wins = results.filter(r => r.simulated_pnl > 0);
    const losses = results.filter(r => r.simulated_pnl <= 0);
    const totalPnl = results.reduce((s,r)=>s+(r.simulated_pnl||0),0);
    const winRate = results.length ? (wins.length / results.length * 100) : 0;
    const grossWins = wins.reduce((s,r)=>s+(r.simulated_pnl||0),0);
    const grossLoss = Math.abs(losses.reduce((s,r)=>s+(r.simulated_pnl||0),0));
    const pf = grossLoss>0 ? (grossWins/grossLoss) : (grossWins>0 ? Infinity : 0);
    return { totalTrades: results.length, winRate, totalPnl, profitFactor: pf };
}

if (trades.length < 10) { console.error('Not enough trades with price data for walk-forward'); process.exit(1); }

const foldSize = Math.floor(trades.length / folds);
const out = [];
for (let i = 0; i < folds; i++) {
    const start = i * foldSize;
    const end = (i+1)*foldSize;
    const window = trades.slice(start, end);
    const results = window.map(t => simulateTrade(t, candidate));
    const m = metricsForResults(results);
    out.push({ fold: i+1, size: window.length, metrics: m });
}

const master = { candidate, folds: folds, totalTrades: trades.length, results: out, generatedAt: new Date().toISOString() };
const outPath = path.join(__dirname, '..', 'logs', `walk_forward_${Date.now()}.json`);
fs.writeFileSync(outPath, JSON.stringify(master, null, 2));
console.log('Walk-forward complete. Summary saved to', outPath);
console.log(JSON.stringify(master, null, 2));
