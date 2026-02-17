/**
 * Test script for prediction market bot components
 * Validates: DB, clients, matcher, signal detector, trading engine
 */

const path = require('path');

// Test framework
let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (error) {
        failed++;
        console.log(`  ❌ ${name}: ${error.message}`);
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

// ===== Database Tests =====
console.log('\n📦 Testing PredictionDatabase...');

const PredictionDatabase = require('../lib/prediction_db');
const testDbPath = path.join(__dirname, '../data/test_prediction.db');

// Clean up previous test DB
const fs = require('fs');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const db = new PredictionDatabase(testDbPath);

test('DB initialized with tables', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map(t => t.name);
    assert(names.includes('markets'), 'markets table missing');
    assert(names.includes('market_prices'), 'market_prices table missing');
    assert(names.includes('prediction_trades'), 'prediction_trades table missing');
    assert(names.includes('signals'), 'signals table missing');
    assert(names.includes('paper_wallet'), 'paper_wallet table missing');
    assert(names.includes('bot_parameters'), 'bot_parameters table missing');
});

test('Paper wallet initialized at $500', () => {
    const wallet = db.getWallet();
    assert(wallet.balance === 500, `Expected 500, got ${wallet.balance}`);
    assert(wallet.initial_balance === 500, 'Initial balance wrong');
});

test('Default parameters loaded', () => {
    const threshold = db.getParameter('entry_threshold');
    assert(threshold === 45, `Expected 45, got ${threshold}`);
    const kelly = db.getParameter('kelly_multiplier');
    assert(kelly === 0.25, `Expected 0.25, got ${kelly}`);
});

test('Upsert and retrieve market', () => {
    db.upsertMarket({
        gemini_market_id: 'test_market_1',
        title: 'Will BTC hit $100k?',
        category: 'crypto',
        resolution_date: '2026-03-31'
    });
    const markets = db.getActiveMarkets();
    assert(markets.length >= 1, 'No markets found');
    assert(markets[0].title === 'Will BTC hit $100k?', 'Title mismatch');
});

test('Insert and retrieve price', () => {
    db.insertPrice({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'test_market_1',
        polymarket_bid: 0.52,
        polymarket_ask: 0.54,
        polymarket_last: 0.53,
        gemini_bid: 0.48,
        gemini_ask: 0.52,
        gemini_last: 0.50
    });
    const prices = db.getLatestPrices();
    assert(prices.length >= 1, 'No prices found');
});

test('Insert and close trade', () => {
    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'test_market_1',
        market_title: 'Will BTC hit $100k?',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.50,
        position_size: 50,
        opportunity_score: 72,
        mode: 'paper'
    });
    assert(tradeId > 0, 'Trade ID should be positive');

    const openBefore = db.getOpenTrades();
    assert(openBefore.length === 1, 'Should have 1 open trade');

    db.closeTrade(tradeId, 0.55, 5.0, 120, 'take_profit');
    const openAfter = db.getOpenTrades();
    assert(openAfter.length === 0, 'Should have 0 open trades after close');

    const recent = db.getRecentTrades(5);
    assert(recent.length >= 1, 'Should have recent trades');
    assert(recent[0].pnl === 5.0, `PnL should be 5.0, got ${recent[0].pnl}`);
});

test('Wallet update', () => {
    db.updateWallet(505, 5.0);
    const wallet = db.getWallet();
    assert(wallet.balance === 505, `Balance should be 505, got ${wallet.balance}`);
    assert(wallet.total_pnl === 5, `Total PnL should be 5, got ${wallet.total_pnl}`);
});

test('Insert signal', () => {
    const id = db.insertSignal({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'test_market_1',
        signal_type: 'composite',
        opportunity_score: 72,
        price_velocity: 0.05,
        spread_differential: 0.06,
        cross_platform_consensus: 1.0,
        gemini_staleness: 30,
        polymarket_price: 0.53,
        gemini_price: 0.50,
        triggered_trade: true
    });
    assert(id > 0, 'Signal ID should be positive');
});

test('Performance summary', () => {
    const summary = db.getPerformanceSummary();
    assert(summary.wallet, 'Should have wallet');
    assert(summary.parameters, 'Should have parameters');
});

// ===== Market Matcher Tests =====
console.log('\n🔗 Testing MarketMatcher...');

const MarketMatcher = require('../lib/market_matcher');
const matcher = new MarketMatcher(db);

test('Normalize title', () => {
    const result = matcher.normalizeTitle('Will Trump Win the 2024 Election?');
    assert(result === 'will trump win the 2024 election', `Got: ${result}`);
});

test('Title similarity - exact match', () => {
    const sim = matcher.titleSimilarity('Will BTC hit $100k?', 'Will BTC hit $100k?');
    assert(sim === 1.0, `Expected 1.0, got ${sim}`);
});

