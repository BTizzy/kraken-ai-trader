#!/usr/bin/env node
/**
 * Cross-Platform Arbitrage Backtester
 *
 * Tests the composite scoring strategy on gemini_sim_* markets
 * where we have Gemini + Polymarket prices over 73 hours.
 *
 * Strategy: When Gemini price diverges from Polymarket reference by more
 * than the spread + fees, enter a trade and hold until convergence.
 *
 * This is the actual strategy the bot uses for non-crypto markets.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');

class CrossPlatformBacktester {
    constructor(params = {}) {
        this.db = new Database(DB_PATH, { readonly: true });

        this.params = {
            minEdge: params.minEdge ?? 0.03,            // Min edge after fees
            spreadFilter: params.spreadFilter ?? 2.0,    // Edge > spread * N + buffer
            spreadBuffer: params.spreadBuffer ?? 0.01,
            maxSpread: params.maxSpread ?? 0.15,
            stopLoss: params.stopLoss ?? 0.05,            // YES-side SL width
            takeProfitMin: params.takeProfitMin ?? 0.015,
            maxHoldSeconds: params.maxHoldSeconds ?? 7200,
            feePerSide: params.feePerSide ?? 0.0001,
            maxPositionUSD: params.maxPositionUSD ?? 10,
            walletUSD: params.walletUSD ?? 166.84,
            maxConcurrent: params.maxConcurrent ?? 3,
            sampleIntervalSec: params.sampleIntervalSec ?? 60, // Check every minute
            minDivergence: params.minDivergence ?? 0.03,  // Min Gemini-Poly divergence
            convergenceTarget: params.convergenceTarget ?? 0.01, // Exit when gap < this
            // Use spread filter or not (for h2s strategies, disable SL from spread filter)
            useSLInSpreadFilter: params.useSLInSpreadFilter ?? true,
        };

        this.positions = [];
        this.closedTrades = [];
        this.wallet = this.params.walletUSD;
        this.peakWallet = this.wallet;
        this.maxDrawdown = 0;
    }

    loadData() {
        // Load all simulated market price data
        const rows = this.db.prepare(`
            SELECT gemini_market_id, timestamp,
                   gemini_price_bid, gemini_price_ask, gemini_last,
                   polymarket_price_bid, polymarket_price_ask, polymarket_last
            FROM market_prices
            WHERE gemini_market_id LIKE 'gemini_sim_%'
              AND gemini_price_bid IS NOT NULL
              AND polymarket_price_bid IS NOT NULL
            ORDER BY timestamp ASC
        `).all();

        // Group by market
        this.markets = new Map();
        for (const row of rows) {
            if (!this.markets.has(row.gemini_market_id)) {
                this.markets.set(row.gemini_market_id, { marketId: row.gemini_market_id, prices: [] });
            }

            const gBid = row.gemini_price_bid;
            const gAsk = row.gemini_price_ask;
            const gMid = (gBid != null && gAsk != null) ? (gBid + gAsk) / 2 : row.gemini_last;
            const pBid = row.polymarket_price_bid;
            const pAsk = row.polymarket_price_ask;
            const pMid = (pBid != null && pAsk != null) ? (pBid + pAsk) / 2 : row.polymarket_last;

            this.markets.get(row.gemini_market_id).prices.push({
                ts: row.timestamp,
                gBid, gAsk, gMid, gLast: row.gemini_last,
                pBid, pAsk, pMid, pLast: row.polymarket_last
            });
        }

        // Build timestamp index
        const tsSet = new Set();
        for (const row of rows) tsSet.add(row.timestamp);
        this.timestamps = [...tsSet].sort((a, b) => a - b);

        // Build price lookup
        this.priceLookup = new Map();
        for (const [marketId, market] of this.markets) {
            const lookup = new Map();
            for (const p of market.prices) lookup.set(p.ts, p);
            this.priceLookup.set(marketId, lookup);
        }
    }

    run(silent = false) {
        if (!silent) this.loadData();
        const log = silent ? () => {} : console.log;

        log('\n--- Cross-Platform Arb Backtest ---');
        log(`Markets: ${this.markets.size}, Snapshots per market: ~${Math.round([...this.markets.values()][0]?.prices.length || 0)}`);
        log(`Params: minEdge=${this.params.minEdge}, minDiv=${this.params.minDivergence}, SL=${this.params.stopLoss}, maxHold=${this.params.maxHoldSeconds}s`);

        let signalsGenerated = 0, signalsFiltered = 0;
        const filterReasons = {};
        const addFilter = (r) => { signalsFiltered++; filterReasons[r] = (filterReasons[r] || 0) + 1; };
        let lastSampleTs = 0;

        for (const ts of this.timestamps) {
            if (ts - lastSampleTs < this.params.sampleIntervalSec) continue;
            lastSampleTs = ts;

            // Monitor positions
            this._monitorPositions(ts);

            // Scan for signals
            for (const [marketId, market] of this.markets) {
                const lookup = this.priceLookup.get(marketId);
                const price = lookup.get(ts);
                if (!price) continue;
                if (price.gBid == null || price.gAsk == null) continue;
                if (price.pMid == null) continue;

                const gSpread = price.gAsk - price.gBid;
                if (gSpread <= 0) continue;
                if (gSpread > this.params.maxSpread) { addFilter('spread_too_wide'); continue; }

                const gMid = price.gMid;
                const refPrice = price.pMid; // Polymarket as reference

                // Divergence: how far is Gemini from reference
                const divergence = gMid - refPrice;
                const absDivergence = Math.abs(divergence);

                if (absDivergence < this.params.minDivergence) continue;
                signalsGenerated++;

                // Direction: if Gemini < ref → buy YES (underpriced), if Gemini > ref → buy NO
                let direction, edge, entryPrice;
                if (divergence < 0) {
                    // Gemini underpriced → buy YES at ask
                    direction = 'YES';
                    edge = refPrice - price.gAsk; // Expected profit: ref - ask
                    entryPrice = price.gAsk;
                } else {
                    // Gemini overpriced → buy NO (entry at YES bid)
                    direction = 'NO';
                    edge = price.gBid - refPrice; // Expected profit: bid - ref
                    entryPrice = price.gBid; // YES-side
                }

                if (edge <= 0) { addFilter('negative_edge'); continue; }

                // Net edge
                const cost = direction === 'NO' ? (1 - entryPrice) : entryPrice;
                const roundTripFees = cost * this.params.feePerSide * 2;
                const netEdge = edge - roundTripFees - gSpread;
                if (netEdge < this.params.minEdge) { addFilter('edge_too_small'); continue; }

                // Spread filter
                const minReqEdge = this.params.useSLInSpreadFilter
                    ? Math.max(this.params.stopLoss, gSpread * this.params.spreadFilter + this.params.spreadBuffer)
                    : gSpread * this.params.spreadFilter + this.params.spreadBuffer;
                if (edge < minReqEdge) { addFilter('spread_filter'); continue; }

                // Max concurrent
                if (this.positions.length >= this.params.maxConcurrent) { addFilter('max_concurrent'); continue; }

                // No duplicate
                if (this.positions.some(p => p.marketId === marketId)) { addFilter('duplicate'); continue; }

                // Position sizing
                const positionSize = Math.min(this.params.maxPositionUSD, this.wallet * 0.10);
                if (positionSize < 1) { addFilter('wallet_low'); continue; }

                // TP/SL
                const tpTarget = direction === 'YES'
                    ? Math.min(refPrice, 0.99) // Target: converge to ref
                    : Math.max(refPrice, 0.01);
                const tpPrice = direction === 'YES'
                    ? Math.max(tpTarget, entryPrice + this.params.takeProfitMin)
                    : Math.min(tpTarget, entryPrice - this.params.takeProfitMin);
                const slPrice = direction === 'YES'
                    ? gMid - this.params.stopLoss
                    : gMid + this.params.stopLoss;

                this.positions.push({
                    marketId, direction, entryPrice, entryTs: ts,
                    positionSize, edge, netEdge, gSpread: gSpread,
                    refPrice, tpPrice, slPrice,
                    maxHold: this.params.maxHoldSeconds,
                    divergence: absDivergence
                });
            }
        }

        // Close remaining
        const finalTs = this.timestamps[this.timestamps.length - 1];
        for (const pos of [...this.positions]) this._closePosition(pos, finalTs, 'data_end');

        return this._report(signalsGenerated, signalsFiltered, filterReasons, silent);
    }

    _monitorPositions(ts) {
        for (const pos of [...this.positions]) {
            const lookup = this.priceLookup.get(pos.marketId);
            const price = lookup?.get(ts);
            if (!price) return;

            const gMid = price.gMid;
            if (gMid == null) continue;

            const holdTime = ts - pos.entryTs;

            // Time-decay SL
            let effectiveSL = pos.slPrice;
            const decayFrac = holdTime / pos.maxHold;
            if (decayFrac >= 0.80) {
                const tighten = 1 - (decayFrac - 0.80) / 0.20 * 0.50;
                const dist = Math.abs(gMid - pos.slPrice);
                effectiveSL = pos.direction === 'YES' ? gMid - dist * tighten : gMid + dist * tighten;
            }

            // Convergence exit: if Gemini converged to ref within target
            const currentDiv = pos.direction === 'YES'
                ? (pos.refPrice - gMid)  // For YES: ref > Gemini means gap
                : (gMid - pos.refPrice); // For NO: Gemini > ref means gap
            if (currentDiv <= this.params.convergenceTarget) {
                this._closePosition(pos, ts, 'convergence', null, price);
                continue;
            }

            // TP/SL checks
            let exitReason = null;
            if (pos.direction === 'YES') {
                if (gMid >= pos.tpPrice) exitReason = 'take_profit';
                else if (gMid <= effectiveSL) exitReason = decayFrac >= 0.80 ? 'time_decay' : 'stop_loss';
            } else {
                if (gMid <= pos.tpPrice) exitReason = 'take_profit';
                else if (gMid >= effectiveSL) exitReason = decayFrac >= 0.80 ? 'time_decay' : 'stop_loss';
            }
            if (!exitReason && holdTime >= pos.maxHold) exitReason = 'time_exit';
            if (exitReason) this._closePosition(pos, ts, exitReason, null, price);
        }
    }

    _closePosition(pos, ts, reason, settlement = null, price = null) {
        const idx = this.positions.indexOf(pos);
        if (idx === -1) return;
        this.positions.splice(idx, 1);

        let exitPrice = null, pnl = 0;

        if (price) {
            // YES exits at bid, NO exits at ask (YES-side)
            exitPrice = pos.direction === 'YES'
                ? (price.gBid ?? price.gMid ?? price.gLast)
                : (price.gAsk ?? price.gMid ?? price.gLast);
        } else {
            // Data end — use last known price
            const market = this.markets.get(pos.marketId);
            if (market && market.prices.length > 0) {
                const last = market.prices[market.prices.length - 1];
                exitPrice = pos.direction === 'YES' ? (last.gBid ?? last.gMid) : (last.gAsk ?? last.gMid);
            }
        }

        if (exitPrice != null) {
            if (pos.direction === 'YES') {
                pnl = (exitPrice - pos.entryPrice) * pos.positionSize / pos.entryPrice;
            } else {
                pnl = (pos.entryPrice - exitPrice) * pos.positionSize / (1 - pos.entryPrice);
            }
        }

        // Fees + clamp
        const entryFee = pos.positionSize * this.params.feePerSide;
        const exitFee = Math.abs(pnl + pos.positionSize) * this.params.feePerSide;
        pnl -= (entryFee + exitFee);
        pnl = Math.max(-pos.positionSize, Math.min(pnl, pos.positionSize * 10));

        this.wallet += pnl;
        this.peakWallet = Math.max(this.peakWallet, this.wallet);
        this.maxDrawdown = Math.max(this.maxDrawdown, (this.peakWallet - this.wallet) / this.peakWallet);

        this.closedTrades.push({
            ...pos, exitTs: ts, exitPrice, reason, pnl,
            holdTimeSec: ts - pos.entryTs, walletAfter: this.wallet
        });
    }

    _report(signalsGenerated, signalsFiltered, filterReasons, silent = false) {
        const trades = this.closedTrades;
        const wins = trades.filter(t => t.pnl > 0);
        const losses = trades.filter(t => t.pnl <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
        const avgPnl = trades.length > 0 ? totalPnl / trades.length : 0;
        const winRate = trades.length > 0 ? wins.length / trades.length : 0;

        const returns = trades.map(t => t.pnl / t.positionSize);
        const meanRet = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
        const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (returns.length - 1) : 0;
        const sharpe = variance > 0 ? (meanRet / Math.sqrt(variance)) * Math.sqrt(252 * 6) : 0;
        const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        const result = { trades: trades.length, wins: wins.length, winRate, totalPnl, avgPnl, profitFactor: pf, sharpe, maxDrawdown: this.maxDrawdown, finalWallet: this.wallet };

        if (silent) return result;

        console.log('\n' + '='.repeat(65));
        console.log('  CROSS-PLATFORM ARB BACKTEST RESULTS');
        console.log('='.repeat(65));

        console.log(`\n  Signals generated: ${signalsGenerated}`);
        console.log(`  Signals filtered:  ${signalsFiltered}`);
        for (const [r, c] of Object.entries(filterReasons).sort((a, b) => b[1] - a[1])) {
            console.log(`    ${r}: ${c}`);
        }

        console.log(`\n  Total trades: ${trades.length}`);
        console.log(`  Wins: ${wins.length}  Losses: ${losses.length}`);
        console.log(`  Win rate: ${(winRate * 100).toFixed(1)}%`);
        console.log(`  Total PnL: $${totalPnl.toFixed(2)}`);
        console.log(`  Avg PnL/trade: $${avgPnl.toFixed(2)}`);
        console.log(`  Profit factor: ${pf.toFixed(2)}`);
        console.log(`  Sharpe ratio: ${sharpe.toFixed(2)}`);
        console.log(`  Max drawdown: ${(this.maxDrawdown * 100).toFixed(1)}%`);
        console.log(`  Final wallet: $${this.wallet.toFixed(2)} (start: $${this.params.walletUSD})`);
        if (wins.length > 0) console.log(`  Avg win: $${(grossProfit / wins.length).toFixed(2)}`);
        if (losses.length > 0) console.log(`  Avg loss: $${(grossLoss / losses.length).toFixed(2)}`);

        // By exit reason
        console.log('\n  Exit reason breakdown:');
        const byReason = {};
        for (const t of trades) {
            if (!byReason[t.reason]) byReason[t.reason] = { count: 0, pnl: 0, wins: 0 };
            byReason[t.reason].count++; byReason[t.reason].pnl += t.pnl;
            if (t.pnl > 0) byReason[t.reason].wins++;
        }
        for (const [r, d] of Object.entries(byReason)) {
            console.log(`    ${r}: ${d.count} trades, $${d.pnl.toFixed(2)} PnL, ${(d.wins/d.count*100).toFixed(0)}% win`);
        }

        // By direction
        console.log('\n  Direction breakdown:');
        for (const dir of ['YES', 'NO']) {
            const dt = trades.filter(t => t.direction === dir);
            if (dt.length === 0) continue;
            const dw = dt.filter(t => t.pnl > 0);
            const dp = dt.reduce((s, t) => s + t.pnl, 0);
            console.log(`    ${dir}: ${dt.length} trades, $${dp.toFixed(2)} PnL, ${(dw.length/dt.length*100).toFixed(0)}% win`);
        }

        // Individual trades
        if (trades.length <= 80) {
            console.log('\n  Trades:');
            console.log('  ' + '-'.repeat(110));
            console.log(`  ${'Market'.padEnd(22)} ${'Dir'.padEnd(4)} ${'Entry'.padEnd(7)} ${'Exit'.padEnd(7)} ${'Edge'.padEnd(7)} ${'Div'.padEnd(6)} ${'Hold'.padEnd(7)} ${'PnL'.padEnd(9)} ${'Reason'.padEnd(14)} Ref`);
            console.log('  ' + '-'.repeat(110));
            for (const t of trades) {
                const holdMin = (t.holdTimeSec / 60).toFixed(0);
                console.log(
                    `  ${t.marketId.padEnd(22)} ${t.direction.padEnd(4)} ` +
                    `${(t.entryPrice||0).toFixed(3).padEnd(7)} ${(t.exitPrice||0).toFixed(3).padEnd(7)} ` +
                    `${(t.edge||0).toFixed(3).padEnd(7)} ${(t.divergence||0).toFixed(3).padEnd(6)} ` +
                    `${(holdMin+'m').padEnd(7)} ${('$'+(t.pnl||0).toFixed(2)).padEnd(9)} ` +
                    `${t.reason.padEnd(14)} ${(t.refPrice||0).toFixed(3)}`
                );
            }
        }

        console.log('\n' + '='.repeat(65) + '\n');
        return result;
    }
}

// ─── Parameter Sweep ──────────────────────────────────────────────────────────

function sweep() {
    console.log('='.repeat(65));
    console.log('  CROSS-PLATFORM ARB PARAMETER SWEEP');
    console.log('='.repeat(65) + '\n');

    const template = new CrossPlatformBacktester();
    template.loadData();

    console.log(`  Data: ${template.markets.size} markets, ${template.timestamps.length} timestamps`);
    console.log(`  Time: ${new Date(template.timestamps[0]*1000).toISOString()} → ${new Date(template.timestamps[template.timestamps.length-1]*1000).toISOString()}\n`);

    const configs = [
        // Baseline
        { name: 'Baseline' },

        // Min divergence
        { name: 'Div 2c', minDivergence: 0.02 },
        { name: 'Div 4c', minDivergence: 0.04 },
        { name: 'Div 5c', minDivergence: 0.05 },
        { name: 'Div 8c', minDivergence: 0.08 },

        // Edge threshold
        { name: 'Edge 1c', minEdge: 0.01 },
        { name: 'Edge 2c', minEdge: 0.02 },
        { name: 'Edge 5c', minEdge: 0.05 },
        { name: 'Edge 8c', minEdge: 0.08 },

        // Stop loss
        { name: 'SL 3c', stopLoss: 0.03 },
        { name: 'SL 8c', stopLoss: 0.08 },
        { name: 'SL 10c', stopLoss: 0.10 },
        { name: 'SL 15c', stopLoss: 0.15 },
        { name: 'No SL', stopLoss: 0.99, useSLInSpreadFilter: false },

        // Hold time
        { name: 'Hold 30m', maxHoldSeconds: 1800 },
        { name: 'Hold 1h', maxHoldSeconds: 3600 },
        { name: 'Hold 4h', maxHoldSeconds: 14400 },

        // Convergence target
        { name: 'Conv 0.5c', convergenceTarget: 0.005 },
        { name: 'Conv 2c', convergenceTarget: 0.02 },
        { name: 'Conv 3c', convergenceTarget: 0.03 },

        // Max concurrent
        { name: 'MaxConc 5', maxConcurrent: 5 },
        { name: 'MaxConc 10', maxConcurrent: 10 },

        // Spread filter
        { name: 'NoSL+SprdFilt', useSLInSpreadFilter: false },
        { name: 'SprdFilt 1.5x', spreadFilter: 1.5 },
        { name: 'SprdFilt 3x', spreadFilter: 3.0 },

        // Combined
        { name: 'Tight', minDivergence: 0.05, minEdge: 0.03, stopLoss: 0.08 },
        { name: 'Loose', minDivergence: 0.02, minEdge: 0.01, stopLoss: 0.10, maxConcurrent: 5, useSLInSpreadFilter: false },
        { name: 'LongHold', maxHoldSeconds: 14400, stopLoss: 0.10, convergenceTarget: 0.005 },
        { name: 'Scalper', maxHoldSeconds: 600, stopLoss: 0.03, convergenceTarget: 0.01, sampleIntervalSec: 30 },
        { name: 'Patient', minDivergence: 0.04, maxHoldSeconds: 14400, stopLoss: 0.15, useSLInSpreadFilter: false, convergenceTarget: 0.005 },
        { name: 'HighConvic', minDivergence: 0.05, minEdge: 0.05, stopLoss: 0.10, maxHoldSeconds: 7200 },
        { name: 'Wide+Long', stopLoss: 0.15, maxHoldSeconds: 14400, convergenceTarget: 0.005, useSLInSpreadFilter: false },
        { name: 'MaxFlow', minDivergence: 0.02, minEdge: 0.01, maxConcurrent: 10, useSLInSpreadFilter: false, convergenceTarget: 0.02 },
    ];

    const results = [];
    for (const config of configs) {
        const { name, ...params } = config;
        const bt = new CrossPlatformBacktester(params);
        bt.markets = template.markets;
        bt.timestamps = template.timestamps;
        bt.priceLookup = template.priceLookup;

        const result = bt.run(true);
        result.name = name;
        results.push(result);

        process.stdout.write(
            `  ${name.padEnd(18)} → ${String(result.trades).padEnd(4)} trades, WR ${(result.winRate*100).toFixed(0).padStart(3)}%, ` +
            `PnL $${result.totalPnl.toFixed(2).padStart(8)}, PF ${result.profitFactor.toFixed(2).padStart(6)}, ` +
            `Sharpe ${result.sharpe.toFixed(2).padStart(7)}, DD ${(result.maxDrawdown*100).toFixed(1).padStart(5)}%\n`
        );
    }

    // Summary
    console.log('\n' + '='.repeat(100));
    console.log('  SWEEP RESULTS (sorted by PnL)');
    console.log('='.repeat(100));
    console.log(`${'Name'.padEnd(20)} ${'#Tr'.padEnd(5)} ${'WR'.padEnd(7)} ${'PnL'.padEnd(11)} ${'AvgPnL'.padEnd(10)} ${'PF'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'MaxDD'.padEnd(8)}`);
    console.log('-'.repeat(100));

    results.sort((a, b) => b.totalPnl - a.totalPnl);
    for (const r of results) {
        console.log(
            `${r.name.padEnd(20)} ${String(r.trades).padEnd(5)} ` +
            `${(r.winRate*100).toFixed(0).padStart(3)}%    ` +
            `$${r.totalPnl.toFixed(2).padStart(8)}   ` +
            `$${r.avgPnl.toFixed(2).padStart(7)}   ` +
            `${r.profitFactor.toFixed(2).padStart(6)}   ` +
            `${r.sharpe.toFixed(2).padStart(6)}   ` +
            `${(r.maxDrawdown*100).toFixed(1).padStart(5)}%`
        );
    }

    const profitable = results.filter(r => r.totalPnl > 0 && r.trades >= 5);
    if (profitable.length > 0) {
        console.log(`\n  BEST: ${profitable[0].name} — ${profitable[0].trades} trades, ${(profitable[0].winRate*100).toFixed(0)}% WR, $${profitable[0].totalPnl.toFixed(2)} PnL, PF ${profitable[0].profitFactor.toFixed(2)}`);
    } else {
        console.log('\n  No profitable strategies with 5+ trades found');
    }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'sweep';
if (mode === 'single') {
    const bt = new CrossPlatformBacktester();
    bt.loadData();
    bt.run();
} else if (mode === 'sweep') {
    sweep();
}
