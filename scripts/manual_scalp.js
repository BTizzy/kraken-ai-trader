#!/usr/bin/env node
/**
 * Manual Scalp — Execute a Single High-Conviction Trade
 * 
 * This script does ONE thing: finds the best OTM crypto binary on Gemini Predictions
 * where Black-Scholes says NO is mispriced, and buys it.
 * 
 * WHY THIS WORKS:
 * V18 backtest proved that buying NO on OTM crypto binaries (strike 7%+ above spot)
 * is the single profitable strategy. All 3 backtest wins were this pattern.
 * 
 * HOW TO USE:
 *   GEMINI_MODE=live node scripts/manual_scalp.js
 * 
 * What it does:
 *   1. Fetches all GEMI-* contracts from Gemini
 *   2. Gets current BTC/ETH spot prices
 *   3. Computes Black-Scholes fair value for each contract
 *   4. Finds contracts where NO is cheap relative to BS fair value
 *   5. Ranks by edge and settlement time
 *   6. Displays the top opportunities (or executes if --execute flag)
 */

require('dotenv').config();
const GeminiClient = require('../lib/gemini_client');
const FairValueEngine = require('../lib/fair_value_engine');
const { Logger } = require('../lib/logger');

const logger = new Logger({ component: 'SCALP', level: 'INFO' });
const EXECUTE = process.argv.includes('--execute');

// Black-Scholes normal CDF
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

function bsProbAbove(spot, strike, hoursToExpiry, vol = 0.50) {
    if (hoursToExpiry <= 0) return spot > strike ? 1.0 : 0.0;
    const T = hoursToExpiry / (365.25 * 24);
    const d2 = (Math.log(spot / strike) - (vol * vol / 2) * T) / (vol * Math.sqrt(T));
    return normalCDF(d2);
}

