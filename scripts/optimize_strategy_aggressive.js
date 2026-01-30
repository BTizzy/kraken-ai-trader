#!/usr/bin/env node
/**
 * Aggressive optimizer: grid search over strategy params + confidence/vol filters
 * Prints ranked candidates by simulated P&L and profit factor.
 */

const fs = require('fs');
const path = require('path');

const TRADE_LOG_PATH = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
if (!fs.existsSync(TRADE_LOG_PATH)) {
    console.error('❌ trade_log.json not found:', TRADE_LOG_PATH);
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
const trades = data.trades || [];
const completed = trades.filter(t => t.status === 'completed' || (t.entry_price > 0 && t.exit_price > 0));
if (completed.length === 0) {
    console.error('No completed trades available for optimization');
    process.exit(1);
}

function simulateTrade(trade, strat) {
    const hasValid = trade.entry_price > 0 && trade.exit_price > 0;
    if (!hasValid) return { could_simulate: false, original_pnl: trade.pnl || 0 };

    const entry = trade.entry_price;
    const exit = trade.exit_price;
    const dir = trade.direction || 'LONG';
    const isShort = dir === 'SHORT';
    const pricePct = isShort ? ((entry - exit) / entry * 100) : ((exit - entry) / entry * 100);

    let simPricePct = pricePct;
    if (pricePct >= strat.tp) simPricePct = strat.tp;
    else if (pricePct <= -strat.sl) simPricePct = -strat.sl;
    else if (pricePct >= strat.trail_start) {
        const peak = Math.max(pricePct, strat.trail_start);
        const trailed = peak - strat.trail_stop;
        if (trailed > pricePct) simPricePct = trailed;
    }
    const positionSize = strat.position_size_usd;
    const gross = positionSize * (simPricePct / 100);
    const fees = positionSize * (strat.taker_fee_pct / 100) * 2;
    const net = gross - fees;
    return { could_simulate: true, simulated_pnl: net, original_pnl: trade.pnl || 0, sim_exit_pct: simPricePct };
}

function metricsForResults(results) {
    const sim = results.filter(r => r.could_simulate);
    const wins = sim.filter(r => r.simulated_pnl > 0);
    const losses = sim.filter(r => r.simulated_pnl <= 0);
    const totalPnl = sim.reduce((s,r)=>s + r.simulated_pnl,0);
    const winPnl = wins.reduce((s,r)=>s + r.simulated_pnl,0);
    const lossPnl = Math.abs(losses.reduce((s,r)=>s + r.simulated_pnl,0));
    const profitFactor = lossPnl > 0 ? (winPnl / lossPnl) : (winPnl>0?Infinity:0);
    return { simulated_trades: sim.length, total_pnl: totalPnl, win_rate: sim.length ? (wins.length/sim.length*100):0, profit_factor: profitFactor };
}

// Parameter grids (aggressive focus)
const TPS = [1.5, 2.0, 2.5, 3.0];
const SLS = [0.2, 0.4, 0.6, 1.0];
const TRAILS = [0.3, 0.5, 0.8];
const TRAIL_STOPS = [0.1, 0.2, 0.3];
const MIN_VOL = [0.0, 0.01, 0.02]; // percent
const VOL_QUANTS = [0.8, 0.9, 0.95]; // consider top-volatility quantiles
const MIN_CONF = [0.0, 0.35, 0.5]; // 0-1
const KELLY = [0.25, 0.5]; // fraction override to try

const candidates = [];

for (const tp of TPS) {
    for (const sl of SLS) {
        for (const ts of TRAILS) {
            for (const tstop of TRAIL_STOPS) {
                for (const mv of MIN_VOL) {
                    for (const mc of MIN_CONF) {
                        for (const kf of KELLY) {
                            const strat = {
                                tp: tp, sl: sl, trail_start: ts, trail_stop: tstop,
                                min_volatility: mv, min_confidence: mc, kelly_fraction: kf,
                                position_size_usd: 100, taker_fee_pct: 0.4
                            };

                            // Filter trades that meet vol threshold
                            let baseFiltered = completed.filter(t => {
                                const v = t.volatility_pct || (t.volatility_at_entry || 0);
                                return v >= mv;
                            });

                            // Test multiple volatility quantiles (including no quantile)
                            const quantilesToTest = [null].concat(VOL_QUANTS);
                            for (const q of quantilesToTest) {
                                let filtered = baseFiltered;
                                if (q !== null && baseFiltered.length > 0) {
                                    // compute threshold at quantile
                                    const vals = baseFiltered.map(t => t.volatility_pct || (t.volatility_at_entry || 0)).sort((a,b)=>a-b);
                                    const idx = Math.max(0, Math.floor(vals.length * q) - 1);
                                    const thr = vals[idx] || 0;
                                    filtered = baseFiltered.filter(t => (t.volatility_pct || (t.volatility_at_entry || 0)) >= thr);
                                }

                                if (filtered.length < 5) continue; // not enough samples

                            const results = filtered.map(t => simulateTrade(t, strat));
                            const m = metricsForResults(results);
                            // Keep candidates with a minimal sample size; we'll rank later
                            if (m.simulated_trades > 10) {
                                candidates.push({ strat, m });
                            }
                        }
                    }
                }
            }
        }
    }
}

candidates.sort((a,b) => b.m.total_pnl - a.m.total_pnl);

console.log('Top candidates (by total_pnl):');
console.log('Count:', candidates.length);
for (let i=0;i<Math.min(10,candidates.length);i++) {
    const c = candidates[i];
    console.log(`#${i+1}: TP=${c.strat.tp}% SL=${c.strat.sl}% TRAIL=${c.strat.trail_start}% TRSTOP=${c.strat.trail_stop}% MIN_VOL=${c.strat.min_volatility}% MIN_CONF=${c.strat.min_confidence} KELLY=${c.strat.kelly_fraction} -> Trades=${c.m.simulated_trades} P&L=${c.m.total_pnl.toFixed(2)} PF=${c.m.profit_factor.toFixed(2)} WR=${c.m.win_rate.toFixed(1)}%`);
}

if (candidates.length === 0) {
    console.log('No candidates found with positive P&L and PF>1.1 - consider loosening filters');
}

// Also show top by profit factor
const byPF = candidates.slice().sort((a,b) => b.m.profit_factor - a.m.profit_factor);
console.log('\nTop candidates (by profit factor):');
for (let i=0;i<Math.min(10,byPF.length);i++) {
    const c = byPF[i];
    console.log(`#${i+1}: PF=${c.m.profit_factor.toFixed(2)} P&L=${c.m.total_pnl.toFixed(2)} TRADES=${c.m.simulated_trades} TP=${c.strat.tp}% SL=${c.strat.sl}% MIN_VOL=${c.strat.min_volatility}% MIN_CONF=${c.strat.min_confidence}`);
}

// Top by win rate
const byWR = candidates.slice().sort((a,b) => b.m.win_rate - a.m.win_rate);
console.log('\nTop candidates (by win rate):');
for (let i=0;i<Math.min(10,byWR.length);i++) {
    const c = byWR[i];
    console.log(`#${i+1}: WR=${c.m.win_rate.toFixed(1)}% P&L=${c.m.total_pnl.toFixed(2)} PF=${c.m.profit_factor.toFixed(2)} TP=${c.strat.tp}% SL=${c.strat.sl}% MIN_VOL=${c.strat.min_volatility}% MIN_CONF=${c.strat.min_confidence}`);
}

module.exports = { candidates };
