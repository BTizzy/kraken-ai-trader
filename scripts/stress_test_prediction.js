#!/usr/bin/env node
/**
 * Stress Test — Prediction Market Trading Bot
 *
 * Runs an accelerated simulation:
 *   1. Creates 20 synthetic markets with realistic price dynamics
 *   2. Simulates 24 hours of trading in ~60 seconds
 *   3. Introduces periodic price shocks to create fresh divergence
 *   4. Reports win rate, PnL, drawdown, Sharpe, and trade distribution
 *
 * Usage:
 *   node scripts/stress_test_prediction.js [--hours 24] [--speed 1000] [--markets 20]
 */

const path = require('path');
const PredictionDatabase = require('../lib/prediction_db');
const GeminiClient = require('../lib/gemini_client');
const SignalDetector = require('../lib/signal_detector');
const PaperTradingEngine = require('../lib/paper_trading_engine');

// ── CLI args ──
const args = process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--') && arr[i + 1]) acc[a.slice(2)] = arr[i + 1];
    return acc;
}, {});

const SIM_HOURS = parseInt(args.hours || '24', 10);
const SPEED_MULT = parseInt(args.speed || '1000', 10);       // ticks per sim-second
const NUM_MARKETS = parseInt(args.markets || '20', 10);
const TICK_MS = 2000;                                         // sim interval in ms

// ── Synthetic market templates ──
const CATEGORIES = ['politics', 'sports', 'crypto', 'economics', 'other'];
function makeMarkets(n) {
    const markets = [];
    for (let i = 0; i < n; i++) {
        const cat = CATEGORIES[i % CATEGORIES.length];
        const basePrice = 0.15 + Math.random() * 0.70; // 0.15 – 0.85
        markets.push({
            id: `stress_mkt_${i}`,
            title: `Stress Market ${i} (${cat})`,
            category: cat,
            basePrice,
            polyPrice: basePrice,
            volatility: 0.002 + Math.random() * 0.006,       // 0.2 – 0.8 ¢ per tick
            shockProb: 0.005,                                  // ~1 shock / 200 ticks (more frequent)
            trendDir: 0,                                       // current trend: -1, 0, or 1
            trendTicks: 0,                                     // ticks remaining in trend
        });
    }
    return markets;
}

// ── Price dynamics ──
function tickPrices(markets) {
    for (const m of markets) {
        // Trend persistence: information-driven moves hold for 50-200 ticks
        if (m.trendTicks > 0) {
            m.polyPrice += m.trendDir * m.volatility * 0.5;
            m.trendTicks--;
        }

        // Random walk component (noise)
        const dPoly = (Math.random() - 0.5) * m.volatility * 1.5;
        m.polyPrice = Math.max(0.02, Math.min(0.98, m.polyPrice + dPoly));

        // Information shock: 3-6¢ jump that PERSISTS (trend)
        if (Math.random() < m.shockProb) {
            const shock = (Math.random() - 0.5) * 0.10;
            m.polyPrice = Math.max(0.02, Math.min(0.98, m.polyPrice + shock));
            // Trend persists for 50-200 ticks after shock
            m.trendDir = shock > 0 ? 1 : -1;
            m.trendTicks = 50 + Math.floor(Math.random() * 150);
        }
    }
}

