#!/usr/bin/env node
/**
 * Real Data Observation Mode v2
 * 
 * Connects to REAL Gemini Predictions, Polymarket, and Kalshi APIs.
 * Logs cross-platform price data to validate whether our strategy actually works.
 * 
 * Key fixes from v1:
 *   - Only uses bestBid/bestAsk (real orderbook levels), NOT sell.yes/buy.yes (indicative)
 *   - Strict cross-platform matching by asset + strike + timeframe
 *   - Correct prediction market PnL formula: contracts pay $1 if YES, $0 if NO
 *   - Realistic fee modeling (2% per side, conservative estimate)
 *   - Tracks price changes over time to measure actual edge
 * 
 * Usage:
 *   node scripts/observe_real_markets.js [--duration=3600] [--interval=30]
 */

const GeminiPredictionsReal = require('../lib/gemini_predictions_real');
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [k, v] = arg.replace('--', '').split('=');
    acc[k] = v;
    return acc;
}, {});

const DURATION_SEC = parseInt(args.duration || '3600');
const INTERVAL_SEC = parseInt(args.interval || '30');
const LOG_FILE = path.join(__dirname, '..', 'data', 'real_market_observations.json');

// Fee model: Gemini Predictions fee structure
// 0.05% flat + 0.01% maker = ~0.06% per side
// Cheapest prediction market (vs Polymarket 2% taker, Kalshi ~1.2%, PredictIt 10%)
const FEE_PER_SIDE = 0.0006;

// --- Polymarket fetch ---
async function fetchPolymarketCrypto() {
    try {
        const response = await fetch(
            'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&tag=crypto',
            { headers: { 'Accept': 'application/json' } }
        );
        if (!response.ok) return [];
        const data = await response.json();
        return (data || []).map(m => ({
            platform: 'polymarket',
            id: m.conditionId || m.id,
            title: (m.question || m.title || '').trim(),
            bestBid: m.bestBid ? parseFloat(m.bestBid) : null,
            bestAsk: m.bestAsk ? parseFloat(m.bestAsk) : null,
            lastPrice: m.lastTradePrice ? parseFloat(m.lastTradePrice) : null,
            volume: m.volume ? parseFloat(m.volume) : null,
            liquidity: m.liquidity ? parseFloat(m.liquidity) : null,
        }));
    } catch (e) {
        return [];
    }
}

// --- Kalshi fetch ---
async function fetchKalshiCrypto() {
    try {
        const response = await fetch(
            'https://api.elections.kalshi.com/trade-api/v2/events?limit=50&with_nested_markets=true&status=open',
            { headers: { 'Accept': 'application/json' } }
        );
        if (!response.ok) return [];
        const data = await response.json();
        return (data.events || [])
            .filter(e => /bitcoin|btc|ethereum|eth|solana|sol|crypto/i.test(e.title))
            .flatMap(event =>
                (event.markets || []).map(m => ({
                    platform: 'kalshi',
                    id: m.ticker,
                    eventTitle: event.title,
                    title: `${event.title}: ${m.title || m.subtitle || ''}`.trim(),
                    yesBid: m.yes_bid != null ? m.yes_bid / 100 : null,
                    yesAsk: m.yes_ask != null ? m.yes_ask / 100 : null,
                    lastPrice: m.last_price != null ? m.last_price / 100 : null,
                    volume: m.volume || null,
                }))
            );
    } catch (e) {
        return [];
    }
}

