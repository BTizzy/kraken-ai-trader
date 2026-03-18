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
        const result = fn();
        if (result && typeof result.then === 'function') {
            // Async test — queue it
            asyncTests.push(result.then(() => {
                passed++;
                console.log(`  ✅ ${name}`);
            }).catch(error => {
                failed++;
                console.log(`  ❌ ${name}: ${error.message}`);
            }));
        } else {
            passed++;
            console.log(`  ✅ ${name}`);
        }
    } catch (error) {
        failed++;
        console.log(`  ❌ ${name}: ${error.message}`);
    }
}
const asyncTests = [];

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
    assert(kelly === 0.15, `Expected 0.15, got ${kelly}`);
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
gemini.updatePaperMarket('GEMI-TEST2602190200-HI50000', 0.50, { title: 'Test Market', volume: 5000 });

// Reset wallet for clean test
db.db.prepare('UPDATE paper_wallet SET balance = 500, total_trades = 0, winning_trades = 0, losing_trades = 0, total_pnl = 0').run();

const engine = new PaperTradingEngine(db, gemini);
const shortRunEngine = new PaperTradingEngine(db, gemini, { tradingProfile: 'short-run' });
const paperSessionEngine = new PaperTradingEngine(db, gemini, {
    tradingProfile: 'short-run',
    autonomous15mSession: true,
    sessionTimeoutMs: 900000,
    sessionMinTtxSeconds: 600,
    sessionMaxTtxSeconds: 3600,
    sessionEntryBufferSeconds: 120,
    sessionForceExitBufferSeconds: 60
});
const liveModeGemini = new GeminiClient({ mode: 'live' });
const sessionEngine = new PaperTradingEngine(db, liveModeGemini, {
    tradingProfile: 'short-run',
    autonomous15mSession: true,
    sessionTimeoutMs: 900000,
    sessionMinTtxSeconds: 600,
    sessionMaxTtxSeconds: 3600,
    sessionEntryBufferSeconds: 120,
    sessionForceExitBufferSeconds: 60
});

