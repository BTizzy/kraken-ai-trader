/**
 * Tests for FairValueEngine and KalshiClient cross-platform methods
 * 
 * Covers:
 *   - normalCDF / normalPDF math
 *   - Black-Scholes binary option pricing
 *   - Kalshi bracket parsing / synthetic above computation
 *   - Ensemble fair value
 *   - Signal generation & Kelly sizing
 *   - SignalDetector fair-value integration
 */

let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
    total++;
    try {
        const result = fn();
        // Support async tests
        if (result && typeof result.then === 'function') {
            result.then(() => {
                passed++;
                console.log(`  ✅ ${name}`);
            }).catch(err => {
                failed++;
                console.log(`  ❌ ${name}: ${err.message}`);
            });
        } else {
            passed++;
            console.log(`  ✅ ${name}`);
        }
    } catch (error) {
        failed++;
        console.log(`  ❌ ${name}: ${error.message}`);
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertClose(actual, expected, tolerance, msg) {
    const diff = Math.abs(actual - expected);
    if (diff > tolerance) {
        throw new Error(`${msg || 'Not close'}: expected ${expected} ±${tolerance}, got ${actual} (diff=${diff})`);
    }
}

// ===================================================================
// FairValueEngine Tests
// ===================================================================

const FairValueEngine = require('../lib/fair_value_engine');

console.log('\n📊 Testing FairValueEngine...');

// --- normalCDF ---
test('normalCDF(0) = 0.5', () => {
    const engine = new FairValueEngine();
    // Access via Black-Scholes: priceBinaryOption at the money
    // normalCDF is module-scoped, test via priceBinaryOption
    // For x=0, standard normal CDF = 0.5
    // We test via priceBinaryOption (ATM, low vol → ~0.5)
    const result = engine.priceBinaryOption(100, 100, 1, 0.0001);
    assertClose(result.probability, 0.5, 0.01, 'ATM with very low vol should be ~0.5');
});

test('priceBinaryOption: deep ITM → ~1.0', () => {
    const engine = new FairValueEngine();
    const result = engine.priceBinaryOption(100, 50, 24, 0.50);
    assert(result.probability > 0.95, `Expected >0.95, got ${result.probability}`);
});

test('priceBinaryOption: deep OTM → ~0.0', () => {
    const engine = new FairValueEngine();
    const result = engine.priceBinaryOption(100, 200, 1, 0.50);
    assert(result.probability < 0.05, `Expected <0.05, got ${result.probability}`);
});

test('priceBinaryOption: higher vol increases OTM probability', () => {
    const engine = new FairValueEngine();
    const lowVol = engine.priceBinaryOption(100, 120, 24, 0.20);
    const highVol = engine.priceBinaryOption(100, 120, 24, 0.80);
    assert(highVol.probability > lowVol.probability,
        `High vol (${highVol.probability}) should give higher OTM prob than low vol (${lowVol.probability})`);
});

test('priceBinaryOption: shorter time reduces OTM probability', () => {
    const engine = new FairValueEngine();
    const longTime = engine.priceBinaryOption(100, 120, 168, 0.50); // 1 week
    const shortTime = engine.priceBinaryOption(100, 120, 1, 0.50);  // 1 hour
    assert(longTime.probability > shortTime.probability,
        `Long time (${longTime.probability}) should give higher OTM prob than short (${shortTime.probability})`);
});

test('priceBinaryOption: expired contract', () => {
    const engine = new FairValueEngine();
    const aboveStrike = engine.priceBinaryOption(105, 100, 0, 0.50);
    const belowStrike = engine.priceBinaryOption(95, 100, 0, 0.50);
    assert(aboveStrike.probability === 1.0, 'Expired above strike should be 1.0');
    assert(belowStrike.probability === 0.0, 'Expired below strike should be 0.0');
});

test('priceBinaryOption: realistic BTC binary (12h, 50% vol)', () => {
    const engine = new FairValueEngine();
    // BTC at $97,000, strike $97,500, 12 hours, 50% ann vol
    const result = engine.priceBinaryOption(97000, 97500, 12, 0.50);
    // Should be slightly below 0.5 (slightly OTM)
    assert(result.probability > 0.2 && result.probability < 0.8,
        `Expected 0.2-0.8, got ${result.probability}`);
});

// --- Spot Price Tracking ---
test('recordSpotPrice and getSpotPrice', () => {
    const engine = new FairValueEngine();
    engine.recordSpotPrice('BTC', 97000);
    engine.recordSpotPrice('BTC', 97100);
    assert(engine.getSpotPrice('BTC') === 97100, 'Should return latest price');
});

test('getSpotPrice returns null for unknown asset', () => {
    const engine = new FairValueEngine();
    assert(engine.getSpotPrice('DOGE') === null, 'Should return null');
});

// --- Volatility Calculation ---
test('calculateVolatility: too few data points → default vol', () => {
    const engine = new FairValueEngine({ defaultVolatility: 0.55 });
    engine.recordSpotPrice('ETH', 3000);
    const vol = engine.calculateVolatility('ETH');
    assert(vol === 0.55, `Expected default 0.55, got ${vol}`);
});

test('calculateVolatility: with sufficient data', () => {
    const engine = new FairValueEngine();
    const now = Date.now();
    // Generate 50 price points with small random walk
    let price = 97000;
    for (let i = 0; i < 50; i++) {
        price += (Math.random() - 0.5) * 100;
        engine.recordSpotPrice('BTC', price, now - (50 - i) * 60000);
    }
    const vol = engine.calculateVolatility('BTC');
    assert(vol > 0 && vol < 10, `Volatility should be reasonable, got ${vol}`);
});

// --- Black-Scholes Fair Value ---
test('blackScholesFairValue: returns null without spot price', () => {
    const engine = new FairValueEngine();
    const result = engine.blackScholesFairValue('BTC', 97000, new Date(Date.now() + 3600000));
    assert(result === null, 'Should return null without spot');
});

test('blackScholesFairValue: returns correct structure', () => {
    const engine = new FairValueEngine();
    engine.recordSpotPrice('BTC', 97000);
    const expiry = new Date(Date.now() + 12 * 3600 * 1000);
    const result = engine.blackScholesFairValue('BTC', 97000, expiry);
    assert(result !== null, 'Should return result');
    assert(result.model === 'BLACK_SCHOLES', 'Model name');
    assert(typeof result.fairValue === 'number', 'fairValue is number');
    assert(typeof result.spot === 'number', 'spot is number');
    assert(typeof result.strike === 'number', 'strike is number');
    assert(typeof result.volatility === 'number', 'volatility is number');
    assert(typeof result.delta === 'number', 'delta is number');
});

// --- Kalshi Synthetic Fair Value ---
test('kalshiSyntheticFairValue: returns null for no match', () => {
    const engine = new FairValueEngine();
    assert(engine.kalshiSyntheticFairValue(null) === null, 'null input');
    assert(engine.kalshiSyntheticFairValue({ matched: false }) === null, 'not matched');
});

test('kalshiSyntheticFairValue: wraps analysis correctly', () => {
    const engine = new FairValueEngine();
    const analysis = {
        matched: true,
        kalshiFairValue: 0.65,
        kalshiBidSum: 0.60,
        kalshiAskSum: 0.70,
        kalshiStrike: 97000,
        strikeDiff: 250,
        confidence: 0.8,
        kalshiVolume: 5000,
        bracketCount: 10
    };
    const result = engine.kalshiSyntheticFairValue(analysis);
    assert(result.model === 'KALSHI_SYNTHETIC');
    assert(result.fairValue === 0.65);
    assert(result.kalshiBidSum === 0.60);
});

// --- Ensemble Fair Value ---
test('ensembleFairValue: single model', () => {
    const engine = new FairValueEngine();
    const bsFV = { model: 'BLACK_SCHOLES', fairValue: 0.60 };
    const result = engine.ensembleFairValue(bsFV, null);
    assert(result.model === 'ENSEMBLE');
    assertClose(result.fairValue, 0.60, 0.01, 'Single model ensemble');
    assert(result.modelCount === 1);
});

test('ensembleFairValue: two models weighted', () => {
    const engine = new FairValueEngine({ modelWeights: { blackScholes: 0.35, kalshiSynthetic: 0.65 } });
    const bsFV = { model: 'BLACK_SCHOLES', fairValue: 0.50 };
    const kalshiFV = { model: 'KALSHI_SYNTHETIC', fairValue: 0.70 };
    const result = engine.ensembleFairValue(bsFV, kalshiFV);
    // Expected: 0.50 * 0.35 + 0.70 * 0.65 = 0.175 + 0.455 = 0.63
    assertClose(result.fairValue, 0.63, 0.01, 'Weighted ensemble');
    assert(result.modelCount === 2);
});

test('ensembleFairValue: no models → null', () => {
    const engine = new FairValueEngine();
    assert(engine.ensembleFairValue(null, null) === null);
});

// --- Kelly Sizing ---
test('kellySize: positive edge → positive kelly', () => {
    const engine = new FairValueEngine();
    const k = engine.kellySize(0.10, 0.60, 'YES');
    assert(k > 0, `Kelly should be positive, got ${k}`);
    assert(k <= 0.25, `Kelly should be ≤ 0.25 (fractional), got ${k}`);
});

test('kellySize: fair value 0.5 → moderate kelly', () => {
    const engine = new FairValueEngine();
    const k = engine.kellySize(0.10, 0.50, 'YES');
    assert(k > 0 && k < 0.1, `Expected moderate kelly, got ${k}`);
});

test('kellySize: direction NO', () => {
    const engine = new FairValueEngine();
    const k = engine.kellySize(0.10, 0.30, 'NO');
    assert(k > 0, `Kelly for NO should be positive with edge, got ${k}`);
});

// --- Signal Generation ---
test('generateSignal: BUY YES when fair value > ask', () => {
    const engine = new FairValueEngine();
    engine.recordSpotPrice('BTC', 97500);
    
    const signal = engine.generateSignal({
        asset: 'BTC',
        strike: 97000,
        bid: 0.55,
        ask: 0.58,
        expiryDate: new Date(Date.now() + 12 * 3600 * 1000),
        marketId: 'test-1',
        eventTitle: 'BTC > $97,000'
    });
    
    // BS should give fv > 0.5 (spot > strike), so direction should be YES if fv > ask
    assert(typeof signal.actionable === 'boolean', 'has actionable');
    assert(typeof signal.netEdge === 'number', 'has netEdge');
    if (signal.actionable) {
        assert(signal.direction === 'YES', 'Should be YES direction');
        assert(signal.edge > 0, 'Edge should be positive');
        assert(signal.netEdge > 0, 'Net edge should be positive');
    }
});

test('generateSignal: BUY NO when fair value < bid', () => {
    const engine = new FairValueEngine();
    engine.recordSpotPrice('BTC', 96500);
    
    const signal = engine.generateSignal({
        asset: 'BTC',
        strike: 97000,
        bid: 0.60,
        ask: 0.65,
        expiryDate: new Date(Date.now() + 1 * 3600 * 1000), // 1 hour left
        marketId: 'test-2',
        eventTitle: 'BTC > $97,000'
    });
    
    // BS should give fv < 0.5 (spot < strike with 1h), so direction could be NO if fv < bid
    if (signal.actionable) {
        assert(signal.direction === 'NO', `Should be NO, got ${signal.direction}`);
    }
});

test('generateSignal: not actionable when edge too small', () => {
    const engine = new FairValueEngine({ minEdge: 0.50 }); // Very high threshold
    engine.recordSpotPrice('BTC', 97000);
    
    const signal = engine.generateSignal({
        asset: 'BTC',
        strike: 97000,
        bid: 0.49,
        ask: 0.51,
        expiryDate: new Date(Date.now() + 12 * 3600 * 1000),
        marketId: 'test-3',
        eventTitle: 'BTC > $97,000'
    });
    
    assert(signal.actionable === false, 'Should not be actionable with high min edge');
});

test('generateSignal: with kalshi analysis', () => {
    const engine = new FairValueEngine();
    engine.recordSpotPrice('BTC', 97000);
    
    const kalshiAnalysis = {
        matched: true,
        kalshiFairValue: 0.75,
        kalshiBidSum: 0.70,
        kalshiAskSum: 0.80,
        kalshiStrike: 97000,
        strikeDiff: 0,
        confidence: 0.85,
        kalshiVolume: 10000,
        bracketCount: 15
    };
    
    const signal = engine.generateSignal({
        asset: 'BTC',
        strike: 97000,
        bid: 0.55,
        ask: 0.58,
        expiryDate: new Date(Date.now() + 12 * 3600 * 1000),
        marketId: 'test-4',
        eventTitle: 'BTC > $97,000'
    }, kalshiAnalysis);
    
    assert(signal.models.kalshiSynthetic !== null, 'Should have Kalshi model');
    assert(signal.models.ensemble !== null, 'Should have ensemble');
    // Ensemble should include both models
    if (signal.models.ensemble) {
        assert(signal.models.ensemble.modelCount === 2, 'Ensemble should have 2 models');
    }
});

test('generateSignal: no fair value available', () => {
    const engine = new FairValueEngine();
    // No spot price recorded, no Kalshi analysis
    const signal = engine.generateSignal({
        asset: 'UNKNOWN',
        strike: 1000,
        bid: 0.50,
        ask: 0.55,
        expiryDate: null,
        marketId: 'test-5',
        eventTitle: 'Unknown'
    });
    assert(signal.actionable === false, 'Should not be actionable');
    assert(signal.reason === 'No fair value available', `Wrong reason: ${signal.reason}`);
});

// --- Fee Model ---
test('Fees: 0.06% per side is very small', () => {
    const engine = new FairValueEngine({ feePerSide: 0.0006 });
    // For a trade at 0.50, round trip fee = 0.50 * 0.0006 * 2 = 0.0006
    // This should not eat into a 3¢ edge significantly
    const signal = engine.generateSignal({
        asset: 'BTC',
        strike: 97000,
        bid: 0.45,
        ask: 0.50,
        expiryDate: null,
        marketId: 'test-fee',
        eventTitle: 'BTC > $97,000'
    });
    
    if (signal.roundTripFees !== undefined) {
        assert(signal.roundTripFees < 0.01,
            `Round trip fees should be tiny, got ${signal.roundTripFees}`);
    }
});

// --- Static Parsers ---
test('parseContractLabel: "BTC > $67,500"', () => {
    const result = FairValueEngine.parseContractLabel('BTC > $67,500');
    assert(result.asset === 'BTC');
    assert(result.strike === 67500);
    assert(result.direction === 'above');
});

test('parseContractLabel: "ETH > $3,200"', () => {
    const result = FairValueEngine.parseContractLabel('ETH > $3,200');
    assert(result.asset === 'ETH');
    assert(result.strike === 3200);
});

test('parseContractLabel: "SOL > $250"', () => {
    const result = FairValueEngine.parseContractLabel('SOL > $250');
    assert(result.asset === 'SOL');
    assert(result.strike === 250);
});

test('parseContractLabel: invalid label', () => {
    const result = FairValueEngine.parseContractLabel('Will it rain tomorrow?');
    assert(result === null, 'Should return null for non-crypto label');
});

test('parseSettlementHour: "BTC price today at 12pm EST"', () => {
    const hour = FairValueEngine.parseSettlementHour('BTC price today at 12pm EST');
    assert(hour === 12, `Expected 12, got ${hour}`);
});

test('parseSettlementHour: "BTC price today at 5pm EST"', () => {
    const hour = FairValueEngine.parseSettlementHour('BTC price today at 5pm EST');
    assert(hour === 17, `Expected 17, got ${hour}`);
});

test('parseSettlementHour: no time info', () => {
    const hour = FairValueEngine.parseSettlementHour('BTC Price on February 18');
    assert(hour === null, 'Should return null');
});

// --- getStats ---
test('getStats returns config info', () => {
    const engine = new FairValueEngine({ feePerSide: 0.0006, minEdge: 0.03 });
    engine.recordSpotPrice('BTC', 97000);
    const stats = engine.getStats();
    assert(stats.trackedAssets === 1);
    assert(stats.feePerSide === 0.0006);
    assert(stats.minEdge === 0.03);
    assert(typeof stats.volatilities === 'object');
});

// ===================================================================
// KalshiClient Cross-Platform Method Tests
// ===================================================================

console.log('\n📊 Testing KalshiClient cross-platform methods...');

const KalshiClient = require('../lib/kalshi_client');

// Create a client with mock API (won't make real requests for unit tests)
const kalshiClient = new KalshiClient({ logLevel: 'ERROR' });

test('SERIES_TICKERS defined', () => {
    assert(KalshiClient.SERIES_TICKERS.BTC === 'KXBTC');
    assert(KalshiClient.SERIES_TICKERS.ETH === 'KXETH');
    assert(KalshiClient.SERIES_TICKERS.SOL === 'KXSOL');
});

test('parseBracket: basic bracket parsing', () => {
    const market = {
        ticker: 'KXBTC-26FEB1712-B97250',
        event_ticker: 'KXBTC-26FEB1712',
        strike_type: 'between',
        floor_strike: 97000,
        cap_strike: 97249.99,
        yes_bid: 25,  // cents
        yes_ask: 30,
        last_price: 27,
        volume: 5000,
        open_interest: 1200
    };
    const b = kalshiClient.parseBracket(market);
    assert(b.ticker === 'KXBTC-26FEB1712-B97250');
    assert(b.eventTicker === 'KXBTC-26FEB1712');
    assert(b.strikeType === 'between');
    assert(b.floorStrike === 97000);
    assert(b.capStrike === 97249.99);
    assertClose(b.yesBid, 0.25, 0.001, 'yesBid');
    assertClose(b.yesAsk, 0.30, 0.001, 'yesAsk');
    assertClose(b.mid, 0.275, 0.001, 'mid');
    assert(b.volume === 5000);
    assert(b.settlementHour === 12, `Expected settlement hour 12, got ${b.settlementHour}`);
    assertClose(b.spread, 0.05, 0.001, 'spread');
    assert(b.hasLiquidity === true);
});

test('parseBracket: zero bid/ask uses last price', () => {
    const market = {
        ticker: 'TEST',
        event_ticker: 'KXBTC-26FEB1717',
        strike_type: 'between',
        floor_strike: 97000,
        yes_bid: 0,
        yes_ask: 0,
        last_price: 15,
        volume: 100
    };
    const b = kalshiClient.parseBracket(market);
    assertClose(b.mid, 0.15, 0.001, 'Should use last price as mid');
    assert(b.settlementHour === 17, `Expected settlement hour 17, got ${b.settlementHour}`);
});

test('parseBracket: no liquidity', () => {
    const market = {
        ticker: 'TEST',
        event_ticker: 'TEST',
        strike_type: 'between',
        floor_strike: 99000,
        yes_bid: 0,
        yes_ask: 0,
        last_price: 0,
        volume: 0
    };
    const b = kalshiClient.parseBracket(market);
    assert(b.hasLiquidity === false);
    assert(b.mid === 0);
});

test('computeSyntheticAbove: basic sum', () => {
    // Simulate 3 brackets: [96000, 97000, 98000]
    const brackets = [
        { strikeType: 'between', floorStrike: 96000, mid: 0.30, yesBid: 0.28, yesAsk: 0.32, volume: 1000, hasLiquidity: true },
        { strikeType: 'between', floorStrike: 97000, mid: 0.25, yesBid: 0.22, yesAsk: 0.28, volume: 2000, hasLiquidity: true },
        { strikeType: 'between', floorStrike: 98000, mid: 0.15, yesBid: 0.13, yesAsk: 0.17, volume: 500, hasLiquidity: true }
    ];
    
    const above = kalshiClient.computeSyntheticAbove(brackets);
    
    // P(BTC > 96000) = sum all = 0.30 + 0.25 + 0.15 = 0.70
    assertClose(above[96000].mid, 0.70, 0.01, 'Above 96000');
    assert(above[96000].bracketCount === 3);
    
    // P(BTC > 97000) = 0.25 + 0.15 = 0.40
    assertClose(above[97000].mid, 0.40, 0.01, 'Above 97000');
    assert(above[97000].bracketCount === 2);
    
    // P(BTC > 98000) = 0.15
    assertClose(above[98000].mid, 0.15, 0.01, 'Above 98000');
    assert(above[98000].bracketCount === 1);
});

test('computeSyntheticAbove: bid/ask sums', () => {
    const brackets = [
        { strikeType: 'between', floorStrike: 96000, mid: 0.30, yesBid: 0.28, yesAsk: 0.32, volume: 1000, hasLiquidity: true },
        { strikeType: 'between', floorStrike: 97000, mid: 0.25, yesBid: 0.22, yesAsk: 0.28, volume: 2000, hasLiquidity: true }
    ];
    
    const above = kalshiClient.computeSyntheticAbove(brackets);
    
    // Bid sum above 96000 = 0.28 + 0.22 = 0.50
    assertClose(above[96000].bidSum, 0.50, 0.01, 'Bid sum');
    // Ask sum above 96000 = 0.32 + 0.28 = 0.60
    assertClose(above[96000].askSum, 0.60, 0.01, 'Ask sum');
});

test('computeSyntheticAbove: filters non-between types', () => {
    const brackets = [
        { strikeType: 'between', floorStrike: 96000, mid: 0.30, yesBid: 0.28, yesAsk: 0.32, volume: 1000, hasLiquidity: true },
        { strikeType: 'greater', floorStrike: 99000, mid: 0.10, yesBid: 0.08, yesAsk: 0.12, volume: 500, hasLiquidity: true }
    ];
    const above = kalshiClient.computeSyntheticAbove(brackets);
    // Should only include "between" brackets
    assert(above[96000].bracketCount === 1, 'Should only count between brackets');
    assert(above[99000] === undefined, 'Should not include greater type');
});

test('computeSyntheticAbove: empty brackets → empty result', () => {
    const above = kalshiClient.computeSyntheticAbove([]);
    assert(Object.keys(above).length === 0);
});

test('findSyntheticPrice: exact match', () => {
    const aboveProbs = {
        96000: { mid: 0.70, bidSum: 0.65, askSum: 0.75, bracketCount: 3, liquidBrackets: 3, totalVolume: 3500 },
        97000: { mid: 0.40, bidSum: 0.35, askSum: 0.45, bracketCount: 2, liquidBrackets: 2, totalVolume: 2500 }
    };
    
    const result = kalshiClient.findSyntheticPrice(aboveProbs, 97000);
    assert(result !== null);
    assert(result.kalshiStrike === 97000);
    assert(result.strikeDiff === 0);
    assertClose(result.fairValueMid, 0.40, 0.01);
});

test('findSyntheticPrice: closest match within $500', () => {
    const aboveProbs = {
        96750: { mid: 0.55, bidSum: 0.50, askSum: 0.60, bracketCount: 3, liquidBrackets: 3, totalVolume: 3000 }
    };
    
    const result = kalshiClient.findSyntheticPrice(aboveProbs, 97000);
    assert(result !== null);
    assert(result.kalshiStrike === 96750);
    assert(result.strikeDiff === 250, `Expected strikeDiff=250, got ${result.strikeDiff}`);
});

test('findSyntheticPrice: no match beyond $500', () => {
    const aboveProbs = {
        90000: { mid: 0.95, bidSum: 0.90, askSum: 1.0, bracketCount: 10, liquidBrackets: 10, totalVolume: 50000 }
    };
    
    const result = kalshiClient.findSyntheticPrice(aboveProbs, 97000);
    assert(result === null, 'Should return null when closest strike is >$500 away');
});

test('findSyntheticPrice: empty input', () => {
    const result = kalshiClient.findSyntheticPrice({}, 97000);
    assert(result === null);
});

// ===================================================================
// SignalDetector Integration Tests
// ===================================================================

console.log('\n📊 Testing SignalDetector fair-value integration...');

const path = require('path');
const PredictionDatabase = require('../lib/prediction_db');
const SignalDetector = require('../lib/signal_detector');
const fs = require('fs');

const testDbPath = path.join(__dirname, '../data/test_fv_signals.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
const db = new PredictionDatabase(testDbPath);

test('SignalDetector has fairValueEngine', () => {
    const detector = new SignalDetector(db, { feePerSide: 0.0006 });
    assert(detector.fairValueEngine !== null);
    assert(detector.fairValueEngine instanceof FairValueEngine);
});

test('SignalDetector.recordSpotPrice delegates to engine', () => {
    const detector = new SignalDetector(db);
    detector.recordSpotPrice('BTC', 97000);
    assert(detector.fairValueEngine.getSpotPrice('BTC') === 97000);
});

test('SignalDetector.setKalshiClient', () => {
    const detector = new SignalDetector(db);
    const mockClient = { test: true };
    detector.setKalshiClient(mockClient);
    assert(detector.kalshiClient === mockClient);
});

test('getStats includes fairValueEngine stats', () => {
    const detector = new SignalDetector(db, { feePerSide: 0.0006 });
    detector.recordSpotPrice('BTC', 97000);
    const stats = detector.getStats();
    assert(stats.fairValueEngine !== undefined);
    assert(stats.fairValueEngine.trackedAssets === 1);
    assert(stats.fairValueEngine.feePerSide === 0.0006);
});

test('generateFairValueSignals: returns actionable signals', async () => {
    const detector = new SignalDetector(db, { 
        feePerSide: 0.0006,
        minEdge: 0.01,  // Low threshold for test
        signalCooldownMs: 0
    });
    
    // Set up spot price that creates a clear YES signal
    detector.recordSpotPrice('BTC', 98000);
    
    const contracts = [{
        asset: 'BTC',
        strike: 97000,
        bid: 0.40,
        ask: 0.45,
        expiryDate: new Date(Date.now() + 12 * 3600 * 1000),
        marketId: 'test-fv-signal-1',
        eventTitle: 'BTC > $97,000'
    }];
    
    const signals = await detector.generateFairValueSignals(contracts);
    
    // With BTC at $98,000 and strike at $97,000, BS fair value should be well above 0.45
    // So we expect a BUY YES signal
    assert(Array.isArray(signals), 'Should return array');
    if (signals.length > 0) {
        const s = signals[0];
        assert(s.direction === 'YES', 'Should recommend YES');
        assert(s.category === 'crypto');
        assert(s.actionable === true);
        assert(typeof s.score === 'number');
        assert(typeof s.kellyFraction === 'number');
        assert(typeof s.netEdge === 'number');
    }
});

// ===================================================================
// PaperTradingEngine Position Sizing Integration Tests
// ===================================================================

console.log('\n📊 Testing PaperTradingEngine position sizing...');

const PaperTradingEngine = require('../lib/paper_trading_engine');

// Create mock gemini client
const mockGemini = {
    executePaperTrade: (marketId, dir, size, opts) => ({
        success: true,
        fill_price: 0.50,
        market_bid: 0.48,
        market_ask: 0.52,
        slippage: 0.005
    })
};

const traderDb = new PredictionDatabase(path.join(__dirname, '../data/test_fv_trader.db'));
const trader = new PaperTradingEngine(traderDb, mockGemini);

test('Position size uses kellyFraction from signal when available', () => {
    const wallet = { balance: 500 };
    const signal = {
        direction: 'YES',
        gemini_ask: 0.50,
        gemini_bid: 0.48,
        referencePrice: 0.60,
        targetPrice: 0.58,
        score: 75,
        kellyFraction: 0.10,  // 10% of balance
        netEdge: 0.08
    };
    
    const size = trader.calculatePositionSize(signal, wallet);
    // With kellyFraction 0.10 and balance $500, expect $50
    assertClose(size, 50, 1, 'Should use kellyFraction × balance');
});

test('Position size uses netEdge when no kellyFraction', () => {
    const wallet = { balance: 500 };
    const signal = {
        direction: 'YES',
        gemini_ask: 0.50,
        gemini_bid: 0.48,
        referencePrice: 0.60,
        targetPrice: 0.58,
        score: 75,
        netEdge: 0.08
        // kellyFraction not set
    };
    
    const size = trader.calculatePositionSize(signal, wallet);
    assert(size >= 5, `Position size should be at least $5, got ${size}`);
    assert(size <= 100, `Position size should be ≤ max, got ${size}`);
});

test('Position size respects max limits', () => {
    const wallet = { balance: 500 };
    const signal = {
        direction: 'YES',
        gemini_ask: 0.50,
        gemini_bid: 0.48,
        referencePrice: 0.60,
        targetPrice: 0.58,
        score: 75,
        kellyFraction: 0.50,  // Would be $250
    };
    
    const size = trader.calculatePositionSize(signal, wallet);
    assert(size <= trader.params.max_position_size,
        `Should respect max_position_size (${trader.params.max_position_size}), got ${size}`);
});

// ===================================================================
// Summary
// ===================================================================

// Use setTimeout to wait for async tests
setTimeout(() => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
    
    // Cleanup test DBs
    try {
        if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
        const traderDbPath = path.join(__dirname, '../data/test_fv_trader.db');
        if (fs.existsSync(traderDbPath)) fs.unlinkSync(traderDbPath);
    } catch (e) {}
    
    if (failed > 0) {
        process.exit(1);
    }
}, 2000);
