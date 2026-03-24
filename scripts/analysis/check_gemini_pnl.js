#!/usr/bin/env node
require('dotenv').config();
const GeminiClient = require('../lib/gemini_client.js');
const gc = new GeminiClient({ mode: 'live' });

(async () => {
    const history = await gc.getOrderHistory();
    const raw = Array.isArray(history) ? history : (history?.orders || []);
    const filled = raw.filter(o => o.status === 'filled');

    const bySymbol = new Map();
    for (const o of filled) {
        const sym = o.symbol || 'UNKNOWN';
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        bySymbol.get(sym).push(o);
    }

    console.log('=== GEMINI P&L BY CONTRACT (filled orders) ===\n');
    let totalPnL = 0;
    let totalInvested = 0;
    for (const [sym, trades] of bySymbol) {
        let buyCost = 0, buyQty = 0, sellRevenue = 0, sellQty = 0;
        const details = [];
        for (const t of trades) {
            const q = parseFloat(t.filledQuantity || 0);
            const p = parseFloat(t.avgExecutionPrice || 0);
            if (t.side === 'buy') { buyCost += q * p; buyQty += q; }
            else { sellRevenue += q * p; sellQty += q; }
            details.push(`  ${t.side.toUpperCase()} ${t.outcome} qty=${q} @$${p.toFixed(2)} [${t.createdAt}]`);
        }
        const pnl = sellRevenue - buyCost;
        const netQty = buyQty - sellQty;
        totalPnL += pnl;
        totalInvested += buyCost;
        const status = netQty > 0 ? `OPEN(${netQty} remaining)` : 'CLOSED';
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        console.log(`${sym} [${status}]`);
        console.log(`  Bought: ${buyQty} @ avg $${buyQty > 0 ? (buyCost/buyQty).toFixed(3) : '0'} = $${buyCost.toFixed(2)}`);
        console.log(`  Sold:   ${sellQty} @ avg $${sellQty > 0 ? (sellRevenue/sellQty).toFixed(3) : '0'} = $${sellRevenue.toFixed(2)}`);
        console.log(`  PnL: ${pnlStr}`);
        for (const d of details) console.log(d);
        console.log('');
    }
    console.log('=== SUMMARY ===');
    console.log(`Total invested: $${totalInvested.toFixed(2)}`);
    console.log(`Total P&L: $${totalPnL.toFixed(2)}`);
    console.log(`Filled orders: ${filled.length}`);

    // Current positions
    try {
        const pos = await gc.getPositions();
        const positions = pos?.positions || pos || [];
        console.log(`\n=== OPEN POSITIONS ON GEMINI (${Array.isArray(positions) ? positions.length : '?'}) ===`);
        if (Array.isArray(positions)) {
            for (const p of positions) {
                console.log(`  ${p.symbol} ${p.outcome} qty=${p.quantity} avgEntry=$${p.avgEntryPrice}`);
            }
        }
    } catch(e) {
        console.log('Could not fetch positions:', e.message);
    }
})();
