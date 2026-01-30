#!/usr/bin/env node
/**
 * Generate candidate parameter sets for dynamic-vol strategies using historical trades.
 * Strategy: TP = volatility_at_entry * tp_multiplier, SL = volatility_at_entry * sl_multiplier
 * Outputs top N candidates by simulated PnL to logs/candidates_dynamic.json
 */
const fs = require('fs');
const path = require('path');

const TRADE_LOG = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
if (!fs.existsSync(TRADE_LOG)) { console.error('trade_log.json missing'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'));
const trades = (data.trades || []).filter(t => t.entry_price && t.exit_price && t.volatility_at_entry);

const TP_MS = [5,10,20,30,50,100];
const SL_MS = [1,2,4];
const KELLY = [0.05,0.1,0.2];

function simulateCandidate(tp_m, sl_m, kelly) {
    let total = 0;
    let wins = 0, losses = 0, fees = 0;
    for (const t of trades) {
        const vol = t.volatility_at_entry || 0.1; // percent
        const tp_pct = Math.max(0.01, vol * tp_m);
        const sl_pct = Math.max(0.01, vol * sl_m);
        // Simulate: if original exit_price gives us a movement that would reach TP or SL
        const entry = t.entry_price, exit = t.exit_price;
        const isShort = t.direction === 'SHORT';
        let pnl_pct = isShort ? ((entry - exit) / entry) * 100.0 : ((exit - entry) / entry) * 100.0;
        let sim_price_pct = pnl_pct;
        let exit_reason = 'timeout';
        if (pnl_pct >= tp_pct) { sim_price_pct = tp_pct; exit_reason = 'tp'; }
        else if (pnl_pct <= -sl_pct) { sim_price_pct = -sl_pct; exit_reason = 'sl'; }
        else if (pnl_pct >= 0) { exit_reason = 'timeout'; }
        // Position size assumed constant for simulation, apply kelly as multiplier
        const position = (t.position_size || 50) * kelly;
        const gross = position * (sim_price_pct / 100.0);
        const fee = position * 0.008;
        const net = gross - fee;
        total += net;
        if (net > 0) wins++; else losses++;
        fees += fee;
    }
    return { total, wins, losses, fees, trades: trades.length };
}

const results = [];
for (const tp of TP_MS) for (const sl of SL_MS) for (const k of KELLY) {
    const res = simulateCandidate(tp, sl, k);
    results.push({tp_multiplier: tp, sl_multiplier: sl, kelly_fraction: k, total_pnl: res.total, wins: res.wins, losses: res.losses});
}

results.sort((a,b)=> b.total_pnl - a.total_pnl);
const out = path.join(__dirname, '..', 'logs', 'candidates_dynamic.json');
fs.writeFileSync(out, JSON.stringify(results.slice(0,50), null, 2));
console.log('Generated', results.length, 'candidates. Top results saved to', out);