// --- Parse Gemini contract into structured data ---
function parseGeminiContract(contract) {
    const label = contract.label || '';
    const title = contract.eventTitle || '';
    
    // Extract asset: "BTC > $67,500" -> BTC
    const assetMatch = label.match(/^(BTC|ETH|SOL|XRP|DOGE|LINK|ZEC|LTC|AAVE|ADA|AVAX|DOT)/i);
    const asset = assetMatch ? assetMatch[1].toUpperCase() : null;
    
    // Extract strike: "BTC > $67,500" -> 67500
    const strikeMatch = label.match(/\$([0-9,.]+)/);
    const strike = strikeMatch ? parseFloat(strikeMatch[1].replace(/,/g, '')) : null;
    
    // Extract direction: > or <
    const direction = label.includes('>') ? 'above' : label.includes('<') ? 'below' : null;
    
    // Extract date from event title: "BTC Price on February 18" -> Feb 18
    const dateMatch = title.match(/(?:on|at)\s+(\w+\s+\d+)/i) || title.match(/today/i);
    const dateStr = dateMatch ? (dateMatch[1] || 'today') : null;
    
    return { asset, strike, direction, dateStr, label, title };
}

// --- Parse Polymarket title ---
function parsePolymarketTitle(title) {
    title = title || '';
    
    const assetMatch = title.match(/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|doge)\b/i);
    let asset = assetMatch ? assetMatch[1].toUpperCase() : null;
    if (asset === 'BITCOIN') asset = 'BTC';
    if (asset === 'ETHEREUM') asset = 'ETH';
    if (asset === 'SOLANA') asset = 'SOL';
    
    const strikeMatch = title.match(/\$([0-9,.]+[kK]?)/);
    let strike = null;
    if (strikeMatch) {
        let val = strikeMatch[1].replace(/,/g, '');
        if (/k/i.test(val)) {
            val = parseFloat(val) * 1000;
        }
        strike = parseFloat(val);
    }
    
    const direction = /above|over|hit|reach|exceed/i.test(title) ? 'above' : 
                      /below|under|drop/i.test(title) ? 'below' : null;
    
    return { asset, strike, direction, title };
}

// --- Strict cross-platform matching ---
function findStrictMatches(geminiContracts, polyData, kalshiData) {
    const matches = [];
    
    for (const gc of geminiContracts) {
        const gParsed = parseGeminiContract(gc);
        if (!gParsed.asset || !gParsed.strike) continue;
        
        // Match Polymarket
        for (const pm of polyData) {
            const pParsed = parsePolymarketTitle(pm.title);
            if (!pParsed.asset || !pParsed.strike) continue;
            
            if (pParsed.asset !== gParsed.asset) continue;
            
            // Strike must be within 5% to be "comparable"
            const strikeDiff = Math.abs(pParsed.strike - gParsed.strike) / gParsed.strike;
            if (strikeDiff > 0.05) continue;
            
            // Direction should match (or both null)
            if (gParsed.direction && pParsed.direction && gParsed.direction !== pParsed.direction) continue;
            
            const geminiMid = (gc.bid + gc.ask) / 2;
            const polyPrice = pm.bestBid || pm.lastPrice;
            if (!polyPrice) continue;
            
            const priceGap = Math.abs(geminiMid - polyPrice);
            
            matches.push({
                asset: gParsed.asset,
                geminiContract: gc.instrumentSymbol,
                geminiLabel: gc.label,
                geminiEvent: gc.eventTitle,
                geminiExpiry: gc.expiryDate,
                geminiBid: gc.bid,
                geminiAsk: gc.ask,
                geminiSpread: gc.spread,
                geminiMid,
                polymarketId: pm.id,
                polymarketTitle: pm.title,
                polyBid: pm.bestBid,
                polyAsk: pm.bestAsk,
                polyLast: pm.lastPrice,
                polyVolume: pm.volume,
                polyPrice,
                priceGap,
                priceGapPercent: (priceGap / Math.max(geminiMid, 0.01) * 100).toFixed(1),
                strikeMatch: `$${gParsed.strike} vs $${pParsed.strike}`,
                timestamp: Date.now()
            });
        }
        
        // Match Kalshi
        for (const km of kalshiData) {
            const kTitle = km.title || '';
            const kAsset = /bitcoin|btc/i.test(kTitle) ? 'BTC' :
                           /ethereum|eth/i.test(kTitle) ? 'ETH' :
                           /solana|sol/i.test(kTitle) ? 'SOL' : null;
            if (kAsset !== gParsed.asset) continue;
            
            const kStrikeMatch = kTitle.match(/\$([0-9,.]+[kK]?)/);
            if (!kStrikeMatch) continue;
            let kStrike = parseFloat(kStrikeMatch[1].replace(/,/g, ''));
            if (/k/i.test(kStrikeMatch[1])) kStrike *= 1000;
            
            const strikeDiff = Math.abs(kStrike - gParsed.strike) / gParsed.strike;
            if (strikeDiff > 0.05) continue;
            
            const kalshiPrice = km.yesBid || km.lastPrice;
            if (!kalshiPrice) continue;
            
            const geminiMid = (gc.bid + gc.ask) / 2;
            const priceGap = Math.abs(geminiMid - kalshiPrice);
            
            matches.push({
                asset: gParsed.asset,
                geminiContract: gc.instrumentSymbol,
                geminiLabel: gc.label,
                geminiEvent: gc.eventTitle,
                geminiBid: gc.bid,
                geminiAsk: gc.ask,
                geminiSpread: gc.spread,
                geminiMid,
                kalshiId: km.id,
                kalshiTitle: km.title,
                kalshiBid: km.yesBid,
                kalshiAsk: km.yesAsk,
                kalshiLast: km.lastPrice,
                kalshiPrice,
                priceGap,
                priceGapPercent: (priceGap / Math.max(geminiMid, 0.01) * 100).toFixed(1),
                strikeMatch: `$${gParsed.strike} vs $${kStrike}`,
                platform: 'kalshi',
                timestamp: Date.now()
            });
        }
    }
    
    return matches.sort((a, b) => b.priceGap - a.priceGap);
}