test('Title similarity - similar', () => {
    const sim = matcher.titleSimilarity(
        'Will Bitcoin reach $100,000 by March 2026?',
        'Bitcoin to hit $100000 by March 2026'
    );
    assert(sim > 0.5, `Expected > 0.5, got ${sim}`);
});

test('Title similarity - different', () => {
    const sim = matcher.titleSimilarity(
        'Will BTC hit $100k?',
        'Who will win Super Bowl LX?'
    );
    assert(sim < 0.3, `Expected < 0.3, got ${sim}`);
});

test('Date matching - same date', () => {
    assert(matcher.datesMatch('2026-03-31', '2026-03-31'), 'Same dates should match');
});

test('Date matching - 1 day tolerance', () => {
    assert(matcher.datesMatch('2026-03-31', '2026-04-01'), 'Adjacent dates should match');
});

test('Market matching', () => {
    const polyMarkets = [
        { market_id: 'poly_1', title: 'Will BTC hit $100k by March 2026?', category: 'crypto', resolution_date: '2026-03-31' },
        { market_id: 'poly_2', title: 'Super Bowl LX Winner', category: 'sports', resolution_date: '2026-02-08' }
    ];
    const kalshiMarkets = [
        { market_id: 'kalshi_1', title: 'Bitcoin above $100,000 on March 31', category: 'crypto', resolution_date: '2026-03-31' }
    ];
    const geminiMarkets = [
        { market_id: 'gemini_1', title: 'Will Bitcoin reach $100k by March 2026?', category: 'crypto', resolution_date: '2026-03-31' }
    ];

    const matches = matcher.matchMarkets(polyMarkets, kalshiMarkets, geminiMarkets);
    // Should have at least the auto-matched gemini_1
    const autoMatch = matches.find(m => m.gemini_market_id === 'gemini_1');
    assert(autoMatch, 'Should match gemini_1');
    assert(autoMatch.polymarket_market_id === 'poly_1', 'Should match to poly_1');
});

// ===== Signal Detector Tests =====
console.log('\n📡 Testing SignalDetector...');

const SignalDetector = require('../lib/signal_detector');
const signalDetector = new SignalDetector(db);

test('Record and calculate price velocity', () => {
    const now = Date.now();
    // Simulate price moving from 0.50 to 0.55 over 5 seconds
    for (let i = 0; i < 6; i++) {
        signalDetector.recordPrice('test_1', 'polymarket', 0.50 + i * 0.01, now - (5 - i) * 1000);
    }
    const velocity = signalDetector.calculatePriceVelocity('test_1', 'polymarket', 10000);
    assert(velocity.magnitude > 0.04, `Expected magnitude > 0.04, got ${velocity.magnitude}`);
    assert(velocity.direction === 'up', `Expected 'up', got ${velocity.direction}`);
});

test('Spread differential calculation', () => {
    const diff = signalDetector.calculateSpreadDifferential(
        { bid: 0.40, ask: 0.65 }, // Gemini: 25¢ spread
        { bid: 0.50, ask: 0.54 }, // Poly: 4¢ spread
        { bid: 0.49, ask: 0.55 }  // Kalshi: 6¢ spread
    );
    assert(diff > 0.15, `Expected > 0.15, got ${diff}`);
});

test('Reference price calculation', () => {
    const ref = signalDetector.calculateReferencePrice(
        { bid: 0.52, ask: 0.54 },
        { bid: 0.51, ask: 0.55 }
    );
    assert(Math.abs(ref - 0.53) < 0.01, `Expected ~0.53, got ${ref}`);
});

test('Opportunity scoring', () => {
    const score = signalDetector.scoreOpportunity(
        'test_1', 'crypto',
        { bid: 0.45, ask: 0.55, volume: 5000, last_trade_time: Date.now() - 120000 },
        { bid: 0.52, ask: 0.54 },
        { bid: 0.51, ask: 0.55 }
    );
    assert(score.total >= 0 && score.total <= 100, `Score out of range: ${score.total}`);
    assert(score.components, 'Should have components breakdown');
});

test('Direction determination', () => {
    const now = Date.now();
    // Strong upward movement on polymarket
    for (let i = 0; i < 10; i++) {
        signalDetector.recordPrice('test_dir', 'polymarket', 0.40 + i * 0.02, now - (9 - i) * 1000);
    }
    const dir = signalDetector.determineDirection('test_dir',
        { bid: 0.58, ask: 0.60 },
        { bid: 0.57, ask: 0.61 }
    );
    assert(dir === 'YES', `Expected YES, got ${dir}`);
});

// ===== Paper Trading Engine Tests =====
console.log('\n💰 Testing PaperTradingEngine...');

const GeminiClient = require('../lib/gemini_client');
const PaperTradingEngine = require('../lib/paper_trading_engine');

const gemini = new GeminiClient({ mode: 'paper' });
gemini.updatePaperMarket('test_market_1', 0.50, { title: 'Test Market', volume: 5000 });

