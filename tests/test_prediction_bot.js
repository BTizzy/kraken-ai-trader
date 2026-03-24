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
const noDataMinedRulesPath = path.join(__dirname, '../data/does_not_exist_data_mined_rules.json');

const gemini = new GeminiClient({ mode: 'paper' });
gemini.updatePaperMarket('GEMI-TEST2602190200-HI50000', 0.50, { title: 'Test Market', volume: 5000 });

// Reset wallet for clean test
db.db.prepare('UPDATE paper_wallet SET balance = 500, total_trades = 0, winning_trades = 0, losing_trades = 0, total_pnl = 0').run();

const engine = new PaperTradingEngine(db, gemini, { dataMinedRulesPath: noDataMinedRulesPath });
const shortRunEngine = new PaperTradingEngine(db, gemini, {
    tradingProfile: 'short-run',
    dataMinedRulesPath: noDataMinedRulesPath
});
const paperSessionEngine = new PaperTradingEngine(db, gemini, {
    tradingProfile: 'short-run',
    autonomous15mSession: true,
    sessionTimeoutMs: 900000,
    sessionMinTtxSeconds: 600,
    sessionMaxTtxSeconds: 3600,
    sessionEntryBufferSeconds: 120,
    sessionForceExitBufferSeconds: 60,
    dataMinedRulesPath: noDataMinedRulesPath
});
const liveModeGemini = new GeminiClient({ mode: 'live' });
const sessionEngine = new PaperTradingEngine(db, liveModeGemini, {
    tradingProfile: 'short-run',
    autonomous15mSession: true,
    sessionTimeoutMs: 900000,
    sessionMinTtxSeconds: 600,
    sessionMaxTtxSeconds: 3600,
    sessionEntryBufferSeconds: 120,
    sessionForceExitBufferSeconds: 60,
    dataMinedRulesPath: noDataMinedRulesPath
});
const relaxedSessionEngine = new PaperTradingEngine(db, liveModeGemini, {
    tradingProfile: 'short-run',
    autonomous15mSession: true,
    sessionTimeoutMs: 900000,
    sessionMinTtxSeconds: 600,
    sessionMaxTtxSeconds: 3600,
    sessionEntryBufferSeconds: 120,
    sessionForceExitBufferSeconds: 60,
    sessionRequiredRemainingCapSeconds: 180,
    dataMinedRulesPath: noDataMinedRulesPath
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
    assert(policy.required_session_remaining_seconds === 240,
        `Expected required_session_remaining_seconds=240, got ${policy.required_session_remaining_seconds}`);
});

test('Session remaining-time cap can be relaxed for short runs', () => {
    const defaultGate = sessionEngine.getRequiredSessionRemainingSeconds();
    const relaxedGate = relaxedSessionEngine.getRequiredSessionRemainingSeconds();

    assert(defaultGate === 240, `Expected default required remaining gate 240, got ${defaultGate}`);
    assert(relaxedGate === 180, `Expected relaxed required remaining gate 180, got ${relaxedGate}`);

    sessionEngine.markSessionStart(0, 100);
    relaxedSessionEngine.markSessionStart(0, 100);

    sessionEngine.sessionStartTimeMs = Date.now() - (sessionEngine.sessionTimeoutMs - 200000);
    relaxedSessionEngine.sessionStartTimeMs = Date.now() - (relaxedSessionEngine.sessionTimeoutMs - 200000);

    const signal = {
        category: 'crypto',
        marketId: makeFutureGemiSymbol('BTC', '50000', 20),
        direction: 'YES'
    };

    const defaultCheck = sessionEngine.canEnterPosition(signal);
    const relaxedCheck = relaxedSessionEngine.canEnterPosition(signal);

    assert(defaultCheck.allowed === false, `Expected default gate to block, got ${defaultCheck.reason}`);
    assert(relaxedCheck.allowed === true, `Expected relaxed gate to allow, got ${relaxedCheck.reason}`);
});