// --- Correct Prediction Market PnL ---
// Buy N contracts at entryAsk each. Each contract pays $1 if YES, $0 if NO.
// To exit early, sell at exitBid.
function calcPredictionPnL(entryAsk, exitBid, positionSizeDollars) {
    if (!entryAsk || !exitBid || entryAsk <= 0) return null;
    
    const numContracts = Math.floor(positionSizeDollars / entryAsk);
    const entryCost = numContracts * entryAsk;
    const exitProceeds = numContracts * exitBid;
    const entryFee = entryCost * FEE_PER_SIDE;
    const exitFee = exitProceeds * FEE_PER_SIDE;
    
    return {
        numContracts,
        entryCost: +entryCost.toFixed(2),
        exitProceeds: +exitProceeds.toFixed(2),
        grossPnL: +(exitProceeds - entryCost).toFixed(2),
        totalFees: +(entryFee + exitFee).toFixed(2),
        netPnL: +((exitProceeds - entryCost) - (entryFee + exitFee)).toFixed(2),
        returnPct: ((exitProceeds - entryCost - entryFee - exitFee) / entryCost * 100).toFixed(2),
        breakEvenSpread: +(2 * FEE_PER_SIDE * entryAsk).toFixed(4)
    };
}

// --- Track price changes over time ---
class PriceTracker {
    constructor() {
        this.history = new Map();
    }
    
    record(contracts) {
        const now = Date.now();
        for (const c of contracts) {
            const key = c.instrumentSymbol;
            if (!this.history.has(key)) {
                this.history.set(key, []);
            }
            this.history.get(key).push({
                bid: c.bid,
                ask: c.ask,
                mid: (c.bid + c.ask) / 2,
                spread: c.spread,
                timestamp: now
            });
        }
    }
    
    getMovers(minSnapshots = 2) {
        const movers = [];
        for (const [key, history] of this.history) {
            if (history.length < minSnapshots) continue;
            const first = history[0];
            const last = history[history.length - 1];
            const midChange = last.mid - first.mid;
            if (Math.abs(midChange) > 0.005) {
                movers.push({
                    symbol: key,
                    firstMid: first.mid,
                    lastMid: last.mid,
                    change: midChange,
                    snapshots: history.length,
                    duration: (last.timestamp - first.timestamp) / 1000
                });
            }
        }
        return movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    }
    
