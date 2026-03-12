#!/usr/bin/env node
const Database = require('better-sqlite3');
const db = new Database('./data/prediction_markets.db', { readonly: true });

const trades = db.prepare("SELECT id, gemini_market_id, direction, entry_price, exit_price, position_size, pnl, exit_reason, is_open, mode, created_at, take_profit_price, stop_loss_price, realistic_entry_price, realistic_exit_price, realistic_pnl FROM prediction_trades WHERE mode='live' ORDER BY id DESC").all();

const openTrades = trades.filter(t => t.is_open);
const closedTrades = trades.filter(t => !t.is_open);

console.log('Total live trades:', trades.length);
console.log('Open:', openTrades.length);
console.log('Closed:', closedTrades.length);

console.log('\n=== CLOSED LIVE TRADES ===');
let totalPnl = 0, wins = 0, losses = 0;
const byReason = {};
for (const t of closedTrades) {
    totalPnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) wins++;
    else losses++;
    const reason = t.exit_reason || 'unknown';
    if (!byReason[reason]) byReason[reason] = { count: 0, pnl: 0 };
    byReason[reason].count++;
    byReason[reason].pnl += t.pnl || 0;
    
    const sym = t.gemini_market_id.substring(0, 42);
    console.log(`#${t.id} ${sym} ${t.direction} entry=$${t.entry_price} exit=$${t.exit_price} sz=$${t.position_size} pnl=$${(t.pnl||0).toFixed(3)} TP=$${t.take_profit_price} SL=$${t.stop_loss_price} reason=${t.exit_reason}`);
}

console.log('\n=== P&L BY EXIT REASON ===');
for (const [reason, data] of Object.entries(byReason)) {
    console.log(`${reason}: ${data.count} trades, PnL=$${data.pnl.toFixed(2)}`);
}

console.log(`\nWins: ${wins} Losses: ${losses} Total PnL: $${totalPnl.toFixed(2)}`);

console.log('\n=== OPEN LIVE POSITIONS ===');
for (const t of openTrades) {
    const sym = t.gemini_market_id.substring(0, 42);
    console.log(`#${t.id} ${sym} ${t.direction} entry=$${t.entry_price} sz=$${t.position_size} TP=$${t.take_profit_price} SL=$${t.stop_loss_price}`);
}

// Check for duplicate market entries (same market, multiple open)
console.log('\n=== DUPLICATE CHECK ===');
const marketCounts = {};
for (const t of trades) {
    const k = t.gemini_market_id;
    if (!marketCounts[k]) marketCounts[k] = { open: 0, closed: 0 };
    if (t.is_open) marketCounts[k].open++;
    else marketCounts[k].closed++;
}
for (const [k, v] of Object.entries(marketCounts)) {
    if (v.open > 1 || (v.open + v.closed) > 2) {
        console.log(`${k.substring(0,42)}: ${v.open} open, ${v.closed} closed = ${v.open+v.closed} total`);
    }
}

db.close();
