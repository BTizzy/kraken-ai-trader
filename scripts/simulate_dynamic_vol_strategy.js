#!/usr/bin/env node
/**
 * Simulate a volatility-adaptive strategy where TP/SL scale with observed entry volatility
 */
const fs = require('fs');
const path = require('path');
const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
if (!fs.existsSync(TRADE_LOG_PATH)) { console.error('trade_log.json missing'); process.exit(1); }
const trades = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8')).trades || [];
const completed = trades.filter(t => t.entry_price>0 && t.exit_price>0);

function simulateDynamic(trade, tp_mult, sl_mult, position_size=100, fee_pct=0.4) {
    const vol = trade.volatility_at_entry || trade.volatility_pct || 0.0; // assume percent
    const tp = vol * tp_mult; // percent
    const sl = vol * sl_mult; // percent
    const entry = trade.entry_price;
    const exit = trade.exit_price;
    const dir = trade.direction || 'LONG';
    const isShort = dir === 'SHORT';
    const pricePct = isShort ? ((entry - exit) / entry * 100) : ((exit - entry) / entry * 100);
    let simPct = pricePct;
    if (pricePct >= tp) simPct = tp;
    else if (pricePct <= -sl) simPct = -sl;
    const gross = position_size * (simPct / 100);
    const fees = position_size * (fee_pct/100) * 2;
    return gross - fees;
}

const tp_mults = [10,20,30,40,50];
const sl_mults = [2,5,8,10];
const results = [];
for (const tp of tp_mults) {
    for (const sl of sl_mults) {
        const res = completed.map(t => simulateDynamic(t,tp,sl,100,0.4));
        const wins = res.filter(r=>r>0);
        const loss = res.filter(r=>r<=0);
        const total = res.reduce((s,r)=>s+r,0);
        const pf = Math.abs(loss.reduce((s,r)=>s+r,0))>0 ? (wins.reduce((s,r)=>s+r,0) / Math.abs(loss.reduce((s,r)=>s+r,0))) : (wins.length>0?Infinity:0);
        results.push({tp_mult:tp, sl_mult:sl, total_pnl:total, pf, win_rate: res.length? (wins.length/res.length*100):0});
    }
}
results.sort((a,b)=>b.total_pnl - a.total_pnl);
console.log('Top dynamic-vol candidates by total P&L:');
for (let i=0;i<Math.min(10,results.length);i++) {
    const r = results[i];
    console.log(`#${i+1}: TPmult=${r.tp_mult} SLM=${r.sl_mult} P&L=${r.total_pnl.toFixed(2)} PF=${r.pf.toFixed(2)} WR=${r.win_rate.toFixed(1)}%`);
}

module.exports = { results };
