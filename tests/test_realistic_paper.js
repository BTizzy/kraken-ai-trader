/**
 * Test script for realistic paper trading mode
 * Validates: synthetic lag bypass, realistic fills, realistic exits, round-trip PnL, backward compat
 */

const path = require('path');
const fs = require('fs');

// Test framework
let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
        console.log(`  \u2705 ${name}`);
    } catch (error) {
        failed++;
        console.log(`  \u274c ${name}: ${error.message}`);
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertApprox(actual, expected, tolerance, msg) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`${msg || 'Approx assertion failed'}: expected ~${expected}, got ${actual} (diff=${diff.toFixed(4)})`);
    }
}

// ===== Setup =====
const GeminiClient = require('../lib/gemini_client');
const PredictionDatabase = require('../lib/prediction_db');

const testDbPath = path.join(__dirname, '../data/test_realistic_paper.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
const db = new PredictionDatabase(testDbPath);

// ===== Test Group A: Synthetic Lag Bypass =====
console.log('\n\ud83d\udcc8 Test Group A: Synthetic Lag Bypass...');

test('realisticPaper flag defaults to false', () => {
    const client = new GeminiClient({ mode: 'paper' });
    assert(client.realisticPaper === false, 'Expected false');
});

test('realisticPaper flag can be set to true', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });
    assert(client.realisticPaper === true, 'Expected true');
});

test('updatePaperMarket preserves real data when realisticPaper=true', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    // Set real market data (simulating refreshRealData)
    client.paperMarkets.set('GEMI-BTC-TEST', {
        market_id: 'GEMI-BTC-TEST',
        title: 'BTC Test',
        bid: 0.40,
        ask: 0.46,
        last: 0.43,
        spread: 0.06,
        volume: 1000,
        bid_depth: 500,
        ask_depth: 500,
        updated: Date.now(),
        isReal: true
    });

    // Call updatePaperMarket with a different reference price
    client.updatePaperMarket('GEMI-BTC-TEST', 0.60);

    const market = client.paperMarkets.get('GEMI-BTC-TEST');
    assert(market.bid === 0.40, `Bid should be preserved at 0.40, got ${market.bid}`);
    assert(market.ask === 0.46, `Ask should be preserved at 0.46, got ${market.ask}`);
    assert(market.isReal === true, 'isReal flag should be preserved');
});

test('updatePaperMarket updates metadata for real markets', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-META', {
        market_id: 'GEMI-BTC-META',
        title: 'Old Title',
        bid: 0.30,
        ask: 0.35,
        last: 0.325,
        spread: 0.05,
        volume: 500,
        bid_depth: 500,
        ask_depth: 500,
        updated: Date.now(),
        isReal: true
    });

    client.updatePaperMarket('GEMI-BTC-META', 0.70, { title: 'New Title', volume: 999 });

    const market = client.paperMarkets.get('GEMI-BTC-META');
    assert(market.title === 'New Title', `Title should be updated, got ${market.title}`);
    assert(market.volume === 999, `Volume should be updated, got ${market.volume}`);
    assert(market.bid === 0.30, `Bid should be preserved at 0.30, got ${market.bid}`);
});

// ===== Test Group B: Realistic Fill Pricing =====
console.log('\n\ud83d\udcb0 Test Group B: Realistic Fill Pricing...');

test('executeRealisticPaperTrade: YES fills at ask', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-FILL', {
        market_id: 'GEMI-BTC-FILL',
        bid: 0.40,
        ask: 0.46,
        last: 0.43,
        spread: 0.06,
        bid_depth: 500,
        ask_depth: 500,
        updated: Date.now()
    });

    const order = client.executeRealisticPaperTrade('GEMI-BTC-FILL', 'YES', 50);
    assert(order.success === true, 'Order should succeed');
    // Position is small vs depth ($50 / $500 = 10% > 5% threshold)
    // Slippage = 0.10 * 0.03 = 0.003, so fillPrice = 0.46 + 0.003 = 0.463
    assert(order.fill_price >= 0.46, `YES fill should be >= ask 0.46, got ${order.fill_price}`);
    assert(order.realistic === true, 'Should be marked as realistic');
});