    getSummary() {
        let totalContracts = this.history.size;
        let movers = this.getMovers();
        let avgChange = 0;
        if (movers.length > 0) {
            avgChange = movers.reduce((s, m) => s + Math.abs(m.change), 0) / movers.length;
        }
        return { totalTracked: totalContracts, moversCount: movers.length, avgAbsChange: avgChange };
    }
}

// --- Main ---
async function main() {
    console.log('='.repeat(70));
    console.log('REAL DATA OBSERVATION MODE v2');
    console.log(`Duration: ${DURATION_SEC}s | Interval: ${INTERVAL_SEC}s | Fee: ${FEE_PER_SIDE*100}%/side`);
    console.log(`Log file: ${LOG_FILE}`);
    console.log('='.repeat(70));
    
    const gemini = new GeminiPredictionsReal({
        categories: ['crypto'],
        minRequestInterval: 2000,
        cacheTTL: 5000
    });
    const tracker = new PriceTracker();
    
    const observations = {
        startTime: new Date().toISOString(),
        config: { duration: DURATION_SEC, interval: INTERVAL_SEC, feePerSide: FEE_PER_SIDE },
        snapshots: [],
        strictMatches: [],
        summary: null
    };
    
    const startTime = Date.now();
    let iteration = 0;
    
    const observe = async () => {
        iteration++;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log(`\n--- Observation #${iteration} (${elapsed}s elapsed) ---`);
        
        // 1. Fetch real data from all platforms
        const geminiEvents = await gemini.fetchMarkets({ category: 'crypto', limit: 60 });
        
        // Stagger the other requests
        const [polyData, kalshiData] = await Promise.all([
            fetchPolymarketCrypto(),
            fetchKalshiCrypto()
        ]);
        
        // 2. Analyze Gemini liquidity (only real orderbook)
        const tradeable = gemini.getTradeableContracts();
        const liquidity = gemini.analyzeLiquidity();
        
        console.log(`  Gemini: ${geminiEvents.length} events, ${gemini.contracts.size} contracts`);
        console.log(`  Tradeable (real bid+ask): ${tradeable.length} / ${gemini.contracts.size}`);
        console.log(`  Median spread: ${liquidity.medianSpread || 'N/A'} | Avg: ${liquidity.avgSpread || 'N/A'}`);
        console.log(`  Polymarket: ${polyData.length} | Kalshi: ${kalshiData.length}`);
        
        // 3. Track prices
        tracker.record(tradeable);
        
        // 4. Show top contracts by tightest spread
        if (tradeable.length > 0) {
            console.log('\n  Top 5 tightest-spread contracts (real orderbook):');
            for (const c of tradeable.slice(0, 5)) {
                const spreadPct = (c.spread / c.ask * 100).toFixed(1);
                console.log(`    ${c.eventTitle}: ${c.label}`);
                console.log(`      bid=${c.bid.toFixed(2)} ask=${c.ask.toFixed(2)} spread=${c.spread.toFixed(3)} (${spreadPct}%) last=${c.lastTrade}`);
                
                // Can we profit after fees?
                const pnl = calcPredictionPnL(c.ask, c.bid, 50);
                if (pnl) {
                    console.log(`      $50 round-trip: gross=${pnl.grossPnL} fees=${pnl.totalFees} net=${pnl.netPnL} | breakeven=${pnl.breakEvenSpread}`);
                }
            }
        }
        
        // 5. Strict cross-platform matching
        const matches = findStrictMatches(tradeable, polyData, kalshiData);
        if (matches.length > 0) {
            console.log(`\n  Cross-platform strict matches: ${matches.length}`);
            for (const m of matches.slice(0, 5)) {
                const platform = m.polymarketTitle ? 'Poly' : 'Kalshi';
                const otherPrice = m.polyPrice || m.kalshiPrice;
                console.log(`    [${m.asset}] ${m.strikeMatch}`);
                console.log(`      Gemini: bid=${m.geminiBid} ask=${m.geminiAsk} mid=${m.geminiMid.toFixed(3)}`);
                console.log(`      ${platform}: ${otherPrice} | Gap: ${m.priceGap.toFixed(3)} (${m.priceGapPercent}%)`);
            }
            observations.strictMatches.push(...matches);
        } else {
            console.log('\n  No strict cross-platform matches found');
        }
        
        // 6. Price movers
        const movers = tracker.getMovers();
        if (movers.length > 0) {
            console.log(`\n  Price movers (>0.5¢ since tracking): ${movers.length}`);
            for (const m of movers.slice(0, 3)) {
                console.log(`    ${m.symbol}: ${m.firstMid.toFixed(3)} -> ${m.lastMid.toFixed(3)} (${m.change > 0 ? '+' : ''}${m.change.toFixed(3)}) over ${m.duration}s`);
            }
        }
        
        // 7. Gemini-only profitability analysis
        const breakevens = tradeable.map(c => ({
            symbol: c.instrumentSymbol,
            spread: c.spread,
            feeCost: c.ask * FEE_PER_SIDE * 2,
            totalBreakeven: c.spread + c.ask * FEE_PER_SIDE * 2
        }));
        
        const profitableIfMoves5c = breakevens.filter(b => b.totalBreakeven < 0.05).length;
        const avgBreakeven = breakevens.length > 0 
            ? breakevens.reduce((s, b) => s + b.totalBreakeven, 0) / breakevens.length
            : 0;
        
        console.log(`\n  Gemini-only profitability:`);
        console.log(`    Avg breakeven needed: ${(avgBreakeven * 100).toFixed(1)}¢`);
        console.log(`    Contracts beatable with 5¢ move: ${profitableIfMoves5c} / ${tradeable.length}`);
        
        // 8. Record snapshot
        observations.snapshots.push({
            iteration,
            timestamp: new Date().toISOString(),
            elapsed,
            gemini: {
                events: geminiEvents.length,
                totalContracts: gemini.contracts.size,
                tradeableContracts: tradeable.length,
                liquidity,
                topContracts: tradeable.slice(0, 15).map(c => ({
                    symbol: c.instrumentSymbol,
                    label: c.label,
                    event: c.eventTitle,
                    bid: c.bid,
                    ask: c.ask,
                    spread: c.spread,
                    lastTrade: c.lastTrade,
                    expiry: c.expiryDate,
                }))
            },
            polymarket: { count: polyData.length },
            kalshi: { count: kalshiData.length },
            strictMatches: matches.length,
            priceMovers: movers.length,
            profitableContracts: profitableIfMoves5c,
            avgBreakeven: +avgBreakeven.toFixed(4)
        });
        
        // Save progress
        try {
            fs.writeFileSync(LOG_FILE, JSON.stringify(observations, null, 2));
        } catch (e) {
            console.error(`Save error: ${e.message}`);
        }
    };
    
    // Initial observation
    await observe();
    
    // Periodic observations
    const timer = setInterval(async () => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed >= DURATION_SEC) {
            clearInterval(timer);
            generateSummary(observations, tracker);
            process.exit(0);
        }
        await observe();
    }, INTERVAL_SEC * 1000);
    
    process.on('SIGINT', () => {
        console.log('\n\nStopping observation...');
        clearInterval(timer);
        generateSummary(observations, tracker);
        process.exit(0);
    });
}