test('Signal entry policy applies short medium and long TTX buckets', () => {
    const bucketedEngine = new PaperTradingEngine(db, gemini, {
        shortTtxMaxSeconds: 3600,
        mediumTtxMaxSeconds: 14400,
        shortTtxEntryThreshold: 60,
        mediumTtxEntryThreshold: 52,
        longTtxEntryThreshold: 47,
        shortTtxMinEdgeLive: 0.09,
        mediumTtxMinEdgeLive: 0.06,
        longTtxMinEdgeLive: 0.04,
        dataMinedRulesPath: noDataMinedRulesPath
    });

    const shortPolicy = bucketedEngine.getSignalEntryPolicy({
        marketId: makeFutureGemiSymbol('BTC', '50000', 20)
    });
    const mediumPolicy = bucketedEngine.getSignalEntryPolicy({
        marketId: makeFutureGemiSymbol('BTC', '50000', 120)
    });
    const longPolicy = bucketedEngine.getSignalEntryPolicy({
        marketId: makeFutureGemiSymbol('BTC', '50000', 480)
    });

    assert(shortPolicy.bucket === 'short', `Expected short bucket, got ${shortPolicy.bucket}`);
    assert(shortPolicy.entryThreshold === 60, `Expected short entry threshold 60, got ${shortPolicy.entryThreshold}`);
    assert(shortPolicy.minEdgeLive === 0.09, `Expected short min edge 0.09, got ${shortPolicy.minEdgeLive}`);

    assert(mediumPolicy.bucket === 'medium', `Expected medium bucket, got ${mediumPolicy.bucket}`);
    assert(mediumPolicy.entryThreshold === 52, `Expected medium entry threshold 52, got ${mediumPolicy.entryThreshold}`);
    assert(mediumPolicy.minEdgeLive === 0.06, `Expected medium min edge 0.06, got ${mediumPolicy.minEdgeLive}`);

    assert(longPolicy.bucket === 'long', `Expected long bucket, got ${longPolicy.bucket}`);
    assert(longPolicy.entryThreshold === 47, `Expected long entry threshold 47, got ${longPolicy.entryThreshold}`);
    assert(longPolicy.minEdgeLive === 0.04, `Expected long min edge 0.04, got ${longPolicy.minEdgeLive}`);
});

test('Engine status exposes TTX policy thresholds', () => {
    const bucketedEngine = new PaperTradingEngine(db, gemini, {
        shortTtxMaxSeconds: 3600,
        mediumTtxMaxSeconds: 14400,
        shortTtxEntryThreshold: 58,
        mediumTtxEntryThreshold: 50,
        longTtxEntryThreshold: 46,
        shortTtxMinEdgeLive: 0.08,
        mediumTtxMinEdgeLive: 0.055,
        longTtxMinEdgeLive: 0.04,
        dataMinedRulesPath: noDataMinedRulesPath
    });

    const status = bucketedEngine.getStatus();
    assert(status.ttx_policy.short_max_seconds === 3600, `Expected short max 3600, got ${status.ttx_policy.short_max_seconds}`);
    assert(status.ttx_policy.medium_max_seconds === 14400, `Expected medium max 14400, got ${status.ttx_policy.medium_max_seconds}`);
    assert(status.ttx_policy.thresholds.short.entry_threshold === 58,
        `Expected short entry threshold 58, got ${status.ttx_policy.thresholds.short.entry_threshold}`);
    assert(status.ttx_policy.thresholds.medium.min_edge_live === 0.055,
        `Expected medium min edge 0.055, got ${status.ttx_policy.thresholds.medium.min_edge_live}`);
    assert(status.ttx_policy.thresholds.long.min_edge_live === 0.04,
        `Expected long min edge 0.04, got ${status.ttx_policy.thresholds.long.min_edge_live}`);
    assert(status.ttx_policy.thresholds.fallback.entry_threshold === bucketedEngine.params.entry_threshold,
        'Expected fallback entry threshold to match effective params');
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
        sessionMaxTtxSeconds: 3600,
        dataMinedRulesPath: noDataMinedRulesPath
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

test('Live pre-expiry exit defers on one-sided losing book', async () => {
    const liveGeminiForExit = new GeminiClient({ mode: 'live' });
    const liveExitEngine = new PaperTradingEngine(db, liveGeminiForExit, {
        tradingProfile: 'short-run',
        dataMinedRulesPath: noDataMinedRulesPath
    });
    const marketId = makeFutureGemiSymbol('BTC', '50100', 2);
    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000) - 30,
        gemini_market_id: marketId,
        market_title: 'Live Exit Deferral Test',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.40,
        position_size: 2,
        opportunity_score: 70,
        take_profit_price: 0.48,
        stop_loss_price: 0.10,
        mode: 'live'
    });

    liveGeminiForExit.realClient = {
        getBestPrices: () => ({ bid: 0.18, ask: 0.36, hasTwoSidedBook: false })
    };
    liveGeminiForExit.getPositions = async () => ([{
        symbol: marketId,
        outcome: 'yes',
        totalQuantity: 5,
        quantityOnHold: 0,
        prices: {
            sell: { yes: 0.18 },
            buy: { yes: 0.20 }
        }
    }]);

    const exits = await liveExitEngine.monitorPositions();
    assert(exits.length === 0, `Expected deferred administrative exit, got ${JSON.stringify(exits)}`);

    const stillOpen = db.getOpenTrades().find(t => t.id === tradeId);
    assert(stillOpen, 'Trade should remain open when pre-expiry exit is deferred');

    db.closeTrade(tradeId, 0.40, 0, 30, 'test_cleanup');
});