test('executeRealisticPaperTrade: NO fills at 1-bid', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-NO', {
        market_id: 'GEMI-BTC-NO',
        bid: 0.40,
        ask: 0.46,
        last: 0.43,
        spread: 0.06,
        bid_depth: 5000,
        ask_depth: 5000,
        updated: Date.now()
    });

    const order = client.executeRealisticPaperTrade('GEMI-BTC-NO', 'NO', 50);
    assert(order.success === true, 'Order should succeed');
    // NO cost = 1 - 0.40 = 0.60
    // Position $50 vs $5000 depth = 1% < 5% threshold, no slippage
    assertApprox(order.fill_price, 0.60, 0.001, 'NO fill should be ~0.60 (1 - bid)');
});

test('executeRealisticPaperTrade: fails when market not found', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });
    const order = client.executeRealisticPaperTrade('NONEXISTENT', 'YES', 50);
    assert(order.success === false, 'Should fail for missing market');
});

test('executeRealisticPaperTrade: fails when bid is null (NO direction)', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-NULL-BID', {
        market_id: 'GEMI-NULL-BID',
        bid: null,
        ask: 0.50,
        last: 0.50,
        spread: null,
        bid_depth: 0,
        ask_depth: 500,
        updated: Date.now()
    });

    const order = client.executeRealisticPaperTrade('GEMI-NULL-BID', 'NO', 50);
    assert(order.success === false, 'Should fail when bid is null for NO direction');
});

test('executeRealisticPaperTrade: applies depth-based slippage', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-SLIP', {
        market_id: 'GEMI-BTC-SLIP',
        bid: 0.40,
        ask: 0.46,
        last: 0.43,
        spread: 0.06,
        bid_depth: 100,
        ask_depth: 100,
        updated: Date.now()
    });

    // $50 position on $100 depth = 50% impact → slippage = 0.50 * 0.03 = 0.015
    const order = client.executeRealisticPaperTrade('GEMI-BTC-SLIP', 'YES', 50);
    assert(order.success === true, 'Order should succeed');
    assertApprox(order.fill_price, 0.475, 0.001, 'Should have significant slippage');
    assert(order.slippage > 0.01, `Slippage should be > 1c, got ${order.slippage}`);
});

// ===== Test Group C: Realistic Exit Pricing =====
console.log('\n\ud83d\udee3\ufe0f  Test Group C: Realistic Exit Pricing...');

test('getRealisticExitPrice: YES exit at bid', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-EXIT', {
        market_id: 'GEMI-BTC-EXIT',
        bid: 0.48,
        ask: 0.52,
        last: 0.50,
        spread: 0.04,
        updated: Date.now()
    });

    const exitPrice = client.getRealisticExitPrice('GEMI-BTC-EXIT', 'YES');
    assert(exitPrice === 0.48, `YES exit should be bid 0.48, got ${exitPrice}`);
});

test('getRealisticExitPrice: NO exit at 1-ask', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-EXITNO', {
        market_id: 'GEMI-BTC-EXITNO',
        bid: 0.48,
        ask: 0.52,
        last: 0.50,
        spread: 0.04,
        updated: Date.now()
    });

    const exitPrice = client.getRealisticExitPrice('GEMI-BTC-EXITNO', 'NO');
    assertApprox(exitPrice, 0.48, 0.001, 'NO exit should be 1 - ask = 0.48');
});

test('getRealisticExitPrice: returns null for missing market', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });
    const exitPrice = client.getRealisticExitPrice('NONEXISTENT', 'YES');
    assert(exitPrice === null, 'Should return null for missing market');
});

