#!/usr/bin/env node
require('dotenv').config();
const Database = require('better-sqlite3');
const GeminiClient = require('../lib/gemini_client.js');

const gc = new GeminiClient({ mode: 'live' });
const fixTime = 1773277891; // when fixes were deployed

(async () => {
    const bal = await gc.getAvailableBalance();
    const pos = await gc.getPositions();
    const positions = Object.values(pos || {});
    
    let totalCost = 0, totalMktVal = 0;
    const details = [];
    for (const p of positions) {
        const qty = parseFloat(p.totalQuantity || 0);
        const avg = parseFloat(p.avgPrice || 0);
        const last = parseFloat(p.prices?.lastTradePrice || avg);
        const cost = qty * avg;
        const mktVal = qty * last;
        totalCost += cost;
        totalMktVal += mktVal;
        const unrealPnl = mktVal - cost;
        details.push({ sym: p.symbol, outcome: p.outcome, qty, avg, last, cost, mktVal, unrealPnl });
    }
    
    const time = new Date().toISOString().substring(11, 19);
    console.log(`\n=== MONITOR CHECK @ ${time} UTC ===`);
    console.log(`Cash: $${bal.toFixed(2)} | Positions: ${positions.length} | Cost: $${totalCost.toFixed(2)} | Mkt Value: $${totalMktVal.toFixed(2)}`);
    console.log(`Total account: $${(bal + totalMktVal).toFixed(2)} | Unrealized P&L: $${(totalMktVal - totalCost).toFixed(2)}`);
    
    // Show positions with unrealized P&L
    details.sort((a, b) => b.unrealPnl - a.unrealPnl);
    console.log('\nPositions (sorted by unrealized P&L):');
    for (const d of details) {
        const pnlStr = d.unrealPnl >= 0 ? `+$${d.unrealPnl.toFixed(2)}` : `-$${Math.abs(d.unrealPnl).toFixed(2)}`;
        console.log(`  ${d.sym.substring(0,40)} ${d.outcome} ${d.qty}x avg=$${d.avg} last=$${d.last} ${pnlStr}`);
    }
    
    // DB: trades since fix
    const db = new Database('./data/prediction_markets.db', { readonly: true });
    const postFix = db.prepare("SELECT id, gemini_market_id, direction, entry_price, exit_price, position_size, pnl, exit_reason, is_open FROM prediction_trades WHERE mode='live' AND created_at > ? ORDER BY id DESC").all(fixTime);
    const closedPostFix = postFix.filter(t => !t.is_open);
    const openPostFix = postFix.filter(t => t.is_open);
    let postFixPnl = closedPostFix.reduce((s, t) => s + (t.pnl || 0), 0);
    
    console.log(`\nPost-fix trades: ${postFix.length} (${openPostFix.length} open, ${closedPostFix.length} closed)`);
    if (closedPostFix.length > 0) {
        console.log('Closed post-fix trades:');
        for (const t of closedPostFix) {
            const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(3)}` : `-$${Math.abs(t.pnl).toFixed(3)}`;
            console.log(`  #${t.id} ${t.gemini_market_id.substring(0,40)} ${t.direction} ${pnlStr} (${t.exit_reason})`);
        }
        console.log(`Post-fix realized P&L: $${postFixPnl.toFixed(2)}`);
    }
    
    // Recent rejections
    const since = Math.floor(Date.now() / 1000) - 300;
    const rejects = db.prepare("SELECT rejection_reason, COUNT(*) as cnt FROM entry_rejections WHERE timestamp > ? GROUP BY rejection_reason ORDER BY cnt DESC LIMIT 5").all(since);
    if (rejects.length > 0) {
        console.log('\nRecent rejections (5 min):');
        for (const r of rejects) console.log(`  ${r.rejection_reason}: ${r.cnt}`);
    }
    
    db.close();
})();