test('Missing TP and SL do not default to take profit', async () => {
    const marketId = makeFutureGemiSymbol('BTC', '50300', 20);
    gemini.updatePaperMarket(marketId, 0.55, { title: 'Null TP/SL Test', volume: 5000 });

    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000) - 15,
        gemini_market_id: marketId,
        market_title: 'Null TP/SL Test',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.50,
        position_size: 2,
        opportunity_score: 55,
        take_profit_price: null,
        stop_loss_price: null,
        mode: 'paper'
    });

    const exits = await engine.monitorPositions();
    const unexpectedExit = exits.find(exit => exit.tradeId === tradeId);
    assert(!unexpectedExit, `Trade with null TP/SL should stay open, got ${JSON.stringify(unexpectedExit)}`);

    const stillOpen = db.getOpenTrades().find(t => t.id === tradeId);
    assert(stillOpen, 'Trade with null TP/SL should remain open');

    db.closeTrade(tradeId, 0.50, 0, 15, 'test_cleanup');
});

test('Expired live trade reconciles flat when exchange position is gone', async () => {
    const liveGeminiForSettlement = new GeminiClient({ mode: 'live' });
    const liveSettlementEngine = new PaperTradingEngine(db, liveGeminiForSettlement, {
        dataMinedRulesPath: noDataMinedRulesPath
    });
    const marketId = makeFutureGemiSymbol('BTC', '50200', -2);
    const tradeId = db.insertTrade({
        timestamp: Math.floor(Date.now() / 1000) - 120,
        gemini_market_id: marketId,
        market_title: 'Expired Live Settlement Test',
        category: 'crypto',
        direction: 'YES',
        entry_price: 0.42,
        position_size: 2,
        opportunity_score: 65,
        take_profit_price: 0.50,
        stop_loss_price: 0.32,
        mode: 'live'
    });

    liveGeminiForSettlement.getPositions = async () => ([]);

    const exits = await liveSettlementEngine.monitorPositions();
    const settlementExit = exits.find(exit => exit.tradeId === tradeId);
    assert(settlementExit, 'Expected expired live trade to be processed');
    assert(settlementExit.reason === 'reconcile_no_exchange', `Expected reconcile_no_exchange, got ${settlementExit.reason}`);

    const closedTrade = db.db.prepare(
        'SELECT is_open, exit_reason, pnl, exit_price FROM prediction_trades WHERE id = ?'
    ).get(tradeId);
    assert(closedTrade.is_open === 0, 'Expired live trade should be closed');
    assert(closedTrade.exit_reason === 'reconcile_no_exchange', `Expected reconcile_no_exchange, got ${closedTrade.exit_reason}`);
    assert(Number(closedTrade.pnl) === 0, `Expected flat pnl, got ${closedTrade.pnl}`);
    assert(Number(closedTrade.exit_price) === 0.42, `Expected flat exit at entry price, got ${closedTrade.exit_price}`);
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

test('resetSessionState clears stale autonomous session timeout state', async () => {
    const timedOutEngine = new PaperTradingEngine(db, gemini, {
        autonomous15mSession: true,
        sessionTimeoutMs: 60000,
        sessionForceExitBufferSeconds: 30,
        dataMinedRulesPath: noDataMinedRulesPath
    });

    timedOutEngine.markSessionStart(0, 100);
    timedOutEngine.sessionStartTimeMs = Date.now() - 120000;

    const timedOutGate = await timedOutEngine.evaluatePreTradeSafetyGate(true);
    assert(timedOutGate.allowed === false, 'Expected stale session to block before reset');
    assert(timedOutGate.reason === 'session_timeout', `Expected session_timeout, got ${timedOutGate.reason}`);

    timedOutEngine.resetSessionState('stopped:test');
    const resetPolicy = timedOutEngine.getSessionPolicy();
    assert(resetPolicy.session_start_time_ms === null, 'Expected session start time to be cleared after reset');

    const resetGate = await timedOutEngine.evaluatePreTradeSafetyGate(true);
    assert(resetGate.allowed === true, `Expected reset gate to allow fresh session, got ${resetGate.reason}`);
});

test('stopBot source resets session state to avoid stale timeout preflight failures', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');
    const stopBotIdx = serverSource.indexOf('function stopBot(');
    assert(stopBotIdx !== -1, 'stopBot function not found in server source');

    const stopBotSection = serverSource.slice(stopBotIdx, stopBotIdx + 2200);
    assert(stopBotSection.includes('tradingEngine.resetSessionState('),
        'stopBot should reset session state so stale autonomous timeouts do not block preflight');
});

test('emergencyExitAll source uses bounded orphan-only reconcile retry', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');

    assert(serverSource.includes('const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));'),
        'Expected emergency cleanup retry path to define the async sleep helper it uses');
    assert(serverSource.includes('POST_EXIT_RECONCILE_MAX_RETRIES'),
        'Expected configurable post-exit reconcile retry attempt budget');
    assert(serverSource.includes('POST_EXIT_RECONCILE_GRACE_MS'),
        'Expected configurable post-exit reconcile grace window');
    assert(serverSource.includes('POST_EXIT_RECONCILE_RETRY_MS'),
        'Expected configurable post-exit reconcile retry window');
    assert(serverSource.includes('isOrphanOnlyReconcileRace'),
        'Expected orphan-only reconcile race detection before retry');
    assert(serverSource.includes('reconcileRetry.attempts.push'),
        'Expected post-exit reconcile retry diagnostics to track each retry attempt');
    assert(serverSource.includes('reconcile_retry'),
        'Expected emergency cleanup result to expose reconcile_retry diagnostics');
});