// Compare with old paper exit (mid ± 0.001)
test('Realistic exit is worse than paper exit', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-CMP', {
        market_id: 'GEMI-BTC-CMP',
        bid: 0.48,
        ask: 0.52,
        last: 0.50,
        spread: 0.04,
        updated: Date.now()
    });

    const paperExit = client.getPaperExitPrice('GEMI-BTC-CMP', 'YES');
    const realisticExit = client.getRealisticExitPrice('GEMI-BTC-CMP', 'YES');

    // Paper exit: 0.50 - 0.001 = 0.499
    // Realistic exit: 0.48 (the bid)
    assert(realisticExit < paperExit,
        `Realistic exit (${realisticExit}) should be < paper exit (${paperExit})`);
});

// ===== Test Group D: Round-Trip PnL Comparison =====
console.log('\n\ud83d\udcca Test Group D: Round-Trip PnL Comparison...');

test('Realistic round-trip PnL is lower than paper PnL', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.paperMarkets.set('GEMI-BTC-RT', {
        market_id: 'GEMI-BTC-RT',
        bid: 0.40,
        ask: 0.46,
        last: 0.43,
        spread: 0.06,
        bid_depth: 5000,
        ask_depth: 5000,
        updated: Date.now()
    });

    // Paper entry (YES): mid + 0.001 = 0.431
    const paperOrder = client.executePaperTrade('GEMI-BTC-RT', 'YES', 50);
    const paperEntry = paperOrder.fill_price;

    // Realistic entry (YES): ask = 0.46
    const realisticOrder = client.executeRealisticPaperTrade('GEMI-BTC-RT', 'YES', 50);
    const realisticEntry = realisticOrder.fill_price;

    assert(realisticEntry > paperEntry,
        `Realistic entry (${realisticEntry}) should be > paper entry (${paperEntry})`);

    // Now simulate market moving up for exit
    client.paperMarkets.set('GEMI-BTC-RT', {
        market_id: 'GEMI-BTC-RT',
        bid: 0.48,
        ask: 0.52,
        last: 0.50,
        spread: 0.04,
        bid_depth: 5000,
        ask_depth: 5000,
        updated: Date.now()
    });

    // Paper exit (YES): mid - 0.001 = 0.499
    const paperExit = client.getPaperExitPrice('GEMI-BTC-RT', 'YES');

    // Realistic exit (YES): bid = 0.48
    const realisticExit = client.getRealisticExitPrice('GEMI-BTC-RT', 'YES');

    // Paper PnL: (0.499 - 0.431) * 50 / 0.431 = ~$7.89
    const paperPnl = (paperExit - paperEntry) * 50 / paperEntry;

    // Realistic PnL: (0.48 - 0.46) * 50 / 0.46 = ~$2.17
    const realisticPnl = (realisticExit - realisticEntry) * 50 / realisticEntry;

    assert(realisticPnl < paperPnl,
        `Realistic PnL ($${realisticPnl.toFixed(2)}) should be < paper PnL ($${paperPnl.toFixed(2)})`);
    assert(realisticPnl > 0, `Realistic PnL should still be positive, got $${realisticPnl.toFixed(2)}`);
    assert(paperPnl / realisticPnl > 1.5,
        `Paper should overstate by >50%: ratio=${(paperPnl / realisticPnl).toFixed(2)}`);
});

// ===== Test Group E: gemini_sim_* Backward Compatibility =====
console.log('\n\u2699\ufe0f  Test Group E: gemini_sim_* Backward Compatibility...');

