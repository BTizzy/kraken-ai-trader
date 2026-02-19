#!/usr/bin/env node
/**
 * V17 Backtester — Uses real GEMI-* price snapshots from prediction_markets.db
 *
 * Strategy: Black-Scholes fair value vs Gemini market price arbitrage
 *
 * Convention (matches paper_trading_engine.js):
 *   entry_price is ALWAYS the YES-side price, regardless of direction.
 *   For YES: entry = ask (buy YES at ask)
 *   For NO:  entry = bid (YES-side bid; NO cost = 1 - bid)
 *   For YES exit: exitPrice = bid (sell YES at bid)
 *   For NO exit:  exitPrice = ask (YES-side; sell NO at 1 - ask)
 *
 * PnL formula:
 *   YES: (exitPrice - entryPrice) * posSize / entryPrice
 *   NO:  (entryPrice - exitPrice) * posSize / (1 - entryPrice)
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'prediction_markets.db');

// ─── Black-Scholes Binary Option ─────────────────────────────────────────────

function normalCDF(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1.0 + sign * y);
}

function bsBinaryProb(spot, strike, timeToExpiryHours, vol) {
    if (timeToExpiryHours <= 0) return spot >= strike ? 1.0 : 0.0;
    const T = timeToExpiryHours / (365.25 * 24);
    const sqrtT = Math.sqrt(T);
    const d2 = (Math.log(spot / strike) - (vol * vol / 2) * T) / (vol * sqrtT);
    return normalCDF(d2);
}

// ─── Contract Parsing ─────────────────────────────────────────────────────────

function parseContract(marketId) {
    const m = marketId.match(/^GEMI-([A-Z]+)(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-HI(\d+)$/);
    if (!m) return null;
    const [, asset, yy, mm, dd, hh, mn, strikeStr] = m;
    const strike = parseFloat(strikeStr);
    const expiryDate = new Date(Date.UTC(2000 + parseInt(yy), parseInt(mm) - 1, parseInt(dd), parseInt(hh), parseInt(mn)));
    return { asset, strike, expiryDate, expiryTs: expiryDate.getTime() / 1000 };
}

// ─── Spot Price Estimation from Contract Lattice ──────────────────────────────

function estimateSpotFromLattice(contracts) {
    if (contracts.length < 2) return null;
    contracts.sort((a, b) => a.strike - b.strike);

    // Find where mid crosses 0.50 (mid goes from >0.5 to <0.5 as strike increases)
    for (let i = 0; i < contracts.length - 1; i++) {
        const lower = contracts[i];
        const upper = contracts[i + 1];
        if (lower.mid >= 0.50 && upper.mid < 0.50) {
            const frac = (lower.mid - 0.50) / (lower.mid - upper.mid);
            return lower.strike + frac * (upper.strike - lower.strike);
        }
    }

    if (contracts[contracts.length - 1].mid >= 0.50) return contracts[contracts.length - 1].strike * 1.02;
    if (contracts[0].mid < 0.50) return contracts[0].strike * 0.98;
    return null;
}

// ─── Implied Volatility (bisection) ──────────────────────────────────────────

function impliedVol(spot, strike, ttxHours, marketMid) {
    if (ttxHours <= 0.1) return 0.50;
    let lo = 0.05, hi = 3.0;
    for (let i = 0; i < 50; i++) {
        const mid = (lo + hi) / 2;
        const p = bsBinaryProb(spot, strike, ttxHours, mid);
        if (p > marketMid) hi = mid; else lo = mid;
        if (hi - lo < 0.001) break;
    }
    return (lo + hi) / 2;
}

// ─── Main Backtester ──────────────────────────────────────────────────────────

class Backtester {
    constructor(params = {}) {
        this.db = new Database(DB_PATH, { readonly: true });

        this.params = {
            minEdge: params.minEdge ?? 0.08,
            spreadFilter: params.spreadFilter ?? 2.0,
            spreadBuffer: params.spreadBuffer ?? 0.01,
            maxSpread: params.maxSpread ?? 0.15,
            stopLoss: params.stopLoss ?? 0.05,
            takeProfitMin: params.takeProfitMin ?? 0.015,
            maxHoldSeconds: params.maxHoldSeconds ?? 7200,
            expiryHoldFraction: params.expiryHoldFraction ?? 0.80,
            feePerSide: params.feePerSide ?? 0.0001,
            defaultVol: params.defaultVol ?? 0.50,
            maxPositionUSD: params.maxPositionUSD ?? 10,
            walletUSD: params.walletUSD ?? 166.84,
            maxConcurrent: params.maxConcurrent ?? 3,
            sampleIntervalSec: params.sampleIntervalSec ?? 300,
            minMoneyness: params.minMoneyness ?? 0.80,
            maxMoneyness: params.maxMoneyness ?? 1.20,
            minTTXHours: params.minTTXHours ?? 0.5,
            useImpliedVol: params.useImpliedVol ?? false,
            holdToSettlement: params.holdToSettlement ?? false,
        };

        this.positions = [];
        this.closedTrades = [];
        this.wallet = this.params.walletUSD;
        this.peakWallet = this.wallet;
        this.maxDrawdown = 0;
    }

    loadData() {
        // Load all GEMI price data with any non-null fields
        const rows = this.db.prepare(`
            SELECT gemini_market_id, timestamp,
                   gemini_price_bid, gemini_price_ask, gemini_last
            FROM market_prices
            WHERE gemini_market_id LIKE 'GEMI-%'
              AND (gemini_price_bid IS NOT NULL OR gemini_price_ask IS NOT NULL OR gemini_last IS NOT NULL)
            ORDER BY timestamp ASC
        `).all();

        // Parse contracts
        this.contracts = new Map();
        for (const row of rows) {
            const parsed = parseContract(row.gemini_market_id);
            if (!parsed) continue;
            if (!this.contracts.has(row.gemini_market_id)) {
                this.contracts.set(row.gemini_market_id, { ...parsed, marketId: row.gemini_market_id, prices: [] });
            }
            const bid = row.gemini_price_bid;
            const ask = row.gemini_price_ask;
            const last = row.gemini_last;
            const mid = (bid != null && ask != null) ? (bid + ask) / 2 : last;
            this.contracts.get(row.gemini_market_id).prices.push({ ts: row.timestamp, bid, ask, last, mid });
        }

        // Build unique timestamps
        const tsSet = new Set();
        for (const row of rows) tsSet.add(row.timestamp);
        this.timestamps = [...tsSet].sort((a, b) => a - b);

        // Build price lookup: marketId → Map(ts → price)
        this.priceLookup = new Map();
        for (const [marketId, contract] of this.contracts) {
            const lookup = new Map();
            for (const p of contract.prices) lookup.set(p.ts, p);
            this.priceLookup.set(marketId, lookup);
        }

        // Determine settlements
        this.settlements = new Map();
        this._determineSettlements();
    }

    _determineSettlements() {
        const lastTs = this.timestamps[this.timestamps.length - 1];
        for (const [marketId, contract] of this.contracts) {
            if (contract.expiryTs > lastTs + 3600) continue;
            const lastPrice = contract.prices[contract.prices.length - 1];
            if (!lastPrice) continue;
            const fb = lastPrice.bid, fm = lastPrice.mid;
            if (fb != null && fb >= 0.90) this.settlements.set(marketId, 1);
            else if (fb != null && fb <= 0.10) this.settlements.set(marketId, 0);
            else if (fm != null && fm >= 0.85) this.settlements.set(marketId, 1);
            else if (fm != null && fm <= 0.15) this.settlements.set(marketId, 0);
        }
    }

    estimateSpotAtTimestamp(asset, ts) {
        const pts = [];
        for (const [, contract] of this.contracts) {
            if (contract.asset !== asset) continue;
            const p = this.priceLookup.get(contract.marketId).get(ts);
            if (!p || p.mid == null) continue;
            pts.push({ strike: contract.strike, mid: p.mid });
        }
        return pts.length >= 2 ? estimateSpotFromLattice(pts) : null;
    }

    estimateVolFromLattice(asset, spot, ts) {
        const vols = [];
        for (const [, contract] of this.contracts) {
            if (contract.asset !== asset) continue;
            const ttx = (contract.expiryTs - ts) / 3600;
            if (ttx <= 0.5) continue;
            const p = this.priceLookup.get(contract.marketId).get(ts);
            if (!p || p.mid == null || p.mid < 0.05 || p.mid > 0.95) continue;
            const iv = impliedVol(spot, contract.strike, ttx, p.mid);
            if (iv > 0.05 && iv < 2.0) vols.push(iv);
        }
        if (vols.length === 0) return this.params.defaultVol;
        vols.sort((a, b) => a - b);
        return vols[Math.floor(vols.length / 2)];
    }

    getNearestPrice(lookup, ts) {
        if (lookup.has(ts)) return lookup.get(ts);
        for (let d = 1; d <= 30; d++) {
            if (lookup.has(ts - d)) return lookup.get(ts - d);
            if (lookup.has(ts + d)) return lookup.get(ts + d);
        }
        return null;
    }

    run(silent = false) {
        if (!silent) this.loadData();
        const log = silent ? () => {} : console.log;

        log('\n--- Running Backtest ---');
        log(`Params: minEdge=${this.params.minEdge}, SL=${this.params.stopLoss}, maxHold=${this.params.maxHoldSeconds}s, holdToSettle=${this.params.holdToSettlement}`);

        let signalsGenerated = 0, signalsFiltered = 0;
        const filterReasons = {};
        const addFilter = (r) => { signalsFiltered++; filterReasons[r] = (filterReasons[r] || 0) + 1; };
        let lastSampleTs = 0;

        for (const ts of this.timestamps) {
            if (ts - lastSampleTs < this.params.sampleIntervalSec) continue;
            lastSampleTs = ts;

            // Monitor existing positions
            this._monitorPositions(ts);

            // Estimate spot prices
            const spots = {};
            for (const asset of ['BTC', 'ETH']) {
                const s = this.estimateSpotAtTimestamp(asset, ts);
                if (s) spots[asset] = s;
            }

            // Scan for signals
            for (const [marketId, contract] of this.contracts) {
                if (!spots[contract.asset]) continue;
                const spot = spots[contract.asset];
                const ttxHours = (contract.expiryTs - ts) / 3600;
                if (ttxHours < this.params.minTTXHours) continue;

                const price = this.priceLookup.get(marketId).get(ts);
                if (!price || price.bid == null || price.ask == null) continue;

                const spread = price.ask - price.bid;
                if (spread <= 0) continue; // Inverted book
                if (spread > this.params.maxSpread) { addFilter('spread_too_wide'); continue; }

                const vol = this.params.useImpliedVol ? this.estimateVolFromLattice(contract.asset, spot, ts) : this.params.defaultVol;
                const fv = bsBinaryProb(spot, contract.strike, ttxHours, vol);

                // Determine direction (YES-side convention)
                let direction = null, edge = 0, entryPrice = 0;
                if (fv > price.ask) {
                    // FV says YES is worth more than ask → buy YES
                    direction = 'YES';
                    edge = fv - price.ask;
                    entryPrice = price.ask; // YES-side entry
                } else if (fv < price.bid) {
                    // FV says YES is worth less than bid → sell YES / buy NO
                    direction = 'NO';
                    edge = price.bid - fv;
                    entryPrice = price.bid; // YES-side entry (for NO, cost = 1 - bid)
                }
                if (!direction) continue;
                signalsGenerated++;

                // Net edge: subtract fees and spread cost (exit crosses spread)
                const noCost = direction === 'NO' ? (1 - entryPrice) : entryPrice;
                const roundTripFees = noCost * this.params.feePerSide * 2;
                const netEdge = edge - roundTripFees - spread;
                if (netEdge < this.params.minEdge) { addFilter('edge_too_small'); continue; }

                // Spread filter: edge must exceed round-trip spread cost + buffer
                const minReqEdge = Math.max(this.params.stopLoss, spread * this.params.spreadFilter + this.params.spreadBuffer);
                if (edge < minReqEdge) { addFilter('spread_filter'); continue; }

                // Deep ITM/OTM guard
                const moneyness = spot / contract.strike;
                if (moneyness > this.params.maxMoneyness && direction === 'NO') { addFilter('deep_itm_no'); continue; }
                if (moneyness < this.params.minMoneyness && direction === 'YES') { addFilter('deep_otm_yes'); continue; }

                // NO leverage guard: reject cheap NO (expensive YES)
                if (direction === 'NO' && (1 - entryPrice) < 0.05) { addFilter('no_leverage'); continue; }

                // Max concurrent
                if (this.positions.length >= this.params.maxConcurrent) { addFilter('max_concurrent'); continue; }

                // No duplicate market
                if (this.positions.some(p => p.marketId === marketId)) { addFilter('duplicate'); continue; }

                // Position sizing (10% of wallet, capped at maxPositionUSD)
                const positionSize = Math.min(this.params.maxPositionUSD, this.wallet * 0.10);
                if (positionSize < 1) { addFilter('wallet_low'); continue; }

                // Max hold (expiry-aware)
                let maxHold = this.params.maxHoldSeconds;
                if (this.params.holdToSettlement) {
                    maxHold = Math.max(maxHold, ttxHours * 3600 * this.params.expiryHoldFraction);
                }

                // TP/SL (all in YES-side price space)
                const mid = (price.bid + price.ask) / 2;
                let tpPrice, slPrice;
                if (direction === 'YES') {
                    tpPrice = Math.min(Math.max(fv, entryPrice + this.params.takeProfitMin), 0.99);
                    slPrice = mid - this.params.stopLoss;
                } else {
                    tpPrice = Math.max(Math.min(fv, entryPrice - this.params.takeProfitMin), 0.01);
                    slPrice = mid + this.params.stopLoss;
                }

                this.positions.push({
                    marketId, direction, entryPrice, entryTs: ts,
                    positionSize, fv, tpPrice, slPrice, maxHold,
                    spot, strike: contract.strike, ttxHoursAtEntry: ttxHours,
                    spread, edge, netEdge, vol
                });
            }
        }

        // Close remaining at data end
        const finalTs = this.timestamps[this.timestamps.length - 1];
        for (const pos of [...this.positions]) this._closePosition(pos, finalTs, 'data_end');

        return this._report(signalsGenerated, signalsFiltered, filterReasons, silent);
    }

    _monitorPositions(ts) {
        for (const pos of [...this.positions]) {
            const contract = this.contracts.get(pos.marketId);
            if (!contract) continue;

            // Settlement
            if (ts >= contract.expiryTs) {
                const settlement = this.settlements.get(pos.marketId);
                this._closePosition(pos, ts, settlement !== undefined ? 'settlement' : 'expired_unknown', settlement);
                continue;
            }

            const price = this.getNearestPrice(this.priceLookup.get(pos.marketId), ts);
            if (!price) continue;
            const currentMid = price.mid;
            if (currentMid == null) continue;

            const holdTime = ts - pos.entryTs;

            // Time-decay stop tightening
            let effectiveSL = pos.slPrice;
            const decayFraction = holdTime / pos.maxHold;
            if (decayFraction >= 0.80) {
                const tightenFactor = 1 - (decayFraction - 0.80) / 0.20 * 0.50;
                const stopDist = Math.abs(currentMid - pos.slPrice);
                effectiveSL = pos.direction === 'YES'
                    ? currentMid - stopDist * tightenFactor
                    : currentMid + stopDist * tightenFactor;
            }

            // Check TP/SL/time (all in YES-side price space)
            let exitReason = null;
            if (pos.direction === 'YES') {
                if (currentMid >= pos.tpPrice) exitReason = 'take_profit';
                else if (currentMid <= effectiveSL) exitReason = decayFraction >= 0.80 ? 'time_decay_stop' : 'stop_loss';
            } else {
                if (currentMid <= pos.tpPrice) exitReason = 'take_profit';
                else if (currentMid >= effectiveSL) exitReason = decayFraction >= 0.80 ? 'time_decay_stop' : 'stop_loss';
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

        if (settlement !== null) {
            // Settlement: YES=1 means YES-side price goes to 1.0
            exitPrice = settlement; // 1 or 0 (YES-side)
            if (pos.direction === 'YES') {
                pnl = (exitPrice - pos.entryPrice) * pos.positionSize / pos.entryPrice;
            } else {
                pnl = (pos.entryPrice - exitPrice) * pos.positionSize / (1 - pos.entryPrice);
            }
        } else if (price) {
            // Realistic exit: YES sells at bid, NO sells at ask (YES-side)
            exitPrice = pos.direction === 'YES'
                ? (price.bid ?? price.mid ?? price.last)
                : (price.ask ?? price.mid ?? price.last);
            if (exitPrice != null) {
                if (pos.direction === 'YES') {
                    pnl = (exitPrice - pos.entryPrice) * pos.positionSize / pos.entryPrice;
                } else {
                    pnl = (pos.entryPrice - exitPrice) * pos.positionSize / (1 - pos.entryPrice);
                }
            }
        }

        // Fees
        const cost = pos.direction === 'NO' ? (1 - pos.entryPrice) : pos.entryPrice;
        const entryFee = pos.positionSize * this.params.feePerSide;
        const exitFee = Math.abs(pnl + pos.positionSize) * this.params.feePerSide;
        pnl -= (entryFee + exitFee);

        // Clamp
        pnl = Math.max(-pos.positionSize, Math.min(pnl, pos.positionSize * 10));

        this.wallet += pnl;
        this.peakWallet = Math.max(this.peakWallet, this.wallet);
        const dd = (this.peakWallet - this.wallet) / this.peakWallet;
        this.maxDrawdown = Math.max(this.maxDrawdown, dd);

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
        const meanReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
        const variance = returns.length > 1 ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1) : 0;
        const sharpe = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(252 * 6) : 0;

        const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

        const result = { trades: trades.length, wins: wins.length, winRate, totalPnl, avgPnl, profitFactor: pf, sharpe, maxDrawdown: this.maxDrawdown, finalWallet: this.wallet };

        if (silent) return result;

        console.log('\n' + '='.length ? '=' .repeat(65) : '');
        console.log('  BACKTEST RESULTS');
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

        // Individual trades (if manageable)
        if (trades.length <= 60) {
            console.log('\n  Trades:');
            console.log('  ' + '-'.repeat(130));
            console.log(`  ${'Market'.padEnd(35)} ${'Dir'.padEnd(4)} ${'Entry'.padEnd(7)} ${'Exit'.padEnd(7)} ${'Edge'.padEnd(7)} ${'Sprd'.padEnd(6)} ${'Hold'.padEnd(8)} ${'PnL'.padEnd(9)} ${'Reason'.padEnd(16)} ${'FV'.padEnd(6)} Vol`);
            console.log('  ' + '-'.repeat(130));
            for (const t of trades) {
                const holdMin = (t.holdTimeSec / 60).toFixed(0);
                const ep = t.entryPrice != null ? t.entryPrice.toFixed(3) : '??';
                const xp = t.exitPrice != null ? t.exitPrice.toFixed(3) : '??';
                console.log(`  ${t.marketId.padEnd(35)} ${t.direction.padEnd(4)} ${ep.padEnd(7)} ${xp.padEnd(7)} ${t.edge.toFixed(3).padEnd(7)} ${t.spread.toFixed(3).padEnd(6)} ${(holdMin+'m').padEnd(8)} ${('$'+t.pnl.toFixed(2)).padEnd(9)} ${t.reason.padEnd(16)} ${t.fv.toFixed(3).padEnd(6)} ${(t.vol||0).toFixed(2)}`);
            }
        }

        console.log('\n' + '='.repeat(65) + '\n');
        return result;
    }
}

// ─── Parameter Sweep ──────────────────────────────────────────────────────────

function parameterSweep() {
    console.log('='.repeat(65));
    console.log('  PARAMETER SWEEP — Finding Optimal Strategy Settings');
    console.log('='.repeat(65) + '\n');

    // Load data once
    const template = new Backtester();
    template.loadData();

    const configs = [
        // Baseline
        { name: 'V17 Baseline' },

        // Edge thresholds
        { name: 'Edge 3c', minEdge: 0.03 },
        { name: 'Edge 5c', minEdge: 0.05 },
        { name: 'Edge 10c', minEdge: 0.10 },
        { name: 'Edge 12c', minEdge: 0.12 },
        { name: 'Edge 15c', minEdge: 0.15 },
        { name: 'Edge 20c', minEdge: 0.20 },

        // Stop loss
        { name: 'SL 3c', stopLoss: 0.03 },
        { name: 'SL 8c', stopLoss: 0.08 },
        { name: 'SL 10c', stopLoss: 0.10 },
        { name: 'SL 15c', stopLoss: 0.15 },
        { name: 'No SL', stopLoss: 0.99 },

        // Hold time
        { name: 'Hold 30m', maxHoldSeconds: 1800 },
        { name: 'Hold 1h', maxHoldSeconds: 3600 },
        { name: 'Hold 4h', maxHoldSeconds: 14400 },
        { name: 'Hold 8h', maxHoldSeconds: 28800 },

        // Hold to settlement
        { name: 'H2S', holdToSettlement: true },
        { name: 'H2S+NoSL', holdToSettlement: true, stopLoss: 0.99 },
        { name: 'H2S+SL10', holdToSettlement: true, stopLoss: 0.10 },
        { name: 'H2S+SL15', holdToSettlement: true, stopLoss: 0.15 },

        // Implied vol
        { name: 'IV', useImpliedVol: true },
        { name: 'IV+H2S', useImpliedVol: true, holdToSettlement: true },
        { name: 'IV+H2S+NoSL', useImpliedVol: true, holdToSettlement: true, stopLoss: 0.99 },

        // Default vol
        { name: 'Vol 30%', defaultVol: 0.30 },
        { name: 'Vol 80%', defaultVol: 0.80 },
        { name: 'Vol 100%', defaultVol: 1.00 },

        // Lower spread tolerance
        { name: 'MaxSprd 8c', maxSpread: 0.08 },
        { name: 'MaxSprd 10c', maxSpread: 0.10 },
        { name: 'SprdFilt 1.5x', spreadFilter: 1.5 },
        { name: 'SprdFilt 3x', spreadFilter: 3.0 },

        // Sample interval
        { name: 'Sample 2m', sampleIntervalSec: 120 },
        { name: 'Sample 10m', sampleIntervalSec: 600 },

        // Combined strategies
        { name: 'Conservative', minEdge: 0.12, stopLoss: 0.10, holdToSettlement: true },
        { name: 'ValueInvestor', minEdge: 0.10, stopLoss: 0.99, holdToSettlement: true, useImpliedVol: true },
        { name: 'TightFilter', minEdge: 0.10, maxSpread: 0.08, spreadFilter: 3.0 },
        { name: 'HighEdge+H2S', minEdge: 0.15, holdToSettlement: true, stopLoss: 0.15 },
        { name: 'Relaxed', minEdge: 0.05, stopLoss: 0.10, holdToSettlement: true },
        { name: 'UltraConserv', minEdge: 0.15, stopLoss: 0.99, holdToSettlement: true, maxSpread: 0.10 },
        { name: 'WideSL+H2S', minEdge: 0.08, stopLoss: 0.20, holdToSettlement: true },
        { name: 'IV+Edge5c+H2S', useImpliedVol: true, minEdge: 0.05, holdToSettlement: true, stopLoss: 0.15 },
    ];

    const results = [];

    for (const config of configs) {
        const { name, ...params } = config;
        const bt = new Backtester(params);

        // Share loaded data
        bt.contracts = template.contracts;
        bt.timestamps = template.timestamps;
        bt.priceLookup = template.priceLookup;
        bt.settlements = template.settlements;

        const result = bt.run(true);
        result.name = name;
        results.push(result);

        process.stdout.write(`  ${name.padEnd(20)} → ${String(result.trades).padEnd(4)} trades, WR ${(result.winRate*100).toFixed(0).padStart(3)}%, PnL $${result.totalPnl.toFixed(2).padStart(8)}, PF ${result.profitFactor.toFixed(2).padStart(6)}, Sharpe ${result.sharpe.toFixed(2).padStart(7)}, DD ${(result.maxDrawdown*100).toFixed(1).padStart(5)}%\n`);
    }

    // Summary sorted by PnL
    console.log('\n' + '='.repeat(100));
    console.log('  SWEEP RESULTS (sorted by PnL)');
    console.log('='.repeat(100));
    console.log(`${'Name'.padEnd(22)} ${'#Tr'.padEnd(5)} ${'WR'.padEnd(7)} ${'PnL'.padEnd(11)} ${'AvgPnL'.padEnd(10)} ${'PF'.padEnd(8)} ${'Sharpe'.padEnd(8)} ${'MaxDD'.padEnd(8)} ${'Wallet'.padEnd(10)}`);
    console.log('-'.repeat(100));

    results.sort((a, b) => b.totalPnl - a.totalPnl);
    for (const r of results) {
        console.log(
            `${r.name.padEnd(22)} ${String(r.trades).padEnd(5)} ` +
            `${(r.winRate*100).toFixed(0).padStart(3)}%    ` +
            `$${r.totalPnl.toFixed(2).padStart(8)}   ` +
            `$${r.avgPnl.toFixed(2).padStart(7)}   ` +
            `${r.profitFactor.toFixed(2).padStart(6)}   ` +
            `${r.sharpe.toFixed(2).padStart(6)}   ` +
            `${(r.maxDrawdown*100).toFixed(1).padStart(5)}%  ` +
            `$${r.finalWallet.toFixed(2).padStart(8)}`
        );
    }

    const profitable = results.filter(r => r.totalPnl > 0 && r.trades >= 3);
    if (profitable.length > 0) {
        console.log(`\n  BEST: ${profitable[0].name} — ${profitable[0].trades} trades, ${(profitable[0].winRate*100).toFixed(0)}% WR, $${profitable[0].totalPnl.toFixed(2)} PnL`);
    } else {
        const best = results.filter(r => r.trades >= 1).sort((a, b) => b.totalPnl - a.totalPnl)[0];
        if (best) console.log(`\n  LEAST LOSING: ${best.name} — ${best.trades} trades, $${best.totalPnl.toFixed(2)} PnL`);
        else console.log('\n  NO TRADES GENERATED BY ANY CONFIGURATION');
    }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const mode = process.argv[2] || 'sweep';

if (mode === 'single') {
    const bt = new Backtester();
    bt.loadData();
    bt.run();
} else if (mode === 'sweep') {
    parameterSweep();
} else if (mode === 'detail') {
    const bt = new Backtester({
        minEdge: parseFloat(process.argv[3] || '0.08'),
        stopLoss: parseFloat(process.argv[4] || '0.05'),
        maxHoldSeconds: parseInt(process.argv[5] || '7200'),
        holdToSettlement: process.argv[6] === 'true'
    });
    bt.loadData();
    bt.run();
}