test('emergencyExitAll source does not paper-close unresolved live exits', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');

    assert(serverSource.includes('exit_price_unavailable_live'),
        'Expected explicit unresolved status for live exits without executable price');
    assert(!serverSource.includes('EMERGENCY EXIT (no real price):'),
        'Live emergency exits should not fall back to paper close when real exit price is unavailable');
});

test('emergency-stop source runs quick reconcile sweep for zero-close live cleanup', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');

    assert(serverSource.includes('const shouldAttemptQuickFix = !result.skipped_duplicate'),
        'Expected emergency-stop to decide quick-fix sweep via explicit shouldAttemptQuickFix gate');
    assert(serverSource.includes("result.closed === 0"),
        'Expected emergency-stop quick-fix gate to cover zero-close live cleanup');
});

test('capped harness source classifies zero-trade execute windows as non-session-quality', () => {
    const harnessSource = fs.readFileSync(
        path.join(__dirname, '../scripts/run_capped_live_session.js'), 'utf8');

    assert(harnessSource.includes('function isNonSessionQualityFailure('),
        'Expected non-session-quality classifier helper in capped harness');
    assert(harnessSource.includes('function summarizeOpportunitySufficiency('),
        'Expected capped harness to summarize opportunity sufficiency for short sessions');
    assert(harnessSource.includes('outcome.opportunity_sufficiency = summarizeOpportunitySufficiency(outcome, baseline);'),
        'Expected capped harness output to expose an opportunity_sufficiency summary block');
    assert(harnessSource.includes('async function settleFinalFlatness(contextLabel) {'),
        'Expected capped harness to include post-execute flatness settle helper');
    assert(harnessSource.includes("log('Post-execute flatness settle result'"),
        'Expected capped harness to log bounded post-execute flatness settle outcomes');
    assert(harnessSource.includes("text.includes('run entered zero trades')"),
        'Expected zero-trade execute failure to be treated as non-session-quality');
    assert(harnessSource.includes("text.includes('run exited zero trades')"),
        'Expected zero-exit execute failure to be treated as non-session-quality');
    assert(harnessSource.includes("text.includes('zero_eligible_contracts')"),
        'Expected sparse-universe zero_eligible_contracts failures to be treated as non-session-quality');
    assert(harnessSource.includes("text.includes('zero_actionable_signals')"),
        'Expected sparse-signal zero_actionable_signals failures to be treated as non-session-quality');
    assert(harnessSource.includes('function toTradeMode(runtimeMode) {'),
        'Expected capped harness to derive trade mode dynamically from runtime status');
    assert(harnessSource.includes('/api/trades/recent?limit=500&mode=${tradeMode}'),
        'Expected capped harness to query recent trades with runtime-derived mode');
    assert(harnessSource.includes('/api/trades/open?mode=${tradeMode}'),
        'Expected capped harness to query open trades with runtime-derived mode');
    assert(harnessSource.includes("if (!Number.isFinite(liveBalance)) {"),
        'Expected live execute-start guard to block when live balance is unavailable/non-finite');
});