test('updatePaperMarket applies synthetic lag for non-real markets', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    // First call: initialize with reference price 0.50
    client.updatePaperMarket('gemini_sim_12345', 0.50);
    const first = client.paperMarkets.get('gemini_sim_12345');
    assert(first !== undefined, 'Market should be created');
    assert(!first.isReal, 'Should NOT be marked as real');

    // Second call: apply lag
    client.updatePaperMarket('gemini_sim_12345', 0.70);
    const second = client.paperMarkets.get('gemini_sim_12345');

    // With 15% convergence from ~0.50 toward 0.70: should move ~3c
    // last should be somewhere between first.last and 0.70, not equal to 0.70
    assert(second.last < 0.65,
        `Synthetic lag should prevent full convergence: last=${second.last.toFixed(3)} should be < 0.65`);
    assert(second.last > first.last - 0.01,
        `last should have moved toward 0.70: was ${first.last.toFixed(3)}, now ${second.last.toFixed(3)}`);
});

test('executePaperTrade still uses mid for non-real markets', () => {
    const client = new GeminiClient({ mode: 'paper', realisticPaper: true });

    client.updatePaperMarket('gemini_sim_fill', 0.50);
    const market = client.paperMarkets.get('gemini_sim_fill');

    const order = client.executePaperTrade('gemini_sim_fill', 'YES', 50);
    assert(order.success === true, 'Paper trade should succeed');

    // Should fill at last + 0.001 (maker fee), not at ask
    assertApprox(order.fill_price, market.last + 0.001, 0.002,
        'Paper fill should be near mid + 0.001');
});

// ===== Test Group F: DB Schema Migration =====
console.log('\n\ud83d\uddc4\ufe0f  Test Group F: DB Schema Migration...');

test('DB has realistic shadow columns', () => {
    const columns = db.db.prepare(
        "SELECT name FROM pragma_table_info('prediction_trades')"
    ).all().map(c => c.name);

    assert(columns.includes('realistic_entry_price'), 'Missing realistic_entry_price');
    assert(columns.includes('realistic_exit_price'), 'Missing realistic_exit_price');
    assert(columns.includes('realistic_pnl'), 'Missing realistic_pnl');
    assert(columns.includes('gemini_actual_bid'), 'Missing gemini_actual_bid');
    assert(columns.includes('gemini_actual_ask'), 'Missing gemini_actual_ask');
    assert(columns.includes('gemini_actual_spread'), 'Missing gemini_actual_spread');
});

test('updateTradeRealisticEntry stores data', () => {
    // Insert a trade first
    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'test_realistic_1',
        market_title: 'Test Realistic',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.43,
        position_size: 50,
        opportunity_score: 55,
        mode: 'paper'
    });

    // Update with realistic entry data
    db.updateTradeRealisticEntry(tradeId, 0.46, 0.40, 0.46, 0.06);

    const trade = db.db.prepare('SELECT * FROM prediction_trades WHERE id = ?').get(tradeId);
    assert(trade.realistic_entry_price === 0.46, `Expected 0.46, got ${trade.realistic_entry_price}`);
    assert(trade.gemini_actual_bid === 0.40, `Expected 0.40, got ${trade.gemini_actual_bid}`);
    assert(trade.gemini_actual_ask === 0.46, `Expected 0.46, got ${trade.gemini_actual_ask}`);
    assert(trade.gemini_actual_spread === 0.06, `Expected 0.06, got ${trade.gemini_actual_spread}`);
});

test('updateTradeRealisticExit stores data', () => {
    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'test_realistic_2',
        market_title: 'Test Realistic Exit',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.43,
        position_size: 50,
        opportunity_score: 55,
        mode: 'paper'
    });

    db.updateTradeRealisticEntry(tradeId, 0.46, 0.40, 0.46, 0.06);
    db.updateTradeRealisticExit(tradeId, 0.48, 2.17);

    const trade = db.db.prepare('SELECT * FROM prediction_trades WHERE id = ?').get(tradeId);
    assert(trade.realistic_exit_price === 0.48, `Expected 0.48, got ${trade.realistic_exit_price}`);
    assertApprox(trade.realistic_pnl, 2.17, 0.01, 'realistic_pnl should be stored');
});

// ===== Cleanup =====
db.close();
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