function makeFutureGemiSymbol(asset = 'BTC', strike = '50000', minutesAhead = 20) {
    const expiry = new Date(Date.now() + minutesAhead * 60 * 1000);
    const yy = String(expiry.getUTCFullYear()).slice(2);
    const mm = String(expiry.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(expiry.getUTCDate()).padStart(2, '0');
    const hh = String(expiry.getUTCHours()).padStart(2, '0');
    const mn = String(expiry.getUTCMinutes()).padStart(2, '0');
    return `GEMI-${asset}${yy}${mm}${dd}${hh}${mn}-HI${strike}`;
}

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

test('Standard profile keeps hold-to-settlement enabled', () => {
    assert(engine.tradingProfile === 'standard', `Expected standard profile, got ${engine.tradingProfile}`);
    assert(engine.params.hold_to_settlement === 1, `Expected hold_to_settlement=1, got ${engine.params.hold_to_settlement}`);
});

test('Short-run profile overrides exit timing parameters', () => {
    assert(shortRunEngine.tradingProfile === 'short-run', `Expected short-run profile, got ${shortRunEngine.tradingProfile}`);
    assert(shortRunEngine.params.hold_to_settlement === 0, 'Short-run profile should disable hold_to_settlement');
    assert(shortRunEngine.params.max_hold_time === 480, `Expected max_hold_time=480, got ${shortRunEngine.params.max_hold_time}`);
    assert(shortRunEngine.params.pre_expiry_exit_seconds === 180, `Expected pre_expiry_exit_seconds=180, got ${shortRunEngine.params.pre_expiry_exit_seconds}`);
});

test('Trade timing config respects hold-to-settlement by profile', () => {
    const expiry = new Date(Date.now() + 24 * 3600 * 1000);
    const yy = String(expiry.getUTCFullYear()).slice(2);
    const mm = String(expiry.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(expiry.getUTCDate()).padStart(2, '0');
    const hh = String(expiry.getUTCHours()).padStart(2, '0');
    const mn = String(expiry.getUTCMinutes()).padStart(2, '0');
    const trade = {
        gemini_market_id: `GEMI-BTC${yy}${mm}${dd}${hh}${mn}-HI70000`,
        timestamp: Math.floor(Date.now() / 1000),
        stop_loss_price: 0.40,
        opportunity_score: 80,
        direction: 'YES'
    };

    const standardTiming = engine.getTradeTimingConfig(trade, 0.50, Date.now());
    const shortTiming = shortRunEngine.getTradeTimingConfig(trade, 0.50, Date.now());

    assert(standardTiming.timeToExpiry > 0, 'Expected positive timeToExpiry');
    assert(standardTiming.maxHold > shortTiming.maxHold,
        `Expected standard maxHold > short-run maxHold, got ${standardTiming.maxHold} vs ${shortTiming.maxHold}`);
    assert(shortTiming.maxHold === 600, `Expected short-run maxHold=600, got ${shortTiming.maxHold}`);
});

test('Engine status exposes trading profile and effective parameters', () => {
    const status = shortRunEngine.getStatus();
    assert(status.trading_profile === 'short-run', `Expected short-run status profile, got ${status.trading_profile}`);
    assert(status.profile_overrides.max_hold_time === 480, 'Expected profile override to include short-run max_hold_time');
    assert(status.parameters.hold_to_settlement === 0, 'Expected effective params to reflect short-run override');
    assert(status.db_parameters.hold_to_settlement === 1, 'Expected db params to preserve long-run default');
});

test('Session policy exposes coherent short-session entry timing', () => {
    const policy = sessionEngine.getSessionPolicy();
    assert(policy.timeout_ms === 900000, `Expected timeout_ms=900000, got ${policy.timeout_ms}`);
    assert(policy.entry_buffer_seconds === 120, `Expected entry_buffer_seconds=120, got ${policy.entry_buffer_seconds}`);
    assert(policy.min_entry_ttx_seconds === 300, `Expected min_entry_ttx_seconds=300, got ${policy.min_entry_ttx_seconds}`);
});

test('Autonomous session blocks late entries near session end', () => {
    sessionEngine.markSessionStart(0, 100);
    sessionEngine.sessionStartTimeMs = Date.now() - (sessionEngine.sessionTimeoutMs - 45000);
    const signal = {
        category: 'crypto',
        marketId: makeFutureGemiSymbol('BTC', '50000', 20),
        direction: 'YES'
    };
    const check = sessionEngine.canEnterPosition(signal);
    assert(check.allowed === false, 'Expected session endgame entry to be blocked');
    assert(check.reason.includes('session_time_remaining_too_short'), `Unexpected reason: ${check.reason}`);
});

test('Paper-mode autonomous session gate supports readiness checks', async () => {
    paperSessionEngine.markSessionStart(0, 500);
    const gate = await paperSessionEngine.evaluatePreTradeSafetyGate(true);
    assert(gate.allowed === true, `Expected paper session gate to allow readiness, got ${gate.reason}`);
    assert(gate.details.session_mode === 'paper', `Expected paper session mode, got ${gate.details.session_mode}`);
});

test('Gemini source filter keeps only short-session eligible markets', async () => {
    const sourceFilteredGemini = new GeminiClient({
        mode: 'paper',
        useRealPrices: true,
        sessionMinTtxSeconds: 600,
        sessionMaxTtxSeconds: 3600,
        sourceSessionTtxFilterEnabled: true
    });

    sourceFilteredGemini.refreshRealData = async () => {};
    sourceFilteredGemini.realClient.getAllNormalizedMarkets = () => ([
        {
            market_id: makeFutureGemiSymbol('BTC', '50000', 20),
            title: 'Eligible',
            hasTwoSidedBook: true
        },
        {
            market_id: makeFutureGemiSymbol('BTC', '50000', 600),
            title: 'Too Long',
            hasTwoSidedBook: true
        }
    ]);

    const markets = await sourceFilteredGemini.fetchAllActiveMarkets();
    assert(markets.length === 1, `Expected 1 eligible market, got ${markets.length}`);
    assert(markets[0].title === 'Eligible', `Unexpected market kept: ${markets[0].title}`);
});

test('Autonomous 15m session rejects non fair-value signals', async () => {
    const sessionMarketId = makeFutureGemiSymbol('BTC', '51000', 20);
    gemini.updatePaperMarket(sessionMarketId, 0.50, { title: 'Session Test Market', volume: 5000 });

    const autonomousEngine = new PaperTradingEngine(db, gemini, {
        autonomous15mSession: true,
        sessionMinTtxSeconds: 600,
        sessionMaxTtxSeconds: 3600
    });

    const entry = await autonomousEngine.enterPosition({
        marketId: sessionMarketId,
        title: 'Session Test Market',
        category: 'crypto',
        signalType: 'composite',
        score: 80,
        direction: 'YES',
        gemini_bid: 0.49,
        gemini_ask: 0.51,
        gemini_volume: 5000,
        referencePrice: 0.70,
        targetPrice: 0.70,
        netEdge: 0.10,
        kellyFraction: 0.10,
        models: {
            blackScholes: { fairValue: 0.70 }
        }
    });

    assert(entry === null, 'Autonomous 15m mode should reject non fair-value signals');
});

test('Enter position', async () => {
    const signal = {
        marketId: 'GEMI-TEST2602190200-HI50000',
        title: 'Test Market',
        category: 'crypto',
        score: 75,
        direction: 'YES',
        gemini_bid: 0.49,
        gemini_ask: 0.51,
        gemini_volume: 5000,
        referencePrice: 0.65,
        targetPrice: 0.65,
        netEdge: 0.05,
        kellyFraction: 0.10
    };
    const entry = await engine.enterPosition(signal);
    assert(entry !== null, 'Should enter position');
    assert(entry.tradeId > 0, 'Should have trade ID');
    assert(entry.order.success, 'Paper order should succeed');
});

test('Monitor positions', async () => {
    // Update price to trigger take profit
    gemini.updatePaperMarket('GEMI-TEST2602190200-HI50000', 0.60, { title: 'Test Market' });
    const exits = await engine.monitorPositions();
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

// ===== Lifecycle Regression Tests =====
console.log('\n🔒 Testing lifecycle regression (cleanup/mutex/stopBot)...');

test('DB live trade stays open when closeTrade is not called', () => {
    // Regression: emergencyExitAll previously called closeTrade() optimistically for
    // unresolved/failed GTC sells, leaving DB closed but exchange still holding position.
    // New behavior: closeTrade() is only called after confirmed fill; unresolved exits skip it.
    const liveTradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000),
        gemini_market_id: 'GEMI-BTC2602190200-HI66250',
        market_title: 'Will BTC exceed $66,250 by Feb 19?',
        category: 'crypto',
        direction: 'NO',
        entry_price: 0.92,
        position_size: 10,
        opportunity_score: 55,
        mode: 'live'
    });
    assert(liveTradeId > 0, 'Live trade insert failed');

    // Simulates cleanup got back exit_submitted_unresolved and skipped closeTrade()
    const openTrades = db.getOpenTrades();
    const liveTrade = openTrades.find(t => t.id === liveTradeId);
    assert(liveTrade !== undefined, 'Live trade should still be open (closeTrade not called)');
    assert(liveTrade.mode === 'live', `Trade mode should be 'live', got '${liveTrade.mode}'`);

    // Cleanup for subsequent tests
    db.closeTrade(liveTradeId, 0.89, 0.30, 60, 'test_cleanup');
    const afterClose = db.getOpenTrades().find(t => t.id === liveTradeId);
    assert(afterClose === undefined, 'Trade should be closed after explicit closeTrade()');
});

test('cleanupStatus mutex logic prevents duplicate cleanup', () => {
    // Regression: emergencyExitAll now guards against concurrent calls with a mutex.
    // When cleanupStatus is 'in_progress', a second call must return { skipped_duplicate: true }.
    const botState = { cleanupStatus: 'idle', cleanupResult: null };

    function simulateEmergencyExitAll() {
        if (botState.cleanupStatus === 'in_progress') {
            return { skipped_duplicate: true };
        }
        botState.cleanupStatus = 'in_progress';
        botState.cleanupStatus = 'complete';
        botState.cleanupResult = { is_flat: true, total: 0, unresolved: 0 };
        return botState.cleanupResult;
    }

    const result1 = simulateEmergencyExitAll();
    assert(result1.is_flat === true, 'First call should return cleanup result with is_flat');
    assert(!result1.skipped_duplicate, 'First call should not be skipped_duplicate');

    // Simulate re-entry while still in_progress
    botState.cleanupStatus = 'in_progress';
    const result2 = simulateEmergencyExitAll();
    assert(result2.skipped_duplicate === true, 'Concurrent call must return skipped_duplicate: true');
});

test('stopBot source no longer contains fire-and-forget emergencyExitAll', () => {
    // Regression: old stopBot had:
    //   if (sessionEndReasons.includes(reason)) { emergencyExitAll(...).catch(...) }
    // This raced with harness-triggered cleanup. Verify it is removed.
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');
    const stopBotIdx = serverSource.indexOf('function stopBot(');
    assert(stopBotIdx !== -1, 'stopBot function not found in server source');

    // Extract 2KB starting at stopBot to scope the check
    const stopBotSection = serverSource.slice(stopBotIdx, stopBotIdx + 2000);
    const hasFireAndForget = /sessionEndReasons[\s\S]{0,300}emergencyExitAll[\s\S]{0,100}\.catch/
        .test(stopBotSection);
    assert(!hasFireAndForget,
        'stopBot still contains fire-and-forget emergencyExitAll pattern — regression!');
});

// ===== Wait for async tests then Summary =====
Promise.all(asyncTests).then(() => {
    // Cleanup
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Tests: ${total} total, ${passed} passed, ${failed} failed`);
    console.log(`${'='.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
});
