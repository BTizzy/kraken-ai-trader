#!/usr/bin/env node
/**
 * Analyze historical trades to detect pairs where flipping trade direction would've improved results.
 * Produces logs/directional_analysis.json and writes data/direction_rules.json with simple invert rules.
 */
const fs = require('fs');
const path = require('path');

const TRADE_LOG = path.join(__dirname, '..', 'bot', 'build', 'trade_log.json');
const OUT = path.join(__dirname, '..', 'logs', 'directional_analysis.json');
const RULES_OUT = path.join(__dirname, '..', 'data', 'direction_rules.json');

if (!fs.existsSync(TRADE_LOG)) { console.error('trade_log.json missing (run bot to collect trades)'); process.exit(1); }
const data = JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'));
const trades = (data.trades || []).filter(t => t.entry_price && t.exit_price && t.position_size);

const byPair = {};
for (const t of trades) {
    const pair = t.pair || 'UNKNOWN';
    if (!byPair[pair]) byPair[pair] = {count:0, original_wins:0, inverted_wins:0, original_pnl_sum:0, inverted_pnl_sum:0, samples:[]};
    const entry = t.entry_price; const exit = t.exit_price; const pos = t.position_size || 0;
    // original net pnl already recorded, use gross pnl if available
    const orig_net = t.pnl || 0;
    // compute inverted pnl: flip direction
    let inverted_pnl = 0;
    if (t.direction === 'LONG') {
        // inverted would be SHORT: profit when price falls -> (entry - exit)/entry
        const pnl_pct = ((entry - exit) / entry) * 100.0;
        inverted_pnl = pos * (pnl_pct / 100.0) - (pos * 0.008);
    } else if (t.direction === 'SHORT') {
        const pnl_pct = ((exit - entry) / entry) * 100.0; // flipping direction
        inverted_pnl = pos * (pnl_pct / 100.0) - (pos * 0.008);
    }
    byPair[pair].count++;
    byPair[pair].original_pnl_sum += orig_net;
    byPair[pair].inverted_pnl_sum += inverted_pnl;
    if (orig_net > 0) byPair[pair].original_wins++;
    if (inverted_pnl > 0) byPair[pair].inverted_wins++;
    byPair[pair].samples.push({entry, exit, orig_net, inverted_pnl, direction: t.direction, timestamp: t.timestamp});
}

const summary = { generatedAt: new Date().toISOString(), pairs: {} };
const rules = {};
for (const [pair, s] of Object.entries(byPair)) {
    const avg_orig = s.original_pnl_sum / Math.max(1, s.count);
    const avg_inv = s.inverted_pnl_sum / Math.max(1, s.count);
    const prefer_invert = (s.inverted_wins > s.original_wins + Math.max(2, Math.floor(0.2 * s.count))) && (avg_inv > avg_orig);
    summary.pairs[pair] = { count: s.count, original_wins: s.original_wins, inverted_wins: s.inverted_wins, avg_orig: avg_orig, avg_inverted: avg_inv, prefer_invert };
    if (prefer_invert) rules[pair] = { invert: true, note: 'inverted wins significantly more historically' };
}

fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
fs.writeFileSync(RULES_OUT, JSON.stringify(rules, null, 2));
console.log('Directional analysis complete. Summary:', OUT, 'Rules written to', RULES_OUT);