function generateSummary(observations, tracker) {
    const snapshots = observations.snapshots;
    const snapCount = snapshots.length;
    
    const allSpreads = snapshots.flatMap(s =>
        (s.gemini.topContracts || []).map(c => c.spread)
    ).filter(s => s != null && s >= 0);
    
    allSpreads.sort((a, b) => a - b);
    const medianSpread = allSpreads.length > 0 ? allSpreads[Math.floor(allSpreads.length / 2)] : null;
    const avgSpread = allSpreads.length > 0 ? allSpreads.reduce((s, v) => s + v, 0) / allSpreads.length : null;
    
    const trackerSummary = tracker.getSummary();
    const movers = tracker.getMovers();
    
    // Avg breakeven = spread + 2*fee*midprice
    // Approximate using avg spread + 2 * fee * 0.5 (typical mid-price)
    const avgBreakeven = avgSpread !== null ? avgSpread + 2 * FEE_PER_SIDE * 0.5 : null;
    
    const totalMatches = observations.strictMatches.length;
    
    observations.summary = {
        endTime: new Date().toISOString(),
        totalDuration: Math.floor((Date.now() - new Date(observations.startTime).getTime()) / 1000),
        totalSnapshots: snapCount,
        
        geminiLiquidity: {
            avgTradeableContracts: snapCount > 0 
                ? +(snapshots.reduce((s, snap) => s + snap.gemini.tradeableContracts, 0) / snapCount).toFixed(0)
                : 0,
            medianSpread: medianSpread?.toFixed(4),
            avgSpread: avgSpread?.toFixed(4),
            minSpread: allSpreads.length > 0 ? allSpreads[0].toFixed(4) : null,
            maxSpread: allSpreads.length > 0 ? allSpreads[allSpreads.length - 1].toFixed(4) : null
        },
        
        priceMovement: {
            contractsTracked: trackerSummary.totalTracked,
            contractsWithMovement: trackerSummary.moversCount,
            avgAbsoluteChange: +trackerSummary.avgAbsChange.toFixed(4),
            topMovers: movers.slice(0, 10).map(m => ({
                symbol: m.symbol,
                change: +m.change.toFixed(3),
                duration: m.duration
            }))
        },
        
        crossPlatform: {
            strictMatchesFound: totalMatches,
            uniqueAssets: [...new Set(observations.strictMatches.map(m => m.asset))],
            avgPriceGap: totalMatches > 0 
                ? +(observations.strictMatches.reduce((s, m) => s + m.priceGap, 0) / totalMatches).toFixed(4)
                : null
        },
        
        profitability: {
            feePerSide: FEE_PER_SIDE,
            totalFeeRoundTrip: FEE_PER_SIDE * 2,
            avgSpread: avgSpread?.toFixed(4),
            estimatedBreakeven: avgBreakeven?.toFixed(4),
            avgPriceMovement: +trackerSummary.avgAbsChange.toFixed(4),
            movementExceedsBreakeven: avgBreakeven !== null && trackerSummary.avgAbsChange > avgBreakeven,
        },
        
        verdict: null
    };
    
    // Generate honest verdict
    const p = observations.summary.profitability;
    if (snapCount < 3) {
        observations.summary.verdict = 'INSUFFICIENT_DATA: Need more observation time (run with --duration=3600)';
    } else if (trackerSummary.moversCount === 0) {
        observations.summary.verdict = 'NO_MOVEMENT: No price changes detected — markets may be stale or duration too short';
    } else if (p.movementExceedsBreakeven) {
        observations.summary.verdict = `POTENTIALLY_VIABLE: Avg movement (${trackerSummary.avgAbsChange.toFixed(3)}) > breakeven (${avgBreakeven.toFixed(3)}). BUT this is directional movement, not guaranteed profit.`;
    } else {
        observations.summary.verdict = `NOT_VIABLE: Avg movement (${trackerSummary.avgAbsChange.toFixed(3)}) < breakeven (${avgBreakeven?.toFixed(3) || 'N/A'}). Real spreads (${avgSpread?.toFixed(3) || '?'}) + fees (${(FEE_PER_SIDE*2*100).toFixed(0)}%) eat all edge.`;
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('OBSERVATION SUMMARY');
    console.log('='.repeat(70));
    console.log(JSON.stringify(observations.summary, null, 2));
    
    fs.writeFileSync(LOG_FILE, JSON.stringify(observations, null, 2));
    console.log(`\nFull data saved to: ${LOG_FILE}`);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