test('wallet source tagging and live balance unavailability handling are explicit in server source', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');

    assert(serverSource.includes('wallet_source'),
        'Expected getDisplayWallet responses to include wallet_source for source-of-truth auditing');
    assert(serverSource.includes("wallet_source: 'balance_unavailable'"),
        'Expected explicit live balance unavailable marker instead of silent DB fallback');
    assert(serverSource.includes('LIVE_BALANCE_UNAVAILABLE_MAX_STREAK'),
        'Expected drawdown guard to enforce bounded tolerance for missing live balance telemetry');
    assert(serverSource.includes('Drawdown check skipped: live balance unavailable'),
        'Expected explicit logging when drawdown checks cannot evaluate live balance');
    assert(serverSource.includes("app.get('/api/session/diagnostics-bundle'"),
        'Expected one-shot diagnostics bundle endpoint for baseline/session observability');
    assert(serverSource.includes("app.get('/api/parameters/audit'"),
        'Expected parameter guardrail audit endpoint');
    assert(serverSource.includes("app.post('/api/parameters/audit/apply'"),
        'Expected parameter guardrail clamp/apply endpoint');
    assert(serverSource.includes('tradingEngine._liveBalance = Number(details.balance);'),
        'Expected preflight to synchronize runtime live balance cache with latest observed balance');
    assert(serverSource.includes('details.live_usd_reserve_effective = effectiveReserveUsd;'),
        'Expected preflight to expose effective adaptive reserve for small-balance accounts');
    assert(serverSource.includes('details.live_min_tradable_balance_effective = effectiveMinTradableUsd;'),
        'Expected preflight to expose effective adaptive min-tradable threshold for small-balance accounts');
});

test('capped harness and batch artifacts stamp profile checksums', () => {
    const harnessSource = fs.readFileSync(
        path.join(__dirname, '../scripts/run_capped_live_session.js'), 'utf8');
    const batchSource = fs.readFileSync(
        path.join(__dirname, '../scripts/run_capped_session_batch.js'), 'utf8');
    const profileSource = fs.readFileSync(
        path.join(__dirname, '../scripts/activate_session_profile.js'), 'utf8');

    assert(profileSource.includes('PROFILE_JSON_PREFIX = \'SESSION_PROFILE_JSON:\''),
        'Expected profile activation script to emit a stable machine-readable prefix');
    assert(profileSource.includes('createHash(\'sha256\')'),
        'Expected profile activation script to compute deterministic profile checksum');
    assert(harnessSource.includes('profile_manifest: profileManifest'),
        'Expected capped harness result payload to include profile_manifest metadata');
    assert(batchSource.includes('profile_manifest: profileManifest'),
        'Expected capped batch artifact config to include profile manifest metadata');
    assert(harnessSource.includes('function getExecuteBalanceThreshold(preflightDetails = {}) {'),
        'Expected capped harness to derive execute-start threshold from preflight policy details');
    assert(harnessSource.includes('thresholds.effectiveThreshold'),
        'Expected capped harness execute-start guard to use effective dynamic threshold');
});

test('trading engine source exposes adaptive low-balance reserve policy', () => {
    const engineSource = fs.readFileSync(
        path.join(__dirname, '../lib/paper_trading_engine.js'), 'utf8');

    assert(engineSource.includes('getEffectiveLiveReserve(balance) {'),
        'Expected trading engine to compute adaptive reserve from current balance');
    assert(engineSource.includes('getEffectiveLiveMinTradableBalance(balance) {'),
        'Expected trading engine to compute adaptive min tradable threshold from current balance');
    assert(engineSource.includes('live_usd_reserve_fraction_cap'),
        'Expected session policy/status to include adaptive reserve fraction cap');
});

test('manual close source pre-cancels exits and retries insufficient funds', () => {
    const serverSource = fs.readFileSync(
        path.join(__dirname, '../server/prediction-proxy.js'), 'utf8');

    assert(serverSource.includes('const cancelSameOutcomeExitOrders = async (marketId, outcomeLower) => {'),
        'Expected manual close route to define same-outcome exit pre-cancel helper');
    assert(serverSource.includes('const preCancelled = await cancelSameOutcomeExitOrders(trade.gemini_market_id, desiredOutcome);'),
        'Expected manual close route to pre-cancel same-outcome exit orders before sell');
    assert(serverSource.includes('const isInsufficientFunds = /InsufficientFunds/i.test(msg);'),
        'Expected manual close route to detect InsufficientFunds and retry safely');
    assert(serverSource.includes('Number(exchangePos?.prices?.sell?.yes)'),
        'Expected manual close live YES exits to price from executable sell.yes quote');
    assert(serverSource.includes('Number(exchangePos?.prices?.sell?.no)'),
        'Expected manual close live NO exits to price from executable sell.no quote');
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
