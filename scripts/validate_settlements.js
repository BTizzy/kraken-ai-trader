#!/usr/bin/env node
/**
 * Settlement Validation Script
 *
 * Replays stored GEMI-* price data through the BS fair value model,
 * identifies every signal (actionable or not), and checks whether the
 * predicted direction matched the actual settlement outcome.
 *
 * This answers: "If we had traded every BS signal, how many would have
 * settled in our favor?"
 */

const Database = require('better-sqlite3');
const path = require('path');

// Inline BS pricing (avoid dependency on live spot price feed)
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

function bsFairValue(spot, strike, hoursToExpiry, vol) {
    if (spot <= 0 || strike <= 0 || hoursToExpiry <= 0 || vol <= 0) {
        if (hoursToExpiry <= 0) return spot > strike ? 1.0 : 0.0;
        return 0.5;
    }
    const T = hoursToExpiry / (365.25 * 24);
    const d2 = (Math.log(spot / strike) - (vol * vol / 2) * T) / (vol * Math.sqrt(T));
    return normalCDF(d2);
}

// Parse GEMI symbol: GEMI-BTC2602192200-HI67000
function parseGemiSymbol(symbol) {
    const m = symbol.match(/GEMI-(\w+?)(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-HI(\d+)/);
    if (!m) return null;
    const [, asset, yy, mm, dd, hh, mn, strikeStr] = m;
    const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
    return { asset, strike: parseInt(strikeStr), expiry, expiryTs: expiry.getTime() };
}

// Estimate BTC/ETH spot from the set of contracts at a given timestamp
// Uses midpoint interpolation between the highest ITM and lowest OTM strikes
function estimateSpotFromContracts(contracts) {
    // contracts: [{strike, mid}] sorted by strike
    // Find where mid crosses 0.50
    let below = null, above = null;
    for (const c of contracts) {
        if (c.mid >= 0.50) {
            below = c; // highest strike where YES > 50% (ITM)
        } else {
            above = c; // lowest strike where YES < 50% (OTM)
            break;
        }
    }
    if (below && above) {
        // Linear interpolation
        const range = above.strike - below.strike;
        const frac = (0.50 - below.mid) / (above.mid - below.mid);
        return below.strike + range * frac;
    }
    if (below) return below.strike + 250; // all ITM, spot is above highest
    if (above) return above.strike - 250; // all OTM, spot is below lowest
    return null;
}

const dbPath = path.join(__dirname, '..', 'data', 'prediction_markets.db');
const db = new Database(dbPath, { readonly: true });

const VOL = 0.50; // Default annualized vol (same as engine default)
const MIN_EDGE = 0.02; // Show signals with at least 2c raw edge
const now = Date.now();

// Get all distinct GEMI contracts
const contracts = db.prepare(`
    SELECT DISTINCT gemini_market_id FROM market_prices
    WHERE gemini_market_id LIKE 'GEMI-%'
`).all().map(r => ({ ...parseGemiSymbol(r.gemini_market_id), marketId: r.gemini_market_id }))
  .filter(c => c && c.expiry); // filter out unparseable

// Separate settled vs unsettled
const settled = contracts.filter(c => c.expiryTs < now);
const unsettled = contracts.filter(c => c.expiryTs >= now);

console.log(`\n${'='.repeat(80)}`);
console.log('  SETTLEMENT VALIDATION — BS Fair Value vs Actual Outcomes');
console.log(`${'='.repeat(80)}\n`);
console.log(`  Total GEMI contracts tracked: ${contracts.length}`);
console.log(`  Already settled: ${settled.length}`);
console.log(`  Still open: ${unsettled.length}`);
console.log();

// For each settled contract, find what our BS model would have predicted
// at various times before settlement
const signals = [];

// Group contracts by asset + settlement time to estimate spot
const settlementGroups = {};
for (const c of settled) {
    const key = `${c.asset}-${c.expiryTs}`;
    if (!settlementGroups[key]) settlementGroups[key] = [];
    settlementGroups[key].push(c);
}

// For each settlement group, sample price data at intervals
for (const [groupKey, groupContracts] of Object.entries(settlementGroups)) {
    const asset = groupContracts[0].asset;
    const expiryTs = groupContracts[0].expiryTs;

    // Get all price data for these contracts, grouped by timestamp
    const marketIds = groupContracts.map(c => c.marketId);
    const placeholders = marketIds.map(() => '?').join(',');

    const prices = db.prepare(`
        SELECT gemini_market_id, timestamp, gemini_price_bid, gemini_price_ask
        FROM market_prices
        WHERE gemini_market_id IN (${placeholders})
          AND gemini_price_bid IS NOT NULL AND gemini_price_ask IS NOT NULL
        ORDER BY timestamp
    `).all(...marketIds);

    if (prices.length === 0) continue;

    // Group by timestamp (within 5s buckets)
    const buckets = {};
    for (const p of prices) {
        const bucket = Math.floor(p.timestamp / 5) * 5;
        if (!buckets[bucket]) buckets[bucket] = [];
        buckets[bucket].push(p);
    }

    // Sample every 60 seconds to avoid overwhelming output
    const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    const sampledKeys = [];
    let lastSampled = 0;
    for (const k of bucketKeys) {
        if (k - lastSampled >= 60) {
            sampledKeys.push(k);
            lastSampled = k;
        }
    }

    for (const ts of sampledKeys) {
        const bucket = buckets[ts];

        // Build contract snapshot for spot estimation
        const contractSnaps = [];
        for (const p of bucket) {
            const parsed = parseGemiSymbol(p.gemini_market_id);
            if (!parsed) continue;
            const mid = (p.gemini_price_bid + p.gemini_price_ask) / 2;
            contractSnaps.push({ strike: parsed.strike, mid, bid: p.gemini_price_bid, ask: p.gemini_price_ask, marketId: p.gemini_market_id });
        }
        contractSnaps.sort((a, b) => a.strike - b.strike);

        const spot = estimateSpotFromContracts(contractSnaps);
        if (!spot) continue;

        // For each contract in this bucket, compute BS FV and check for signal
        for (const snap of contractSnaps) {
            const parsed = parseGemiSymbol(snap.marketId);
            const hoursToExpiry = (expiryTs - ts * 1000) / (1000 * 60 * 60);
            if (hoursToExpiry <= 0) continue;

            const fv = bsFairValue(spot, parsed.strike, hoursToExpiry, VOL);

            let direction = null, edge = 0, entryPrice = null;
            if (fv > snap.ask) {
                direction = 'YES';
                edge = fv - snap.ask;
                entryPrice = snap.ask;
            } else if (fv < snap.bid) {
                direction = 'NO';
                edge = snap.bid - fv;
                entryPrice = 1 - snap.bid;
            }

            if (direction && edge >= MIN_EDGE) {
                const spread = snap.ask - snap.bid;
                const netEdge = edge - spread;

                // Determine actual settlement: did spot end above strike?
                // For settled contracts, settlement = 1 if BTC > strike at expiry, else 0
                // We can check the last known price near settlement, or use the fact
                // that the contract settled

                signals.push({
                    marketId: snap.marketId,
                    asset: parsed.asset,
                    strike: parsed.strike,
                    expiryTs,
                    signalTs: ts,
                    hoursToExpiry: hoursToExpiry.toFixed(2),
                    spot: spot.toFixed(0),
                    fv: fv.toFixed(3),
                    bid: snap.bid.toFixed(3),
                    ask: snap.ask.toFixed(3),
                    spread: spread.toFixed(3),
                    direction,
                    edge: edge.toFixed(3),
                    netEdge: netEdge.toFixed(3),
                    entryPrice: entryPrice.toFixed(3)
                });
            }
        }
    }
}

// Deduplicate signals: take the FIRST signal per contract (earliest entry)
const firstSignals = {};
for (const s of signals) {
    if (!firstSignals[s.marketId] || s.signalTs < firstSignals[s.marketId].signalTs) {
        firstSignals[s.marketId] = s;
    }
}

const uniqueSignals = Object.values(firstSignals);

// Now determine actual settlement outcome for each signal
// We need to know: at expiry time, was spot > strike?
// Use our spot estimates at the latest timestamp near expiry
function getSettlementOutcome(asset, strike, expiryTs) {
    // Look at deeply ITM/OTM contracts in the same settlement group to infer spot at settlement
    // Or use the last price snapshot before settlement
    const nearExpiry = db.prepare(`
        SELECT gemini_market_id, gemini_price_bid, gemini_price_ask, timestamp
        FROM market_prices
        WHERE gemini_market_id LIKE 'GEMI-' || ? || '%'
          AND gemini_price_bid IS NOT NULL
          AND timestamp BETWEEN ? AND ?
        ORDER BY timestamp DESC
        LIMIT 200
    `).all(asset, Math.floor(expiryTs / 1000) - 3600, Math.floor(expiryTs / 1000));

    if (nearExpiry.length === 0) {
        // Fall back to latest data we have
        const latest = db.prepare(`
            SELECT gemini_market_id, gemini_price_bid, gemini_price_ask, timestamp
            FROM market_prices
            WHERE gemini_market_id LIKE 'GEMI-' || ? || '%'
              AND gemini_price_bid IS NOT NULL
            ORDER BY timestamp DESC LIMIT 200
        `).all(asset);
        nearExpiry.push(...latest);
    }

    // Group by contract and estimate spot
    const contractSnaps = [];
    const seen = new Set();
    for (const p of nearExpiry) {
        const parsed = parseGemiSymbol(p.gemini_market_id);
        if (!parsed || seen.has(p.gemini_market_id)) continue;
        seen.add(p.gemini_market_id);
        const mid = (p.gemini_price_bid + p.gemini_price_ask) / 2;
        contractSnaps.push({ strike: parsed.strike, mid });
    }
    contractSnaps.sort((a, b) => a.strike - b.strike);

    const spot = estimateSpotFromContracts(contractSnaps);
    if (!spot) return null;

    return {
        settledSpot: spot,
        yesSettlement: spot > strike ? 1 : 0
    };
}

console.log(`  Total BS signals (edge >= ${MIN_EDGE * 100}c): ${signals.length}`);
console.log(`  Unique contracts with signals: ${uniqueSignals.length}`);
console.log();

if (uniqueSignals.length === 0) {
    console.log('  No actionable signals found in settled contracts.\n');
    process.exit(0);
}

console.log('-'.repeat(120));
console.log(
    'Market'.padEnd(35),
    'Dir'.padEnd(5),
    'Spot'.padEnd(8),
    'Strike'.padEnd(8),
    'FV'.padEnd(7),
    'Bid'.padEnd(7),
    'Ask'.padEnd(7),
    'Edge'.padEnd(7),
    'Net'.padEnd(7),
    'TTX(h)'.padEnd(7),
    'Settled'.padEnd(9),
    'Result'
);
console.log('-'.repeat(120));

let correct = 0, incorrect = 0, unknown = 0;
let totalPnl = 0;

for (const s of uniqueSignals.sort((a, b) => a.signalTs - b.signalTs)) {
    const outcome = getSettlementOutcome(s.asset, s.strike, s.expiryTs);

    let result = '???';
    let pnl = 0;
    if (outcome) {
        const didSettle = outcome.yesSettlement;
        if (s.direction === 'YES') {
            // We bought YES at ask. Settles at 1 if spot > strike, else 0
            result = didSettle === 1 ? 'WIN' : 'LOSS';
            pnl = didSettle === 1 ? (1 - parseFloat(s.entryPrice)) : -parseFloat(s.entryPrice);
        } else {
            // We bought NO (cost = 1 - bid). Settles at 1 if spot <= strike, else 0
            result = didSettle === 0 ? 'WIN' : 'LOSS';
            pnl = didSettle === 0 ? (1 - parseFloat(s.entryPrice)) : -parseFloat(s.entryPrice);
        }
        if (result === 'WIN') correct++;
        else incorrect++;
        totalPnl += pnl;
    } else {
        unknown++;
    }

    const time = new Date(s.signalTs * 1000).toISOString().replace('T', ' ').slice(0, 19);
    console.log(
        s.marketId.padEnd(35),
        s.direction.padEnd(5),
        s.spot.padEnd(8),
        String(s.strike).padEnd(8),
        s.fv.padEnd(7),
        s.bid.padEnd(7),
        s.ask.padEnd(7),
        s.edge.padEnd(7),
        s.netEdge.padEnd(7),
        s.hoursToExpiry.padEnd(7),
        (outcome ? `$${outcome.settledSpot.toFixed(0)}` : '???').padEnd(9),
        result + (pnl !== 0 ? ` (${pnl > 0 ? '+' : ''}$${(pnl * 10).toFixed(2)})` : '')
    );
}

console.log('-'.repeat(120));
console.log();
console.log(`  RESULTS (per-contract, $10 position size):`);
console.log(`  Correct predictions:   ${correct}`);
console.log(`  Incorrect predictions: ${incorrect}`);
console.log(`  Unknown outcome:       ${unknown}`);
if (correct + incorrect > 0) {
    console.log(`  Accuracy:              ${(correct / (correct + incorrect) * 100).toFixed(1)}%`);
    console.log(`  Total PnL (per $10):   $${(totalPnl * 10).toFixed(2)}`);
    console.log(`  Avg PnL per signal:    $${(totalPnl * 10 / (correct + incorrect)).toFixed(2)}`);
}
console.log();

// Also show unsettled signals (pending validation)
console.log(`${'='.repeat(80)}`);
console.log('  PENDING SIGNALS — Unsettled Contracts');
console.log(`${'='.repeat(80)}\n`);

const pendingSignals = [];
for (const c of unsettled) {
    const prices = db.prepare(`
        SELECT gemini_market_id, timestamp, gemini_price_bid, gemini_price_ask
        FROM market_prices
        WHERE gemini_market_id = ?
          AND gemini_price_bid IS NOT NULL AND gemini_price_ask IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
    `).all(c.marketId);

    if (prices.length === 0) continue;

    const p = prices[0];
    const hoursToExpiry = (c.expiryTs - p.timestamp * 1000) / (1000 * 60 * 60);

    // Get spot estimate from same-expiry group
    const groupContracts = unsettled.filter(u => u.expiryTs === c.expiryTs && u.asset === c.asset);
    const snapshots = [];
    for (const gc of groupContracts) {
        const latest = db.prepare(`
            SELECT gemini_price_bid, gemini_price_ask FROM market_prices
            WHERE gemini_market_id = ? AND gemini_price_bid IS NOT NULL
            ORDER BY timestamp DESC LIMIT 1
        `).get(gc.marketId);
        if (latest) {
            snapshots.push({ strike: gc.strike, mid: (latest.gemini_price_bid + latest.gemini_price_ask) / 2 });
        }
    }
    snapshots.sort((a, b) => a.strike - b.strike);
    const spot = estimateSpotFromContracts(snapshots);
    if (!spot || hoursToExpiry <= 0) continue;

    const fv = bsFairValue(spot, c.strike, hoursToExpiry, VOL);
    let direction = null, edge = 0;
    if (fv > p.gemini_price_ask) { direction = 'YES'; edge = fv - p.gemini_price_ask; }
    else if (fv < p.gemini_price_bid) { direction = 'NO'; edge = p.gemini_price_bid - fv; }

    if (direction && edge >= MIN_EDGE) {
        const spread = p.gemini_price_ask - p.gemini_price_bid;
        pendingSignals.push({
            marketId: c.marketId,
            direction,
            spot: spot.toFixed(0),
            strike: c.strike,
            fv: fv.toFixed(3),
            bid: p.gemini_price_bid.toFixed(3),
            ask: p.gemini_price_ask.toFixed(3),
            edge: edge.toFixed(3),
            netEdge: (edge - spread).toFixed(3),
            hoursToExpiry: hoursToExpiry.toFixed(1),
            expiry: new Date(c.expiryTs).toISOString().slice(0, 16)
        });
    }
}

if (pendingSignals.length === 0) {
    console.log('  No pending signals on unsettled contracts.\n');
} else {
    console.log('-'.repeat(110));
    console.log(
        'Market'.padEnd(35),
        'Dir'.padEnd(5),
        'Spot'.padEnd(8),
        'Strike'.padEnd(8),
        'FV'.padEnd(7),
        'Edge'.padEnd(7),
        'Net'.padEnd(7),
        'TTX'.padEnd(7),
        'Settles'
    );
    console.log('-'.repeat(110));
    for (const s of pendingSignals) {
        console.log(
            s.marketId.padEnd(35),
            s.direction.padEnd(5),
            s.spot.padEnd(8),
            String(s.strike).padEnd(8),
            s.fv.padEnd(7),
            s.edge.padEnd(7),
            s.netEdge.padEnd(7),
            `${s.hoursToExpiry}h`.padEnd(7),
            s.expiry
        );
    }
    console.log();
}

db.close();