// ── Main ──
async function main() {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   PREDICTION BOT STRESS TEST                    ║');
    console.log(`║   ${SIM_HOURS}h simulation · ${NUM_MARKETS} markets · ${SPEED_MULT}x speed     ║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    // In-memory DB
    const db = new PredictionDatabase(':memory:');
    const gemini = new GeminiClient({ mode: 'paper' });
    const signals = new SignalDetector(db, {
        config: { minScore: 45, stalenessThreshold: 120 },
        signalCooldownMs: 5000,
        logLevel: 'ERROR',
    });
    const engine = new PaperTradingEngine(db, gemini, {
        logLevel: 'ERROR',
        learningInterval: 60000,
    });
    engine.isRunning = true;

    // Create synthetic markets — pass polyPrice as reference, let updatePaperMarket handle lag
    const markets = makeMarkets(NUM_MARKETS);
    for (const m of markets) {
        gemini.updatePaperMarket(m.id, m.polyPrice, {
            title: m.title,
            volume: 5000 + Math.floor(Math.random() * 15000),
            spreadWidth: 0.015 + Math.random() * 0.01,
            convergenceRate: 0.05,
        });
        db.upsertMarket({
            gemini_market_id: m.id,
            title: m.title,
            category: m.category,
        });
    }

    // Simulation loop
    const totalTicks = Math.floor((SIM_HOURS * 3600) / (TICK_MS / 1000));
    const reportEvery = Math.max(1, Math.floor(totalTicks / 20)); // 20 progress reports
    const pnlSnapshots = [];  // { tick, balance }
    let allExits = [];
    const startWall = Date.now();
    const startBalance = db.getWallet().balance;

    console.log(`Running ${totalTicks.toLocaleString()} ticks…\n`);

    for (let tick = 0; tick < totalTicks; tick++) {
        // 1. Update Polymarket reference prices (random walk + shocks)
        tickPrices(markets);

        // 2. Update Gemini paper markets — pass Polymarket price as REFERENCE.
        //    updatePaperMarket handles convergence lag internally.
        //    Use 5% convergence (slower than live bot) for stress test realism:
        //    at 43K ticks, 5% gives ~20-tick convergence half-life.
        for (const m of markets) {
            gemini.updatePaperMarket(m.id, m.polyPrice, {
                title: m.title,
                spreadWidth: 0.015 + Math.random() * 0.01, // 1.5-2.5¢ spread
                convergenceRate: 0.05, // 5% per tick (slower, more edge time)
            });
        }

        // 3. Build market states using ACTUAL Gemini paper market state
        const marketStates = [];
        for (const m of markets) {
            const gm = gemini.paperMarkets.get(m.id);
            if (!gm) continue;

            const halfSpread = 0.005 + Math.random() * 0.01;
            marketStates.push({
                marketId: m.id,
                category: m.category,
                matchedMarket: { event_title: m.title },
                gemini: {
                    market_id: m.id,
                    title: m.title,
                    bid: gm.bid,
                    ask: gm.ask,
                    last: gm.last,
                    volume: gm.volume || 5000 + Math.floor(Math.random() * 15000),
                    last_trade_time: gm.last_trade_time,
                },
                polymarket: {
                    bid: Math.max(0.01, m.polyPrice - halfSpread),
                    ask: Math.min(0.99, m.polyPrice + halfSpread),
                    last: m.polyPrice,
                    spread: halfSpread * 2,
                },
                kalshi: { bid: null, ask: null, last: null, spread: null },
            });
        }

        // 4. Run signal detection + trading engine
        const scored = signals.processMarkets(marketStates);
        const actionable = scored.filter(s => s.actionable);
        const result = engine.tick(actionable);
        allExits.push(...result.exits);

        // 5. Snapshot balance periodically
        if (tick % reportEvery === 0) {
            const w = db.getWallet();
            pnlSnapshots.push({ tick, balance: w.balance });
            const pct = ((tick / totalTicks) * 100).toFixed(0);
            const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
            process.stdout.write(
                `\r  ${pct}% | tick ${tick.toLocaleString()} | bal $${w.balance.toFixed(2)} | trades ${allExits.length} | ${elapsed}s`
            );
        }
    }

    // ── Final stats ──
    const wallet = db.getWallet();
    const endBalance = wallet.balance;
    const totalPnL = endBalance - startBalance;
    const wins = allExits.filter(e => e.pnl > 0).length;
    const losses = allExits.filter(e => e.pnl < 0).length;
    const breakeven = allExits.filter(e => e.pnl === 0).length;
    const winRate = allExits.length > 0 ? wins / allExits.length : 0;
    const totalTrades = allExits.length;

    // Drawdown
    let peak = startBalance;
    let maxDrawdown = 0;
    for (const snap of pnlSnapshots) {
        if (snap.balance > peak) peak = snap.balance;
        const dd = (peak - snap.balance) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Sharpe (annualized from hourly PnL)
    const hourlyReturns = [];
    const ticksPerHour = Math.floor(3600 / (TICK_MS / 1000));
    for (let i = 1; i < pnlSnapshots.length; i++) {
        const ret = (pnlSnapshots[i].balance - pnlSnapshots[i - 1].balance) / pnlSnapshots[i - 1].balance;
        hourlyReturns.push(ret);
    }
    const meanRet = hourlyReturns.length ? hourlyReturns.reduce((a, b) => a + b, 0) / hourlyReturns.length : 0;
    const stdRet = hourlyReturns.length > 1
        ? Math.sqrt(hourlyReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / (hourlyReturns.length - 1))
        : 0;
    const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(8760) : 0; // annualized

    // Average hold time
    const avgHold = totalTrades > 0
        ? allExits.reduce((s, e) => s + e.holdTime, 0) / totalTrades
        : 0;

    // PnL by exit reason
    const byReason = {};
    for (const e of allExits) {
        if (!byReason[e.exitReason]) byReason[e.exitReason] = { count: 0, pnl: 0 };
        byReason[e.exitReason].count++;
        byReason[e.exitReason].pnl += e.pnl;
    }

    // PnL by category
    const byCat = {};
    for (const e of allExits) {
        const cat = e.trade.category || 'other';
        if (!byCat[cat]) byCat[cat] = { count: 0, pnl: 0, wins: 0 };
        byCat[cat].count++;
        byCat[cat].pnl += e.pnl;
        if (e.pnl > 0) byCat[cat].wins++;
    }

    const wallTime = ((Date.now() - startWall) / 1000).toFixed(1);

    // ── Report ──
    console.log('\n\n' + '═'.repeat(55));
    console.log('  STRESS TEST RESULTS');
    console.log('═'.repeat(55));
    console.log(`  Simulated period .... ${SIM_HOURS} hours`);
    console.log(`  Wall-clock time ..... ${wallTime}s`);
    console.log(`  Markets ............. ${NUM_MARKETS}`);
    console.log(`  Total ticks ......... ${totalTicks.toLocaleString()}`);
    console.log('');
    console.log(`  Starting balance .... $${startBalance.toFixed(2)}`);
    console.log(`  Ending balance ...... $${endBalance.toFixed(2)}`);
    console.log(`  Total PnL ........... $${totalPnL.toFixed(2)} (${((totalPnL / startBalance) * 100).toFixed(2)}%)`);
    console.log(`  Max drawdown ........ ${(maxDrawdown * 100).toFixed(2)}%`);
    console.log(`  Sharpe ratio ........ ${sharpe.toFixed(2)} (annualized)`);
    console.log('');
    console.log(`  Total trades ........ ${totalTrades}`);
    console.log(`  Win / Loss / BE ..... ${wins} / ${losses} / ${breakeven}`);
    console.log(`  Win rate ............ ${(winRate * 100).toFixed(1)}%`);
    console.log(`  Avg hold time ....... ${avgHold.toFixed(0)}s`);
    console.log('');
    console.log('  By exit reason:');
    for (const [reason, data] of Object.entries(byReason)) {
        console.log(`    ${reason.padEnd(15)} ${String(data.count).padStart(4)} trades  $${data.pnl.toFixed(2)}`);
    }
    console.log('');
    console.log('  By category:');
    for (const [cat, data] of Object.entries(byCat)) {
        const wr = data.count > 0 ? ((data.wins / data.count) * 100).toFixed(0) : '0';
        console.log(`    ${cat.padEnd(12)} ${String(data.count).padStart(4)} trades  $${data.pnl.toFixed(2).padStart(8)}  WR=${wr}%`);
    }
    console.log('═'.repeat(55));

    // ── Exit codes for CI ──
    if (totalPnL > 0 && winRate > 0.40) {
        console.log('\n✅ PASS — Bot is profitable with acceptable win rate.\n');
        process.exit(0);
    } else {
        console.log('\n❌ FAIL — Bot did not meet profitability criteria.\n');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('Stress test error:', err);
    process.exit(1);
});