// Reset wallet for clean test
db.db.prepare('UPDATE paper_wallet SET balance = 500, total_trades = 0, winning_trades = 0, losing_trades = 0, total_pnl = 0').run();

const engine = new PaperTradingEngine(db, gemini);

test('Calculate position size', () => {
    const wallet = db.getWallet();
    const size = engine.calculatePositionSize({
        direction: 'YES',
        gemini_ask: 0.50,
        targetPrice: 0.55,
        score: 75
    }, wallet);
    assert(size > 0, `Position size should be positive, got ${size}`);
    assert(size <= 100, `Should not exceed max $100, got ${size}`);
});

test('Entry position check', () => {
    const check = engine.canEnterPosition({ category: 'crypto', marketId: 'new_market' });
    assert(check.allowed === true, `Should allow entry, got: ${check.reason}`);
});

test('Enter position', () => {
    const signal = {
        marketId: 'test_market_1',
        title: 'Test Market',
        category: 'crypto',
        score: 75,
        direction: 'YES',
        gemini_bid: 0.48,
        gemini_ask: 0.52,
        gemini_volume: 5000,
        referencePrice: 0.53,
        targetPrice: 0.53
    };
    const entry = engine.enterPosition(signal);
    assert(entry !== null, 'Should enter position');
    assert(entry.tradeId > 0, 'Should have trade ID');
    assert(entry.order.success, 'Paper order should succeed');
});

test('Monitor positions', () => {
    // Update price to trigger take profit
    gemini.updatePaperMarket('test_market_1', 0.60, { title: 'Test Market' });
    const exits = engine.monitorPositions();
    // May or may not exit depending on exact paper prices
    assert(Array.isArray(exits), 'Should return array');
});

// ===== Client Tests =====
console.log('\n🌐 Testing API Clients...');

const PolymarketClient = require('../lib/polymarket_client');
const KalshiClient = require('../lib/kalshi_client');

test('Polymarket client normalizes market', () => {
    const poly = new PolymarketClient();
    const normalized = poly.normalizeMarket({
        id: 'abc123',
        question: 'Will BTC hit $100k?',
        clobTokenIds: '["token1","token2"]',
        outcomePrices: '[0.55, 0.45]',
        volume: '50000',
        tags: '["crypto"]'
    });
    assert(normalized.platform === 'polymarket', 'Wrong platform');
    assert(normalized.title === 'Will BTC hit $100k?', 'Wrong title');
    assert(normalized.category === 'crypto', `Wrong category: ${normalized.category}`);
    assert(normalized.last_price_yes === 0.55, `Wrong price: ${normalized.last_price_yes}`);
});

test('Kalshi client normalizes market', () => {
    const kalshi = new KalshiClient();
    const normalized = kalshi.normalizeMarket({
        ticker: 'BTCABOVE100K-26MAR31',
        title: 'Bitcoin above $100,000 on March 31',
        status: 'open',
        volume: 5000,
        last_price: 55,
        yes_bid: 53,
        yes_ask: 57
    });
    assert(normalized.platform === 'kalshi', 'Wrong platform');
    assert(normalized.market_id === 'BTCABOVE100K-26MAR31', 'Wrong ID');
    assert(normalized.last_price_yes === 0.55, `Wrong price: ${normalized.last_price_yes}`);
    assert(normalized.category === 'crypto', `Wrong category: ${normalized.category}`);
});

test('Gemini paper trade execution', () => {
    const g = new GeminiClient({ mode: 'paper' });
    g.updatePaperMarket('test_exec', 0.50, { title: 'Test' });
    const order = g.executePaperTrade('test_exec', 'YES', 25);
    assert(order.success, 'Paper order should succeed');
    assert(order.fill_price > 0, 'Should have fill price');
    assert(order.direction === 'YES', 'Wrong direction');
});

// ===== Rate Limiter Tests =====
console.log('\n⏱️ Testing RateLimiter...');

const RateLimiter = require('../server/rate-limiter');
const limiter = new RateLimiter({ polymarketRPM: 5 });

test('Rate limiter allows initial requests', () => {
    assert(limiter.canRequest('polymarket'), 'Should allow first request');
});

test('Rate limiter tracks requests', () => {
    for (let i = 0; i < 5; i++) {
        limiter.recordRequest('polymarket');
    }
    assert(!limiter.canRequest('polymarket'), 'Should block after limit');
});

test('Rate limiter stats', () => {
    const stats = limiter.getStats();
    assert(stats.polymarket, 'Should have polymarket stats');
    assert(stats.polymarket.used === 5, `Used should be 5, got ${stats.polymarket.used}`);
});

// ===== Cleanup =====
db.close();
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
// Also clean WAL/SHM files
if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');

// ===== Summary =====
console.log(`\n${'='.repeat(50)}`);
console.log(`Tests: ${total} total, ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