async function main() {
    const mode = process.env.GEMINI_MODE || 'paper';
    logger.info(`Mode: ${mode} | Execute: ${EXECUTE}`);

    const gemini = new GeminiClient({
        mode,
        useRealPrices: true,
        logLevel: 'WARN'
    });

    // Wait for real data to load
    logger.info('Fetching Gemini prediction market data...');
    await gemini.init();
    
    // Give it time to fetch all categories
    await new Promise(r => setTimeout(r, 5000));

    // Get current spot prices from public API
    logger.info('Fetching spot prices...');
    const spotPrices = {};
    try {
        const btcResp = await fetch('https://api.gemini.com/v1/pubticker/btcusd');
        const btcData = await btcResp.json();
        spotPrices.BTC = parseFloat(btcData.last);
        logger.info(`BTC spot: $${spotPrices.BTC.toLocaleString()}`);
    } catch (e) {
        logger.error(`Failed to get BTC price: ${e.message}`);
    }
    try {
        const ethResp = await fetch('https://api.gemini.com/v1/pubticker/ethusd');
        const ethData = await ethResp.json();
        spotPrices.ETH = parseFloat(ethData.last);
        logger.info(`ETH spot: $${spotPrices.ETH.toLocaleString()}`);
    } catch (e) {
        logger.error(`Failed to get ETH price: ${e.message}`);
    }

    // Get all GEMI contracts
    const contracts = [];
    if (gemini.realClient) {
        const allContracts = gemini.realClient.getAllContracts();
        for (const [symbol, data] of allContracts) {
            if (!symbol.startsWith('GEMI-')) continue;
            contracts.push({ symbol, ...data });
        }
    }

    if (contracts.length === 0) {
        // Try fetching directly
        logger.info('No contracts from realClient, fetching directly...');
        for (const category of ['crypto']) {
            try {
                const resp = await fetch(`https://www.gemini.com/prediction-markets/api/v1/markets?category=${category}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.markets) {
                        for (const m of data.markets) {
                            contracts.push(m);
                        }
                    }
                }
            } catch (e) {
                logger.debug(`Category ${category} fetch failed: ${e.message}`);
            }
        }
    }

    logger.info(`Found ${contracts.length} GEMI contracts`);

    // Analyze each contract
    const opportunities = [];
    const now = Date.now();
    const VOL = 0.50; // Default annualized vol (V18 validated)

    for (const c of contracts) {
        const symbol = c.symbol || c.instrumentId || '';
        if (!symbol.startsWith('GEMI-')) continue;

        // Parse asset, expiry, strike from symbol
        // Format: GEMI-BTC2602190200-HI66500
        const match = symbol.match(/GEMI-(\w+?)(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-HI(\d+D?\d*)/);
        if (!match) continue;

        const [, asset, yy, mm, dd, hh, mn, strikeStr] = match;
        const strike = parseFloat(strikeStr.replace('D', '.'));
        const expiry = new Date(`20${yy}-${mm}-${dd}T${hh}:${mn}:00Z`);
        const hoursToExpiry = (expiry.getTime() - now) / (1000 * 3600);

        if (hoursToExpiry <= 0.5) continue; // Skip near-expired
        if (hoursToExpiry > 48) continue; // Skip very long-dated (less predictable)

        const spot = spotPrices[asset.toUpperCase()];
        if (!spot) continue;

        // Compute Black-Scholes probability
        const probAbove = bsProbAbove(spot, strike, hoursToExpiry, VOL);
        const probBelow = 1 - probAbove;

        // Moneyness check — we want OTM (strike above spot)
        const moneyness = spot / strike;
        if (moneyness > 0.95) continue; // Skip ATM/ITM — not our edge

        // Get market prices
        const prices = gemini.realClient
            ? gemini.realClient.getBestPrices(symbol)
            : null;

        if (!prices) continue;

        // NO price = 1 - YES bid (what we'd pay for NO)
        const noAsk = prices.ask ? (1 - prices.bid) : null; // Approximate NO ask
        const yesAsk = prices.ask;
        const yesBid = prices.bid;

        if (noAsk === null || noAsk <= 0) continue;

        // Fair value of NO = probBelow
        const noFairValue = probBelow;
        const noEdge = noFairValue - noAsk;

        // Only interested if NO is cheap (we can buy below fair value)
        if (noEdge < 0.05) continue; // Need at least 5¢ edge

        opportunities.push({
            symbol,
            asset: asset.toUpperCase(),
            strike,
            spot,
            moneyness: moneyness.toFixed(3),
            hoursToExpiry: hoursToExpiry.toFixed(1),
            expiry: expiry.toISOString().replace('T', ' ').replace('.000Z', ' UTC'),
            probAbove: (probAbove * 100).toFixed(1) + '%',
            probBelow: (probBelow * 100).toFixed(1) + '%',
            yesBid: yesBid?.toFixed(3),
            yesAsk: yesAsk?.toFixed(3),
            noApproxAsk: noAsk.toFixed(3),
            noFairValue: noFairValue.toFixed(3),
            noEdge: noEdge.toFixed(3),
            edgePct: ((noEdge / noAsk) * 100).toFixed(1) + '%',
            direction: 'NO',
            recommendation: noEdge >= 0.15 ? '*** STRONG ***' :
                           noEdge >= 0.10 ? '** GOOD **' :
                           noEdge >= 0.05 ? '* OK *' : ''
        });
    }

    // Sort by edge
    opportunities.sort((a, b) => parseFloat(b.noEdge) - parseFloat(a.noEdge));

    // Display results
    console.log('\n' + '='.repeat(100));
    console.log('  GEMINI PREDICTION MARKET OPPORTUNITIES — NO on OTM Crypto Binaries');
    console.log('  Strategy: Buy NO when BS fair value > market price (V18 validated)');
    console.log('='.repeat(100));

    if (opportunities.length === 0) {
        console.log('\n  No opportunities found with 5¢+ edge.');
        console.log('  This is normal — wait for new contracts or volatile markets.');
        console.log('  Try again when BTC/ETH move significantly or new contracts are listed.\n');
    } else {
        console.log(`\n  Found ${opportunities.length} opportunities:\n`);
        for (const o of opportunities.slice(0, 15)) {
            console.log(`  ${o.recommendation}`);
            console.log(`  ${o.symbol}`);
            console.log(`    ${o.asset} spot=$${o.spot.toLocaleString()} | strike=$${o.strike.toLocaleString()} | ${o.moneyness} moneyness`);
            console.log(`    Expires: ${o.expiry} (${o.hoursToExpiry}h)`);
            console.log(`    BS P(above): ${o.probAbove} | P(below): ${o.probBelow}`);
            console.log(`    YES bid=${o.yesBid} ask=${o.yesAsk}`);
            console.log(`    NO approx ask=${o.noApproxAsk} | NO fair value=${o.noFairValue}`);
            console.log(`    EDGE: ${o.noEdge} (${o.edgePct})`);
            console.log('');
        }
    }

    // If --execute, place the best trade
    if (EXECUTE && opportunities.length > 0 && mode === 'live') {
        const best = opportunities[0];
        logger.info(`\nEXECUTING: Buy NO on ${best.symbol} (edge=${best.noEdge})`);

        try {
            // Get balance
            const balance = await gemini.getAvailableBalance();
            logger.info(`Available balance: $${balance}`);

            if (parseFloat(balance) < 1) {
                logger.error('Insufficient balance (< $1)');
                process.exit(1);
            }

            // Calculate position: use all available balance minus $1 reserve
            const tradableBalance = Math.max(1, parseFloat(balance) - 1);
            const noPrice = parseFloat(best.noApproxAsk);
            const contracts = Math.floor(tradableBalance / noPrice);

            if (contracts < 1) {
                logger.error(`Can't afford even 1 contract at $${noPrice}`);
                process.exit(1);
            }

            logger.info(`Placing order: ${contracts} NO contracts at $${noPrice.toFixed(2)}`);

            const order = await gemini.placeOrder({
                symbol: best.symbol,
                side: 'buy',
                amount: contracts,
                price: noPrice.toFixed(2),
                direction: 'NO'
            });

            if (order && order.success) {
                logger.info(`ORDER PLACED: orderId=${order.orderId} status=${order.orderStatus}`);
                logger.info(`Filled: ${order.filledQuantity || 0} @ ${order.fill_price || noPrice}`);
                logger.info(`Expected PnL at settlement: $${(contracts * parseFloat(best.noEdge)).toFixed(2)}`);
            } else {
                logger.error(`Order failed: ${JSON.stringify(order)}`);
            }
        } catch (err) {
            logger.error(`Execution error: ${err.message}`);
        }
    } else if (EXECUTE && mode !== 'live') {
        logger.warn('Cannot execute in paper mode. Set GEMINI_MODE=live');
    }

    // Clean exit
    if (gemini.realClient && gemini.realClient.stop) {
        gemini.realClient.stop();
    }
    process.exit(0);
}

main().catch(err => {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
});
